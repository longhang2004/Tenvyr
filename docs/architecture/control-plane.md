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
records now (artifact/usage records arrive in later milestones); it never
rewrites a terminal result.

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

Canonical event payloads are bounded at 64 KiB, SHA-256 hashed for identity
comparison, and stored with worker-reported `occurredAt` (audit evidence only)
plus server-assigned `receivedAt` (the liveness authority).

### Liveness projection

Each applied event updates server-received liveness fields on the active
`StepAttempt`, only while the attempt is non-terminal:

- `accepted` → `acceptedAt`;
- `heartbeat` → `lastHeartbeatReceivedAt`;
- `progress` → `lastProgressReceivedAt`;
- any applied event → `lastEventReceivedAt`.

A `DISPATCHED` attempt becomes `RUNNING` exactly once, guarded by the status
predicate, with `startTime` preserved if already set. Late events after a
terminal result remain append-only evidence and never touch these columns.

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
(`DISPATCHED`/`RUNNING`) of agents that opted in, ordered by dispatch time and
last heartbeat, with per-attempt error isolation:

- **Rule A — `AGENT_ACCEPTANCE_TIMEOUT`** (`retryable: true`): a `DISPATCHED`
  attempt that received no event and whose persisted `dispatchedAt` plus
  `startupGraceMs` has elapsed.
- **Rule B — `AGENT_HEARTBEAT_STALE`** (`retryable: true`): a `RUNNING`
  attempt whose persisted `lastHeartbeatReceivedAt` plus `staleAfterMs` has
  elapsed.

Both rules terminalize through the same `ResultInbox` path as persisted
deadline recovery, producing a synthetic `timed_out` `AgentResult`, so
cancel-versus-watchdog race correctness, workflow retry policy, and replica
deduplication all hold.

### Determinism

Synthetic results are deterministic across replicas: `completedAt` is derived
from PERSISTED timestamps plus configured durations (dispatch time + grace, or
last server-received heartbeat + `staleAfterMs`), never the recovery tick
time. Every replica that times out the same attempt constructs the identical
canonical payload and payload hash, so the inbox deduplicates instead of
recording a conflicting payload. Server `receivedAt` timestamps are the
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

| Legacy `step_executions.status` | StepAttempt status | attemptNumber |
| ------------------------------- | ------------------ | ------------- |
| `COMPLETED`                     | `SUCCESS`          | `GREATEST(attempt, 1)` |
| `FAILED`                        | `FAILED`           | `GREATEST(attempt, 1)` |
| `CANCELLED`                     | `CANCELLED`        | `GREATEST(attempt, 1)` |
| `RUNNING`                       | `RUNNING`          | `GREATEST(attempt, 1)` |
| `PENDING`, `SKIPPED`, or any other state | — (no attempt) | — |

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
