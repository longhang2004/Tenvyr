---
title: "M5 Verification: Dynamic Planner and Immutable Plan Revision"
status: planned
audience:
  - developer
last_verified: 2026-08-11
sources:
  - docs/plans/active/tenvyr-roadmap/M5-dynamic-planner/SPEC.md
  - docs/operations/testing-and-verification.md
  - services/orchestrator/src/database/postgres.integration.spec.ts
  - services/orchestrator/src/services/pipeline-validation.service.spec.ts
---

# M5 verification contract

## Static architecture audit

- Planner has no DB/service/dispatch authority and cannot mutate PipelineEntity;
- revisions are insert-only; proposal decisions are separate evidence;
- only approved operations exist; no arbitrary JSON Patch/full replacement/remove;
- `baseRevision` is not rowVersion and stale proposals are not rebased;
- Planner conditions are declarative data with unsafe-key guards;
- M4 checks happen at activation, not just proposal generation.

## Unit tests

- operation/version/payload/count validation and canonical proposal hash;
- deterministic order/apply for add and replace-unfrozen;
- duplicate/conflicting operation IDs and targets;
- frozen/attempted replacement rejection;
- full plan DAG/reference/step/depth/fanout/condition validation;
- malicious `constructor`/`prototype`/`__proto__` references and non-JSON values;
- proposal decision/idempotency/error codes and safe logs.

## Real PostgreSQL tests

- two concurrent same-base proposals: exactly one ACCEPTED, one STALE;
- claim versus replacement: old frozen or new revision, never mixed;
- activation transaction atomically writes proposal decision, revision, added rows,
  replacement representation, active pointer, policy/budget evidence;
- forced insert/pointer/materialization failure rolls everything back and retries;
- crash after commit before reconcile is recovered;
- retry result still uses original attempt revision/failure policy;
- approval then base change produces STALE;
- duplicate/conflicting proposal is exactly-once evidence;
- migration upgrade preserves all old revisions/steps and invents none.

## Integration tests

Use one deterministic mock Planner through M3 to generate valid, invalid, stale,
oversized, malicious, and repeated proposals. Prove M2 context is bounded, M4 budget
charges Planner/revisions, cancellation/deadline works, and Planner cannot dispatch.

## Crash/restart and concurrency

Test crash before/after proposal persist, approval, revision insert, logical-row
materialization, pointer switch, and reconcile poke. Race Planner/Planner,
Planner/claim, Planner/result, Planner/cancel, and approval/revision change.

## Security review

Test plan amplification, deep/cyclic graph, forbidden executor/agent, secret refs,
arbitrary condition strings/code, prototype pollution, huge reason/metadata, recursive
Planner creation, budget bypass, and authorization limitation. No public Planner API
before exposure gate.

## Compatibility and docs

Run old static pipelines, condition compatibility, retries, cancellation, recovery,
M2 context/artifacts, M3 executors, M4 budgets/policy, both Workers/transports, and
package contracts. Update current plan-revision architecture, status ledger, limits,
operator workflow, and proposal retention limitations.

## Required current commands

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

Run PostgreSQL twice sequentially. Add M3 executor/loopback, frontend, Docker, and
exposure gates when changed.

## Closure gate

SAFE TO CLOSE only if Sol independently proves immutable revisions, frozen-step
safety, one-winner CAS, atomic activation/recovery, bounded malicious proposals,
policy/budget enforcement, compatibility, and truthful docs. DeepSeek is provisional.
