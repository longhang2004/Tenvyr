from __future__ import annotations

from collections.abc import Collection, Mapping
from dataclasses import dataclass, field
from types import MappingProxyType
from typing import Protocol, TypeAlias


class CallbackDeliverySettings(Protocol):
    @property
    def callback_max_attempts(self) -> int: ...

    @property
    def callback_initial_delay_seconds(self) -> float: ...

    @property
    def callback_max_delay_seconds(self) -> float: ...

    @property
    def callback_jitter_ratio(self) -> float: ...

    @property
    def callback_request_timeout_seconds(self) -> float: ...

    @property
    def callback_max_response_bytes(self) -> int: ...

    @property
    def allow_insecure_http(self) -> bool: ...

    @property
    def _normalized_callback_origins(
        self,
    ) -> Collection[tuple[str, str, int]]: ...


class CallbackLogger(Protocol):
    def debug(
        self, message: str, context: Mapping[str, object] | None = None
    ) -> object: ...

    def info(
        self, message: str, context: Mapping[str, object] | None = None
    ) -> object: ...

    def warning(
        self, message: str, context: Mapping[str, object] | None = None
    ) -> object: ...

    def error(
        self, message: str, context: Mapping[str, object] | None = None
    ) -> object: ...


class StopSignal(Protocol):
    def is_set(self) -> bool: ...

    async def wait(self) -> bool: ...


@dataclass(frozen=True, slots=True)
class CallbackDeliveryRequest:
    agent: str
    invocation_id: str
    run_id: str
    callback_url: str
    key_id: str
    secret: str = field(repr=False)
    result: object = field(repr=False)


@dataclass(frozen=True, slots=True)
class CallbackDeliveryOutcome:
    delivered: bool
    delivery_id: str
    attempts: int
    reason: str | None = None
    http_status: int | None = None


CallbackDeliveryFailedEvent: TypeAlias = Mapping[str, object]


def make_callback_delivery_failed_event(
    *,
    agent: str,
    invocation_id: str,
    run_id: str,
    delivery_id: str,
    attempts: int,
    callback_host: str,
    reason: str,
    http_status: int | None = None,
) -> CallbackDeliveryFailedEvent:
    event: dict[str, object] = {
        "agent": agent,
        "invocation_id": invocation_id,
        "run_id": run_id,
        "delivery_id": delivery_id,
        "attempts": attempts,
        "callback_host": callback_host,
        "reason": reason,
    }
    if http_status is not None:
        event["http_status"] = http_status
    return MappingProxyType(event)


class CallbackFailureHook(Protocol):
    def __call__(self, event: CallbackDeliveryFailedEvent, /) -> object: ...
