"""Logger isolation and fixed execution context binding."""

from __future__ import annotations

import asyncio
import inspect
from collections.abc import Mapping
from types import MappingProxyType
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from .._public.types import WorkerLogger


class _NoOpLogger:
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


NO_OP_LOGGER = _NoOpLogger()
no_op_logger = NO_OP_LOGGER


class _SafeLogger:
    def __init__(self, logger: WorkerLogger) -> None:
        self._logger = logger

    def debug(self, message: str, context: Mapping[str, object] | None = None) -> None:
        self._invoke("debug", message, context)

    def info(self, message: str, context: Mapping[str, object] | None = None) -> None:
        self._invoke("info", message, context)

    def warning(
        self, message: str, context: Mapping[str, object] | None = None
    ) -> None:
        self._invoke("warning", message, context)

    def error(self, message: str, context: Mapping[str, object] | None = None) -> None:
        self._invoke("error", message, context)

    def _invoke(
        self,
        level: str,
        message: str,
        context: Mapping[str, object] | None,
    ) -> None:
        try:
            outcome = getattr(self._logger, level)(message, context)
        except Exception:
            return
        if inspect.isawaitable(outcome):
            _observe_awaitable(outcome)


class _BoundLogger:
    def __init__(self, logger: WorkerLogger, fixed: Mapping[str, str | int]) -> None:
        self._safe = safe_logger(logger)
        self._fixed = MappingProxyType(dict(fixed))

    def debug(self, message: str, context: Mapping[str, object] | None = None) -> None:
        self._safe.debug(message, self._context(context))

    def info(self, message: str, context: Mapping[str, object] | None = None) -> None:
        self._safe.info(message, self._context(context))

    def warning(
        self, message: str, context: Mapping[str, object] | None = None
    ) -> None:
        self._safe.warning(message, self._context(context))

    def error(self, message: str, context: Mapping[str, object] | None = None) -> None:
        self._safe.error(message, self._context(context))

    def _context(self, extra: Mapping[str, object] | None) -> Mapping[str, object]:
        try:
            copied = dict(extra) if extra else {}
        except Exception:
            copied = {}
        return MappingProxyType({**copied, **self._fixed})


def safe_logger(logger: WorkerLogger) -> WorkerLogger:
    return _SafeLogger(logger)


def bound_logger(logger: WorkerLogger, fixed: Mapping[str, str | int]) -> WorkerLogger:
    return _BoundLogger(logger, fixed)


def _observe_awaitable(outcome: Any) -> None:
    if inspect.iscoroutine(outcome):
        outcome.close()
    elif isinstance(outcome, asyncio.Future):
        outcome.add_done_callback(_consume_logger_outcome)


def _consume_logger_outcome(task: asyncio.Future[object]) -> None:
    if task.cancelled():
        return
    try:
        task.exception()
    except Exception:
        return
