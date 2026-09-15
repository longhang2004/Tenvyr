---
title: "VERIFY: Polyglot HTTP workers"
status: planned
audience:
  - developer
last_verified: 2026-09-15
sources:
  - docs/plans/active/polyglot-http-workers/SPEC.md
  - package.json
  - scripts/verify-product-identity.mjs
  - scripts/verify-docs.mjs
  - services/orchestrator/src/agent-adapters/http-java-worker.integration.spec.ts
---

# VERIFY

## Focused gates (must pass)

```bash
python3 scripts/sync-java-worker-schemas.py check
mvn -B -f sdks/java-worker/pom.xml test
cmake -S sdks/cpp-worker -B /tmp/tenvyr-cpp-worker -DCMAKE_CXX_COMPILER=g++
cmake --build /tmp/tenvyr-cpp-worker
ctest --test-dir /tmp/tenvyr-cpp-worker --output-on-failure
pnpm test:executor-host-rs
pnpm test:identity
pnpm verify:identity
pnpm test:docs
pnpm verify:docs
TENVYR_JAVA_EXECUTABLE=java pnpm --filter orchestrator test:java-worker-loopback
```

## Proof each slice

1. Java: HMAC test prints/asserts 8/8 vectors; protocol test receives one
   callback whose `X-AgentWeave-Signature` matches `Hmac.sign` over the
   raw body.
2. C++: same 8 vectors; mock POST `/v1/runs` returns 202; callback HMAC
   verifies.
3. Rust: `kill_at` in written state is after `started_at` by wall time;
   `scripts/dev-ux.test.mjs` still defaults to the TypeScript host.
4. Identity: `java-worker-sends-` and `cpp-worker-sends-` rules match the
   four protocol-v1 HMAC header constants.

5. Java loopback: retry + idempotent re-invoke without re-run; safe
   integer boundaries; unsafe output → `AGENT_OUTPUT_INVALID`; raw
   unsafe input 400 then the same invocation ID still runs.

## Anti-pattern grep

- No `X-Tenvyr-Signature` in worker sources.
- No Orchestrator/Gateway rewrite in the diff.
- `TENVYR_EXECUTOR_HOST` default is still not rust.

## Unavailable

Live Orchestrator↔C++ loopback is out of this slice (mock callback
server only). Do not report it as passed.
