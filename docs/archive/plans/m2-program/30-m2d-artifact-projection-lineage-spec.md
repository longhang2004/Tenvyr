---
title: "M2D Specification: Artifact Projection and Attempt Lineage"
status: historical
superseded_by:
  - docs/architecture/control-plane.md
audience:
  - developer
last_verified: 2026-08-11
sources:
  - services/orchestrator/src/entities/artifact.entity.ts
  - services/orchestrator/src/entities/result-inbox.entity.ts
  - services/orchestrator/src/services/result-inbox.service.ts
  - services/orchestrator/src/entities/step-attempt.entity.ts
  - docs/archive/plans/2026-08-11-tenvyr-m2a-durable-artifact-references.md
---

# M2D artifact projection and lineage specification

## Outcome

A pipeline step may explicitly select bounded artifact references produced by
eligible dependency steps. Tenvyr resolves selections to its own durable Artifact
UUIDs, exposes bounded descriptors in the attempt ContextSnapshot, and records
append-only attempt-to-artifact exposure edges atomically with claim.

The word `exposure` is authoritative. It proves Tenvyr put the reference in the
attempt's committed context. It does not claim dispatch succeeded, the Worker
opened the URI, or the agent reasoned over the artifact.

## Authority model

- Only an M2A `ArtifactEntity.id` is the authoritative artifact identity.
- Producer lineage remains Artifact -> canonical ResultInbox -> producer
  StepAttempt -> logical step/execution.
- The result payload descriptor is immutable canonical evidence for name,
  mediaType, URI, and metadata; descriptor-provided `id` is never Tenvyr authority.
- AgentEvent `artifact` evidence cannot create or satisfy a selection.
- Consumer lineage is exposure -> consumer StepAttempt -> execution.
- Every projected artifact must belong to the consumer execution.

## Pipeline selector

Extend M2C's optional context projection:

```yaml
contextProjection:
  stateKeys:
    - approvedBrief
  artifacts:
    - fromStep: research
      name: report.json
      includeMetadata: false
    - fromStep: sources
      ordinal: 0
      includeMetadata: true
```

Rules:

- `fromStep` is required and must be a declared transitive dependency of the
  consumer step; self, unrelated, and future steps are rejected at pipeline ingress.
- `name` and `ordinal` are optional filters but mutually exclusive.
- no filter selects all authoritative artifacts from the eligible producer result,
  still subject to the total reference bound;
- `name` uses exact Unicode string equality; no glob, regex, semantic search, or
  case folding;
- `ordinal` is a non-negative descriptor ordinal;
- `includeMetadata` defaults false. When false, metadata is absent, not `{}`;
- duplicate selectors and overlapping selectors that resolve the same artifact are
  rejected deterministically rather than silently changing requested semantics;
- an empty artifacts array is rejected; omit the member when no artifacts are wanted.

## Producer eligibility

Resolve only the canonical APPLIED successful result for the dependency's current
successful attempt in this execution. Do not expose artifacts registered from a
failed, cancelled, timed-out, ignored, conflicting, or superseded attempt.

If no eligible result exists, the selector resolves no artifacts. If a configured
filter matches no artifact, deterministic claim failure occurs with a stable code.
This prevents a typo from silently withholding required execution data.

The implementation must use persisted logical-step/attempt/result authority, not
"latest created row" timing and not descriptor-supplied IDs.

## Context representation

M2D fills `context.tenvyr.artifacts` in the M2C envelope. Each reference contains:

```json
{
  "artifactId": "Tenvyr UUID",
  "producerStepId": "research",
  "producerAttemptId": "UUID",
  "descriptorOrdinal": 0,
  "name": "report.json",
  "mediaType": "application/json",
  "uri": "opaque producer URI",
  "metadata": { "only": "when explicitly requested" }
}
```

Optional source fields remain absent when absent. Do not include result output,
artifact bytes, canonical ResultInbox payload, transport receipts, internal row
versions, or provider prompt fragments.

Sort references deterministically by producer step ID, producer attempt ID,
descriptor ordinal, then Artifact UUID. Snapshot and invocation must deep-equal
and remain within M2C's complete 65,536-byte envelope limit.

## Bounds and security

- maximum configured artifact selectors per step: 128;
- maximum resolved artifact references per attempt: 128;
- selector string/key limits reuse current pipeline and JSON safety bounds;
- descriptor fields and opted-in metadata count toward the complete context bound;
- URI remains opaque. The Orchestrator must never fetch, probe, resolve, follow,
  open, normalize as a path, or use it as transport configuration;
- logs/errors contain artifact UUIDs/counts/codes, not URI, name, metadata, or bytes;
- no cross-execution, cross-workflow historical, or global artifact lookup exists.

## Durable exposure relation

Add one narrow append-only relation, named for exposure/projection rather than
semantic consumption, with at least:

- Tenvyr UUID primary key;
- consumer StepAttempt foreign key;
- Artifact foreign key;
- created timestamp;
- unique `(stepAttemptId, artifactId)`;
- indexes supporting artifact-to-consumer and attempt-to-artifact lineage queries.

Do not duplicate descriptors or snapshot JSON into this relation.

Foreign-key deletion behavior must preserve authoritative audit truth. A result or
artifact referenced by an exposure must not be silently cascade-deleted. Historical
cleanup policy is outside M2; tests may truncate with CASCADE only in disposable DBs.

## Atomicity and concurrency

Snapshot resolution occurs inside `claimRunnableStep` under the existing locks.
Persist attempt, snapshot, all exposure edges, and outbox atomically. A missing,
foreign, ambiguous, duplicate, oversized, or failed edge insert produces no
attempt/outbox/exposure authority and follows deterministic failure policy.

A producer result commit racing consumer claim yields one deterministic database
truth: either the committed eligible producer is visible and projected, or the
claim fails/defers according to existing dependency readiness. It must never use
an uncommitted descriptor or create a dangling edge.

Retries own separate exposure rows for their separate StepAttempts. Dispatch
redelivery for one attempt creates no new rows.

## Migration and history

Use the next live migration after M2B/M2C migrations. Do not backfill exposure
rows for historical attempts; that would invent what agents saw. M2A Artifact
identities and producer lineage remain unchanged.

## Non-goals

- no artifact upload/download/blob store, byte digest verification, signed URL,
  retention, deletion workflow, tenant sharing, or public artifact API;
- no URI dereference, crawling, embedding, semantic search, RAG, vector database,
  or long-term memory;
- no claim that external bytes at an opaque URI are immutable;
- no state writes, provider prompt construction, or replay execution.

## Acceptance requirements

M2D is review-ready only after tests prove selector graph validation, authoritative
resolution, same-execution enforcement, producer eligibility, exact snapshot and
outbox equality, exposure atomicity, restart durability, retry/redelivery behavior,
URI non-dereference, bounds, migration safety, and unchanged M0/M1/M2A-C behavior.
