from __future__ import annotations

import math
from typing import TypeAlias, cast

JsonPrimitive: TypeAlias = bool | int | float | str | None
JsonValue: TypeAlias = JsonPrimitive | list["JsonValue"] | dict[str, "JsonValue"]


def to_json_value(
    value: object, *, _path: str = "$", _seen: set[int] | None = None
) -> JsonValue:
    if value is None or isinstance(value, (str, bool)):
        return value
    if type(value) in (int, float):
        number = cast(int | float, value)
        if isinstance(number, float) and not math.isfinite(number):
            raise TypeError(f"{_path} must be a finite JSON number")
        return number
    if type(value) not in (list, dict):
        raise TypeError(f"{_path} is not JSON-compatible")

    seen = _seen if _seen is not None else set()
    identity = id(value)
    if identity in seen:
        raise TypeError(f"{_path} contains a circular reference")
    seen.add(identity)
    try:
        if isinstance(value, list):
            return [
                to_json_value(item, _path=f"{_path}[{index}]", _seen=seen)
                for index, item in enumerate(value)
            ]
        mapping = cast(dict[object, object], value)
        converted: dict[str, JsonValue] = {}
        for key, item in mapping.items():
            if not isinstance(key, str):
                raise TypeError(f"{_path} must contain only string object keys")
            converted[key] = to_json_value(
                item, _path=_child_path(_path, key), _seen=seen
            )
        return converted
    finally:
        seen.remove(identity)


def _child_path(parent: str, key: str) -> str:
    return f"{parent}.{key}" if key.isidentifier() else f"{parent}[{key!r}]"
