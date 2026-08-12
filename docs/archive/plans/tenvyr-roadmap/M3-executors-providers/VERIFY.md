---
title: "M3 Verification: Executor Architecture and Runtime Integration"
status: historical
superseded_by:
  - docs/reference/implementation-status.json
audience:
  - developer
last_verified: 2026-08-11
sources:
  - docs/archive/plans/tenvyr-roadmap/M3-executors-providers/SPEC.md
  - docs/operations/testing-and-verification.md
  - services/orchestrator/src/database/postgres.integration.spec.ts
  - services/orchestrator/src/architecture.spec.ts
---

# M3 verification contract

## Static architecture audit

- Orchestrator imports no provider SDK/prompt/tool formatting.
- Executor, transport, provider, and logical agent concepts are not collapsed.
- secrets cannot enter PipelineDefinition, descriptor snapshots, events, logs, or
  implementation reports.
- one authoritative attempt/outbox/result/event path remains.
- capability flags are conservative and used only where proven.
- local process execution has no shell or untrusted executable/path interpolation.

## Unit tests

- descriptor parsing, canonical hashing, bounds, redaction, secret-ref handling;
- resolver unknown/disabled/version cases and old `agent` compatibility;
- executor error classification and optional capability handling;
- fixed argv/env/cwd/sandbox resolution, output limits, protocol validation;
- idempotent cancellation and late result rejection;
- official integration fixtures pinned to researched supported behavior.

## Real PostgreSQL tests

- attempt/outbox freezes exact descriptor under concurrent claims;
- restart/redelivery reuses descriptor and invocation;
- workflow retry creates distinct attempt/descriptor evidence;
- launch/receipt/result/cancel races preserve one terminal authority;
- descriptor persistence failure rolls claim/outbox back;
- runtime crash after accepted dispatch becomes exactly one terminal result;
- multi-replica recovery does not duplicate a locally owned invocation;
- migrations upgrade prior rows without invented executor facts.

## Integration tests

- existing Kafka and HTTP full lifecycle remain green;
- TypeScript and Python Workers receive identical bounded input/context;
- local process success, invalid output, timeout, cancellation, signal escalation,
  oversized stdout/stderr, orphan/restart, and secret-redaction cases;
- each approved native/A2A adapter uses official supported auth/lifecycle fixtures;
- provider examples use mocks unless explicitly authorized credentials exist.

## Crash/restart and concurrency

Inject crash before launch, after launch before durable receipt, after receipt, after
result commit, and during cancel. Test duplicate recovery claims, concurrent cancel/
result, config rotation after attempt freeze, and executor shutdown/startup races.

## Security review

Test shell metacharacters, traversal/symlink cwd, hostile env names, huge output,
fork/process explosion bounds, callback impersonation, executor identity mismatch,
credential leak in errors/argv/process listings, URI-as-path, and untrusted runtime
metadata. Record sandbox limitations. External exposure gate remains open unless
separately verified.

## Compatibility and docs

Existing pipelines, Kafka/HTTP identities, Worker SDKs, result/event duplicate rules,
retries, deadlines, cancellation, M2 context/artifacts, and package consumers pass.
Update current architecture, configuration, executor compatibility matrix, status
ledger, security limitations, and official research citations.

## Required current commands

```bash
pnpm --filter orchestrator test -- --runInBand
TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/tenvyr_roadmap_test \
  pnpm --filter orchestrator test -- --runInBand
pnpm --filter @tenvyr/worker test
pnpm --filter @tenvyr/worker exec jest --runInBand --detectOpenHandles
TENVYR_PYTHON_EXECUTABLE=/absolute/path/to/python \
  pnpm --filter orchestrator test:python-worker-loopback
python -m pytest sdks/python-worker/tests
pnpm test:all
pnpm build:all
pnpm test:docs
pnpm verify:docs
pnpm test:identity
pnpm verify:identity
pnpm verify:package-packs
python scripts/verify-python-worker-package.py
git diff --check
```

Run real PostgreSQL twice sequentially after the first green result. Add Java,
frontend, Docker, and native-runtime supported gates when their areas change.

## Closure gate

SAFE TO CLOSE only if Sol independently confirms every approved executor path,
security boundary, durable race, compatibility gate, current doc/ledger claim, and
official-source integration assumption. DeepSeek's report is provisional.
