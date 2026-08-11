---
title: "M2 Program Architecture Specification"
status: historical
superseded_by:
  - docs/architecture/control-plane.md
audience:
  - developer
last_verified: 2026-08-11
sources:
  - services/orchestrator/src/entities/execution.entity.ts
  - services/orchestrator/src/entities/step-attempt.entity.ts
  - services/orchestrator/src/entities/result-inbox.entity.ts
  - services/orchestrator/src/entities/artifact.entity.ts
  - services/orchestrator/src/services/execution.service.ts
  - services/orchestrator/src/services/result-inbox.service.ts
  - services/orchestrator/src/services/dispatch-outbox.service.ts
  - contracts/schemas/agent-invocation.v1.schema.json
  - contracts/schemas/agent-result.v1.schema.json
---

# M2 program architecture specification

## Product interpretation

Tenvyr must let workflow steps share execution data without copying every
prior output into prompts or one mutable bag. Tenvyr owns selection,
authority, durability, bounds, and lineage. Agent runtimes own reasoning and
provider-specific prompt/tool behavior.

The final M2 model keeps four concepts distinct:

| Concept         | Mutability                           | Purpose                                      | Authority                         |
| --------------- | ------------------------------------ | -------------------------------------------- | --------------------------------- |
| ExecutionState  | Mutable, bounded, semantic versioned | Small execution-scoped values                | Orchestrator transaction          |
| Artifact        | Immutable Tenvyr identity/reference  | Larger output reference and producer lineage | Canonical ResultInbox application |
| ContextSnapshot | Immutable per StepAttempt            | Exact data exposed to one attempt            | Scheduling transaction            |
| MemoryRef       | Future external pointer only         | Reference to a separate memory system        | Not implemented in M2             |

## Repository facts that constrain the design

- PostgreSQL is execution authority.
- `ExecutionEntity.rowVersion` protects the complete row and is distinct from
  semantic `executionStateVersion`.
- `ExecutionService.claimRunnableStep` freezes the execution specification,
  creates the StepAttempt and DispatchOutbox record, and is the atomic seam for
  ContextSnapshot creation.
- Dispatch reads the durable outbox invocation. Recovery must never rebuild a
  different projection.
- `ResultInboxService.apply` is the canonical terminal-result transaction and
  the only approved seam for result-derived state writes.
- M2A artifacts are Tenvyr-owned rows linked to canonical ResultInbox rows;
  worker descriptor IDs remain opaque.
- AgentEvents remain evidence and cannot mutate state, create Artifact truth,
  or replace terminal AgentResult authority.
- `AgentInvocationV1.context` is an optional open JSON object. M2 may populate
  it with a documented Tenvyr projection envelope without adding provider
  prompt semantics.
- `AgentResultV1.output` already carries framework-neutral result data. M2E
  selects declared values from it; it does not add an agent-controlled state
  mutation field.

## Cross-milestone architecture decisions

### 1. Context is opt-in and deny-by-default

A step with no projection declaration receives the same invocation behavior
as before. Tenvyr never injects all state, all prior results, or all artifacts.
Projection declarations identify exact state keys and artifacts produced by
declared dependencies.

### 2. ContextSnapshot is created before dispatch

The snapshot, StepAttempt, and DispatchOutbox invocation commit together. A
crash produces either all three or none. Redelivery uses the stored invocation
and the same snapshot identity/hash.

### 3. Step input remains separate from context

Existing input templates and `steps.<stepId>.result.<field>` behavior stay
stable. M2 does not silently migrate input into context or change condition
evaluation.

### 4. State writes are declared by the pipeline, not invented by the agent

M2E adds explicit mappings from selected successful `AgentResultV1.output`
values to named ExecutionState keys. Tenvyr never copies the complete output.
No new top-level `AgentResultV1.statePatch` field is introduced.

### 5. Parallel write determinism is validated statically

Two steps that may run concurrently cannot declare writes to the same state
key. Pipeline validation rejects overlapping unordered writers. Ordered
writers are allowed when dependency reachability establishes sequence.
Disjoint parallel writes commute and serialize through the execution row lock.

### 6. Projection and mapping failures are execution failures, not poison

A runtime projection or declared state-write value that violates the frozen
execution contract must terminate the affected attempt deterministically with
a Tenvyr-owned error and flow through the existing failure policy. It must not
leave a READY/RUNNING attempt that retries forever at the transport layer.
The canonical result/inbox evidence remains durable when a result-derived
mapping fails.

### 7. Artifact content is never fetched by Tenvyr core

Artifact `uri` values are opaque producer-declared references. Core does not
perform HTTP/file/object-store fetches, eliminating an SSRF/path-access seam.
Optional producer content-digest and size claims may be normalized, but M2
does not claim that external bytes were verified or are immutable.

### 8. Exposure lineage comes from snapshots

An Artifact is exposed when its Tenvyr artifact ID is included in a committed
ContextSnapshot. Exposure lineage links Artifact → ContextSnapshot → target
StepAttempt. This proves context authority, not that transport succeeded or the
agent semantically consumed the content.

### 9. Bounds are semantic, not merely transport limits

HTTP/Kafka body limits do not define context policy. Each milestone defines
item counts, key lengths, UTF-8 byte limits, and safe-JSON validation at its
own trust boundary.

### 10. Replay is prepared, not implemented

At M2 completion the database must answer: which state version and artifact
references did an attempt receive, who produced each artifact, and which
attempts were exposed to it. M2 does not execute a replay or compare model
outputs.

## Migration order

The remaining migrations use monotonically increasing identities:

```text
1722270002000  M2A Artifact identity
1722270003000  M2B ExecutionState
1722270004000  M2C only if ContextSnapshot needs new durable schema
1722270005000  M2D artifact exposure lineage, or next available identity
1722270006000  M2E controlled state-write provenance, or next available identity
```

DeepSeek must confirm the live migration list before allocating each number.
Do not create an empty migration merely to preserve the proposed numbering.

## Compatibility rules

- Existing pipelines with no new fields behave identically.
- Existing AgentInvocation/AgentResult producers remain valid.
- Existing input templates, conditions, retry semantics, cancellation,
  supervision, result deduplication, and artifact registration remain intact.
- No historical M2A artifact backfill is invented.
- State migration defaults existing executions to `{}` version `0`; later
  snapshots are created only for newly claimed attempts after M2C lands.
- No later milestone may reinterpret old outbox invocations during recovery.

## Security and privacy rules

- State, snapshot payloads, artifact metadata, and result-selected values are
  untrusted JSON and require bounds before persistence.
- No secrets or complete snapshot payloads are logged.
- No public read/write endpoints are added in M2.
- Cross-execution artifact references are rejected before snapshot commit.
- Projection errors expose stable codes, not sensitive values.
- Metadata labels are not treated as policy enforcement until the future
  policy milestone.

## Program completion condition

M2 is closure-ready only when all five remaining milestone gates and the
global anti-regression matrix pass against real PostgreSQL, both Worker SDKs,
all transports, documentation/identity verifiers, and the complete build.
