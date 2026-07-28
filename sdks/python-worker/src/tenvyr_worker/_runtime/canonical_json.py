"""Canonical JSON used only for process-local idempotency fingerprints."""

from __future__ import annotations

import hashlib
import json
import math
from collections.abc import Callable, Mapping
from typing import TypeAlias

_JsonValue: TypeAlias = (
    bool | int | float | str | list["_JsonValue"] | dict[str, "_JsonValue"] | None
)


def canonical_json(value: object) -> str:
    """Return compact, recursively key-sorted JSON without mutating *value*."""

    normalized = _normalize(value, set())
    return json.dumps(
        normalized,
        ensure_ascii=False,
        allow_nan=False,
        separators=(",", ":"),
        sort_keys=True,
    )


def request_fingerprint(request: object, idempotency_key: str) -> bytes:
    """Hash the idempotency key and canonical request into a local binary key."""

    digest = hashlib.sha256()
    digest.update(idempotency_key.encode("utf-8"))
    digest.update(b"\n")
    digest.update(canonical_json(request).encode("utf-8"))
    return digest.digest()


def _normalize(value: object, ancestors: set[int]) -> _JsonValue:
    if value is None or isinstance(value, (bool, str)):
        return value
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        if not math.isfinite(value):
            raise TypeError("Canonical JSON requires finite numbers")
        # Match JSON's mathematical value for negative zero and avoid a
        # fingerprint split.
        return 0 if value == 0 else value
    if isinstance(value, list):
        return _normalize_container(
            value, ancestors, lambda: [_normalize(item, ancestors) for item in value]
        )
    if isinstance(value, Mapping):
        if not all(isinstance(key, str) for key in value):
            raise TypeError(
                "Canonical JSON requires JSON-compatible string object keys"
            )
        return _normalize_container(
            value,
            ancestors,
            lambda: {key: _normalize(item, ancestors) for key, item in value.items()},
        )
    raise TypeError("Canonical JSON requires JSON-compatible values")


def _normalize_container(
    value: object,
    ancestors: set[int],
    build: Callable[[], _JsonValue],
) -> _JsonValue:
    identity = id(value)
    if identity in ancestors:
        raise TypeError("Canonical JSON requires JSON-compatible acyclic values")
    ancestors.add(identity)
    try:
        # ``build`` is kept as a zero-argument callable to add/remove the ancestor
        # around recursive traversal without copying a container twice.
        return build()
    finally:
        ancestors.remove(identity)
