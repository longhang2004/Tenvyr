from __future__ import annotations

import asyncio
import json
import threading
from collections.abc import Mapping
from dataclasses import dataclass
from typing import cast

import pytest

from tenvyr_worker import AgentExecutionError, AgentFailureOptions, define_agent
from tenvyr_worker._runtime.execution import execute_agent
from tenvyr_worker._runtime.safe_logger import NO_OP_LOGGER, bound_logger, safe_logger

_NOW = 1_785_024_001.0
_INVOCATION: dict[str, object] = {
    "schemaVersion": "1",
    "invocationId": "invocation-1",
    "executionId": "execution-1",
    "stepExecutionId": "step-execution-1",
    "stepId": "echo",
    "target": {"agent": "echo-agent"},
    "input": {"message": "hello"},
    "attempt": 1,
    "createdAt": "2026-07-26T00:00:00.000Z",
    "trace": {"traceId": "trace-1", "correlationId": "invocation-1"},
}


async def _execute(agent, **options):
    return await execute_agent(
        agent=agent,
        invocation=_INVOCATION,
        run_id="run-1",
        timeout_seconds=options.pop("timeout_seconds", 1.0),
        now=options.pop("now", lambda: _NOW),
        **options,
    )


@pytest.mark.asyncio
async def test_raw_none_and_structured_missing_or_explicit_none_are_distinct() -> None:
    raw = define_agent(name="echo-agent", execute=lambda _context, _input: None)
    missing = define_agent(
        name="echo-agent", execute=lambda context, _input: context.success()
    )
    explicit = define_agent(
        name="echo-agent",
        execute=lambda context, _input: context.success(output=None),
    )

    assert (await _execute(raw))["output"] is None
    assert "output" not in await _execute(missing)
    assert (await _execute(explicit))["output"] is None


@pytest.mark.asyncio
async def test_handler_reads_the_tenvyr_envelope_from_invocation_context() -> None:
    """M2C conformance: the Python handler sees the semantically identical
    Tenvyr envelope the Orchestrator persisted, with no result-semantic drift."""
    envelope = {
        "tenvyr": {
            "schemaVersion": 1,
            "executionState": {"version": 7, "values": {"approvedBrief": "x"}},
            "artifacts": [],
        }
    }
    invocation = {**_INVOCATION, "context": envelope}
    seen: dict[str, object] = {}

    def handler(context, _input):
        seen["context"] = dict(context.invocation["context"])  # type: ignore[index]
        return {"output": {"sawContext": True}}

    result = await execute_agent(
        agent=define_agent(name="echo-agent", execute=handler),
        invocation=invocation,
        run_id="run-1",
        timeout_seconds=1.0,
        now=lambda: _NOW,
    )
    assert seen["context"] == envelope
    assert result["status"] == "succeeded"
    assert result["output"] == {"output": {"sawContext": True}}


@pytest.mark.asyncio
async def test_parsers_wrap_async_handler_and_structured_success() -> None:
    calls: list[str] = []

    class OutputParser:
        def parse(self, value: object) -> str:
            calls.append("output")
            return str(value).upper()

    def parse_input(value: object) -> str:
        calls.append("input")
        return str(cast(dict[str, object], value)["message"])

    async def handler(context, value: str):
        calls.append("execute")
        return context.success(
            output=value,
            usage={"totalTokens": 3},
            artifacts=[{"id": "artifact-1", "name": "result.json"}],
            metadata={"source": "test"},
        )

    agent = define_agent(
        name="echo-agent",
        execute=handler,
        input_parser=parse_input,
        output_parser=OutputParser(),
    )
    result = await _execute(agent)

    assert calls == ["input", "execute", "output"]
    assert result["output"] == "HELLO"
    assert result["usage"] == {"totalTokens": 3}
    assert result["artifacts"] == [{"id": "artifact-1", "name": "result.json"}]
    assert result["metadata"] == {"source": "test"}


@pytest.mark.asyncio
async def test_sync_handler_runs_in_thread_and_awaits_returned_awaitable() -> None:
    loop_thread = threading.get_ident()
    handler_thread = 0

    async def eventual() -> str:
        await asyncio.sleep(0)
        return "done"

    def handler(_context, _input):
        nonlocal handler_thread
        handler_thread = threading.get_ident()
        return eventual()

    result = await _execute(define_agent(name="echo-agent", execute=handler))

    assert result["output"] == "done"
    assert handler_thread != loop_thread


@pytest.mark.asyncio
async def test_input_output_and_unexpected_failures_are_safe() -> None:
    called = False

    def fail_input(_value: object) -> object:
        raise RuntimeError("TOP_SECRET_INPUT")

    def should_not_run(_context, _input):
        nonlocal called
        called = True

    input_result = await _execute(
        define_agent(name="echo-agent", execute=should_not_run, input_parser=fail_input)
    )
    invalid_result = await _execute(
        define_agent(name="echo-agent", execute=lambda _context, _input: object())
    )

    async def explode(_context, _input):
        raise RuntimeError("TOP_SECRET_THROWN")

    thrown_result = await _execute(define_agent(name="echo-agent", execute=explode))

    assert not called
    assert input_result["error"]["code"] == "AGENT_INPUT_INVALID"
    assert invalid_result["error"]["code"] == "AGENT_OUTPUT_INVALID"
    assert thrown_result["error"]["code"] == "AGENT_EXECUTION_FAILED"
    assert "TOP_SECRET" not in json.dumps([input_result, invalid_result, thrown_result])


@pytest.mark.asyncio
async def test_every_unsafe_handler_value_maps_to_output_invalid() -> None:
    unsafe = 9_007_199_254_740_992

    def structured(field: str):
        def handler(context, _input):
            options = {
                "output": {"safe": True},
                field: (
                    [
                        {
                            "id": "artifact-1",
                            "name": "result",
                            "metadata": {"unsafe": unsafe},
                        }
                    ]
                    if field == "artifacts"
                    else {"unsafe": unsafe}
                ),
            }
            return context.success(**options)

        return handler

    def explicit_failure(context, _input):
        context.fail(
            code="DOMAIN_FAILURE",
            message="Domain failure",
            retryable=False,
            details={"unsafe": unsafe},
        )

    mutated_failure = AgentFailureOptions(
        code="DOMAIN_FAILURE",
        message="Domain failure",
        retryable=False,
        details={"safe": True},
    )
    object.__setattr__(mutated_failure, "details", {"unsafe": unsafe})

    def direct_failure(_context, _input):
        raise AgentExecutionError(mutated_failure)

    agents = (
        define_agent(
            name="echo-agent",
            execute=lambda _context, _input: {"unsafe": unsafe},
        ),
        define_agent(name="echo-agent", execute=structured("output")),
        define_agent(name="echo-agent", execute=structured("usage")),
        define_agent(name="echo-agent", execute=structured("metadata")),
        define_agent(name="echo-agent", execute=structured("artifacts")),
        define_agent(
            name="echo-agent",
            execute=lambda _context, _input: "parsed",
            output_parser=lambda _value: {"unsafe": unsafe},
        ),
        define_agent(name="echo-agent", execute=explicit_failure),
        define_agent(name="echo-agent", execute=direct_failure),
    )

    for agent in agents:
        result = await _execute(agent)
        assert result["status"] == "failed"
        assert result["error"] == {
            "code": "AGENT_OUTPUT_INVALID",
            "message": "Agent output validation failed",
            "retryable": False,
        }


@pytest.mark.asyncio
async def test_input_parser_domain_objects_remain_supported() -> None:
    @dataclass(frozen=True)
    class DomainInput:
        message: str

    def parse_input(value: object) -> DomainInput:
        return DomainInput(cast(dict[str, str], value)["message"])

    agent = define_agent(
        name="echo-agent",
        input_parser=parse_input,
        execute=lambda _context, value: {"message": value.message.upper()},
    )

    assert (await _execute(agent))["output"] == {"message": "HELLO"}


@pytest.mark.asyncio
async def test_context_and_direct_explicit_failures_are_preserved() -> None:
    via_context = define_agent(
        name="echo-agent",
        execute=lambda context, _input: context.fail(
            code="REPOSITORY_UNAVAILABLE",
            message="Repository could not be read",
            retryable=True,
            details={"host": "git.internal"},
        ),
    )

    def direct(_context, _input):
        raise AgentExecutionError(
            AgentFailureOptions(
                code="DIRECT_FAILURE",
                message="Explicit direct failure",
                retryable=False,
            )
        )

    assert (await _execute(via_context))["error"] == {
        "code": "REPOSITORY_UNAVAILABLE",
        "message": "Repository could not be read",
        "retryable": True,
        "details": {"host": "git.internal"},
    }
    assert (await _execute(define_agent(name="echo-agent", execute=direct)))["error"][
        "code"
    ] == "DIRECT_FAILURE"


@pytest.mark.asyncio
async def test_timeout_cancels_context_and_ignores_late_completion() -> None:
    cancelled = asyncio.Event()
    release = asyncio.Event()

    async def handler(context, _input):
        try:
            await context.wait_cancelled()
            cancelled.set()
            await release.wait()
        except asyncio.CancelledError:
            cancelled.set()
            await release.wait()
        return "late"

    result = await _execute(
        define_agent(name="echo-agent", execute=handler), timeout_seconds=0.001
    )

    assert result["status"] == "timed_out"
    assert result["error"]["code"] == "AGENT_EXECUTION_TIMEOUT"
    await asyncio.wait_for(cancelled.wait(), timeout=1)
    release.set()
    await asyncio.sleep(0)
    assert result["status"] == "timed_out"


@pytest.mark.asyncio
async def test_sync_timeout_sets_thread_visible_cancellation() -> None:
    observed = threading.Event()
    finished = threading.Event()

    def handler(context, _input):
        while not context.is_cancelled:
            observed.wait(0.001)
        observed.set()
        finished.set()
        return "late"

    result = await _execute(
        define_agent(name="echo-agent", execute=handler), timeout_seconds=0.001
    )

    assert result["status"] == "timed_out"
    assert observed.wait(1)
    assert finished.wait(1)
    await asyncio.sleep(0)


@pytest.mark.asyncio
async def test_timeout_then_shutdown_then_completion_priority() -> None:
    shutdown = asyncio.Event()
    shutdown.set()
    agent = define_agent(name="echo-agent", execute=lambda _context, _input: "done")

    timed_out = await _execute(agent, timeout_seconds=0.0, shutdown_event=shutdown)
    cancelled = await _execute(agent, timeout_seconds=10.0, shutdown_event=shutdown)

    assert timed_out["status"] == "timed_out"
    assert cancelled["status"] == "cancelled"


class _RecordingLogger:
    def __init__(self) -> None:
        self.contexts: list[Mapping[str, object]] = []

    def debug(self, message: str, context=None) -> None:
        self.contexts.append(context)

    info = debug
    warning = debug
    error = debug


def test_bound_logger_context_is_immutable_and_fixed_values_win() -> None:
    logger = _RecordingLogger()
    bound = bound_logger(
        logger,
        {"agent": "fixed-agent", "run_id": "run-1"},
    )

    bound.info("safe", {"agent": "caller-agent", "extra": 1})

    context = logger.contexts[0]
    assert context == {"agent": "fixed-agent", "run_id": "run-1", "extra": 1}
    with pytest.raises(TypeError):
        cast(dict[str, object], context)["agent"] = "mutated"


def test_bound_logger_isolates_broken_caller_context() -> None:
    class BrokenContext(Mapping[str, object]):
        def __getitem__(self, key: str) -> object:
            raise RuntimeError(key)

        def __iter__(self):
            raise RuntimeError("broken context")

        def __len__(self) -> int:
            return 1

    logger = _RecordingLogger()
    bound = bound_logger(logger, {"agent": "fixed-agent", "run_id": "run-1"})

    bound.info("safe", BrokenContext())

    assert logger.contexts == [{"agent": "fixed-agent", "run_id": "run-1"}]


def test_logger_exceptions_are_isolated_and_warn_alias_is_absent() -> None:
    class BrokenLogger:
        def debug(self, message: str, context=None) -> None:
            raise RuntimeError("logger failed")

        info = debug
        warning = debug
        error = debug

    logger = safe_logger(BrokenLogger())

    logger.error("ignored")
    assert not hasattr(NO_OP_LOGGER, "warn")


@pytest.mark.asyncio
async def test_async_logger_failure_is_observed() -> None:
    class BrokenAsyncLogger:
        async def debug(self, message: str, context=None) -> None:
            await asyncio.sleep(0)
            raise RuntimeError("logger failed")

        info = debug
        warning = debug
        error = debug

    logger = safe_logger(BrokenAsyncLogger())  # type: ignore[arg-type]

    logger.warning("ignored")
    await asyncio.sleep(0)
    await asyncio.sleep(0)
