from __future__ import annotations

import json
from collections.abc import Iterable, Iterator
from dataclasses import dataclass
from functools import cache, lru_cache
from typing import cast

from jsonschema import Draft202012Validator, FormatChecker
from jsonschema.exceptions import ValidationError
from referencing import Registry, Resource

from .json_value import JsonCompatibilityError, JsonValue, to_json_value
from .schemas import load_schemas


@dataclass(frozen=True)
class ValidationIssue:
    path: str
    message: str
    keyword: str


class ContractValidationError(ValueError):
    def __init__(self, issues: tuple[ValidationIssue, ...]) -> None:
        super().__init__("Contract validation failed")
        self.issues = issues


def loads_json(value: str | bytes | bytearray) -> JsonValue:
    return cast(JsonValue, json.loads(value, parse_constant=_reject_constant))


def parse_agent_invocation(value: object) -> dict[str, JsonValue]:
    return _parse("urn:tenvyr:schema:agent-invocation:v1", value)


def parse_agent_result(value: object) -> dict[str, JsonValue]:
    return _parse("urn:tenvyr:schema:agent-result:v1", value)


def parse_agent_event(value: object) -> dict[str, JsonValue]:
    return _parse("urn:tenvyr:schema:agent-event:v1", value)


def parse_http_agent_run_request(value: object) -> dict[str, JsonValue]:
    return _parse("urn:tenvyr:schema:http-agent-run-request:v1", value)


def parse_http_agent_run_accepted(
    value: object, *, expected_invocation_id: str | None = None
) -> dict[str, JsonValue]:
    parsed = _parse("urn:tenvyr:schema:http-agent-run-accepted:v1", value)
    if (
        expected_invocation_id is not None
        and parsed.get("invocationId") != expected_invocation_id
    ):
        raise ContractValidationError(
            (
                ValidationIssue(
                    path="$.invocationId",
                    message="invocationId does not match the expected invocation",
                    keyword="correlation",
                ),
            )
        )
    return parsed


def _parse(schema_id: str, value: object) -> dict[str, JsonValue]:
    try:
        converted = to_json_value(value)
    except JsonCompatibilityError as error:
        raise ContractValidationError(
            (ValidationIssue(error.path, error.message, error.keyword),)
        ) from None
    errors = sorted(_validator(schema_id).iter_errors(converted), key=_error_key)
    if errors:
        raise ContractValidationError(tuple(_issues(errors)))
    if not isinstance(converted, dict):
        raise ContractValidationError(
            (ValidationIssue("$", "value must be an object", "type"),)
        )
    return converted


@lru_cache(maxsize=1)
def _registry() -> Registry[dict[str, JsonValue]]:
    schemas = load_schemas()
    return Registry().with_resources(
        (schema_id, Resource.from_contents(schema))
        for schema_id, schema in schemas.items()
    )


@cache
def _validator(schema_id: str) -> Draft202012Validator:
    return Draft202012Validator(
        load_schemas()[schema_id],
        registry=_registry(),
        format_checker=FormatChecker(),
    )


def _issues(errors: list[ValidationError]) -> Iterator[ValidationIssue]:
    for error in errors:
        if (
            error.validator == "additionalProperties"
            and isinstance(error.instance, dict)
            and isinstance(error.schema, dict)
            and error.schema.get("additionalProperties") is False
        ):
            known = set(error.schema.get("properties", {}))
            for key in sorted(set(error.instance) - known):
                yield ValidationIssue(
                    _format_path((*error.absolute_path, key)),
                    "property is not allowed",
                    "additionalProperties",
                )
            continue
        yield ValidationIssue(
            _format_path(error.absolute_path),
            error.message,
            str(error.validator),
        )


def _format_path(parts: Iterable[object]) -> str:
    result = "$"
    for part in parts:
        if isinstance(part, int):
            result += f"[{part}]"
        elif isinstance(part, str) and part.isidentifier() and not part.startswith("_"):
            result += f".{part}"
        else:
            result += "[" + json.dumps(str(part), ensure_ascii=False) + "]"
    return result


def _error_key(error: ValidationError) -> tuple[str, str, str]:
    return _format_path(error.absolute_path), str(error.validator), error.message


def _reject_constant(value: str) -> None:
    raise ValueError(f"non-finite JSON constant is not allowed: {value}")
