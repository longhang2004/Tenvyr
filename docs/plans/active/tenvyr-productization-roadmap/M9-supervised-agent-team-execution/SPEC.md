---
title: "M9 Specification: Supervised Agent Team Execution"
status: planned
audience:
  - developer
last_verified: 2026-08-12
sources:
  - docs/plans/active/tenvyr-productization-roadmap/M9-supervised-agent-team-execution/PLAN.md
  - docs/architecture/control-plane.md
  - docs/archive/plans/tenvyr-roadmap/M5-dynamic-planner/SPEC.md
  - docs/archive/plans/tenvyr-roadmap/M6-delegation-subagents/SPEC.md
---

# M9 Supervised Agent Team Execution specification

## Coordinator identity and authority

Coordinator is deterministic Tenvyr control-plane code plus supervised agent roles:

- Planner proposes a bounded `TaskBatchProposalV1`;
- Workers execute bounded tasks through existing attempts/executors;
- Verifier proposes `ACCEPT | CONTINUE | FAIL | WAIT_FOR_HUMAN`;
- Coordinator alone validates, persists, schedules, waits, and terminalizes.

Neither Planner nor Verifier receives repositories, transactions, dispatch access,
mutable pipeline entities, secret values, or permission to create another iteration.

## Durable model

`CoordinationRun` is a minimal one-to-one authority extension of an Execution. It
freezes team configuration and hard limits, phase, current iteration number,
cumulative worker count, loop deadline, active iteration, and version. It is not a
second Execution or user-facing workflow resource.

`CoordinationIteration` supplies the persistence current primitives lack: stable ID,
unique `(coordinationRunId, number)`, Planner attempt/proposal, accepted plan revision,
bounded worker manifest, Verifier step/attempt, immutable consumed decision/hash,
and terminal iteration outcome. Worker work itself is never duplicated here; the
manifest references LogicalStep IDs and marks each `required` or `optional`.

No separate TaskBatch or AgentTeamRun table exists. Plan revisions, attempts,
ResultInbox, artifacts, policy/budget decisions, and Capsules remain their existing
authorities.

## Configuration and hard bounds

Freeze at start: Planner/Verifier connection revisions or selection rules; allowed
worker agents/connections; `maxIterations`; `maxWorkersPerIteration`;
`maxTotalWorkers`; existing graph depth/fanout/step bounds; planning-operation and
payload bounds; budget grants; deadline/wall time; delegation depth; policy,
approval, permissions, and allowed executors. Hard maxima cannot be raised by a
Verifier decision or ordinary approval. Operator correction, if supported, is a
separate audited authority action and never implicit.

## State machine

```text
PLANNING -> BATCH_VALIDATION -> WORKING -> VERIFYING -> DECIDING
   ^                                                |
   |-- authorized CONTINUE -> next iteration -------|
   `-- WAITING_FOR_HUMAN <- WAIT/approval required

DECIDING -> ACCEPTED | FAILED | CANCELLED | LIMIT_REACHED
```

Every phase transition locks the CoordinationRun first, then iteration/execution and
existing records in a documented deterministic order. A unique iteration constraint,
guarded version/phase update, and unique consumed Verifier attempt ensure one winner.
Recovery reads PostgreSQL only; no process-local queue or timer is loop truth.

## Iteration creation and TaskBatch

Coordinator creates the next configured Planner step from a trusted team template;
Planner cannot add Planner steps. Planner output is a versioned bounded batch of
complete Worker proposals: stable task ID, agent/connection selector, bounded input,
dependencies within the iteration or on approved prior facts, required flag, budget,
timeout/retry, context projection, and reason. It cannot add a verifier, coordinator,
executable condition, secret reference, arbitrary command, or nested loop.

Coordinator validates current phase/base revision, all hard bounds, allowed
runtimes, DAG, budget, deadline, policy/approval, then compiles the batch plus one
trusted configured Verifier step into the existing restricted PlanPatch. Revision,
logical rows, iteration manifest, counters, and phase change commit atomically or
not at all. Planner rejection is bounded failure/retry evidence, not partial work.

## Fan-out, fan-in, and worker failures

Each manifest entry points to exactly one LogicalStep. Parallel scheduling is the
existing DAG scheduler, bounded by graph and connection/executor capacity. Verifier
depends on every member and uses failure-continuation semantics so exhausted worker
failure/timeout is evidence rather than a stranded DAG.

`all required workers finished` means every required manifest LogicalStep has one
durable terminal outcome after its configured retries. Optional workers are also
awaited once admitted to the batch; their failure does not by itself require FAIL.
Execution-level cancellation or a canonical worker `cancelled` result preserves the
existing whole-execution CANCELLED semantics and skips verification. Initial M9 has
no independent per-worker cancellation claim.

Budget/deadline exhaustion before fan-in creates deterministic `LIMIT_REACHED` or
`FAILED` evidence and no more workers. A policy decision requiring approval or a
Verifier WAIT creates durable WAITING; approval rechecks every current authority.

## Bounded aggregation

Verifier receives a new immutable ContextSnapshot assembled from:

- stable worker IDs/roles/status/failure codes and bounded result summaries;
- explicitly selected output fields, not complete raw results;
- bounded ArtifactRefs and lineage, never fetched bytes;
- selected ExecutionState keys and prior decision summary;
- current iteration/cumulative limits and remaining budget/deadline facts;
- relevant policy/approval evidence and Capsule subset identifiers.

Per-field/item/byte limits and deterministic truncation/omission metadata apply.
Secrets, raw logs, chain of thought, complete Capsule dumps, unselected artifacts,
and provider auth never enter aggregation.

## Verifier decision contract

`VerifierDecisionV1` includes version, iteration ID/number, action, bounded reason,
criteria/evidence references, and optional next-iteration recommendation. It cannot
contain executable work or change limits.

- `ACCEPT`: Coordinator marks loop accepted and authorizes normal execution
  completion only after rechecking authority.
- `CONTINUE`: proposal only. Coordinator checks max iterations/total workers,
  planning operations, budget, deadline, policy, approval, permissions, connection
  availability, delegation limits, and current phase. If allowed, atomically creates
  the next iteration and Planner step; otherwise WAIT/DENY/FAIL with reason.
- `FAIL`: terminal FAILED under the first committed authority transition.
- `WAIT_FOR_HUMAN`: durable WAITING with bounded request/context; approve/deny/expiry
  rechecks phase, decision identity, limits, budget, deadline, policy, and runtime.

Duplicate identical decision delivery is idempotent; same attempt/identity with a
different payload is conflict evidence and changes nothing. Stale decisions never
rebase. The Coordinator completion hold prevents the generic engine from marking the
Execution COMPLETED while a live coordination phase or unconsumed decision exists.

## Recovery, races, and persistence

After restart, run + iteration + immutable plan/attempt facts answer exactly:
current iteration, phase, member set, terminal Workers, Verifier readiness/attempt,
decision pending/consumed, counters, bounds, and wait reason. Reconciliation may
repeat safely. Two coordinators racing CONTINUE yield one next iteration; crash after
commit before reconcile rediscovers the Planner; crash before commit creates none.

## Replay, Capsule, and compatibility

Capsules project loop configuration, iterations, worker manifests, decisions,
policy/budget/approval facts, artifacts, and bounded delegation graph without
duplicating authority. Replay creates a new CoordinationRun from source goal/team
template but resolves current connections, credentials, policy, approvals, budgets,
permissions, and deadline. Old executions/pipelines without coordination remain
unchanged; protocol-v1 Workers need no loop intelligence.

## End-to-end example

Iteration 1 Planner proposes implementation, tests, and review Workers. One optional
review fails; required implementation/tests finish. Verifier receives bounded facts
and returns CONTINUE. Two replicas process it: one creates iteration 2, the other sees
the consumed decision. Current budget permits two more Workers. Iteration 2 Verifier
returns ACCEPT; Coordinator releases the completion hold and the Execution completes
with one Capsule containing both iterations.

## Non-goals

No LLM-owned authority, recursive Planner, unbounded loop, hidden subagent inference,
per-worker kill guarantee, cross-control-plane federation, semantic artifact-byte
verification, or deterministic model replay.
