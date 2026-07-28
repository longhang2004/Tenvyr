from __future__ import annotations

import re
from typing import Literal

from .types import CallbackDeliverySettings

CallbackResponseClassification = Literal["delivered", "retry", "do-not-retry"]

_DELTA_SECONDS = re.compile(r"^[0-9]+$")


def classify_callback_response(status: int) -> CallbackResponseClassification:
    if 200 <= status <= 299:
        return "delivered"
    if status in (408, 429) or 500 <= status <= 599:
        return "retry"
    return "do-not-retry"


def retry_after_delay_seconds(
    value: str | None,
    *,
    status: int,
    maximum: float,
) -> float | None:
    if (
        classify_callback_response(status) != "retry"
        or value is None
        or _DELTA_SECONDS.fullmatch(value) is None
    ):
        return None
    return min(maximum, float(int(value)))


def backoff_delay_seconds(
    settings: CallbackDeliverySettings,
    *,
    attempt: int,
    random_value: float,
) -> float:
    initial = settings.callback_initial_delay_seconds
    maximum = settings.callback_max_delay_seconds
    jitter = settings.callback_jitter_ratio
    base = min(maximum, initial * (2.0 ** max(0, attempt - 1)))
    factor = 1 + ((random_value * 2) - 1) * jitter
    return float(max(0.0, min(maximum, base * factor)))
