from __future__ import annotations

import math
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from types import MappingProxyType
from typing import Generic, TypeVar, cast

from .._http.callback_policy import (
    NormalizedOrigin,
    canonical_origin,
    normalize_callback_origin,
)
from .agent import AgentDefinition
from .types import WorkerLogger

InputT = TypeVar("InputT")
OutputT = TypeVar("OutputT")
CallbackFailureHook = Callable[[Mapping[str, object]], object]


@dataclass(frozen=True)
class TenvyrWorkerConfig(Generic[InputT, OutputT]):
    agent: AgentDefinition[InputT, OutputT]
    bearer_token: str = field(repr=False)
    callback_keys: Mapping[str, str] = field(repr=False)
    allowed_callback_origins: Sequence[str]

    allow_insecure_http: bool = False
    callback_max_response_bytes: int = 64 * 1024

    execution_timeout_seconds: float = 15 * 60
    execution_concurrency: int = 4
    max_queued_runs: int = 100

    idempotency_ttl_seconds: float = 24 * 60 * 60
    idempotency_max_entries: int = 10_000

    callback_max_attempts: int = 8
    callback_initial_delay_seconds: float = 0.5
    callback_max_delay_seconds: float = 30
    callback_jitter_ratio: float = 0.2
    callback_request_timeout_seconds: float = 10

    events_enabled: bool = False
    event_heartbeat_interval_seconds: float = 60.0

    max_request_bytes: int = 1024 * 1024
    shutdown_grace_seconds: float = 30

    logger: WorkerLogger | None = field(default=None, repr=False)
    on_callback_delivery_failed: CallbackFailureHook | None = field(
        default=None, repr=False
    )
    _normalized_callback_origins: tuple[NormalizedOrigin, ...] = field(
        init=False, repr=False, compare=False
    )

    def __post_init__(self) -> None:
        if not isinstance(self.agent, AgentDefinition):
            raise _invalid("agent must be an AgentDefinition")
        _non_empty(self.bearer_token, "bearer token")
        if type(self.allow_insecure_http) is not bool:
            raise _invalid("allow_insecure_http must be boolean")

        if not isinstance(self.callback_keys, Mapping) or not self.callback_keys:
            raise _invalid("at least one callback key is required")
        copied_keys: dict[str, str] = {}
        for key_id, secret in self.callback_keys.items():
            copied_keys[_non_empty(key_id, "callback key ID")] = _non_empty(
                secret, "callback secret"
            )
        object.__setattr__(self, "callback_keys", MappingProxyType(copied_keys))

        if isinstance(self.allowed_callback_origins, (str, bytes)) or not isinstance(
            self.allowed_callback_origins, Sequence
        ):
            raise _invalid("allowed callback origins must be a sequence")
        if not self.allowed_callback_origins:
            raise _invalid("at least one callback origin is required")
        try:
            normalized = tuple(
                normalize_callback_origin(origin, self.allow_insecure_http)
                for origin in self.allowed_callback_origins
            )
        except (TypeError, ValueError) as error:
            raise _invalid(str(error)) from None
        object.__setattr__(
            self,
            "allowed_callback_origins",
            tuple(canonical_origin(origin) for origin in normalized),
        )
        object.__setattr__(self, "_normalized_callback_origins", normalized)

        _positive_int(self.callback_max_response_bytes, "callback response-size limit")
        _positive_duration(self.execution_timeout_seconds, "execution timeout")
        _positive_int(self.execution_concurrency, "execution concurrency")
        _non_negative_int(self.max_queued_runs, "execution queue capacity")
        _positive_duration(self.idempotency_ttl_seconds, "idempotency TTL")
        _positive_int(self.idempotency_max_entries, "idempotency capacity")
        _positive_int(self.callback_max_attempts, "callback attempts")
        _positive_duration(
            self.callback_initial_delay_seconds, "callback initial delay"
        )
        _positive_duration(self.callback_max_delay_seconds, "callback maximum delay")
        _ratio(self.callback_jitter_ratio, "callback jitter ratio")
        _positive_duration(
            self.callback_request_timeout_seconds, "callback request timeout"
        )
        if type(self.events_enabled) is not bool:
            raise _invalid("events_enabled must be boolean")
        _bounded_duration(
            self.event_heartbeat_interval_seconds,
            "event heartbeat interval",
            minimum=1.0,
            maximum=3600.0,
        )
        _positive_int(self.max_request_bytes, "request-size limit")
        _positive_duration(self.shutdown_grace_seconds, "shutdown grace period")
        if self.callback_initial_delay_seconds > self.callback_max_delay_seconds:
            raise _invalid("callback initial delay must not exceed maximum delay")

        if self.logger is not None and any(
            not callable(getattr(self.logger, level, None))
            for level in ("debug", "info", "warning", "error")
        ):
            raise _invalid("logger must implement debug, info, warning, and error")
        if self.on_callback_delivery_failed is not None and not callable(
            self.on_callback_delivery_failed
        ):
            raise _invalid("callback delivery failure hook must be callable")


def _non_empty(value: object, field_name: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise _invalid(f"{field_name} must be a non-empty string")
    return value


def _positive_duration(value: object, field_name: str) -> None:
    if type(value) not in (int, float):
        raise _invalid(f"{field_name} must be positive finite seconds")
    number = cast(int | float, value)
    if not math.isfinite(number) or number <= 0:
        raise _invalid(f"{field_name} must be positive finite seconds")


def _positive_int(value: object, field_name: str) -> None:
    if type(value) is not int or value <= 0:
        raise _invalid(f"{field_name} must be a positive integer")


def _non_negative_int(value: object, field_name: str) -> None:
    if type(value) is not int or value < 0:
        raise _invalid(f"{field_name} must be a non-negative integer")


def _ratio(value: object, field_name: str) -> None:
    if type(value) not in (int, float):
        raise _invalid(f"{field_name} must be between 0 and 1")
    number = cast(int | float, value)
    if not math.isfinite(number) or number < 0 or number > 1:
        raise _invalid(f"{field_name} must be between 0 and 1")


def _bounded_duration(
    value: object, field_name: str, *, minimum: float, maximum: float
) -> None:
    if type(value) not in (int, float):
        raise _invalid(
            f"{field_name} must be between {minimum:g} and {maximum:g} seconds"
        )
    number = cast(int | float, value)
    if not math.isfinite(number) or number < minimum or number > maximum:
        raise _invalid(
            f"{field_name} must be between {minimum:g} and {maximum:g} seconds"
        )


def _invalid(message: str) -> ValueError:
    return ValueError(f"Invalid Tenvyr Worker configuration: {message}")
