from __future__ import annotations

import copy
import json
import math
import subprocess
import sys
from importlib import resources
from pathlib import Path

import pytest

from tenvyr_worker._protocol.json_value import to_json_value
from tenvyr_worker._protocol.schemas import (
    SCHEMA_FILENAMES,
    load_schema_bytes,
    load_schemas,
)
from tenvyr_worker._protocol.validation import (
    ContractValidationError,
    loads_json,
    parse_agent_event,
    parse_agent_result,
    parse_http_agent_run_accepted,
    parse_http_agent_run_request,
)

REPO_ROOT = Path(__file__).resolve().parents[3]
CANONICAL_SCHEMAS = REPO_ROOT / "contracts" / "schemas"
CONFORMANCE = REPO_ROOT / "contracts" / "conformance"
SYNC_SCRIPT = REPO_ROOT / "scripts" / "sync-python-worker-schemas.py"

EXPECTED_SCHEMAS = (
    "agent-event.v1.schema.json",
    "agent-invocation.v1.schema.json",
    "agent-result.v1.schema.json",
    "http-agent-run-accepted.v1.schema.json",
    "http-agent-run-request.v1.schema.json",
)

pytestmark = pytest.mark.conformance


def _fixture(path: str) -> object:
    return json.loads((CONFORMANCE / path).read_text(encoding="utf-8"))


def _fixture_bytes(path: str) -> bytes:
    return (CONFORMANCE / path).read_bytes()


def test_packaged_schema_allowlist_is_exact_and_byte_equal() -> None:
    assert SCHEMA_FILENAMES == EXPECTED_SCHEMAS
    packaged = resources.files("tenvyr_worker").joinpath("schema_json")
    assert sorted(
        item.name for item in packaged.iterdir() if item.name.endswith(".json")
    ) == list(EXPECTED_SCHEMAS)
    for filename in EXPECTED_SCHEMAS:
        expected = (CANONICAL_SCHEMAS / filename).read_bytes()
        assert load_schema_bytes(filename) == expected
        assert packaged.joinpath(filename).read_bytes() == expected


def test_all_schemas_have_tenvyr_urn_ids() -> None:
    schemas = load_schemas()
    assert len(schemas) == 5
    assert set(schemas) == {
        "urn:tenvyr:schema:agent-event:v1",
        "urn:tenvyr:schema:agent-invocation:v1",
        "urn:tenvyr:schema:agent-result:v1",
        "urn:tenvyr:schema:http-agent-run-accepted:v1",
        "urn:tenvyr:schema:http-agent-run-request:v1",
    }


def test_schema_sync_check_is_non_mutating() -> None:
    packaged = resources.files("tenvyr_worker").joinpath("schema_json")
    before = {
        filename: packaged.joinpath(filename).read_bytes()
        for filename in EXPECTED_SCHEMAS
    }
    completed = subprocess.run(
        [sys.executable, str(SYNC_SCRIPT), "check"],
        cwd=REPO_ROOT,
        check=False,
        capture_output=True,
        text=True,
    )
    assert completed.returncode == 0, completed.stdout + completed.stderr
    assert "5/5" in completed.stdout
    assert before == {
        filename: packaged.joinpath(filename).read_bytes()
        for filename in EXPECTED_SCHEMAS
    }


@pytest.mark.parametrize(
    "path",
    (
        "run-request/valid/minimal.json",
        "run-request/valid/full.json",
    ),
)
def test_shared_valid_run_requests(path: str) -> None:
    value = _fixture(path)
    assert parse_http_agent_run_request(value) == value


@pytest.mark.parametrize(
    "path",
    (
        "run-request/invalid/callback-secret-leak.json",
        "run-request/invalid/invalid-callback-url.json",
        "run-request/invalid/missing-invocation.json",
        "run-request/invalid/unsupported-delivery-mode.json",
    ),
)
def test_shared_invalid_run_requests(path: str) -> None:
    with pytest.raises(ContractValidationError):
        parse_http_agent_run_request(_fixture(path))


def test_shared_valid_acceptance() -> None:
    value = _fixture("run-accepted/valid/accepted.json")
    assert (
        parse_http_agent_run_accepted(
            value, expected_invocation_id="invocation-conformance-1"
        )
        == value
    )


@pytest.mark.parametrize(
    "path",
    (
        "run-accepted/invalid/invalid-timestamp.json",
        "run-accepted/invalid/invocation-mismatch.json",
        "run-accepted/invalid/missing-run-id.json",
    ),
)
def test_shared_invalid_acceptances(path: str) -> None:
    with pytest.raises(ContractValidationError):
        parse_http_agent_run_accepted(
            _fixture(path), expected_invocation_id="invocation-conformance-1"
        )


@pytest.mark.parametrize(
    "path",
    (
        "results/valid/cancelled.json",
        "results/valid/failed.json",
        "results/valid/succeeded.json",
        "results/valid/timed-out.json",
    ),
)
def test_shared_valid_results(path: str) -> None:
    value = _fixture(path)
    assert parse_agent_result(value) == value


@pytest.mark.parametrize(
    "path",
    (
        "results/invalid/failed-without-error.json",
        "results/invalid/negative-usage.json",
        "results/invalid/succeeded-with-error.json",
    ),
)
def test_shared_invalid_results(path: str) -> None:
    with pytest.raises(ContractValidationError):
        parse_agent_result(_fixture(path))


def _valid_event(**overrides: object) -> dict[str, object]:
    event: dict[str, object] = {
        "schemaVersion": "1",
        "eventId": "event-1",
        "invocationId": "invocation-1",
        "executionId": "execution-1",
        "stepExecutionId": "step-execution-1",
        "sequence": 0,
        "type": "progress",
        "occurredAt": "2026-07-26T00:00:00.000Z",
        "payload": {"stage": "indexing"},
        "trace": {"traceId": "trace-1", "correlationId": "invocation-1"},
    }
    event.update(overrides)
    return event


def test_event_id_and_sequence_storage_safe_boundaries() -> None:
    """Contract/storage parity: maxima persist, out-of-range values reject."""
    parsed = parse_agent_event(_valid_event(eventId="e" * 255, sequence=2147483647))
    assert parsed["eventId"] == "e" * 255
    assert parsed["sequence"] == 2147483647
    with pytest.raises(ContractValidationError):
        parse_agent_event(_valid_event(eventId="e" * 256))
    with pytest.raises(ContractValidationError):
        parse_agent_event(_valid_event(sequence=2147483648))


def test_validation_reports_special_key_paths_without_mutation() -> None:
    value = _fixture("run-request/valid/minimal.json")
    assert isinstance(value, dict)
    value["__proto__"] = {"constructor": "prototype"}
    before = copy.deepcopy(value)

    with pytest.raises(ContractValidationError) as caught:
        parse_http_agent_run_request(value)

    assert value == before
    issue = caught.value.issues[0]
    assert issue.path == '$["__proto__"]'
    assert issue.message
    assert issue.keyword == "additionalProperties"


@pytest.mark.parametrize("constant", ("NaN", "Infinity", "-Infinity"))
def test_json_loading_rejects_non_finite_constants(constant: str) -> None:
    with pytest.raises(ValueError, match="non-finite"):
        loads_json('{"value":' + constant + "}")


@pytest.mark.parametrize("value", (math.nan, math.inf, -math.inf))
def test_json_value_rejects_non_finite_numbers(value: float) -> None:
    with pytest.raises(TypeError, match="finite"):
        to_json_value(value)


def test_json_value_preserves_booleans_and_safe_integer_boundaries() -> None:
    value = {
        "boolean": True,
        "maximum": 9_007_199_254_740_991,
        "minimum": -9_007_199_254_740_991,
        "fractions": [1.25, -0.5, 1e-7],
    }

    assert to_json_value(value) == value
    assert type(to_json_value(value)["boolean"]) is bool  # type: ignore[index]


@pytest.mark.parametrize(
    "value",
    (9_007_199_254_740_992, -9_007_199_254_740_992),
)
def test_json_value_rejects_unsafe_integers_recursively(value: int) -> None:
    with pytest.raises(
        TypeError, match=r"\$\.outer\[0\]\.unsafe.*interoperable safe range"
    ):
        to_json_value({"outer": [{"unsafe": value}]})


@pytest.mark.parametrize(
    "value",
    (9_007_199_254_740_992.0, -9_007_199_254_740_992.0),
)
def test_json_value_rejects_unsafe_integral_floats(value: float) -> None:
    with pytest.raises(
        TypeError, match=r"\$\.outer\[0\]\.unsafe.*interoperable safe range"
    ):
        to_json_value({"outer": [{"unsafe": value}]})


def test_json_loading_is_syntax_only_for_unsafe_integer_literals() -> None:
    assert loads_json(b'{"value":9007199254740992}') == {"value": 9_007_199_254_740_992}


@pytest.mark.parametrize(
    "path",
    (
        "json-numbers/valid/safe-integer-boundaries.json",
        "json-numbers/valid/finite-floats.json",
        "json-numbers/valid/booleans.json",
    ),
)
def test_shared_valid_json_number_documents(path: str) -> None:
    parsed = loads_json(_fixture_bytes(path))
    assert parse_http_agent_run_request(parsed) == parsed


@pytest.mark.parametrize(
    ("path", "parser"),
    (
        (
            "json-numbers/invalid/integer-above-safe-max.json",
            parse_http_agent_run_request,
        ),
        (
            "json-numbers/invalid/integer-below-safe-min.json",
            parse_http_agent_run_request,
        ),
        (
            "json-numbers/invalid/nested-unsafe-integer.json",
            parse_http_agent_run_request,
        ),
        (
            "json-numbers/invalid/unsafe-integer-in-output.json",
            parse_agent_result,
        ),
        (
            "json-numbers/invalid/unsafe-integer-in-metadata.json",
            parse_agent_result,
        ),
    ),
)
def test_shared_invalid_json_number_documents(path: str, parser: object) -> None:
    parsed = loads_json(_fixture_bytes(path))
    with pytest.raises(ContractValidationError) as caught:
        parser(parsed)  # type: ignore[operator]

    issue = caught.value.issues[0]
    assert issue.path.startswith("$")
    assert issue.message == "integer must be within the interoperable safe range"
    assert issue.keyword == "safeInteger"


@pytest.mark.parametrize(
    "value",
    (
        b"bytes",
        ("tuple",),
        {"set"},
        object(),
        {1: "non-string-key"},
    ),
)
def test_json_value_rejects_non_json_types(value: object) -> None:
    with pytest.raises(TypeError):
        to_json_value(value)


def test_json_value_preserves_special_keys_and_copies_without_mutation() -> None:
    value = {
        "__proto__": {"constructor": ["prototype"]},
        "ordinary": 1,
    }
    converted = to_json_value(value)

    assert converted == value
    assert converted is not value
    assert isinstance(converted, dict)
    assert converted["__proto__"] is not value["__proto__"]


def test_json_value_rejects_cycles() -> None:
    value: list[object] = []
    value.append(value)
    with pytest.raises(TypeError, match="circular"):
        to_json_value(value)
