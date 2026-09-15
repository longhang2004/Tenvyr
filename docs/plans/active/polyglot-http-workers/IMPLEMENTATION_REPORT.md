---
title: "IMPLEMENTATION REPORT: Polyglot HTTP workers"
status: planned
audience:
  - developer
  - product
last_verified: 2026-09-15
sources:
  - docs/plans/active/polyglot-http-workers/VERIFY.md
  - sdks/java-worker/src/main/java/com/tenvyr/worker
  - sdks/cpp-worker/src
  - services/local-executor-host-rs/src/host.rs
---

# Implementation report — polyglot HTTP workers

Provisional implementer report. Not independent closure.

## Implemented

- Java Worker SDK (`sdks/java-worker`) with HMAC vectors, mock protocol tests, bundled schemas.
- C++ HTTP worker (`sdks/cpp-worker`) with HMAC vectors and mock protocol tests.
- Rust host persisted `kill_at` = `startedAt + wallTimeMs`; default host remains TypeScript.
- Docs, parity ledger, identity constants, CI jobs.

## Remaining limitations

- No Orchestrator↔Java/C++ loopback.
- Java/C++ do not emit AgentEvents.
- C++ HTTP/1.1 is Content-Length only.
- Rust host is still opt-in.

## Claimed closure status

READY FOR INDEPENDENT SOL VERIFICATION
