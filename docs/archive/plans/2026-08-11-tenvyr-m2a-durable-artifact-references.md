---
title: "M2A: Durable Artifact References and Producer Lineage"
status: historical
completion: completed
superseded_by:
  - docs/architecture/control-plane.md
audience:
  - developer
last_verified: 2026-08-11
sources:
  - services/orchestrator/src/entities/artifact.entity.ts
  - services/orchestrator/src/database/migrations/1722270002000-MilestoneTwoArtifactIdentity.ts
  - services/orchestrator/src/database/database.provider.ts
  - services/orchestrator/src/services/result-inbox.service.ts
  - services/orchestrator/src/services/result-inbox.service.spec.ts
  - services/orchestrator/src/database/migrations/milestone-two-artifact-identity.spec.ts
  - services/orchestrator/src/database/postgres.integration.spec.ts
  - docs/architecture/control-plane.md
  - docs/reference/implementation-status.json
  - docs/reference/implementation-status.md
---

# M2A: Durable Artifact References and Producer Lineage

> Historical implementation record — COMPLETED after independent Tech Lead
> verification on 2026-08-11. Current architecture truth lives in
> `docs/architecture/control-plane.md`; this file records what this slice
> changed and what it deliberately left out.

## Goal

When a canonical `AgentResultV1` containing artifact descriptors becomes
authoritative, create stable, immutable Tenvyr artifact identities linked to
the exact producing `StepAttempt`. This slice manages artifact references and
producer provenance only: it does not store, upload, download, inspect, or
claim immutability of artifact bytes.

## Scope

- One durable `artifacts` row per descriptor in the canonical
  `result.artifacts` array, created inside `ResultInboxService.apply`'s
  existing transaction on the first-application path — for every terminal
  outcome (`succeeded`, `failed`, `cancelled`, `timed_out`).
- Tenvyr-owned identity: the worker-supplied descriptor `id` remains opaque
  producer-declared data and is never assumed globally unique.
- Commit/rollback together with the inbox `APPLIED` state, the guarded attempt
  terminal transition, the logical-step projection, outbox retirement, and the
  execution transition.
- Duplicate, conflicting, ignored, stale, and post-cancellation results create
  no Artifact rows and never mutate existing ones.
- Artifact `AgentEvent`s remain append-only evidence and never create or
  update Artifact rows.

## Persistence model

`artifacts` is an insert-only identity/provenance index:

- `id` — Tenvyr-owned stable uuid identity.
- `resultInboxId` — FK to the canonical `result_inbox` row (resolves producer
  lineage to exactly one `StepAttempt` via `result_inbox.stepAttemptId`).
- `descriptorOrdinal` — index within `result.artifacts`.
- `descriptorHash` — SHA-256 of the canonical descriptor JSON (existing
  `sha256Json` helper; no new hashing or storage dependency).

Uniqueness `(resultInboxId, descriptorOrdinal)` makes duplicate registration
of the same canonical descriptor impossible. The full descriptor (including
unbounded `metadata`) stays in the canonical inbox payload; it is not
duplicated here. `ON DELETE CASCADE` from `result_inbox` mirrors
`agent_events` → `step_attempts`; current code never deletes inbox rows, so
audit history is unchanged.

## Transaction and concurrency

Artifact registration runs inside `apply`'s transaction, after the guarded
terminal transitions and before the inbox is marked `APPLIED`. The existing
pessimistic inbox-row lock serializes identical deliveries (one `applied`,
one `duplicate`), so the artifact insert's `ON CONFLICT DO NOTHING` is defense
in depth against any unique-constraint error escaping as a retry loop. A
failed artifact insert aborts the transaction: no partial `APPLIED` inbox,
attempt transition, step projection, execution transition, or partial artifact
set can commit.

## Migration and backward compatibility

`MilestoneTwoArtifactIdentity1722270002000` runs after M1 in the production
configuration. It is repeat-safe (`IF NOT EXISTS`), performs no historical
backfill, and preserves existing rows. Pre-existing `APPLIED` results gain no
artifact identities — authoritative artifact identity begins after this
migration. Results without `artifacts` behave byte-for-byte as before, and
results with artifacts behave exactly as before plus the new rows. No
`AgentResultV1` field or `schemaVersion` change; no existing result, retry,
cancellation, supervision, Kafka, HTTP, or Worker behavior changed; no new
public/Gateway artifact endpoints (current APIs are unauthenticated and
artifact metadata may be sensitive).

## Verification

- Unit: first application per terminal outcome, identical duplicate, conflict/
  ignored/post-cancellation, zero-artifact compatibility, insert-failure abort.
- Migration unit: order after M1, repeat-safe DDL, no DML (no backfill),
  reverts only `artifacts`.
- Real PostgreSQL: first application + duplicate, artifacts on non-success
  results, concurrent identical delivery (exactly one Artifact per
  descriptor), forced registration failure rolling back the entire terminal
  transaction, and migration behavior (order, repeat-safety, preservation, no
  backfill).

## Explicitly out of scope (later M2 slices)

- Blob/object storage, uploads, downloads, signed URLs, encryption, retention,
  or deletion APIs.
- Consumption lineage or injecting artifact references into later attempts.
- `ExecutionState`, `ContextProjection`, or `ContextSnapshot` behavior.
- Public/Gateway/frontend artifact APIs.
- PROV-O as a transactional schema (possible future projection only).
- Claiming external bytes are immutable because the database record is.
