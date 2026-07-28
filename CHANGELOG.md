# Changelog

## [0.1.0] - Release candidate

### Added

- Versioned agent invocation/result contracts and Kafka/HTTP execution paths.
- Hardened TypeScript and Python Worker SDKs with cross-language conformance.
- Provider-selectable Java Agent Runner for mock, OpenAI, Anthropic, and Ollama.

### Changed

- Organized current, planned, and historical documentation by lifecycle.
- Made provider failure behavior explicit with `LLM_FAILURE_MODE=fail|mock`.

### Fixed

- Hardened JSON-number validation, retry timing, callbacks, and result
  correlation across TypeScript and Python runtimes.
- Replaced interactive frontend lint setup with deterministic ESLint CLI use.

### Security

- HMAC-authenticated HTTP callbacks include timestamp, delivery ID, replay
  checks, exact-origin validation, and bounded request/response handling.
- Dashboard previews recursively redact sensitive keys and cap output length.

### Showcase

- Added an offline Docker Compose golden path with setup, seed, smoke, and
  scoped shutdown commands.
- Added deterministic success and retry-once executions across a Python Worker
  and Java-backed quality gate.

### Known limitations

- Worker queue, idempotency, callback, and replay state are process-local; no
  crash durability or multi-process coordination is provided.
- Cancellation is cooperative. Provider calls remain application/runtime
  responsibilities, and Java Runner token usage may be estimated.
- Compatibility protocol identifiers remain. Packages are MIT-licensed but
  private and unpublished.

### Not included

- No model router, provider registry, fallback chain, policy engine, artifact
  store, durable outbox, OpenTelemetry integration, protocol v2, or framework
  adapter suite.
- No npm or PyPI publication.
