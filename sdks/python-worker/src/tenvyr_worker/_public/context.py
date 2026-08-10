from __future__ import annotations

import asyncio
import threading
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from types import MappingProxyType
from typing import Generic, NoReturn, TypeVar

from .errors import AgentExecutionError, AgentFailureOptions
from .types import EventEmitter, WorkerLogger

OutputT = TypeVar("OutputT")


class _MissingOutput:
    __slots__ = ()


_MISSING = _MissingOutput()


@dataclass(frozen=True)
class AgentExecutionSuccess(Generic[OutputT]):
    output: OutputT | _MissingOutput = field(default=_MISSING, repr=False)
    usage: Mapping[str, object] | None = None
    artifacts: Sequence[Mapping[str, object]] | None = None
    metadata: Mapping[str, object] | None = None

    @property
    def _has_output(self) -> bool:
        return self.output is not _MISSING


class AgentExecutionContext:
    __slots__ = (
        "_async_cancelled",
        "_emitter",
        "_invocation",
        "_logger",
        "_run_id",
        "_thread_cancelled",
    )

    def __init__(
        self,
        *,
        invocation: Mapping[str, object],
        run_id: str,
        logger: WorkerLogger,
        _emitter: EventEmitter | None = None,
        _thread_cancelled: threading.Event | None = None,
        _async_cancelled: asyncio.Event | None = None,
    ) -> None:
        self._invocation = MappingProxyType(dict(invocation))
        self._run_id = run_id
        self._logger = logger
        self._emitter = _emitter
        self._thread_cancelled = _thread_cancelled or threading.Event()
        self._async_cancelled = _async_cancelled or asyncio.Event()

    @property
    def invocation(self) -> Mapping[str, object]:
        return self._invocation

    @property
    def run_id(self) -> str:
        return self._run_id

    @property
    def logger(self) -> WorkerLogger:
        return self._logger

    @property
    def is_cancelled(self) -> bool:
        return self._thread_cancelled.is_set()

    async def wait_cancelled(self) -> None:
        if self.is_cancelled:
            return
        await self._async_cancelled.wait()

    def raise_if_cancelled(self) -> None:
        if self.is_cancelled:
            raise asyncio.CancelledError

    def success(
        self,
        *,
        output: OutputT | _MissingOutput = _MISSING,
        usage: Mapping[str, object] | None = None,
        artifacts: Sequence[Mapping[str, object]] | None = None,
        metadata: Mapping[str, object] | None = None,
    ) -> AgentExecutionSuccess[OutputT]:
        return AgentExecutionSuccess(
            output=output,
            usage=usage,
            artifacts=artifacts,
            metadata=metadata,
        )

    def fail(
        self,
        *,
        code: str,
        message: str,
        retryable: bool,
        details: Mapping[str, object] | None = None,
    ) -> NoReturn:
        raise AgentExecutionError(
            AgentFailureOptions(
                code=code,
                message=message,
                retryable=retryable,
                details=details,
            )
        )

    def progress(self, payload: Mapping[str, object]) -> None:
        """Emit a progress event for this run (no-op when events are disabled)."""
        if self._emitter is not None:
            self._emitter.emit("progress", payload)

    def log(self, message_or_payload: str | Mapping[str, object]) -> None:
        """Emit a log event; a string becomes ``{"message": ...}``."""
        payload: Mapping[str, object] = (
            {"message": message_or_payload}
            if isinstance(message_or_payload, str)
            else message_or_payload
        )
        if self._emitter is not None:
            self._emitter.emit("log", payload)

    def artifact(self, metadata: Mapping[str, object]) -> None:
        """Emit an artifact event carrying the artifact descriptor."""
        if self._emitter is not None:
            self._emitter.emit("artifact", metadata)

    def event(self, type: str, payload: Mapping[str, object]) -> None:
        """Emit an event restricted to ``progress``, ``log``, or ``artifact``.

        System-owned types (accepted, heartbeat, completed, failed) are
        rejected. No-op when events are disabled.
        """
        if type not in ("progress", "log", "artifact"):
            raise ValueError(
                f'Agent events of type "{type}" are reserved for the Worker runtime'
            )
        if self._emitter is not None:
            self._emitter.emit(type, payload)

    def _cancel(self) -> None:
        self._thread_cancelled.set()
        self._async_cancelled.set()
