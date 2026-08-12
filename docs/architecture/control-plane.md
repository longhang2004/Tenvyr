---
title: Control Plane
status: current
audience:
  - developer
last_verified: 2026-08-10
sources:
  - services/orchestrator/src/database/data-source.ts
  - services/orchestrator/src/database/migrations/1722270000000-MilestoneZeroFoundation.ts
  - services/orchestrator/src/database/migrations/1722270001000-MilestoneOneAgentEvents.ts
  - services/orchestrator/src/services/pipeline-validation.service.ts
  - services/orchestrator/src/services/condition-evaluator.service.ts
  - services/orchestrator/src/services/engine.service.ts
  - services/orchestrator/src/services/agent-result.service.ts
  - services/orchestrator/src/services/agent-event.service.ts
  - services/orchestrator/src/services/supervision.service.ts
  - services/orchestrator/src/services/supervision-config.service.ts
  - services/orchestrator/src/services/result-inbox.service.ts
  - services/orchestrator/src/services/dispatch-outbox.service.ts
  - services/orchestrator/src/services/runtime-recovery.service.ts
  - services/orchestrator/src/services/execution.service.ts
  - services/orchestrator/src/services/pipeline.service.ts
  - services/orchestrator/src/entities/agent-event.entity.ts
  - services/orchestrator/src/entities/agent-event-conflict.entity.ts
  - services/orchestrator/src/entities/step-attempt.entity.ts
  - services/orchestrator/src/app.controller.ts
  - services/orchestrator/src/services/engine.service.spec.ts
  - services/orchestrator/src/services/agent-result.service.spec.ts
  - services/orchestrator/src/services/agent-event.service.spec.ts
  - services/orchestrator/src/services/supervision.service.spec.ts
  - services/orchestrator/src/services/supervision-config.service.spec.ts
  - services/gateway/src/app.controller.ts
  - services/gateway/src/socket.gateway.ts
---

# Control Plane

The Orchestrator is the execution authority. It validates reusable pipelines,
snapshots each run into an immutable execution plan revision, persists logical
steps and separate attempt history, resolves dependency and condition state,
and delegates only transport work through `AgentAdapter`.

## Pipeline execution

Pipeline creation rejects duplicate or missing dependencies, cycles, graphs
over 100 steps, depth over 20, fanout over 20, invalid durations/retry values,
and unsupported conditions. Legacy string conditions are accepted only as a
single comparison between bounded context references and literal/reference
operands; they are normalized to a declarative AST. Conditions never execute
JavaScript.

`EngineService.startExecution` loads a validated pipeline and transactionally
creates the execution, immutable plan revision 1, and every logical-step row in
the same transaction. All later dependency, retry, skip, and completion
decisions read that revision rather than mutable `PipelineEntity.steps`. It
then reconciles the run through the engine-level path described below. For
each executed step it:

1. resolves templates from pipeline input and completed step state at the
   scheduling boundary, before the attempt claim;
2. updates the existing compatibility logical-step summary in the
   `step_executions` table and appends a distinct `StepAttempt` — scheduling
   never inserts a step row, so it cannot race a claim against a materialized
   row;
3. creates a `StepAttempt` and `DispatchOutbox` record in the same PostgreSQL
   transaction, with deterministic `<stepExecutionId>:<attempt>` identity;
4. commits, then lets `DispatchOutboxService` lease and invoke the
   `AgentAdapter` outside that transaction.

### Freeze semantics

Materialization is not consumption. A freshly created or backfilled logical
step is `PENDING` with `frozenSpecHash = null`, `frozenAt = null`,
`conditionResult = null`, and `attempt = 0`, so future plan revisions remain
applicable to unstarted steps. A step becomes frozen only when its
execution-defining scheduling or gate decision becomes authoritative:

- a claimed first attempt freezes the active revision's step configuration
  (`frozenSpecHash` + `frozenAt`) in the same transaction as the attempt;
- a condition that evaluates false freezes the spec, persists
  `conditionResult = false`, and marks the step `SKIPPED`;
- a retry claim keeps the original frozen specification, and a claim whose
  active revision differs from the frozen hash is rejected.

Existing `StepAttempt` rows continue to store the frozen hash for their
attempt.

### Engine-level reconciliation

`EngineService.reconcileExecution(executionId)` is the single engine-level
reconciliation primitive. Given PostgreSQL's current authoritative state, it
makes every currently legal autonomous orchestration decision until no
immediately actionable transition remains:

1. promotes a recoverable `PENDING` execution to `RUNNING` through a guarded
   update, backfills missing logical-step rows for pre-materialization
   executions, and advances dependency-resolved `PENDING` steps to `READY`
   (the low-level `ExecutionService.reconcileExecution`);
2. identifies due `READY` (eligible) and `RETRYING` (due `nextAttemptAt`)
   steps, materializes their input templates, and claims each one
   transactionally through the `StepAttempt` + `DispatchOutbox` primitive —
   `FOR UPDATE SKIP LOCKED` makes concurrent replicas safe;
3. persists condition-skip decisions and pokes the dispatch outbox after each
   committed claim;
4. detects completion (every configured step terminal → `COMPLETED` with
   outputs keyed by step ID) and autonomous inability to continue (a `FAILED`
   step whose policy is not `continue`, or a cancelled step) purely from
   durable logical-step state.

It is idempotent, requires no caller-provided step context, and leaves
terminal executions untouched except best-effort Gateway projection when
explicitly requested. `resumeAfterResult(executionId, stepId)` is kept for
protocol/API compatibility only: it is exactly a durable `ResultInbox` commit
followed by `reconcileExecution` with terminal projection — the step ID is not
a source of scheduler truth, and a duplicate result may safely trigger
another reconciliation.

`LogicalStepEntity` is the current domain name for `step_executions`.
`StepExecutionEntity` and protocol-v1 `stepExecutionId` remain compatibility
aliases. Retry creates another attempt with the same logical-step ID and a new
attempt number; prior input, executor snapshot, status, result, error, and
timestamps are retained. Terminal attempt updates use a guarded update and do
not rewrite an already-terminal outcome.

The dispatcher uses `FOR UPDATE SKIP LOCKED` leases and never claims a record
whose execution is already terminal. A process failure after an executor
accepts an invocation but before the receipt is stored can redeliver the same
`invocationId`; dispatch is deliberately at-least-once. Workers must treat
that ID as their idempotency key when repeating execution could be unsafe.
Exactly-once executor runs and exactly-once external side effects are not
guaranteed.

### Targeted versus global dispatch

There are exactly two dispatch entry points, sharing one claimed-record
delivery primitive (`dispatchClaimed`):

- `dispatchAttempt(stepAttemptId)` — claim-specific: leases ONLY the outbox
  row of the StepAttempt that was just claimed (respecting the same
  PENDING/expired-LEASED eligibility and terminal filters), then delivers it.
  `EngineService` calls this immediately after every claim, so the dispatch
  that follows a claim always targets that claim's own attempt and can never
  steal a different execution's record or misattribute its failure.
- `dispatchNext()` / `recover()` — global background drain: claims the
  globally-oldest eligible record. Used by `RuntimeRecoveryService`; it is
  independent of any single execution's reconciliation context.

A terminal dispatch failure always reports the execution that ACTUALLY owns
the failed attempt; the caller reconciles and projects that execution, never
an assumed local one.

### Outbox recovery fairness

Background recovery drains records with per-record error isolation: a
retryable delivery failure returns THAT record to `PENDING` with a future
`nextDispatchAt` (same StepAttempt, same `invocationId`) and the drain
continues with the remaining eligible records, so one repeatedly failing
record cannot starve healthy records behind it. The drain is bounded per call
(`MAX_DISPATCH_RECOVERY_BATCH`), claim-phase database failures still abort and
surface (a later tick retries), and each call reports dispatched count,
terminal-failure execution IDs, and the retryable-failure count.

## Result flow and correlation

`AgentResultService` first applies every terminal delivery through the durable
`ResultInbox`. `invocationId` is the protocol-v1 semantic result identity; the
canonical validated result payload is SHA-256 hashed. The inbox, guarded
terminal attempt update, logical-step outcome, retry eligibility, and any
execution failure transition commit together. Identical deliveries become a
no-op across restarts and replicas. A different payload for the same invocation
is retained in `ResultConflict` and rejected without changing the authoritative
outcome. HTTP delivery IDs and Kafka topic/partition/offset are diagnostic
transport identities, not execution identities.

Attempt outcomes preserve `SUCCESS`, `FAILED`, `TIMED_OUT`, and `CANCELLED`.
The compatibility logical-step summary remains `COMPLETED`/`FAILED`/
`CANCELLED`; retryable timeout and failure leave it `RETRYING` with a durable
`nextAttemptAt`. Terminal attempt fields are guarded with an `UPDATE ... WHERE
status NOT IN (...)` and affected-row verification. Inbox rows use exactly
three states — `RECEIVED` (internal/pre-application state used during the
transactional application, or retained for compatibility; it is a transient
state inside the apply transaction, not a durable queue state), `APPLIED`
(canonical terminal result committed), and `REJECTED` (persisted evidence of a
late or conflicting result on the canonical row, e.g. a result after
cancellation). There is no durable `RECEIVED → later worker → APPLIED`
workflow: the inbox row and the authoritative terminal transition commit
together. Late evidence belongs in append-only inbox/conflict and AgentEvent
records (usage records arrive in later milestones); it never rewrites a
terminal result. The first authoritative application additionally registers
durable Artifact reference identities for every descriptor in
`result.artifacts` (see below).

A worker outcome with terminal status `cancelled` transitions the logical step
to `CANCELLED` and the execution to `CANCELLED` in the same inbox transaction;
it can never make the execution `COMPLETED`. Because the execution is terminal,
`claimRunnableStep` refuses further claims and remaining nonterminal steps
cannot advance, so the run is not left stranded in a live state. A late sibling
outcome under an already-terminal execution records its own attempt and step
facts as terminal — never `RETRYING` — so recovery cannot re-pick the step
every tick, and it never rewrites the terminal execution status.

After a terminal step update, the engine evaluates dependent steps. A
dependency is resolved by `COMPLETED` or `SKIPPED`, or by `FAILED` only when
that dependency uses `onFailure: continue`. When every configured step is
terminal, the execution becomes `COMPLETED` with outputs keyed by step ID.

## Artifact references and producer lineage

Three distinct things must not be confused:

- **Canonical AgentResult artifact descriptors** — the worker-declared
  `result.artifacts` entries in the validated result payload. The descriptor
  `id` is opaque producer-declared data and is never assumed to be a
  Tenvyr-global identifier; descriptors may carry unbounded metadata and are
  untrusted Worker input even after transport authentication (never
  dereference, fetch, probe, or log `uri`, and never interpret `metadata` as
  commands, paths, credentials, or transport configuration).
- **Immutable Tenvyr Artifact reference records** — one `artifacts` row per
  canonical descriptor, created by the first authoritative `ResultInbox`
  application of that result (for every terminal outcome: `succeeded`,
  `failed`, `cancelled`, and `timed_out`). Each row carries a Tenvyr-owned
  stable uuid identity, the `ResultInbox` row reference, the descriptor
  ordinal, and the canonical descriptor SHA-256. Uniqueness over
  `(resultInboxId, descriptorOrdinal)` prevents duplicate registration; rows
  are insert-only with no update path, and deletion cascades from a
  `ResultInbox` row (never performed by current code — inbox rows are audit
  history), mirroring `agent_events` → `step_attempts`.

Storage-amplification boundary: the v1 contract does not cap the `artifacts`
array size or descriptor string lengths (unlike the 64 KiB AgentEvent body
cap), so a hostile worker can declare arbitrarily many descriptors — each
costing one fixed-size Artifact row plus one canonical hash. The registration
already runs as a single batched insert inside the apply transaction, but
batching bounds statement count, not row count: amplification stays linear
over the already-accepted unbounded `payload` jsonb, bounded in practice by
transport body limits. The only real bound is a protocol-level
`maxItems`/`maxLength` cap, which belongs to a future protocol version.

- **Producer lineage** — each Artifact row resolves unambiguously to one
  canonical `ResultInbox` row and therefore, through `stepAttemptId`, to
  exactly one producing `StepAttempt` with its `executionId` and
  `logicalStepId`.

Artifact registration commits or rolls back together with the inbox `APPLIED`
state, the guarded attempt terminal transition, the logical-step projection,
outbox retirement, and any execution transition. Identical duplicate
deliveries, and conflicting, ignored, stale, or post-cancellation results,
create no Artifact rows and never mutate existing ones. No historical backfill
was performed: pre-existing `APPLIED` results keep their payloads but have no
Artifact rows — authoritative artifact identity begins with the M2 migration.

Artifact `AgentEvent`s (`type: "artifact"`) remain append-only operational
evidence. They are never authoritative and never create or update an Artifact
record.

This slice provides immutable reference identity and producer lineage. M2D
adds bounded reference projection and attempt-to-artifact exposure lineage,
described below. Tenvyr still does not provide blob storage,
uploads/downloads, content (byte) immutability, semantic consumption proof,
retention, replay, or public read APIs — and the immutability of an Artifact
database record never implies immutability of the external bytes it references.

## ExecutionState (durable state core)

M2B adds an internal, durable, per-execution semantic state primitive:
`executionState` (jsonb), `executionStateVersion` (integer), and
`executionStateUpdatedAt` (timestamp) on the `executions` row, created by
`MilestoneTwoExecutionState1722270003000` immediately after the M2A
migration. It is an Orchestrator-internal primitive (`ExecutionStateService`)
with no agent, pipeline-definition, public API, Gateway route, or
`AgentInvocationV1.context` exposure. Agent results and artifact descriptors
never flow into it; `AgentResultV1` gains no `statePatch` yet.

Semantics:

- ExecutionState is a top-level JSON object. A patch is
  `{ set?: Record<string, JsonValue>; delete?: string[] }`: `set` replaces the
  complete value of named top-level keys, `delete` removes them, nested values
  are replaced (never recursively merged), a key cannot appear in both, and
  duplicate delete keys are invalid.
- `executionStateVersion` is the explicit semantic state version — distinct
  from the TypeORM `rowVersion` that guards the whole row. A real mutation
  increments it exactly once; a no-op increments nothing and never touches the
  row (no save, no version bump, no timestamp update).
- Hard ceilings: 128 top-level keys; 128 code points per key; 128 operations
  per patch; 16 KiB canonical patch; 64 KiB final state. Keys `__proto__`,
  `prototype`, and `constructor` are rejected. Values must be valid JSON
  (no undefined, bigint, function, symbol, NaN, Infinity, cycles, class
  instances, non-plain objects, or dangerous object keys at any nesting
  depth); validation is a bounded
  `ExecutionStateValidationError`, never a database retry loop.
- `mutate(executionId, expectedVersion, patch)` runs in one transaction: the
  owning execution row is locked pessimistically, then dispositions are
  evaluated in order `missing` → `terminal` → `conflict`. PENDING, RUNNING,
  and WAITING executions may be mutated; COMPLETED, FAILED, and CANCELLED
  reject mutation. A stale writer receives `conflict` with the current
  semantic version and changes nothing. State, semantic version, and the
  state-specific timestamp commit or roll back atomically.
- Outputs are isolated: `read` and `mutate` return deep copies, and applying a
  patch never mutates caller-owned objects.

M2B by itself provides no agent/result mutation authority. M2C–M2E build on it
with bounded projection, exposure lineage, and pipeline-declared result
mappings. The completed M2 program still provides no public read/write API,
memory/RAG/semantic-search behavior, full event-sourced state history, or
replay implementation.

## ContextSnapshot (bounded state projection)

M2C adds an optional declarative `contextProjection` to a pipeline step:

```yaml
contextProjection:
  stateKeys:
    - approvedBrief
    - review.status
```

Keys are exact top-level ExecutionState keys; a dot is an ordinary key
character, never a path operator. Absent `contextProjection` preserves legacy
behavior byte-for-byte: no Tenvyr context envelope and a null
`step_attempts.contextSnapshot`. Empty selections, duplicate keys, unsafe keys
(`__proto__`, `prototype`, `constructor`), keys over 128 code points, and
selections over 128 keys are rejected at pipeline ingress. The field
participates in the plan revision and the frozen step specification hash, so a
selector change is a frozen-spec change.

At claim time (`ExecutionService.claimRunnableStep`, under the existing
execution row lock) Tenvyr materializes an immutable, attempt-owned
ContextSnapshot envelope and persists it on the StepAttempt and inside the
DispatchOutbox invocation `context.tenvyr` member in the same transaction:

```json
{
  "tenvyr": {
    "schemaVersion": 1,
    "executionState": { "version": 7, "values": { "approvedBrief": "..." } },
    "artifacts": []
  }
}
```

Invariants:

- The complete canonical UTF-8 envelope is bounded at 65,536 bytes; selected
  values are isolated clones; output keys are canonically sorted; explicit
  JSON null is included; a missing selected key fails the claim
  deterministically with the stable code `TENVYR_CTX_MISSING_STATE_KEY` (also
  `TENVYR_CTX_INVALID_PROJECTION`, `TENVYR_CTX_UNSAFE_VALUE`,
  `TENVYR_CTX_ENVELOPE_TOO_LARGE`).
- Snapshot, attempt, and outbox commit atomically; dispatch and recovery send
  the persisted outbox invocation and never recompute the snapshot. A retry
  owns a new attempt and a new snapshot; a later state mutation never alters a
  historical snapshot.
- A projection failure creates one terminal FAILED pre-dispatch StepAttempt
  with frozen input/spec/executor snapshots and a null ContextSnapshot. It
  creates no outbox or artifact exposure. The same claim transaction applies
  the frozen step's `retry`/`continue`/`stop` policy; retry consumes attempt
  budget, so no READY poison loop can form. The failure never claims that a
  Worker received context.
- State values never appear in errors or logs; only stable codes, identities,
  versions, and sizes are recorded.
- `AgentInvocationV1.context` is only ever written by the reviewed claim seam;
  adapters, dispatch recovery, supervision, events, and result application
  neither synthesize nor reinterpret it.

The deprecated `createStepExecution` compatibility path rejects
projection-enabled step configs instead of silently dispatching without the
declared context.

## Artifact projection and exposure lineage

M2D extends the same `contextProjection` with explicit artifact references:

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

- `fromStep` must be a declared transitive dependency of the consumer step
  (self, unrelated, and future steps are rejected at pipeline ingress).
  `name` (exact Unicode equality) and `ordinal` (non-negative descriptor
  ordinal) are optional but mutually exclusive filters; no filter selects
  every authoritative artifact of the eligible producer result.
- `includeMetadata` defaults false; metadata is absent from the reference (not
  `{}`) unless explicitly requested. Empty `artifacts` arrays, duplicate
  selectors, and over-128-selector projections are rejected at ingress.
- Only the canonical APPLIED successful result of the dependency's current
  successful attempt is eligible: failed, cancelled, timed-out, ignored,
  conflicting, and superseded attempts are never projected. A dependency with
  no eligible result resolves no artifacts; a configured filter that matches
  nothing fails the claim deterministically
  (`TENVYR_CTX_ARTIFACT_FILTER_NO_MATCH`), as do overlapping selectors
  resolving the same artifact (`TENVYR_CTX_ARTIFACT_OVERLAP`), foreign
  executions (`TENVYR_CTX_FOREIGN_ARTIFACT`), ordinal/hash mismatches
  (`TENVYR_CTX_ARTIFACT_ORDINAL_MISMATCH`), and more than 128 resolved
  references (`TENVYR_CTX_ARTIFACT_LIMIT`).
- The reference carries only bounded Tenvyr-owned data: `artifactId` (Tenvyr
  UUID), `producerStepId`, `producerAttemptId`, `descriptorOrdinal`, `name`,
  `mediaType`, `uri`, and optionally `metadata`. The descriptor `id` is never
  Tenvyr authority. References are sorted deterministically by producer step
  ID, producer attempt ID, descriptor ordinal, then Artifact UUID, and count
  toward the 65,536-byte complete-envelope bound.
- `uri` is opaque untrusted producer data. The Orchestrator never fetches,
  probes, resolves, normalizes, reads, or executes it, and never logs it.
- Each projection commits an append-only `artifact_exposures` row per
  (consumer StepAttempt, Artifact) in the same transaction as the attempt,
  snapshot, and outbox (migration
  `MilestoneTwoArtifactExposure1722270004000`). The word `exposure` is
  authoritative: the edge proves Tenvyr put the reference in the attempt's
  committed context — never that dispatch succeeded, the Worker opened the
  URI, or the agent reasoned over the artifact. Foreign keys use NO ACTION:
  referenced artifacts and attempts are never silently cascade-deleted.
- No historical backfill: exposure lineage begins with M2D. AgentEvent
  artifact evidence can never create or satisfy an exposure. There is no
  public lineage API; internal queries can traverse consumer attempt →
  exposure → Artifact → canonical ResultInbox → producer attempt.

## Controlled state writes

M2E adds an optional `stateWrites` array to a pipeline step: the frozen
pipeline definition — never an agent-supplied patch or metadata field —
authorizes a successful result to copy bounded values from
`AgentResultV1.output` into ExecutionState. Agent Protocol v1 keeps its closed
root schema: no `statePatch` field exists.

```yaml
stateWrites:
  - key: approvedBrief
    fromOutput: /brief
  - key: review.status
    fromOutput: /decision/status
```

Rules:

- `key` is an exact top-level ExecutionState key with M2B key safety/length
  rules (dots are ordinary characters). `fromOutput` is a restricted RFC 6901
  JSON Pointer: the empty pointer, URI-fragment form, wildcards, filters,
  recursive descent, expressions, invalid `~` escapes, and the `-` array
  append token are rejected; array index tokens must be canonical
  non-negative integers without leading zeros (except `0`).
- Empty arrays, duplicate target keys, duplicate mappings, unknown fields,
  unsafe keys, more than 128 mappings, and malformed pointers are rejected at
  pipeline ingress. Every mapping is required: the first missing pointer or
  non-JSON selected value rejects the whole write and applies no keys.
- Static write-conflict rule: two steps that may run concurrently cannot write
  the same key. Same-key writers are allowed only when the DAG proves one is
  transitively ordered before the other; disjoint parallel writes remain
  allowed and commute under the execution row lock.
- Mappings apply only to the first canonical successful result while the
  owning Execution is still RUNNING, inside the existing
  `ResultInboxService.apply` transaction under the already-locked
  execution entity (pure M2B patch semantics, no nested standalone mutation
  transaction). A real change increments `executionStateVersion` exactly once
  and updates the state timestamp; a semantic no-op changes nothing.
- A late successful sibling result received after another step terminalized
  the Execution remains canonical result evidence for its own attempt but
  cannot mutate ExecutionState or create state-write evidence.
- Mapping failure is a deterministic Tenvyr postcondition failure: the
  canonical result payload stays durable evidence, no state key is applied,
  the attempt/logical step follow the existing retry/`onFailure` policy, and
  the ResultInbox row becomes APPLIED with the stable code
  (`TENVYR_STATE_WRITE_REJECTED: TENVYR_STATE_WRITE_POINTER_MISSING` |
  `_UNSAFE_VALUE` | `_BOUNDS` | `_INVALID_PATCH`) so transport redelivery can
  never poison-loop. M2A artifact registration is preserved in the same
  commit.
- Each canonical successful result with configured `stateWrites` persists one
  append-only `state_write_evidence` row (migration
  `MilestoneTwoStateWriteEvidence1722270005000`): execution/attempt/inbox
  identities, prior and resulting semantic versions, disposition
  (`applied` | `noop` | `rejected`), the canonical mapping hash when
  materialization succeeded, and a stable rejection code when it failed. The
  unique `resultInboxId` makes duplicate delivery unable to create a second
  row. Full prior/new state copies are never stored — this is mutation
  provenance, not a replayable state history.
- No state/output values ever reach logs or errors; only stable codes,
  versions, hashes, and identities.

## AgentEvents and supervision

Milestone 1 adds durable operational events and deterministic, opt-in
supervision around attempts. `AgentResult` remains the only worker-originated
terminal authority: events are durable evidence, never lifecycle state.

### Event lifecycle semantics

`AgentEventService.apply` is the application-layer entry point reached through
the adapter handler seam after transport validation/parsing. It resolves the
attempt by `invocationId` and verifies `executionId`/`stepExecutionId`
correlation before touching anything; an unknown or mismatched event is
`ignored`. Within one attempt, `(stepAttemptId, eventId)` is the canonical
identity and `(stepAttemptId, sequence)` the logical order; both are unique.

- **duplicate** — the same `eventId` with an identical canonical payload
  hash is an idempotent no-op; concurrent identical deliveries serialize on a
  pessimistic row lock and the guarded insert (`OR IGNORE`) makes the final
  race a silent no-op.
- **conflict** — the same `eventId` with a different payload
  (`event_id_payload`), or a different `eventId` claiming an owned `sequence`
  (`sequence_owner`), is retained as evidence in `agent_event_conflicts`; the
  canonical row in `agent_events` is never overwritten.
- **out-of-order / gaps** — events may arrive out of order or with gaps; the
  Orchestrator never reorders, renumbers, or fills gaps. Liveness projection is
  monotonic in server-received time, not event sequence.
- **late** — an event arriving after a terminal result is still stored as
  append-only evidence but never touches liveness columns or terminal state.

Canonical AgentEvent bodies are bounded at 64 KiB — the COMPLETE canonical
event, envelope fields included, enforced identically on the Worker before
emission and on the Orchestrator before persistence — and SHA-256 hashed for
identity
comparison, and stored with worker-reported `occurredAt` (audit evidence only)
plus server-assigned `receivedAt` (the liveness authority).

### Transport evidence bounds

Every inbound delivery carries a durable transport identity
(`adapter`/`scope`/`messageId`) that must fit the bounded varchar source
columns of the AgentEvent, ResultInbox, and conflict tables. The bounds are
encoded once in a shared helper used by both `AgentEventService` and
`ResultInboxService`:

- `adapter` is application-internal (≤ 50 chars, defensively asserted);
- HTTP `scope` is the callback `keyId`, bounded to 255 characters by
  transport configuration validation at startup (an oversized key ID fails
  configuration, never every callback later);
- HTTP `messageId` is the callback `deliveryId`, bounded to 255 characters at
  the adapter trust boundary after HMAC verification (permanent 400, never a
  retryable database failure);
- Kafka `scope` is `${topic}:${partition}` — persisted unchanged when it fits
  (≤ 255) and otherwise represented deterministically as
  `kafka-sha256:<sha256(raw)>`, never truncated (truncation could collide on
  the transport dedup index); partition stays part of the identity;
- Kafka `messageId` is the broker offset (numerically small, defensively
  asserted).

A transport identity that violates the durable bounds is a permanent
configuration/programming error, never a PostgreSQL varchar overflow
misclassified as a retryable infrastructure failure.

### Liveness projection

Each applied event updates server-received liveness fields on the active
`StepAttempt`, only while the attempt is non-terminal:

- `accepted` → `acceptedAt`;
- `heartbeat` → `lastHeartbeatReceivedAt`;
- `progress` → `lastProgressReceivedAt`;
- any applied event → `lastEventReceivedAt`.

`accepted` means the Worker durably owns the invocation — the run was
accepted/enqueued — NOT that the handler has begun executing. A concurrency-1
Worker accepts a run and queues it behind a busy execution slot, so
`accepted` projects `acceptedAt` but does NOT transition the attempt. Only
events that prove actual execution activity — `heartbeat`, `progress`, `log`,
`artifact` — transition a `DISPATCHED` attempt to `RUNNING` exactly once
(guarded by the status predicate), with `startTime` set server-side on first
transition and preserved afterwards.

Arrival order between `completed`/`failed` and the terminal `AgentResult` is
NOT execution authority: official Workers prioritize `AgentResult` and emit
the terminal operational event only after the result callback completes,
while a third-party runtime may deliver in any network order. In every case
`AgentResult` is terminal authority and `completed`/`failed` remain
append-only operational evidence: they never transition the attempt (they
only set `lastEventReceivedAt`, which already satisfies acceptance) and never
terminalize it. Late events after a terminal result remain append-only
evidence and never touch these columns.

### Event read API

`GET /executions/:id/events` lists persisted events for an execution, ordered
by `(receivedAt, id)` with a keyset cursor. Query parameters are
`stepAttemptId`, `type`, `limit` (default 50, bounded 1–200), and the
`afterReceivedAt` + `afterId` pair for the next page. Events are retained with
the execution (`ON DELETE CASCADE`) and the control plane never deletes them.

### Supervision configuration

Supervision is configured per agent via `ORCHESTRATOR_SUPERVISION_CONFIG`, a
JSON object keyed by exact agent name:

```json
{
  "watchdog-agent": {
    "heartbeat": {
      "expected": true,
      "startupGraceMs": 30000,
      "staleAfterMs": 30000
    }
  }
}
```

Expectations default to disabled. Agents absent from the configuration (or
with `expected: false`) are never failed by supervision, which preserves
Milestone-0 behavior for third-party HTTP agents that implement only
`AgentResult` and for current Kafka agents that do not heartbeat. Durations
are validated as bounded positive integers (1 ms to 24 h).

### Watchdog rules

`SupervisionService.evaluate` runs one bounded pass over active attempts
(`DISPATCHED`/`RUNNING`) of agents that opted in, ordered by
(`dispatchedAt`, `id`), with per-attempt error isolation and an in-memory
keyset cursor: each pass resumes after the last visited row and wraps at the
end of the candidate set, so more than one batch of continuously-healthy
older attempts can never permanently starve a later stale attempt (a restart
resets the cursor and re-visits the oldest candidates; evaluation is
idempotent, so revisits are harmless):

- **Rule A — `AGENT_ACCEPTANCE_TIMEOUT`** (`retryable: true`): a `DISPATCHED`
  attempt that received NO event (`lastEventReceivedAt IS NULL`) and whose
  persisted `dispatchedAt` plus `startupGraceMs` has elapsed. An `accepted`
  event satisfies Rule A even when the attempt stays `DISPATCHED` while
  queued: `accepted` proves the Worker took ownership, so an accepted run
  waiting in the Worker queue is never acceptance-timed-out. Consequently an
  attempt that was accepted but never produces any execution activity is not
  supervision-recovered while it stays `DISPATCHED`: when the step carries a
  timeout, the persisted `deadlineAt` path (Milestone-0 deadline recovery)
  settles it; a step without a timeout has no watchdog deadline at all — the
  queue-safety semantics deliberately refuse an `acceptedAt`-based timeout
  that would falsely fail legitimately queued runs.
- **Rule B — `AGENT_HEARTBEAT_STALE`** (`retryable: true`): a `RUNNING`
  attempt whose persisted staleness baseline plus `staleAfterMs` has elapsed.
  The baseline is the last server-received heartbeat; before the first
  heartbeat it is the persisted server-side `startTime` (the transition into
  RUNNING). So after execution activity begins the agent has `staleAfterMs`
  to produce its first heartbeat, later deadlines derive only from persisted
  heartbeat receipts, and `progress`/`log`/`artifact` events remain
  operational activity evidence but never substitute for the configured
  heartbeat contract. A run that was accepted but is still queued
  (`DISPATCHED`) is never heartbeat-timed-out.

Both rules terminalize through the same `ResultInbox` path as persisted
deadline recovery, producing a synthetic `timed_out` `AgentResult`, so
cancel-versus-watchdog race correctness, workflow retry policy, and replica
deduplication all hold.

### Determinism

Synthetic results are deterministic across replicas: `completedAt` is derived
from PERSISTED timestamps plus configured durations (dispatch time + grace,
or the persisted staleness baseline — last server-received heartbeat, or
`startTime` before the first heartbeat — plus `staleAfterMs`), never the
recovery tick time. Every replica that times out the same attempt constructs
the identical canonical payload and payload hash, so the inbox deduplicates
instead of recording a conflicting payload. Server timestamps are the
liveness clock; worker `occurredAt` is never used for deadlines.

### Recovery cycle ordering

Within each `RuntimeRecoveryService` cycle, persisted deadline expiry runs
first so Milestone-0 deadline authority is unchanged; deterministic
supervision runs second; candidate-execution reconciliation runs third so
attempts terminalized by supervision never re-enter the schedulable set in the
same cycle; the outbox drain runs last. Cycles never overlap and each
candidate is isolated.

### Worker event delivery limits

Workers deliver events through the same signed callback machinery as results:
worker-local bounded callback state (per-delivery delivery ID, stable body,
bounded retries). That state is process-local — a Worker restart forgets
undelivered events. Once the Orchestrator accepts an event, it is durable
PostgreSQL evidence regardless of later Worker or transport loss.

## Cancellation

`POST /executions/:id/cancel` (proxied by the Gateway) is transactional and
idempotent. While holding the same attempt -> logical-step -> execution lock
order as the result path, it:

1. marks every active attempt `CANCELLED` with a guarded terminal update;
2. marks cancellable logical steps (`PENDING`, `READY`, `RUNNING`, `RETRYING`,
   `WAITING`) `CANCELLED`;
3. retires pending/leased/dispatched outbox records so a late dispatcher
   receipt cannot revive delivery;
4. transitions the execution to `CANCELLED` only from a non-terminal status.

The first authoritative terminal transition wins the cancel-versus-result race:
both paths serialize on the same row locks, and a terminal result arriving
after cancellation is recorded as rejected inbox evidence (`REJECTED` with the
cancellation reason) rather than altering the terminal attempt or execution
truth.

## Execution status semantics

`RUNNING` is the execution status for autonomous delays: capacity limits, short
rate limiting, scheduled retry, and recoverable overdue work. `WAITING` is
reserved for an external authority, signal, or human decision; the scheduler
never advances a `WAITING` execution autonomously, and cancellation remains the
way an external authority ends one. Retry timing stays `RETRYING` +
`nextAttemptAt`; ready or capacity-limited work stays `READY`/eligible.

## Failure policies

- `retry` marks the logical step `RETRYING` with `nextAttemptAt`, then creates
  another attempt when the persisted schedule is due.
- `continue` permits downstream dependency evaluation after failure.
- `stop`, the default, marks the execution `FAILED`.
- Input-template failure is an orchestration/configuration failure of the run,
  not a step execution failure: template materialization happens before the
  attempt claim, so ordinary step `onFailure` retry/continue semantics do not
  apply. It marks the execution `FAILED` and projects the Gateway. No fake
  `StepAttempt` is created to consume retry counts.
- A retryable transport dispatch failure (the adapter marks it
  `retryable: true` or the error is transient) leaves its durable outbox
  record `PENDING` for redelivery of the SAME invocation; it does not
  terminally fail an attempt.
- A non-retryable transport dispatch failure (the adapter marks it
  `retryable: false`, e.g. HTTP 400 or an unconfigured agent) is never
  redelivered through the transport: the outbox record becomes `FAILED` and
  the current `StepAttempt` becomes `FAILED`. The pipeline's normal workflow
  failure policy then applies unchanged:
  - `stop` → execution `FAILED`;
  - `continue` → logical step `FAILED`, and reconciliation may progress
    eligible downstream work immediately (no waiting for the recovery tick);
  - `retry` with attempts remaining → logical step `RETRYING` with a persisted
    `nextAttemptAt`; later reconciliation creates a NEW `StepAttempt` with a
    NEW `invocationId` (never a transport redelivery of the rejected
    attempt), bounded by `maxAttempts`; retry exhausted → execution `FAILED`.
    The lease guard runs first: a stale worker's late non-retryable failure
    after the lease moved to a newer claim is ignored and cannot fail the
    attempt the newer claim owns. After the terminal failure commits, the
    caller reconciles the affected execution and attempts Gateway projection —
    the outbox service itself never depends on the Gateway.
- Persisted attempt deadlines are recovered by `RuntimeRecoveryService` and
  produce a `TIMED_OUT` attempt outcome; process-local `setTimeout` is not
  authoritative. The synthetic timeout result uses the persisted `deadlineAt`
  as its completion time, so every replica timing out the same attempt produces
  the identical payload hash and the inbox deduplicates instead of recording a
  conflict.
- Recovery cycles never overlap: a tick that is still running causes the next
  scheduled tick to be skipped rather than piling up, a cycle rejection is
  logged and never becomes an unhandled scheduled promise, and one failing
  candidate execution or attempt is isolated so later candidates in the same
  batch still run.

## Recovery model

`RuntimeRecoveryService` discovers candidate EXECUTIONS, not step rows: stuck
`PENDING` executions plus `RUNNING` executions with autonomous work (a
`PENDING` step, a due `READY` step, a due `RETRYING` step, or no step rows at
all). Every candidate is driven through
`EngineService.reconcileExecution(executionId)`, so recovery never depends on
remembering which step callback happened before a crash. Terminal executions
(`COMPLETED`/`FAILED`/`CANCELLED`) are excluded at the query level regardless
of what their historical compatibility rows look like, so stale `READY`/
`RETRYING`/`PENDING` rows of a finished run can never consume recovery
capacity. The scan is ordered by `(createdAt, id)` with a keyset cursor and a
fixed batch size: candidates beyond one batch are visited on later ticks, and
a short batch resets the cursor, so bounded scans eventually visit every
candidate and one long-running execution cannot starve another. The cursor is
in-memory; a restart simply re-visits (idempotently) the oldest candidates.

Templates still use bounded property traversal. Conditions use the declarative
evaluator; there is no separate policy engine.

## Execution updates

After material state changes, the Orchestrator posts only the execution ID to
the Gateway webhook. The Gateway fetches the full current execution from the
Orchestrator and emits `execution-update` through Socket.IO. Gateway delivery
failure is logged and does not roll back execution state. The frontend also
polls a selected running execution as a fallback.

A terminal result is always projected: `resumeAfterResult` pushes the update
even when the execution is already terminal (the inbox transaction made it
`FAILED` or `CANCELLED` and no downstream progression runs), so the Gateway
never misses the final state of a run.

## HTTP callback delivery

The HTTP adapter keeps a process-local replay map keyed by
agent/keyId/deliveryId. A delivery that already completed is answered as
`duplicate` without touching the handler. A duplicate that arrives while the
first delivery is still in-flight is routed through the durable result
handler instead of being rejected: the `ResultInbox` is the authoritative
deduplicator across replicas, and a worker retry should stop once the result
is durably recorded, not be forced to retry forever against a process-local
map.

## Durability boundary

PostgreSQL migrations are authoritative by default. Schema synchronization is
disabled except when disposable development explicitly sets
`NODE_ENV=development` and `TENVYR_DB_SYNCHRONIZE=true`. Pipeline snapshots,
plan revisions, logical steps, and attempt history are database-backed.

The foundation migration can be reverted only before runtime-created immutable
attempts exist. Legacy backfill records are removable during that pre-cutover
window; after a plan revision sourced from the runtime owns an attempt, rollback
fails and recovery must use a forward fix. Legacy backfilled revisions record
their plan hash as unavailable rather than claiming compatibility with the
runtime canonical SHA-256 hash.

### Legacy StepAttempt backfill mapping

The migration backfills `step_attempts` ONLY for legacy logical rows with
persisted evidence that an attempt actually existed. The pre-Milestone-0
engine incremented `attempt` at scheduling time and then wrote `RUNNING` or a
terminal status, so the mapping is:

| Legacy `step_executions.status`          | StepAttempt status | attemptNumber          |
| ---------------------------------------- | ------------------ | ---------------------- |
| `COMPLETED`                              | `SUCCESS`          | `GREATEST(attempt, 1)` |
| `FAILED`                                 | `FAILED`           | `GREATEST(attempt, 1)` |
| `CANCELLED`                              | `CANCELLED`        | `GREATEST(attempt, 1)` |
| `RUNNING`                                | `RUNNING`          | `GREATEST(attempt, 1)` |
| `PENDING`, `SKIPPED`, or any other state | — (no attempt)     | —                      |

`PENDING` rows — even with an incremented legacy counter — and `SKIPPED` rows
are scheduling state only: their dispatch outcome is ambiguous or never began,
and a fabricated `CREATED` attempt would block the partial unique
active-attempt index for the step's real first claim. No status outside
`CREATED`/`DISPATCHED`/`RUNNING`/`SUCCESS`/`FAILED`/`TIMED_OUT`/`CANCELLED` is
ever written.

The pre-Milestone-0 model overwrote retry attempts, so migration preserves only
execution facts supported by existing persisted evidence — the defensible
current/latest attempt per logical step. It does not fabricate overwritten
attempt history, and full immutable historical retry provenance is not
reconstructable before `step_attempts` existed. A later real claim continues
numbering from the legacy counter (e.g. an ambiguous `PENDING` row with
`attempt = 3` gets its real attempt #4).

`dispatch_outbox`, `result_inbox`, `result_conflicts`, `agent_events`, and
`agent_event_conflicts` are durable
control-plane records. Recovery scans persisted outbox leases, retry times,
attempt deadlines, and candidate executions, so restart does not depend on
in-process callback maps or timers. Kafka retryable result-handler failures
propagate rather than being acknowledged. HTTP still performs its fast
in-process replay check before the durable inbox; that check is an
optimization only.

Worker queues, Worker-local callback/idempotency state, Gateway notifications,
and external side effects remain outside this durability boundary. The system
does not claim exactly-once execution or external side effects.

## Budget ledger (M4)

The budget ledger is append-only execution authority, not telemetry.
`budget_accounts` hold immutable grant ceilings per dimension (canonical
integer units: `currency_micros`, `tokens`, `wall_time_ms`) with optional
soft ceilings and an optional parent account. `budget_reservations` are
idempotent pre-authorized maxima — one idempotency key can never reserve
twice, and a conflicting request is rejected while the first reservation
stays authoritative. `budget_ledger_entries` are the append-only evidence:
a reservation debits its account AND every ancestor (one entry per account,
all under the account-chain `FOR UPDATE` locks); commit records
actual/estimated usage without moving availability; release credits the
unused amount back; adjust applies a signed correction.

Availability is a pure projection of ledger truth:
`ceiling + adjusts + releases − reserves`. `unknown` usage is never zero:
the reserved maximum stays consumed unless explicit policy releases it.
Reserve/commit/release/adjust each run in one transaction with the account
chain locked in id order, so concurrent branches can never collectively
exceed a hard ceiling and a failure rolls account, reservation, entries,
and state back together. See `services/orchestrator/src/domain/budget.ts`
and `services/orchestrator/src/services/budget-ledger.service.ts`.

### Enforcement wiring (M4-S2)

Budgets are opt-in per pipeline: a pipeline may declare an execution-level
grant (`budget: { tokens, currencyMicros, wallTimeMs }`, frozen into the
plan revision) and steps may declare per-attempt reservation maxima
(`step.budget`) which are enforced at the existing transaction owners:

- **Claim** (`ExecutionService.claimRunnableStep`): the execution account is
  created from the frozen plan grant and every declared step dimension is
  reserved in the SAME transaction as the attempt + outbox — no work
  authority without a reservation. `INSUFFICIENT_BUDGET` becomes a durable
  FAILED attempt that follows the step's failure policy.
- **Result** (`ResultInboxService.apply`): reported usage
  (`usage.totalTokens` → `tokens` actual; `usage.costUsd` → `currency_micros`
  estimated, rounded to micros) is committed and the unused remainder
  released in the SAME transaction as the terminal application. A terminal
  result without usage leaves the reservation consumed (unknown is never
  zero).
- **Retries** reserve independently (the attempt number is part of the
  reservation key); a non-retryable dispatch failure releases the attempt's
  reservation in the failure transaction.
- **Cancellation** releases the full reservation of every cancelled attempt
  in the cancel transaction.

Malformed usage never rejects a canonical result: it is treated as no
report, so the reservation stays consumed. Ledger operations accept an
optional `EntityManager` so they join the owner transaction atomically.

### Policy decision boundary (M4-S3)

Policy configuration (`TENVYR_POLICY`) is trusted, versioned, minimal,
deterministic rule data — no executable strings. The first use freezes a
snapshot per version (one canonical rules hash per version; rotating the
same version is a `POLICY_VERSION_CONFLICT` safe failure — bump the
version). Every intercepted action produces a bounded `ActionProposal`
(actionType `dispatch | plan_patch | delegate | executor_action`, scope,
target, canonical hash) and an immutable `PolicyDecision` (`ALLOW | DENY |
REQUIRE_APPROVAL`, reasons, policy version/hash), stored append-only in
`policy_decisions` in the SAME transaction as the intercepted action.

Only boundaries Tenvyr can stop before side effects are intercepted. The
dispatch boundary (claim transaction) evaluates BEFORE the budget reserve:
`DENY` becomes a durable FAILED attempt following the step's failure
policy; `REQUIRE_APPROVAL` becomes a durable `ApprovalRequest` (PENDING)
with the attempt and step in `WAITING` — no autonomous progress, never a
retryable failure; `ALLOW` alone grants no authority — the budget
reservation is still required. Unlisted actions default to `ALLOW` (policy
is opt-in declarative data). PlanPatch and delegation boundaries arrive in
M5/M6.

### Approvals and WAITING (M4-S4)

One `ApprovalRequest` per intercepted action (proposalId unique). Transitions
are exactly-once under row locks: `PENDING → APPROVED | DENIED | EXPIRED`.
Approving RESUMES the same attempt (same invocationId): budget reserve →
attempt WAITING→CREATED → step WAITING→RUNNING → the single outbox row;
replay returns the same outcome and never mints a second dispatch identity.
Denying fails the attempt durably per the step's failure policy. Expiry is a
deterministic time-based transition; the recovery cycle's `expireDue` sweep
terminalizes due requests (WAITING is never a retryable failure).
Approval/cancel/result/expiry races serialize on the request + attempt +
step row locks and the loser no-ops.

### Inheritance, cancellation, and child outcome (M6-S4)

A child can never exceed its parent:

- **Depth + fanout (server-derived)** — the child's depth is the parent's
  depth + 1 (derived from the `childExecutionId` linkage, never from the
  runtime), bounded by `DELEGATION_BOUNDS.maxDepth` (3); per-attempt
  request fanout is bounded (`maxRequestsPerAttempt` 10). Both are
  enforced at request time and rechecked at approval.
- **Budget subset** — the child pipeline's grant must be a per-dimension
  subset of the parent execution's budget account; its execution account
  is linked to that parent, so every child-attempt reservation traverses
  the ancestor ledger and concurrent siblings cannot overspend. A parent
  without a grant cannot have a budgeted child (approval rejects).
- **Policy + deadline** — approval records a `delegate` policy decision
  before materialization. The parent attempt's frozen deadline becomes the
  child execution's `authorityDeadlineAt`; the shared claim transaction caps
  every child attempt to it and fails the child execution once it has elapsed.
- **Agent/executor classes + credentials** — the child is a normal
  execution: its dispatch claims cross the same policy boundary, and
  credentials stay reference-only through the transport config.
- **Cancellation cascade (durable, deterministic)** — the recovery cycle
  cancels every APPROVED child of a CANCELLED parent in deterministic
  order (createdAt, id), bounded per cycle and crash-resumable; a
  cancelled parent never leaves a runnable orphan.
- **Child outcome** — child work is explicit workflow work: a failed or
  completed child NEVER terminalizes its parent (the parent never
  waited); late child results follow the normal late-result machinery.

The current runtimes (local-executor-host, worker SDK) have NO durable
pause/resume capability, so the load-bearing contract resolves to the
plan's second direction: supervised child work is EXPLICIT WORKFLOW WORK
outside a paused in-runtime attempt. The parent attempt is never
suspended: a delegation request does not change the parent's lifecycle
(the parent completes normally; supervision applies unchanged — a pending
request is NOT a heartbeat exemption, and a stale parent attempt is
terminalized deterministically). The delegation request channel is
service-level (approvals-style); runtimes with durable pause/resume may
later enter a Tenvyr-owned delegation wait state, but neither AgentEvent
nor the terminal AgentResult is ever a delegation request channel
(observed evidence is evidence only — it never promotes to a request).
Due delegation requests are expired by the recovery cycle (same sweep
ownership as approvals).

Authoritative supervised delegation is a durable, parent-attempt-scoped
request: `delegation_requests` (unique (parentAttemptId, requestId),
PENDING → APPROVED|REJECTED|EXPIRED, deterministic expiry). Requesting is
idempotent only for the same canonical payload; a reused identity with a
different payload records append-only conflict evidence and creates no
authority. Approving materializes the
child Execution — execution row, plan revision 1, logical steps — via the
manager-aware materializer INSIDE the decision transaction (all-or-none)
and links `childExecutionId`; the child is a normal schedulable
execution. Decisions are terminal and CAS-guarded: concurrent approves
materialize exactly one child; an expired/rejected request is never
approved. The closure migration adds durable execution/attempt foreign
keys and parent/child query indexes without historical backfill.

Native runtime delegation is declared per step (`delegation`):

- **opaque** (default) — the runtime may delegate invisibly; Tenvyr
  records NOTHING and never invents child lineage.
- **observed** — the runtime may attach bounded delegation evidence
  (`result.delegation`, ≤ 32 observations, each provider/childId/
  assertedAt + ≤ 16 bounded attributes) to its canonical result. The
  orchestrator persists each observation as inert, hash-pinned evidence
  correlated to the parent attempt (`delegation_observations`, identity
  `provider:childId` per attempt; duplicates idempotent; a differing
  redelivery is a result-level conflict). Observations NEVER schedule,
  spend, cancel, or terminalize work.
- **supervised** — declared semantics arrive with M6-S2+ (currently
  rejected at validation; no silent degradation).

An execution may adapt its UNSTARTED work through bounded structured
proposals: `PlanPatch` (schema v1) carries a `baseRevision` and a sequence
of `addStep` / `replaceUnfrozenStep` operations (≤ 20 ops, ≤ 64 KiB
UTF-8, sequential deterministic application, replacement targets must
exist, must NOT be frozen, and the replacement's `step.id` must equal
`stepId`). The whole candidate plan is validated through the exact same
safe pipeline validation as a new pipeline (`validateSteps`: bounds,
identifiers, graph/cycles, fanout/depth, durations, retries, budgets,
conditions).

`plan_proposals` persists every proposal immutably (numbered per
execution, hash-pinned, `PENDING → ACCEPTED|REJECTED|STALE` terminal
decisions). `activate` runs the whole activation in ONE transaction under
the same execution row lock as claims: CAS the active revision against
`baseRevision` (moved base → STALE), protect every frozen step (any
logical step with attempts → REJECTED), validate the candidate, insert
the new revision (`revisionNumber + 1`, parent + base recorded), materialize
added logical rows, and switch the active pointer — a crash rolls
everything back and the proposal stays PENDING (retryable); a committed
decision is final and idempotent. The plan grant (budget envelope) is
carried over unchanged. The Planner trigger (M5-S3): a step marked `planner: true` is a
supervised Planner step — its result output must be a bounded PlanPatch,
which the result application persists as a PENDING proposal INSIDE the
canonical result transaction (baseRevision pinned to the active revision;
the planner never receives execution authority). An invalid patch is a
deterministic `PLANNER_PROPOSAL_INVALID` rejection following the step's
retry/onFailure policy; late planner results under a terminal execution
propose nothing.

### Telemetry projection (M7-S4)

`projectTelemetry` derives a bounded OTLP-JSON-shaped projection from the
capsule (one root span per execution, one span per terminal attempt, one per
supervised delegation child; deterministic trace/span ids from stable
identities, globally capped at 101 spans). Span names are static
(`pipeline.execute`, `step.execute`, `delegation.execute`); dynamic ids are
bounded attributes. The convention mapping is pinned in one place; a future exporter
consumes exactly that shape. Telemetry is NEVER authoritative: the
projection is a pure read, never written back, and cannot influence
lifecycle. W3C trace context is propagated OUTBOUND ONLY: the HTTP
adapter adds a deterministic `traceparent` (`00-<traceId>-<spanId>-01`)
derived from the invocation's own trace identity — inbound trace headers
are never trusted, so foreign trace/baggage can never widen authority or
capture.

`compare(a, b)` structurally compares two capsules over STABLE logical
identities: step drift (id + step-config hash: identical/drifted/
present*in_a_only/present_in_b_only) and outcome drift (per-step terminal
attempt status: same/drifted/no_evidence*\*; null-vs-null is "same").
Truncated sections mark their category `unavailable` — no conclusion is
drawn; runtime-asserted delegation evidence is a separate
`runtimeClaims` section and NEVER part of drift conclusions.
`provenance(executionId)` derives a bounded graph distinguishing
authority edges (revisions/attempts/budget/policy/supervised delegation
— durable facts) from claim edges (observed delegation — runtime
assertions) and exposure edges (M2 artifact exposures, read through the
claim seam's bounded API; never overclaimed as semantic use).

`createExport` persists a SMALL immutable export manifest pinning an
execution to its capsule content hash (`execution_exports`, unique
(executionId, capsuleHash)) — the manifest never duplicates execution
truth. `replay` builds the source capsule (TERMINAL sources only), pins
the ACTIVE revision by its plan hash, and materializes a NEW execution
from the CAPTURED plan + the authoritative immutable source input (never
the current pipeline) in
one transaction with the idempotent replay row (`execution_replays`,
unique (sourceExecutionId, sourceCapsuleHash) — one replay per capsule).
All authority is RE-EVALUATED by the normal claim machinery: the replay
target crosses the CURRENT policy/budget/credentials; historical
approvals are never copied.

`ExecutionCapsuleService.build` assembles the versioned, bounded Execution
Capsule V1 read model inside a REPEATABLE READ transaction (one
point-in-time snapshot): execution header (pipeline hash/version, bounded
input, configuration), immutable plan revisions (number/hash/source/
reason/validation/budget/steps), bounded attempts with input/context
snapshot hashes, outbox/inbox/conflict/event counts, ExecutionState
version/hash and state-write count, artifact producer/exposure counts,
budget account + reservations, bounded real policy-decision identities,
approval counts, and exact M6 delegation totals plus bounded edges.
Terminal executions produce terminal capsules; live
captures are labelled `pointInTime: "live"`. Every bound that bit
(revisions > 20, attempts > 100, input > 64 KiB) is recorded as an
`evidenceCompleteness` warning; `contentHash` is stable over the durable
facts (volatile capture fields excluded) so identical states compare
equal. Service-level only — export and public download land in M7-S2
behind the exposure gate.

Activation is intercepted by the policy boundary BEFORE any activation
authority: `plan_patch` proposals (id `plan:<proposalId>`, no agent target)
are evaluated inside the activation transaction. DENY → the proposal is
durably REJECTED with the decision evidence committed atomically;
REQUIRE_APPROVAL → a durable `plan_patch` approval request is created and
the proposal stays PENDING. Approving re-activates INSIDE the approval
transaction and RECHECKS everything: base revision CAS (a stale approved
proposal becomes STALE), frozen steps, candidate validity, and policy (a
now-denied proposal is REJECTED even with a grant). The plan grant and
growth bounds are unchanged from M5-S2/S1: the patch contract has no
budget operations and the candidate validation bounds step/depth/fanout
growth structurally.

An execution may adapt its UNSTARTED work through bounded structured
proposals: `PlanPatch` (schema v1) carries a `baseRevision` and a sequence
of `addStep` / `replaceUnfrozenStep` operations (≤ 20 ops, ≤ 64 KiB,
sequential deterministic application, replacement targets must exist and
must NOT be frozen). The whole candidate plan is validated through the
exact same safe pipeline validation as a new pipeline (`validateSteps`:
bounds, identifiers, graph/cycles, fanout/depth, durations, retries,
budgets, conditions). Activation, proposal durability, and base-revision
CAS arrive in M5-S2; the Planner trigger in M5-S3; policy/budget/approval
enforcement on proposals in M5-S4.

### Hierarchy completeness (M4-S5)

Child grants are fully bounded by ancestor REMAINING grants at every
boundary. The execution account's parentage comes from the frozen plan
(`budget.parent` scope reference): the parent must be an
operator-created account (missing → `ACCOUNT_NOT_FOUND` safe failure), the
execution grant must be a subset of the parent grant
(`CHILD_CEILING_EXCEEDS_PARENT`), and every reserve/approve-resume debits
the whole chain so no ancestor can ever be overspent. `adjust` now
propagates to the whole chain: a child top-up debits its ancestors (and is
rejected when any ancestor lacks the room), a child reduction credits them
back — the root account's adjust remains the operator's pure grant. No
budget path can mint availability across the hierarchy; the dynamic
boundary (a reserve fails when it would exceed any ancestor's remaining
grant) is the invariant.
