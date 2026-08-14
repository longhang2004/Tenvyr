---
title: "M9 Verification: Supervised Agent Team Execution"
status: planned
audience:
  - developer
last_verified: 2026-08-12
sources:
  - docs/plans/active/tenvyr-productization-roadmap/M9-supervised-agent-team-execution/SPEC.md
  - docs/operations/testing-and-verification.md
  - services/orchestrator/src/database/postgres.integration.spec.ts
---

# M9 verification contract

## Architecture audit

Coordinator owns authority; Planner/Verifier return untrusted bounded data; no
recursive Planner or second workflow engine; minimal coordination tables do not
duplicate attempts/results; Completion requires Coordinator ACCEPT; ExecutionState
is not lifecycle authority; provider behavior stays in runtimes.

## Unit tests

Configuration/hard bounds; TaskBatch/decision parsing, canonical hashes,
idempotency/conflicts; required/optional fan-in; deterministic aggregation and
truncation; every phase/decision; limit/permission/policy/approval matrix; malicious
steps/metadata/conditions/references; Capsule projection bounds.

## Real PostgreSQL tests

Migrations and constraints; atomic iteration/batch/revision/materialization/counters;
100-way same-decision CONTINUE creates exactly one next iteration; Planner/claim,
Worker/result, verifier/decision, cancel/decision, approval/authority, budget reserve,
deadline, revoke, and completion-hold races; forced failures roll back; restart at
every phase; iteration/counter uniqueness; replay creates new authority. Run twice.

## Integration tests

Deterministic Planner, Workers, and Verifier through current HTTP Worker and one
Kafka path; M8 Generic CLI/local-host loop; optional Codex/Claude/OpenCode profiles;
valid ACCEPT, two CONTINUE cycles, FAIL, WAIT/approve/deny/expire, required failure,
optional failure, timeout, budget exhaustion, connection revoke, artifact/context
aggregation, Capsule/replay/compare.

## Crash/restart and multi-replica

Crash before/after Planner result, proposal persist, PlanPatch activation, worker
claim/dispatch/result, fan-in, Verifier claim/result, decision consume, next iteration,
completion release, WAIT resolution, and terminal commit. Reconciliation must use
PostgreSQL only and never duplicate work beyond documented at-least-once dispatch.

## Security review

Recursive/amplifying batch; oversized/deep/cyclic graph; total-worker overflow across
iterations; stale decision/approval; forbidden connection/executor; secret refs;
prototype pollution; unbounded output/artifacts/logs; chain-of-thought request;
authority bypass through direct PlanPatch/delegation; unauthenticated external loop
control; resource starvation and Capsule cardinality.

## Backward compatibility and docs

Run old static/dynamic pipelines, retries, WAITING, budgets, policy, delegation,
capsules/replay, both SDKs/transports, M8 connections and package contracts. Update
architecture, operations, implementation ledger, product demo/limitations, migration
inventory and identity docs when needed.

## Required commands

```bash
pnpm --filter orchestrator test -- --runInBand
TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/tenvyr_roadmap_test \
  pnpm --filter orchestrator test -- --runInBand
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

Run PostgreSQL twice sequentially. Add local-host/runtime/frontend/Docker gates when
their paths change. No skipped external profile is a core loop pass substitute.

## Closure gate

`SAFE TO CLOSE` requires independent Sol proof of exact durable recovery,
one-winner iteration creation, completion hold, bounded fan-out/aggregation/cost,
current-authority decision enforcement, deterministic failure/WAIT semantics,
compatibility and truthful Capsule/docs. DeepSeek cannot close M9.
