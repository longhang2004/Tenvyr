from __future__ import annotations

import asyncio
import json
import os
import signal
import sys
from collections.abc import Mapping
from typing import TypedDict, cast

from tenvyr_worker import (
    AgentDefinition,
    AgentExecutionContext,
    AgentExecutionSuccess,
    TenvyrWorker,
    TenvyrWorkerConfig,
    create_tenvyr_worker,
    define_agent,
)


class EchoInput(TypedDict):
    message: str


class EchoOutput(TypedDict):
    echo: str
    characters: int


class EchoInputParser:
    def parse(self, value: object) -> EchoInput:
        if not isinstance(value, Mapping) or not isinstance(value.get("message"), str):
            raise TypeError("message must be a string")
        return {"message": cast(str, value["message"])}


def parse_output(value: object) -> EchoOutput:
    if not isinstance(value, Mapping):
        raise TypeError("output must be an object")
    if (
        not isinstance(value.get("echo"), str)
        or not isinstance(value.get("characters"), int)
        or isinstance(value.get("characters"), bool)
    ):
        raise TypeError("output echo and characters are invalid")
    return {
        "echo": cast(str, value["echo"]),
        "characters": cast(int, value["characters"]),
    }


execution_count = 0


async def execute_echo(
    context: AgentExecutionContext, input_value: EchoInput
) -> AgentExecutionSuccess[EchoOutput]:
    global execution_count
    execution_count += 1
    if not input_value["message"].strip():
        context.fail(
            code="EMPTY_MESSAGE",
            message="The message must not be empty",
            retryable=False,
        )

    context.raise_if_cancelled()
    await asyncio.sleep(0.01)
    context.raise_if_cancelled()
    context.logger.info("Echo analysis completed")
    return context.success(
        output={
            "echo": input_value["message"],
            "characters": len(input_value["message"]),
        },
        metadata={"example": True},
    )


echo_agent: AgentDefinition[EchoInput, EchoOutput] = define_agent(
    name="echo-analyzer",
    version="1.0.0",
    input_parser=EchoInputParser(),
    output_parser=parse_output,
    execute=execute_echo,
)


def create_example_worker(
    environment: Mapping[str, str] = os.environ,
) -> TenvyrWorker:
    key_id = required(environment, "TENVYR_CALLBACK_KEY_ID")
    return create_tenvyr_worker(
        TenvyrWorkerConfig(
            agent=echo_agent,
            bearer_token=required(environment, "TENVYR_WORKER_TOKEN"),
            callback_keys={key_id: required(environment, "TENVYR_CALLBACK_SECRET")},
            allowed_callback_origins=[required(environment, "TENVYR_CALLBACK_ORIGIN")],
            allow_insecure_http=(
                environment.get("TENVYR_ALLOW_INSECURE_HTTP") == "true"
            ),
        )
    )


async def main() -> None:
    worker = create_example_worker()
    address = await worker.start(
        host=os.environ.get("TENVYR_WORKER_HOST", "127.0.0.1"),
        port=parse_port(os.environ.get("TENVYR_WORKER_PORT", "8080")),
    )
    emit({"event": "tenvyr.worker.ready", "host": address.host, "port": address.port})

    stop_requested = asyncio.Event()
    loop = asyncio.get_running_loop()
    for handled_signal in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(handled_signal, stop_requested.set)

    await stop_requested.wait()
    await worker.stop()
    emit({"event": "tenvyr.worker.stopped", "executions": execution_count})


def required(environment: Mapping[str, str], name: str) -> str:
    value = environment.get(name)
    if value is None or not value.strip():
        raise ValueError(f"{name} is required")
    return value


def parse_port(value: str) -> int:
    try:
        port = int(value)
    except ValueError:
        raise ValueError("TENVYR_WORKER_PORT must be an integer") from None
    if not 0 <= port <= 65535:
        raise ValueError("TENVYR_WORKER_PORT must be between 0 and 65535")
    return port


def emit(event: Mapping[str, object]) -> None:
    print(json.dumps(event, separators=(",", ":")), flush=True)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except Exception as error:
        print(
            json.dumps(
                {
                    "event": "tenvyr.worker.failed",
                    "error": type(error).__name__,
                },
                separators=(",", ":"),
            ),
            file=sys.stderr,
            flush=True,
        )
        raise SystemExit(1) from error
