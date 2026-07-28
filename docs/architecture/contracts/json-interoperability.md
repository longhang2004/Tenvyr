---
title: JSON Interoperability
status: current
audience:
  - developer
last_verified: 2026-07-28
sources:
  - packages/contracts/src/validation.ts
  - packages/contracts/test/json-numbers.spec.ts
  - packages/worker/src/execution/json-value.ts
  - packages/worker/src/invocation/canonical-json.ts
  - packages/worker/test/execution.spec.ts
  - sdks/python-worker/src/tenvyr_worker/_protocol/json_value.py
  - sdks/python-worker/src/tenvyr_worker/_runtime/canonical_json.py
  - sdks/python-worker/tests/test_schema_protocol.py
  - sdks/python-worker/tests/test_canonical_json.py
  - contracts/conformance/json-numbers
---

# JSON Interoperability

Protocol v1 applies a semantic numeric policy in addition to JSON Schema. It
does not change payload fields or `schemaVersion`.

## Integers

Every integer crossing a Tenvyr protocol boundary must be between:

```text
-9,007,199,254,740,991
 9,007,199,254,740,991
```

These are JavaScript's `Number.MIN_SAFE_INTEGER` and
`Number.MAX_SAFE_INTEGER`. TypeScript rejects values for which
`Number.isInteger(value) && !Number.isSafeInteger(value)`. Python rejects `int`
outside the range and rejects integral-valued `float` outside the same range.
Python `bool` remains a boolean even though it subclasses `int`.

The validation is recursive. It covers invocation input and metadata, result
output, failure details, usage, artifact metadata, events, parser output,
generated callback bodies, and local idempotency fingerprints. Values are not
clamped, stringified, or mutated.

## Floating-point values

- JSON numbers must be finite; `NaN`, `Infinity`, and `-Infinity` are invalid.
- Genuine finite non-integer values are allowed.
- Exact decimal equality across languages is not guaranteed.
- Large identifiers must be strings.
- Exact financial or decimal quantities should be decimal strings.
- Approximate measurements may use finite JSON numbers.

## Boundary behavior

An unsafe inbound Worker request returns `400 INVALID_REQUEST` before
fingerprinting, reservation, queue capacity, or `202` acceptance. A later safe
request may reuse the same invocation ID. An unsafe agent result source is
converted to a failed result with `AGENT_OUTPUT_INVALID`, a static message, and
`retryable: false`; unsafe failure details are not copied into the callback.

The TypeScript and Python SDKs may serialize safe values differently for their
process-local fingerprints. Their required observable behavior is the same:
unsafe integral numbers are rejected before acceptance or callback delivery.

## Executable fixtures

The exact-byte fixtures under
[`contracts/conformance/json-numbers`](../../../contracts/conformance/json-numbers)
include safe boundaries, finite fractions, booleans, nested unsafe integers,
and unsafe result output/metadata. Unsafe cases are stored as literal JSON
bytes so JavaScript does not round them before the parser is exercised.
