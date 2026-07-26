# HTTP Protocol Conformance

These language-neutral JSON fixtures define AgentWeave HTTP protocol v1 behavior for Worker
SDK implementations.

- Files under `valid/` must parse successfully.
- Files under `invalid/` must be rejected without modifying the payload.
- Every acceptance fixture is correlated against expected invocation ID
  `invocation-conformance-1`. `invocation-mismatch.json` is schema-valid but protocol-invalid.
- Callback signatures use UTF-8 bytes exactly as represented by `rawBodyUtf8`; implementations
  must not parse or reserialize before signing.
- Any callback `2xx` is delivered. Network errors, timeouts, `408`, `429`, and `5xx` retry.
  Redirects and other `4xx` do not retry.

All secrets are deterministic test values and must never be used outside conformance tests.
