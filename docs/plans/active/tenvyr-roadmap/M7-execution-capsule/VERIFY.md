---
title: "M7 Verification: Execution Capsule, Replay, Comparison, and Projection"
status: planned
audience:
  - developer
last_verified: 2026-08-11
sources:
  - docs/plans/active/tenvyr-roadmap/M7-execution-capsule/SPEC.md
  - docs/operations/testing-and-verification.md
  - docs/roadmap/observability-provenance.md
  - services/orchestrator/src/database/postgres.integration.spec.ts
---

# M7 verification contract

## Static architecture audit

- capsule DTO/assembler does not expose ORM entities or become source truth;
- replay creates a new Execution and cannot mutate source;
- comparison ignores incidental identity noise and labels missing/unverified facts;
- provenance never overclaims exposure/runtime reports;
- telemetry/exporter cannot participate in execution decisions/transactions;
- no secrets/full payloads/artifact URIs in default DTO/spans/logs;
- public access remains blocked until ownership/auth is proven.

## Unit tests

- DTO versioning/canonical semantic hash/completeness classifications/redaction;
- configured row/byte/node/edge/page/preview bounds and stable cursors;
- replay override validation/idempotency/prerequisite decisions;
- structural comparison symmetry/stability/categories;
- provenance mapping authority labels;
- W3C parse/inject limits/trust, convention mapper, attribute cardinality/privacy;
- exporter queue/backoff/drop/failure isolation.

## Real PostgreSQL tests

- unchanged terminal assembly twice yields equal semantic hash;
- repeatable-read live assembly never mixes revisions/attempts;
- all M0–M6 facts join correctly with legacy missing warnings;
- capsule page ordering/count/hash survives restart;
- duplicate replay creates exactly one new Execution/relation;
- conflicting replay request creates no second target;
- replay relation, M4 authority, target execution/revision/steps commit all-or-none;
- replay/cancel/result races reuse existing terminal authority;
- source rows/hashes unchanged after replay/comparison/export;
- manifest/projection migration upgrade invents no historical evidence.

## Integration tests

- seeded complete and legacy/incomplete executions;
- missing/unverified/corrupt artifact replay policy;
- M3 runtime/config drift, M4 policy/budget/approval, M5 revision, M6 delegation;
- HTTP/Kafka/TypeScript/Python W3C parentage conformance after official research;
- collector disabled/down/slow/malformed/partial export and restart;
- internal capsule/query/dashboard projection with bounded pagination.

## Crash/restart and concurrency

Crash during assembly/manifest, replay request, target creation, projection enqueue/
drain. Race live writes/capture, duplicate replay, replay/cancel, exporter/recovery,
retention/read, and concurrent large comparisons.

## Security review

Test cross-owner IDs once gate closes, source enumeration, malicious cursors, zip/
serialization bomb, huge graph, secret/state/context/output/URI leakage, forged trace
headers/baggage, cardinality attack, export replay/tamper, signed manifest rotation,
and override privilege escalation. Verify exposure gate deployment controls separately.

## Compatibility and docs

M0–M6 authority is identical with capsule/telemetry disabled or exporter failed.
Old executions produce honest incomplete capsules. Update current capsule/replay/
telemetry/privacy architecture, ledger, API/operations, compatibility versions, and
limitations. Official OTel/W3C sources and versions are recorded.

## Required current commands

```bash
pnpm --filter orchestrator test -- --runInBand
TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/tenvyr_roadmap_test \
  pnpm --filter orchestrator test -- --runInBand
pnpm test:all
pnpm build:all
pnpm --filter @tenvyr/worker test
pnpm --filter @tenvyr/worker exec jest --runInBand --detectOpenHandles
TENVYR_PYTHON_EXECUTABLE=/absolute/path/to/python \
  pnpm --filter orchestrator test:python-worker-loopback
python -m pytest sdks/python-worker/tests
pnpm --filter frontend lint
pnpm --filter frontend typecheck
pnpm --filter frontend test:safe-preview
pnpm --filter frontend build
pnpm test:docs
pnpm verify:docs
pnpm test:identity
pnpm verify:identity
pnpm verify:package-packs
git diff --check
```

Run PostgreSQL twice sequentially and researched collector/OTLP integration gates.

## Closure gate

SAFE TO CLOSE only if Sol independently verifies coherent bounded capsules, source-
immutable exactly-one replay, honest comparison/provenance, privacy/authorization,
telemetry failure isolation, standards compatibility, and all prior milestones.
DeepSeek's report is provisional.
