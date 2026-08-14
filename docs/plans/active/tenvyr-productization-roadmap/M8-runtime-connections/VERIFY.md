---
title: "M8 Verification: Runtime Connections"
status: planned
audience:
  - developer
last_verified: 2026-08-12
sources:
  - docs/plans/active/tenvyr-productization-roadmap/M8-runtime-connections/SPEC.md
  - docs/operations/testing-and-verification.md
  - services/orchestrator/src/database/postgres.integration.spec.ts
---

# M8 verification contract

## Architecture audit

Runtime/provider/executor remain distinct; connection revisions are immutable and
secret-free; existing adapter and host boundaries are composed rather than
duplicated; pipelines cannot supply commands/credentials; no Orchestrator provider
SDK/prompt logic; no public admin claim; local host still says trusted-code-only.

## Unit tests

Connection/revision validation, canonical hash and idempotency; capability defaults
and downgrade; safe status/reason projection; fixed CLI argv/schema mapping;
probe deadlines/output/frequency/concurrency; missing/version/auth/malformed cases;
revocation decisions; secret redaction and hostile metadata/path/argv.

## Real PostgreSQL tests

Immutable revisions and uniqueness; concurrent revise/revoke/claim has one coherent
frozen identity; dispatch rotation cannot reroute; revocation denies future claims;
retry/replay use current revision; migrations upgrade/restart/rollback repeat-safely;
Capsule provenance references exact revision without secrets. Run twice sequentially.

## Integration tests

- deterministic fake CLIs for every profile and Generic CLI;
- real installed Codex/Claude/OpenCode version/auth-status and non-billable probe when
  available, with explicit SKIP reason otherwise;
- opt-in live execution only with user-supplied supported credentials;
- existing HTTP, Kafka, Local Executor Host, Worker loopbacks and signed callbacks;
- connection API/workbench status mapping if touched.

## Crash/restart and multi-replica

Crash around revision/test receipt/claim/outbox/revocation; duplicate test requests;
two replicas revise/revoke/claim; host crash/orphan cleanup; pending and accepted work
retain deterministic outcomes.

## Security review

Search DB/log/events/Capsule/API responses for seeded secrets. Test symlink/traversal,
shell metacharacters, env inheritance, auth-file probing, token URL/query leakage,
oversized output, probe storms, capability spoofing, unsupported OAuth import,
revoked credential resolution, and unauthenticated external administration.

## Backward compatibility and docs

Old Kafka/HTTP profiles and legacy snapshots execute unchanged; contracts/SDK parity
is preserved. Update architecture, operations, README truth, implementation ledger,
identity inventory if required, tested runtime matrix, and explicit limitations.

## Required commands

```bash
pnpm --filter orchestrator test -- --runInBand
TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/tenvyr_roadmap_test \
  pnpm --filter orchestrator test -- --runInBand
pnpm --filter @tenvyr/local-executor-host test
pnpm test:all
pnpm build:all
pnpm --filter @tenvyr/worker test
python -m pytest sdks/python-worker/tests
pnpm test:docs
pnpm verify:docs
pnpm test:identity
pnpm verify:identity
pnpm verify:package-packs
git diff --check
```

Run the real PostgreSQL command twice. Run runtime/version/live gates only when their
documented executable and credentials are available; report unavailable, never pass.

## Closure gate

`SAFE TO CLOSE` requires independent Sol proof of frozen identity, deterministic
rotation/revocation/replay, no secret persistence/leakage, truthful capabilities and
health, generic executor compatibility, official API conformance, and current docs.
DeepSeek does not approve M8.
