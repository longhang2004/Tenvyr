from __future__ import annotations

import asyncio
import dataclasses
import inspect
from collections.abc import Mapping

import pytest

import tenvyr_worker
from tenvyr_worker import (
    AgentDefinition,
    AgentExecutionContext,
    AgentExecutionError,
    AgentExecutionSuccess,
    AgentFailureOptions,
    TenvyrWorker,
    WorkerAddress,
    WorkerLifecycleState,
    define_agent,
)

EXPECTED_EXPORTS = [
    "AgentDefinition",
    "AgentExecutionContext",
    "AgentExecutionError",
    "AgentExecutionSuccess",
    "AgentFailureOptions",
    "TenvyrWorker",
    "TenvyrWorkerConfig",
    "WorkerAddress",
    "WorkerLifecycleState",
    "WorkerLogger",
    "create_tenvyr_worker",
    "define_agent",
]


class _Logger:
    def debug(self, message: str, context: Mapping[str, object] | None = None) -> None:
        pass

    def info(self, message: str, context: Mapping[str, object] | None = None) -> None:
        pass

    def warning(
        self, message: str, context: Mapping[str, object] | None = None
    ) -> None:
        pass

    def error(self, message: str, context: Mapping[str, object] | None = None) -> None:
        pass


def _execute(context: AgentExecutionContext, value: object) -> object:
    return value


def test_root_all_is_the_exact_compatibility_surface() -> None:
    assert tenvyr_worker.__all__ == EXPECTED_EXPORTS
    assert not hasattr(tenvyr_worker, "create_" + "agent" + "weave" + "_worker")
    assert not hasattr(tenvyr_worker, "Agent" + "Weave" + "Worker")


def test_define_agent_is_keyword_only_and_accepts_callable_or_object_parsers() -> None:
    assert all(
        parameter.kind is inspect.Parameter.KEYWORD_ONLY
        for parameter in inspect.signature(define_agent).parameters.values()
    )

    def callable_parser(value: object) -> str:
        return str(value)

    class ObjectParser:
        def parse(self, value: object) -> int:
            return int(str(value))

    first = define_agent(
        name="callable-parser", execute=_execute, input_parser=callable_parser
    )
    second = define_agent(
        name="object-parser", execute=_execute, output_parser=ObjectParser()
    )

    assert first.input_parser is callable_parser
    assert second.output_parser is not None


@pytest.mark.parametrize(
    ("override", "match"),
    (
        ({"name": ""}, "name"),
        ({"name": "   "}, "name"),
        ({"name": 3}, "name"),
        ({"execute": None}, "execute"),
        ({"input_parser": object()}, "input_parser"),
        ({"output_parser": object()}, "output_parser"),
    ),
)
def test_define_agent_rejects_invalid_values(
    override: dict[str, object], match: str
) -> None:
    arguments: dict[str, object] = {"name": "echo", "execute": _execute}
    arguments.update(override)
    with pytest.raises((TypeError, ValueError), match=match):
        define_agent(**arguments)  # type: ignore[arg-type]


def test_public_value_types_are_frozen_dataclasses_and_lifecycle_is_str_enum() -> None:
    agent = define_agent(name="echo", execute=_execute)
    values = (
        agent,
        AgentExecutionSuccess(output={"ok": True}),
        AgentFailureOptions(code="NO", message="no", retryable=False),
        WorkerAddress(host="127.0.0.1", port=8080),
    )
    assert all(dataclasses.is_dataclass(value) for value in values)
    for value in values:
        with pytest.raises(dataclasses.FrozenInstanceError):
            value.__setattr__("changed", True)
    assert str(WorkerLifecycleState.RUNNING) == "running"
    assert getattr(TenvyrWorker, "_is_protocol", False)


def test_context_distinguishes_missing_output_from_explicit_none_and_raw_none() -> None:
    context = AgentExecutionContext(
        invocation={"invocationId": "invocation-1"},
        run_id="run-1",
        logger=_Logger(),
    )
    missing = context.success()
    explicit = context.success(output=None)

    assert missing._has_output is False
    assert explicit._has_output is True
    assert explicit.output is None
    assert None is not missing


def test_context_cancellation_is_visible_to_threads_and_async_waiters() -> None:
    async def exercise() -> None:
        context = AgentExecutionContext(
            invocation={"invocationId": "invocation-1"},
            run_id="run-1",
            logger=_Logger(),
        )
        waiter = asyncio.create_task(context.wait_cancelled())
        assert context.is_cancelled is False
        context._cancel()
        await waiter
        assert context.is_cancelled is True
        with pytest.raises(asyncio.CancelledError):
            context.raise_if_cancelled()

    asyncio.run(exercise())


def test_context_fail_raises_typed_validated_error() -> None:
    context = AgentExecutionContext(
        invocation={"invocationId": "invocation-1"},
        run_id="run-1",
        logger=_Logger(),
    )
    with pytest.raises(AgentExecutionError) as caught:
        context.fail(
            code="REQUEST_REJECTED",
            message="The request was rejected",
            retryable=False,
            details={"reason": "policy"},
        )
    assert caught.value.failure.code == "REQUEST_REJECTED"
    assert caught.value.failure.details == {"reason": "policy"}


@pytest.mark.parametrize(
    "options",
    (
        {"code": "", "message": "message", "retryable": False},
        {"code": "code", "message": "", "retryable": False},
        {"code": "code", "message": "message", "retryable": 1},
        {
            "code": "code",
            "message": "message",
            "retryable": False,
            "details": {"bad": float("nan")},
        },
    ),
)
def test_failure_options_reject_invalid_values(options: dict[str, object]) -> None:
    with pytest.raises((TypeError, ValueError)):
        AgentFailureOptions(**options)  # type: ignore[arg-type]


def test_agent_definition_is_the_define_agent_return_type() -> None:
    assert isinstance(define_agent(name="echo", execute=_execute), AgentDefinition)
