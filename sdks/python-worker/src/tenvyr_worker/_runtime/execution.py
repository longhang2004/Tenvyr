"""Agent execution with cooperative cancellation and one terminal result."""

from __future__ import annotations

import asyncio
import inspect
import time
from collections.abc import Awaitable, Callable, Mapping
from datetime import UTC, datetime
from typing import Any, cast

from .._protocol.json_value import JsonCompatibilityError, JsonValue, to_json_value
from .._protocol.validation import ContractValidationError, parse_agent_result
from .._public.agent import AgentDefinition, parse_value
from .._public.context import AgentExecutionContext, AgentExecutionSuccess
from .._public.errors import AgentExecutionError, AgentFailureOptions
from .._public.types import WorkerLogger
from .safe_logger import NO_OP_LOGGER, bound_logger

_HandlerResult = object


async def execute_agent(
    *,
    agent: AgentDefinition[Any, Any],
    invocation: Mapping[str, object],
    run_id: str,
    timeout_seconds: float,
    logger: WorkerLogger = NO_OP_LOGGER,
    shutdown_event: asyncio.Event | None = None,
    now: Callable[[], float] = time.time,
) -> dict[str, JsonValue]:
    """Execute one validated invocation and return a validated AgentResultV1."""

    started_at = _timestamp(now())
    scoped_logger = bound_logger(
        logger,
        {
            "agent": agent.name,
            "run_id": run_id,
            "invocation_id": _string_field(invocation, "invocationId"),
            "execution_id": _string_field(invocation, "executionId"),
            "step_execution_id": _string_field(invocation, "stepExecutionId"),
            "attempt": _integer_field(invocation, "attempt"),
        },
    )

    try:
        parsed_input = (
            parse_value(agent.input_parser, invocation.get("input"))
            if agent.input_parser is not None
            else invocation.get("input")
        )
    except Exception:
        return _failed_result(
            invocation,
            started_at,
            now,
            AgentFailureOptions(
                code="AGENT_INPUT_INVALID",
                message="Agent input validation failed",
                retryable=False,
            ),
        )

    context = AgentExecutionContext(
        invocation=invocation,
        run_id=run_id,
        logger=scoped_logger,
    )
    is_async_handler = _is_async_callable(agent.execute)
    handler_task = asyncio.create_task(
        _call_async(agent.execute, context, parsed_input)
        if is_async_handler
        else _call_sync(agent.execute, context, parsed_input),
        name=f"tenvyr-worker-handler-{run_id}",
    )
    timeout_task = asyncio.create_task(
        asyncio.sleep(timeout_seconds),
        name=f"tenvyr-worker-timeout-{run_id}",
    )
    shutdown_task = (
        asyncio.create_task(
            shutdown_event.wait(),
            name=f"tenvyr-worker-shutdown-{run_id}",
        )
        if shutdown_event is not None
        else None
    )
    watchers: set[asyncio.Task[object]] = {timeout_task}
    if shutdown_task is not None:
        watchers.add(shutdown_task)

    try:
        try:
            done, _ = await asyncio.wait(
                {handler_task, *watchers},
                return_when=asyncio.FIRST_COMPLETED,
            )
        except asyncio.CancelledError:
            context._cancel()
            _detach_handler(
                handler_task,
                cancel=is_async_handler,
                logger=scoped_logger,
            )
            raise
        # The explicit ordering is observable when signals become ready together.
        if timeout_task in done:
            context._cancel()
            _detach_handler(handler_task, cancel=is_async_handler, logger=scoped_logger)
            return _terminal_error(
                invocation,
                started_at,
                now,
                status="timed_out",
                failure=AgentFailureOptions(
                    code="AGENT_EXECUTION_TIMEOUT",
                    message="Agent execution exceeded its configured timeout",
                    retryable=True,
                ),
            )
        if shutdown_task is not None and shutdown_task in done:
            context._cancel()
            _detach_handler(handler_task, cancel=is_async_handler, logger=scoped_logger)
            return _terminal_error(
                invocation,
                started_at,
                now,
                status="cancelled",
                failure=AgentFailureOptions(
                    code="WORKER_SHUTDOWN",
                    message="Worker shutdown cancelled the execution",
                    retryable=True,
                ),
            )

        try:
            returned = handler_task.result()
        except JsonCompatibilityError:
            return _invalid_output_result(invocation, started_at, now)
        except AgentExecutionError as error:
            try:
                return _failed_result(invocation, started_at, now, error.failure)
            except (ContractValidationError, JsonCompatibilityError):
                return _invalid_output_result(invocation, started_at, now)
        except asyncio.CancelledError:
            scoped_logger.error("Agent execution failed")
            return _failed_result(
                invocation,
                started_at,
                now,
                AgentFailureOptions(
                    code="AGENT_EXECUTION_FAILED",
                    message="Agent execution failed",
                    retryable=False,
                ),
            )
        except Exception:
            scoped_logger.error("Agent execution failed")
            return _failed_result(
                invocation,
                started_at,
                now,
                AgentFailureOptions(
                    code="AGENT_EXECUTION_FAILED",
                    message="Agent execution failed",
                    retryable=False,
                ),
            )

        return _successful_result(agent, invocation, returned, started_at, now)
    finally:
        for watcher in watchers:
            if not watcher.done():
                watcher.cancel()
        await asyncio.gather(*watchers, return_exceptions=True)


async def _call_async(
    execute: Callable[[AgentExecutionContext, object], object],
    context: AgentExecutionContext,
    parsed_input: object,
) -> _HandlerResult:
    returned = execute(context, parsed_input)
    if inspect.isawaitable(returned):
        return await cast(Awaitable[_HandlerResult], returned)
    return returned


async def _call_sync(
    execute: Callable[[AgentExecutionContext, object], object],
    context: AgentExecutionContext,
    parsed_input: object,
) -> _HandlerResult:
    returned = await asyncio.to_thread(execute, context, parsed_input)
    if inspect.isawaitable(returned):
        return await cast(Awaitable[_HandlerResult], returned)
    return returned


def _successful_result(
    agent: AgentDefinition[Any, Any],
    invocation: Mapping[str, object],
    returned: _HandlerResult,
    started_at: str,
    now: Callable[[], float],
) -> dict[str, JsonValue]:
    try:
        success = returned if isinstance(returned, AgentExecutionSuccess) else None
        has_output = success._has_output if success is not None else True
        output = success.output if success is not None else returned
        if has_output and agent.output_parser is not None:
            output = parse_value(agent.output_parser, output)

        result: dict[str, object] = {
            "schemaVersion": "1",
            "invocationId": _string_field(invocation, "invocationId"),
            "executionId": _string_field(invocation, "executionId"),
            "stepExecutionId": _string_field(invocation, "stepExecutionId"),
            "status": "succeeded",
            "startedAt": started_at,
            "completedAt": _timestamp(now()),
        }
        if has_output:
            result["output"] = to_json_value(output)
        if success is not None:
            if success.usage is not None:
                result["usage"] = to_json_value(dict(success.usage))
            if success.artifacts is not None:
                result["artifacts"] = to_json_value(
                    [dict(artifact) for artifact in success.artifacts]
                )
            if success.metadata is not None:
                result["metadata"] = to_json_value(dict(success.metadata))
        return parse_agent_result(result)
    except Exception:
        return _invalid_output_result(invocation, started_at, now)


def _invalid_output_result(
    invocation: Mapping[str, object],
    started_at: str,
    now: Callable[[], float],
) -> dict[str, JsonValue]:
    return _failed_result(
        invocation,
        started_at,
        now,
        AgentFailureOptions(
            code="AGENT_OUTPUT_INVALID",
            message="Agent output validation failed",
            retryable=False,
        ),
    )


def _failed_result(
    invocation: Mapping[str, object],
    started_at: str,
    now: Callable[[], float],
    failure: AgentFailureOptions,
) -> dict[str, JsonValue]:
    return _terminal_error(
        invocation,
        started_at,
        now,
        status="failed",
        failure=failure,
    )


def _terminal_error(
    invocation: Mapping[str, object],
    started_at: str,
    now: Callable[[], float],
    *,
    status: str,
    failure: AgentFailureOptions,
) -> dict[str, JsonValue]:
    error: dict[str, object] = {
        "code": failure.code,
        "message": failure.message,
        "retryable": failure.retryable,
    }
    if failure.details is not None:
        error["details"] = dict(failure.details)
    return parse_agent_result(
        {
            "schemaVersion": "1",
            "invocationId": _string_field(invocation, "invocationId"),
            "executionId": _string_field(invocation, "executionId"),
            "stepExecutionId": _string_field(invocation, "stepExecutionId"),
            "status": status,
            "error": error,
            "startedAt": started_at,
            "completedAt": _timestamp(now()),
        }
    )


def _detach_handler(
    task: asyncio.Task[_HandlerResult],
    *,
    cancel: bool,
    logger: WorkerLogger,
) -> None:
    if cancel:
        task.cancel()
    if not task.done():
        task.set_name("tenvyr-user-detached-agent-work")

    def observe(completed: asyncio.Task[_HandlerResult]) -> None:
        if not completed.cancelled():
            completed.exception()
        logger.warning("Ignoring late agent completion after terminal result")

    task.add_done_callback(observe)


def _is_async_callable(value: object) -> bool:
    return inspect.iscoroutinefunction(value) or (
        callable(value) and inspect.iscoroutinefunction(type(value).__call__)
    )


def _timestamp(value: float) -> str:
    formatted = datetime.fromtimestamp(value, UTC).isoformat(timespec="milliseconds")
    return formatted.replace("+00:00", "Z")


def _string_field(value: Mapping[str, object], key: str) -> str:
    return cast(str, value[key])


def _integer_field(value: Mapping[str, object], key: str) -> int:
    return cast(int, value[key])
