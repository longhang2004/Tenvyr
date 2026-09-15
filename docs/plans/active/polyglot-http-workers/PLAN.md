---
title: "PLAN: Polyglot HTTP workers"
status: planned
audience:
  - developer
last_verified: 2026-09-15
sources:
  - docs/plans/active/polyglot-http-workers/SPEC.md
  - sdks/python-worker/src/tenvyr_worker/_callback/signer.py
  - packages/worker/src/callback/callback-signer.ts
  - scripts/verify-product-identity.mjs
  - services/orchestrator/src/agent-adapters/http-java-worker.integration.spec.ts
---

# PLAN — copy the existing worker, do not rewrite the plane

## Phase 0 — locked (discovery)

Allowed APIs: HMAC formula in
`packages/worker/src/callback/callback-signer.ts` and
`sdks/python-worker/src/tenvyr_worker/_callback/signer.py`; routes and
status map from the Python/TS workers; five schemas under
`contracts/schemas`; vectors under
`contracts/conformance/callback-signatures/vectors.json`.

Anti-patterns: Orchestrator rewrite, `X-Tenvyr-*` headers, 200-on-submit,
reading `contracts/schemas` at Java runtime (bundle or validate
structurally; tests compare bytes), flipping Rust default.

## Phase 1 — Java Worker SDK

Copy HMAC, bearer compare, origin allowlist, 202 acceptance, compact
result JSON, callback retries (`408`/`429`/`5xx`/network). Mock tests:

1. 8 HMAC vectors from the shared fixture.
2. In-process worker + mock orchestrator: 202, signed callback, duplicate
   idempotency, 401 without bearer, unsafe integer → 400.

Schema resources: byte-copy of the five tracked schemas; `check` script
mirrors `scripts/sync-python-worker-schemas.py`.

## Phase 2 — C++ worker

Same HMAC and routes. Tiny JSON + HTTP/1.1 subset. Mock tests: vectors
file + in-process server/callback. Link `OpenSSL::Crypto`.

## Phase 3 — Rust host truth

1. `kill_at: rfc3339_now()` → timestamp `now + wall_time_ms`.
2. One unit assertion that `kill_at` is after `started_at`.
3. CI job `cargo test --manifest-path services/local-executor-host-rs/Cargo.toml`.
4. Default host stays TypeScript.

## Phase 4 — docs / identity / ledger

Worker docs, parity ledger columns, `docs/README.md`,
`implementation-status.json`, identity constants for Java/C++ header
names, `pnpm test:docs` + `pnpm test:identity`.

## Phase 5 — Orchestrator↔Java loopback

Copy the Python loopback: NDJSON fixture, first callback 500 then 204,
safe-integer boundaries, unsafe output → `AGENT_OUTPUT_INVALID`, raw
unsafe input 400 then same invocation ID still runs. Gate on
`TENVYR_JAVA_EXECUTABLE`. Exclude from default Orchestrator Jest.

## Phase 6 — verification

Commands in [VERIFY.md](VERIFY.md). Do not claim an unrun gate.
