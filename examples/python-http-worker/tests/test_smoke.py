from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest
from tenvyr_worker import AgentExecutionContext, AgentExecutionError


def test_example_module_loads() -> None:
    example = Path(__file__).parents[1] / "src" / "main.py"
    spec = importlib.util.spec_from_file_location("tenvyr_python_example", example)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    assert module.echo_agent.name == "echo-analyzer"
    assert module.parse_port("0") == 0


class Logger:
    def debug(self, message: str, context: dict[str, object] | None = None) -> None:
        pass

    def info(self, message: str, context: dict[str, object] | None = None) -> None:
        pass

    def warn(self, message: str, context: dict[str, object] | None = None) -> None:
        pass

    def error(self, message: str, context: dict[str, object] | None = None) -> None:
        pass


def load_example():
    example = Path(__file__).parents[1] / "src" / "main.py"
    spec = importlib.util.spec_from_file_location("tenvyr_python_showcase", example)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.mark.asyncio
async def test_retry_once_uses_invocation_attempt() -> None:
    module = load_example()
    first = AgentExecutionContext(
        invocation={"attempt": 1}, run_id="run-1", logger=Logger()
    )
    with pytest.raises(AgentExecutionError) as raised:
        await module.execute_echo(first, {"message": "hello", "mode": "retry-once"})
    assert raised.value.failure.code == "SHOWCASE_RETRY_ONCE"
    assert raised.value.failure.retryable is True

    second = AgentExecutionContext(
        invocation={"attempt": 2}, run_id="run-2", logger=Logger()
    )
    result = await module.execute_echo(
        second, {"message": "hello", "mode": "retry-once"}
    )
    assert result.output == {
        "echo": "hello",
        "characters": 5,
        "_tenvyr": {
            "runtime": "python",
            "language": "python",
            "transport": "http",
        },
    }
