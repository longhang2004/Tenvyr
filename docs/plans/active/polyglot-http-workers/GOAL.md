---
title: "Goal: Polyglot HTTP workers (Java, C++) and truthful Rust host"
status: planned
audience:
  - developer
  - product
last_verified: 2026-09-15
sources:
  - docs/architecture/transports/http-agent-adapter-v1.md
  - docs/architecture/workers/python-worker-sdk.md
  - docs/architecture/executors/local-executor-host.md
  - contracts/conformance/callback-signatures/vectors.json
---

# Goal — Polyglot HTTP workers

Slice documents: [PLAN](PLAN.md) · [SPEC](SPEC.md) · [VERIFY](VERIFY.md) · [IMPLEMENTATION REPORT](IMPLEMENTATION_REPORT.md)

Portfolio claim: Tenvyr stays a **language-neutral control plane**. Java,
Rust, and C++ sit on the **worker / executor boundary**. TypeScript
Orchestrator and Gateway stay the authority.

## Slices

1. **Java HTTP Worker SDK** (`sdks/java-worker`): same wire as
   `@tenvyr/worker` / `tenvyr-worker` — `POST /v1/runs` → 202 → signed
   `AgentResultV1` callback. Mock tests (HMAC vectors + in-process
   callback server). No Spring. No Orchestrator rewrite.
2. **C++ HTTP worker** (`sdks/cpp-worker`): same three routes, HMAC,
   safe-integer JSON, mock tests. HTTP/1.1 Content-Length subset.
3. **Rust host remains opt-in.** Fix persisted `kill_at` to match the
   TypeScript host (`now + wallTimeMs`). Do not flip `pnpm dev` default.
   Put `cargo test` on CI.
4. **Docs + identity + ledger.** Parity matrix, current worker docs,
   protocol-v1 HMAC identity constants, implementation-status.

## Non-goals

No Orchestrator/Gateway rewrite. No removing TypeScript from backend.
No AgentEvents in Java/C++ (terminal result is enough). No Landlock.
No making Rust the default host. No Kafka changes. No `X-Tenvyr-*`
HMAC header aliases.
