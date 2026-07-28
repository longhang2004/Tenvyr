from __future__ import annotations

import math
from typing import TypeAlias, cast

JsonPrimitive: TypeAlias = bool | int | float | str | None
JsonValue: TypeAlias = JsonPrimitive | list["JsonValue"] | dict[str, "JsonValue"]
MAX_SAFE_INTEGER = 9_007_199_254_740_991


class JsonCompatibilityError(TypeError):
    def __init__(self, path: str, message: str, keyword: str) -> None:
        super().__init__(f"{path} {message}")
        self.path = path
        self.message = message
        self.keyword = keyword


def to_json_value(
    value: object, *, _path: str = "$", _seen: set[int] | None = None
) -> JsonValue:
    if value is None or isinstance(value, (str, bool)):
        return value
    if type(value) in (int, float):
        number = cast(int | float, value)
        if isinstance(number, int) and abs(number) > MAX_SAFE_INTEGER:
            raise JsonCompatibilityError(
                _path,
                "integer must be within the interoperable safe range",
                "safeInteger",
            )
        if isinstance(number, float) and not math.isfinite(number):
            raise JsonCompatibilityError(
                _path, "must be a finite JSON number", "finiteNumber"
            )
        if (
            isinstance(number, float)
            and number.is_integer()
            and abs(number) > MAX_SAFE_INTEGER
        ):
            raise JsonCompatibilityError(
                _path,
                "integer must be within the interoperable safe range",
                "safeInteger",
            )
        return number
    if type(value) not in (list, dict):
        raise JsonCompatibilityError(_path, "is not JSON-compatible", "type")

    seen = _seen if _seen is not None else set()
    identity = id(value)
    if identity in seen:
        raise JsonCompatibilityError(_path, "contains a circular reference", "acyclic")
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
                raise JsonCompatibilityError(
                    _path, "must contain only string object keys", "objectKey"
                )
            converted[key] = to_json_value(
                item, _path=_child_path(_path, key), _seen=seen
            )
        return converted
    finally:
        seen.remove(identity)


def _child_path(parent: str, key: str) -> str:
    return f"{parent}.{key}" if key.isidentifier() else f"{parent}[{key!r}]"
