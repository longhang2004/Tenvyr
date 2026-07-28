from __future__ import annotations

import json
from functools import lru_cache
from importlib import resources
from types import MappingProxyType
from typing import cast

from .json_value import JsonValue

SCHEMA_FILENAMES = (
    "agent-event.v1.schema.json",
    "agent-invocation.v1.schema.json",
    "agent-result.v1.schema.json",
    "http-agent-run-accepted.v1.schema.json",
    "http-agent-run-request.v1.schema.json",
)


def load_schema_bytes(filename: str) -> bytes:
    if filename not in SCHEMA_FILENAMES:
        raise ValueError("schema is not in the packaged allowlist")
    return (
        resources.files("tenvyr_worker")
        .joinpath("schema_json")
        .joinpath(filename)
        .read_bytes()
    )


@lru_cache(maxsize=1)
def load_schemas() -> MappingProxyType[str, dict[str, JsonValue]]:
    schemas: dict[str, dict[str, JsonValue]] = {}
    for filename in SCHEMA_FILENAMES:
        value = json.loads(
            load_schema_bytes(filename).decode("utf-8"),
            parse_constant=_reject_constant,
        )
        if not isinstance(value, dict):
            raise RuntimeError("packaged schema must be a JSON object")
        schema_id = value.get("$id")
        if not isinstance(schema_id, str) or not schema_id.startswith(
            "urn:tenvyr:schema:"
        ):
            raise RuntimeError("packaged schema has an invalid $id")
        if schema_id in schemas:
            raise RuntimeError("packaged schemas contain a duplicate $id")
        schemas[schema_id] = cast(dict[str, JsonValue], value)
    return MappingProxyType(schemas)


def _reject_constant(value: str) -> None:
    raise ValueError(f"non-finite JSON constant is not allowed: {value}")
