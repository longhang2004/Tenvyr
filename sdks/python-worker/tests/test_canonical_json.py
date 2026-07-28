from __future__ import annotations

import math

import pytest

from tenvyr_worker._runtime.canonical_json import canonical_json, request_fingerprint


def test_canonical_json_sorts_recursively_and_preserves_arrays() -> None:
    value = {"z": [{"b": 2, "a": 1}], "a": True, "unicode": "Xin chào 🌏"}

    assert canonical_json(value) == (
        '{"a":true,"unicode":"Xin chào 🌏","z":[{"a":1,"b":2}]}'
    )


def test_canonical_json_does_not_mutate_input_or_special_keys() -> None:
    value = {
        "nested": {"__proto__": {"safe": True}, "constructor": {}, "prototype": []},
        "items": [{"b": 2, "a": 1}],
    }
    before = repr(value)

    encoded = canonical_json(value)

    assert repr(value) == before
    assert '"__proto__":{"safe":true}' in encoded
    assert list(value["nested"]) == ["__proto__", "constructor", "prototype"]


@pytest.mark.parametrize("value", [math.nan, math.inf, -math.inf])
def test_canonical_json_rejects_non_finite_numbers(value: float) -> None:
    with pytest.raises(TypeError, match="finite"):
        canonical_json({"value": value})


@pytest.mark.parametrize(
    "value",
    [object(), (1, 2), {1: "not-a-string-key"}, {"nested": {1, 2}}],
)
def test_canonical_json_rejects_non_json_values(value: object) -> None:
    with pytest.raises(TypeError, match="JSON-compatible"):
        canonical_json(value)


def test_request_fingerprint_is_order_independent_and_bytes() -> None:
    first = {"input": {"b": 2, "a": 1}, "callback": "https://example.test/a"}
    second = {"callback": "https://example.test/a", "input": {"a": 1, "b": 2}}

    baseline = request_fingerprint(first, "invocation-1")

    assert isinstance(baseline, bytes)
    assert len(baseline) == 32
    assert request_fingerprint(second, "invocation-1") == baseline
    assert request_fingerprint(second, "different") != baseline


@pytest.mark.parametrize(
    "value",
    (
        9_007_199_254_740_992,
        -9_007_199_254_740_992,
        9_007_199_254_740_992.0,
        -9_007_199_254_740_992.0,
    ),
)
def test_fingerprint_rejects_unsafe_integral_numbers(value: int | float) -> None:
    with pytest.raises(TypeError, match="safe integer"):
        request_fingerprint({"nested": {"value": value}}, "invocation-1")
