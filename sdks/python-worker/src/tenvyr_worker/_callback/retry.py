from __future__ import annotations

import math
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
    if classify_callback_response(status) != "retry":
        return None
    return _parse_retry_after_delta(value, maximum)


def _parse_retry_after_delta(value: str | None, maximum: float) -> float | None:
    """Parse ASCII delta-seconds without converting an unbounded integer."""

    if value is None or _DELTA_SECONDS.fullmatch(value) is None:
        return None

    digits = value.lstrip("0") or "0"
    maximum_digits = str(math.floor(maximum))
    if len(digits) > len(maximum_digits) or (
        len(digits) == len(maximum_digits) and digits > maximum_digits
    ):
        return maximum
    return min(maximum, float(int(digits)))


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
