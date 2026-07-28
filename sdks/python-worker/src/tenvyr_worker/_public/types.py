from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from enum import StrEnum
from typing import Protocol, runtime_checkable


class WorkerLifecycleState(StrEnum):
    CREATED = "created"
    STARTING = "starting"
    RUNNING = "running"
    STOPPING = "stopping"
    STOPPED = "stopped"
    FAILED = "failed"


@dataclass(frozen=True)
class WorkerAddress:
    host: str
    port: int


@runtime_checkable
class WorkerLogger(Protocol):
    def debug(
        self, message: str, context: Mapping[str, object] | None = None
    ) -> None: ...

    def info(
        self, message: str, context: Mapping[str, object] | None = None
    ) -> None: ...

    def warning(
        self, message: str, context: Mapping[str, object] | None = None
    ) -> None: ...

    def error(
        self, message: str, context: Mapping[str, object] | None = None
    ) -> None: ...


@runtime_checkable
class TenvyrWorker(Protocol):
    @property
    def agent_name(self) -> str: ...

    async def start(
        self, *, host: str = "127.0.0.1", port: int = 8080
    ) -> WorkerAddress: ...

    async def stop(self, *, grace_seconds: float | None = None) -> None: ...

    def get_state(self) -> WorkerLifecycleState: ...
