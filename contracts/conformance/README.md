# HTTP Protocol Conformance

These language-neutral JSON fixtures define Tenvyr HTTP protocol v1 behavior for Worker
SDK implementations.

- Files under `valid/` must parse successfully.
- Files under `invalid/` must be rejected without modifying the payload.
- Every acceptance fixture is correlated against expected invocation ID
  `invocation-conformance-1`. `invocation-mismatch.json` is schema-valid but protocol-invalid.
- Callback signatures use UTF-8 bytes exactly as represented by `rawBodyUtf8`; implementations
  must not parse or reserialize before signing.
- Any callback `2xx` is delivered. Network errors, timeouts, `408`, `429`, and `5xx` retry.
  Redirects and other `4xx` do not retry.
- `protocol/retry-after-cases.json` accepts only ASCII delta-seconds (`^[0-9]+$`): invalid
  values use fallback backoff, while valid values use a header delay capped without unbounded
  integer conversion.
- `json-numbers/` contains complete protocol documents. Numbers must be finite; integral values
  must stay within `-9007199254740991` through `9007199254740991`, including integral-valued
  floats. Genuine finite non-integers remain valid, and booleans are not treated as integers.

All secrets are deterministic test values and must never be used outside conformance tests.
