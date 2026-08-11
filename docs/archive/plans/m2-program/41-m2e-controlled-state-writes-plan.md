---
title: "M2E Implementation Plan: Controlled Result-to-State Writes"
status: historical
superseded_by:
  - docs/architecture/control-plane.md
audience:
  - developer
last_verified: 2026-08-11
sources:
  - docs/archive/plans/m2-program/40-m2e-controlled-state-writes-spec.md
  - services/orchestrator/src/services/result-inbox.service.ts
  - services/orchestrator/src/services/pipeline-validation.service.ts
  - services/orchestrator/src/database/postgres.integration.spec.ts
---

# M2E implementation plan

## Checkpoint E1 — mapping and graph contract

1. Add the minimal optional `stateWrites` type to the pipeline step contract.
2. Implement a pure restricted JSON Pointer parser/resolver using standard language
   facilities. Do not add JSONPath or another dependency.
3. Validate mapping count, fields, target keys, pointers, duplicates, and static
   same-key reachability conflicts at pipeline ingress.
4. Add plan revision/frozen hash tests and old-pipeline compatibility fixtures.
5. Add pure resolver tests for objects, arrays, escaped tokens, null, missing,
   malformed escapes, indices, boundary values, and output isolation.

## Checkpoint E2 — provenance schema

1. Add the narrow controlled-write evidence entity/table and the next live ordered
   migration if durable schema is needed.
2. Encode unique ResultInbox, identities, versions, disposition, hash/error code,
   timestamp, foreign keys, and lineage indexes.
3. Do not store state/output values in provenance.
4. Add migration tests for adjacency, upgrade/repeat/down, exact constraints,
   preserved prior rows, and no historical backfill.

## Checkpoint E3 — canonical transaction integration

1. Map the current `ResultInboxService.apply` decision tree before editing it.
2. Add controlled writes only on the first canonical `succeeded` branch.
3. Use the existing transaction EntityManager and already-locked Execution entity.
   Reuse M2B pure patch validation/application; do not nest transactions or alter
   lock order.
4. Resolve all mappings before applying any key. Apply patch atomically, preserving
   M2B no-op/version/timestamp behavior.
5. Insert provenance in the same transaction and retain M2A artifact registration.
6. Implement the specified deterministic mapping-failure disposition without
   endless inbox retry and without partial state.
7. Preserve every no-config, non-success, duplicate, conflict, cancellation,
   timeout, watchdog, and late-result branch.

## Checkpoint E4 — concurrency and failure closure

1. Prove disjoint parallel writes both survive and versions advance only for real
   changes.
2. Prove same-key unordered pipelines are impossible and ordered writers behave.
3. Race result/result, result/M2B mutate, and result/cancel using real PostgreSQL.
4. Inject failures at state save, artifact insert, provenance insert, and terminal
   transition boundaries; prove full rollback and clean retry.
5. Restart and replay identical/conflicting transport results; prove exactly-once
   state and provenance.

## Checkpoint E5 — architecture and docs

1. Add guards forbidding `statePatch`/metadata authority and nested state service
   transactions in ResultInbox.
2. Update current control-plane, protocol limitation, implementation status, and
   machine ledger with precise implemented truth.
3. Document the difference between current mutable state and mutation evidence;
   do not claim complete event sourcing or replay.
4. Leave all plans active for independent review.

## Mandatory review questions

- Can a non-canonical or non-success result reach state application?
- Can one missing mapping apply earlier mappings partially?
- Can duplicate delivery increment state version or insert evidence twice?
- Can a provenance/artifact failure leave state committed?
- Can mapping errors poison-loop ResultInbox?
- Can unordered same-key writers pass validation?
- Can full result output, output values, or state leak to provenance/logs?
- Did any protocol v1 root schema change without an explicit version decision?

Repair every unsafe answer before the stage gate.
