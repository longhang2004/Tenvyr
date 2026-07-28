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
    TenvyrWorkerConfig,
    create_tenvyr_worker,
    define_agent,
)


class LoopbackInput(TypedDict):
    message: str


class LoopbackOutput(TypedDict):
    echo: str


def parse_input(value: object) -> LoopbackInput:
    if not isinstance(value, Mapping) or not isinstance(value.get("message"), str):
        raise TypeError("message must be a string")
    return {"message": cast(str, value["message"])}


def parse_output(value: object) -> LoopbackOutput:
    if not isinstance(value, Mapping) or not isinstance(value.get("echo"), str):
        raise TypeError("echo must be a string")
    return {"echo": cast(str, value["echo"])}


executions = 0


async def execute(
    context: AgentExecutionContext, input_value: LoopbackInput
) -> AgentExecutionSuccess[LoopbackOutput]:
    global executions
    executions += 1
    context.raise_if_cancelled()
    return context.success(output={"echo": input_value["message"]})


async def main() -> None:
    key_id = required("TENVYR_CALLBACK_KEY_ID")
    agent: AgentDefinition[LoopbackInput, LoopbackOutput] = define_agent(
        name="remote-echo-agent",
        input_parser=parse_input,
        output_parser=parse_output,
        execute=execute,
    )
    worker = create_tenvyr_worker(
        TenvyrWorkerConfig(
            agent=agent,
            bearer_token=required("TENVYR_WORKER_TOKEN"),
            callback_keys={key_id: required("TENVYR_CALLBACK_SECRET")},
            allowed_callback_origins=[required("TENVYR_CALLBACK_ORIGIN")],
            allow_insecure_http=required("TENVYR_ALLOW_INSECURE_HTTP") == "true",
            callback_max_attempts=3,
            callback_initial_delay_seconds=0.01,
            callback_max_delay_seconds=0.02,
            callback_jitter_ratio=0,
            callback_request_timeout_seconds=1,
        )
    )
    stop_requested = asyncio.Event()
    loop = asyncio.get_running_loop()
    for handled_signal in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(handled_signal, stop_requested.set)

    address = await worker.start(
        host=os.environ.get("TENVYR_WORKER_HOST", "127.0.0.1"),
        port=parse_port(os.environ.get("TENVYR_WORKER_PORT", "0")),
    )
    emit({"event": "tenvyr.worker.ready", "host": address.host, "port": address.port})
    await stop_requested.wait()
    await worker.stop()
    emit({"event": "tenvyr.worker.stopped", "executions": executions})


def required(name: str) -> str:
    value = os.environ.get(name)
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
                {"event": "tenvyr.worker.failed", "error": type(error).__name__},
                separators=(",", ":"),
            ),
            file=sys.stderr,
            flush=True,
        )
        raise SystemExit(1) from error
