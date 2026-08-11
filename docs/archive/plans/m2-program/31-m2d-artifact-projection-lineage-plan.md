---
title: "M2D Implementation Plan: Artifact Projection and Attempt Lineage"
status: historical
superseded_by:
  - docs/architecture/control-plane.md
audience:
  - developer
last_verified: 2026-08-11
sources:
  - docs/archive/plans/m2-program/30-m2d-artifact-projection-lineage-spec.md
  - services/orchestrator/src/services/execution.service.ts
  - services/orchestrator/src/database/database.provider.ts
  - services/orchestrator/src/database/postgres.integration.spec.ts
---

# M2D implementation plan

## Checkpoint D1 — selector and graph validation

1. Extend the existing M2C projection type; do not create a parallel context config.
2. Validate selector shape, count, exact fields, mutual exclusion, duplicates,
   unsafe strings, and dependency eligibility at pipeline ingress.
3. Reuse the pipeline DAG's existing dependency analysis. Do not implement a
   second generic graph engine.
4. Add plan-revision and frozen-hash coverage.
5. Prove old and state-only M2C projections serialize unchanged.

## Checkpoint D2 — durable exposure schema

1. Add the minimal exposure entity/relation and register it through existing
   TypeORM patterns.
2. Add the next monotonic migration only after inspecting the live order.
3. Encode foreign keys, uniqueness, and query indexes explicitly.
4. Protect audit truth from silent cascading deletion.
5. Add a focused migration spec for registration adjacency, upgrade from all prior
   migrations, repeat behavior, exact constraints/indexes, down behavior, preserved
   rows, and no invented historical exposure.

## Checkpoint D3 — authoritative resolution

1. Add a focused internal resolver using the current transaction's EntityManager.
2. Resolve from declared dependency logical step to its canonical successful
   StepAttempt/ResultInbox and M2A Artifact rows.
3. Read descriptor fields by verified ordinal from the canonical result payload;
   never trust descriptor `id` as Tenvyr identity.
4. Apply exact name/ordinal filters, explicit metadata inclusion, deterministic
   sorting, duplicate detection, same-execution checks, and total bounds.
5. Return isolated reference values plus authoritative Artifact entities/IDs for
   edge persistence. Do not fetch URI content.

## Checkpoint D4 — atomic claim integration

1. Extend M2C snapshot creation within `claimRunnableStep` after existing locks.
2. Insert exposure edges using the claim transaction's EntityManager.
3. Commit attempt, full snapshot, edges, and outbox as one unit.
4. Ensure deterministic selector failures follow the same M2C failure mechanism
   and never produce a partial attempt/outbox.
5. Keep the deprecated attempt path consistent or explicitly unable to use
   artifact projection.
6. Add architecture guards for the single authority and URI non-dereference.

## Checkpoint D5 — lineage queryability and docs

1. Prove internal repository/service queries can traverse consumer attempt to
   Artifact to producer ResultInbox/attempt without adding an unauthenticated API.
2. Update current architecture and status docs with the precise word `exposed` or
   `projected`; do not claim semantic consumption or external byte immutability.
3. Update the machine ledger only with real evidence.
4. Document the deletion limitation and same-execution-only policy.

## Mandatory review questions

- Can a descriptor ID or AgentEvent create an exposure?
- Can an unrelated/failed/superseded producer be selected?
- Can an outbox exist without every matching exposure edge?
- Can one retry overwrite or reuse another attempt's edges?
- Can any URI or metadata reach a network/path/log sink?
- Can deleting canonical producer evidence silently erase consumer lineage?
- Does a selector ambiguity have one deterministic outcome?

Any unsafe answer blocks the stage until repaired.
