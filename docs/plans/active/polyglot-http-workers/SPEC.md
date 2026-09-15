---
title: "SPEC: Polyglot HTTP workers"
status: planned
audience:
  - developer
last_verified: 2026-09-15
sources:
  - docs/architecture/transports/http-agent-adapter-v1.md
  - packages/worker/src/callback/callback-signer.ts
  - sdks/python-worker/src/tenvyr_worker/_callback/signer.py
  - services/local-executor-host-rs/src/protocol.rs
  - contracts/schemas/http-agent-run-request.v1.schema.json
  - contracts/schemas/agent-result.v1.schema.json
  - contracts/conformance/callback-signatures/vectors.json
---

# SPEC — wire contract (copy, do not invent)

## HMAC (byte-identical to TS/Python/Rust)

```text
signedBytes = timestamp + "." + deliveryId + "." + rawBody
header      = "v1=" + hex(HMAC-SHA256(secret, signedBytes))
```

Headers (protocol-v1 names, required identity constants):

- `X-AgentWeave-Key-Id`
- `X-AgentWeave-Timestamp`
- `X-AgentWeave-Delivery-Id`
- `X-AgentWeave-Signature`

Sign the **exact UTF-8 bytes** transmitted. Do not re-serialize. Stable
delivery ID across retries; fresh timestamp/signature per attempt.

Conformance: all 8 vectors in
`contracts/conformance/callback-signatures/vectors.json`.

## HTTP Worker surface

| Method | Path | Success |
|--------|------|---------|
| POST | `/v1/runs` | 202 + `HttpAgentRunAcceptedV1` |
| GET | `/health/live` | 200 `{"status":"ok"}` |
| GET | `/health/ready` | 200 or 503 |

No other routes. Submit never returns a terminal result.

Inbound: `Authorization: Bearer`, `Content-Type: application/json`,
`Idempotency-Key` equals `invocation.invocationId`. Callback origin
allowlist; HTTPS unless insecure HTTP is explicit.

## JSON

Integers at every protocol boundary stay inside
±9,007,199,254,740,991. Finite numbers only. See
[JSON interoperability](../../architecture/contracts/json-interoperability.md).

## Java SDK

- Package `com.tenvyr.worker`, artifact `tenvyr-worker`, JDK 17.
- Dependencies: Jackson Databind + JUnit 5 (test). JDK `HttpServer`.
- Public surface: `TenvyrWorker`, `WorkerConfig`, `Hmac`.
- Process-local idempotency and queue. Events: not implemented.

## C++ worker

- C++17, OpenSSL HMAC, POSIX sockets, HTTP/1.1 with `Content-Length`.
- No chunked encoding (`ponytail:` ceiling; upgrade to a real HTTP
  library if operators need it).
- Events: not implemented.

## Rust host

- `TENVYR_EXECUTOR_HOST=rust` stays the only way to select it.
- Persisted `RunState.kill_at` is `startedAt + wallTimeMs` (TypeScript
  host contract), not "now".
- AgentEvents remain absent (documented limitation).
