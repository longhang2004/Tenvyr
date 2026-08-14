---
title: Coordinator Loop Domain (M9)
status: current
audience:
  - developer
last_verified: 2026-08-12
sources:
  - services/orchestrator/src/domain/coordination.ts
  - services/orchestrator/src/domain/coordination.spec.ts
  - docs/plans/active/tenvyr-productization-roadmap/M9-supervised-agent-team-execution/SPEC.md
---

# Coordinator loop domain (M9-S1)

## Purpose

The Coordinator is deterministic Tenvyr control-plane code plus supervised
agent roles: Planner proposes a bounded `TaskBatchProposalV1`, Workers
execute bounded tasks through existing attempts/executors, and the Verifier
proposes `ACCEPT | CONTINUE | FAIL | WAIT_FOR_HUMAN`. The Coordinator alone
validates, persists, schedules, waits, and terminalizes. Planner/Verifier
receive no repositories, transactions, dispatch access, mutable pipeline
entities, or secret values.

## Implemented (slice 1 — pure semantics)

`services/orchestrator/src/domain/coordination.ts` is a pure domain module
with no persistence or dispatch coupling:

- **`CoordinationConfigV1`**: frozen team configuration — Planner/Verifier
  selections (`agent` or M8 `connection`), worker allowlist, `maxIterations`
  (≤100), `maxWorkersPerIteration` (≤64), `maxTotalWorkers` (≤1024),
  `loopDeadlineMs`, optional budget account reference, `delegationDepthMax`
  (≤3), and `allowedExecutors`. Hard maxima cannot be raised by a decision.
- **Phase machine**: `PLANNING -> BATCH_VALIDATION -> WORKING -> VERIFYING ->
  DECIDING`, `CONTINUE` returns to PLANNING, `WAIT` enters
  `WAITING_FOR_HUMAN` (approval re-enters DECIDING, denial FAILED), terminal
  `ACCEPTED | FAILED | CANCELLED | LIMIT_REACHED` absorb every event.
- **`TaskBatchProposalV1`**: stable task IDs (safe charset), agent or
  connection selector, bounded JSON input, in-iteration acyclic
  dependencies, `required` flag, bounded reason, optional bounded
  timeout/retry. Cannot carry a verifier, coordinator, command, secret
  value, or nested loop. `validateTaskBatchProposal` enforces the allowlist,
  iteration and cumulative worker limits against the frozen config.
- **`VerifierDecisionV1`**: versioned, iteration-bound, bounded reason and
  evidence references, optional recommendation. Canonical hash gives
  idempotency; identical identity with a different payload is a conflict
  that changes nothing. No executable content, no limit changes.
- **`fanInReady`**: all required workers terminal (any durable outcome
  after retries); optional failures never fail the loop by themselves.
- **`buildVerifierContext`**: bounded deterministic aggregation — worker
  summaries truncated with recorded omission metadata, explicitly selected
  output fields and ExecutionState keys, bounded artifact refs (never
  bytes), prior decision summary, current limits and remaining budget/
  deadline facts, evidence ids. Secrets, raw logs, chain of thought, and
  unselected artifacts cannot enter by construction.

## Durable run/iteration authority (slice 2 — implemented)

- `CoordinationRunEntity`: one run per execution (`UNIQUE
  coordination_run_execution`), frozen `config` (planner/verifier/worker
  selections, limits, budget), phase machine, `currentIterationNumber`,
  `cumulativeWorkers`, `loopDeadlineAt`, optimistic `version`.
  `CoordinationIterationEntity`: per-iteration identity, planner step id,
  proposal/attempt/revision bindings, worker manifest, verifier step,
  consumed decision.
- `startRun` / `startRunWithManager`: run creation enforces the FULL
  authority chain inside the create transaction on BOTH paths — role
  connection claims (REVOKED denies) and the frozen executor allowlist for
  the Planner and Verifier selections — so the Workbench/managed path can
  never bypass run-level restrictions. Concurrent equivalent starts
  serialize on the execution row lock and converge on exactly one run
  (unique-violation re-read as the backstop); no raw 23505 leaks for an
  equivalent duplicate start.

- Migration `1722270015000-MilestoneNineCoordination`: `coordination_runs`
  (one-to-one with executions; frozen config + hard limits, phase, current
  iteration, cumulative workers, loop deadline, active iteration, guarded
  version) and `coordination_iterations` (stable id, UNIQUE (run, number),
  planner attempt/proposal, accepted plan revision, bounded worker manifest
  referencing LogicalStep ids with required/optional, verifier step/attempt,
  immutable consumed decision + canonical hash, outcome; UNIQUE consumed
  verifier attempt per run).
- `RuntimeCoordinationService`: idempotent `startRun`; `createNextIteration`
  (exactly-once via UNIQUE constraint); guarded `transitionRun`;
  `consumeDecision` — one-winner guarded update (`decisionHash IS NULL`),
  idempotent identical deliveries, conflict on different payload while live,
  `DECISION_STALE` on mismatched iteration identity; ACCEPT/FAIL/
  WAIT_FOR_HUMAN/CONTINUE transitions with `LIMIT_REACHED` at hard limits;
  `recoverRun` (PostgreSQL-only recovery); `isCompletionHeld`.
- Lock order (documented): CoordinationRun row first, then iteration, then
  existing records — 100-way same-decision CONTINUE serializes to exactly
  one next iteration.
- Completion hold wired at the engine choke point: a live run prevents the
  generic engine from marking the Execution COMPLETED; ACCEPTED releases.

## Planner-to-batch integration (slice 3 — implemented)

- `createPlannerStep`: the Coordinator creates the iteration's Planner
  logical step (`planner-<n>`, fixed agent from the frozen config) through
  the existing PlanPatch/proposal/activation authority. The step is NOT
  marked `planner: true` (the M5 result-inbox would intercept its
  TaskBatchProposalV1 output as a PlanPatch); batch recursion is guarded in
  `validateTaskBatchProposal` — the batch can never select the Planner or
  Verifier agent.
- `submitIterationBatch`: Coordinator validates the untrusted batch against
  the frozen config and cumulative worker limits, compiles it plus ONE
  Coordinator-owned Verifier step (`verify-<n>`, depends on every member,
  `onFailure: stop`) into the restricted PlanPatch via
  `compileIterationPlanPatch` (optional workers get `onFailure: continue` —
  failure is evidence, never a stranded DAG), activates the new immutable
  plan revision through the existing proposal authority, and atomically
  binds: frozen planner proposal + attempt id, accepted revision,
  worker manifest (taskId → materialized LogicalStep id, required flags),
  verifier step id, cumulative worker count, and phase
  (PLANNING → BATCH_VALIDATION → WORKING). Rejection is bounded failure
  evidence — no partial materialization. Connection-kind worker selectors
  are recorded on the step (`metadata.tenvyrConnectionId`); dispatch-time
  enforcement lands with slice 5.
- M9-S8 admission gates (closure hardening):
  - EXACT iteration identity — a batch is only admissible for
    `run.currentIterationNumber`; older (already consumed) and future (not
    yet authorized) iterations are rejected deterministically.
  - Planner attempt ownership — the referenced StepAttempt must exist,
    belong to the same execution, be the attempt of THIS run's
    Coordinator-owned Planner step for THIS iteration, be terminal SUCCESS,
    and carry a frozen plan revision. An arbitrary unrelated successful
    attempt id is never accepted.
  - Strict base revision — `TaskBatchProposalV1.baseRevision` must equal
    the Planner attempt's FROZEN plan revision AND the execution's current
    active plan revision. If an authorized PlanPatch activated while the
    Planner ran, the proposal is deterministically STALE: the run fails
    with bounded evidence and NO worker work is activated. The value is
    never silently rewritten to whatever happens to be active on arrival.
  - The Planner step input carries the frozen plan revision
    (`planRevision`) so a truthful Planner can declare it.

## Fan-out/fan-in/decision execution (slice 4 — implemented)

- `reconcileCoordination` (engine hook, PostgreSQL-only): PLANNING — the
  Coordinator auto-creates the next iteration's Planner step, consumes the
  Planner attempt result (TaskBatchProposalV1) into `submitIterationBatch`;
  WORKING — deterministic fan-in (`fanInReady` semantics: every required
  worker terminal; a required failure terminalizes the run FAILED);
  VERIFYING — the Verifier attempt result (VerifierDecisionV1) is consumed
  atomically. Execution CANCELLED/FAILED propagation terminalizes the run.
- Verifier aggregation frozen at claim time: the engine's claim hook
  (`isCoordinationVerifierStep` + `buildVerifierInput`) materializes the
  bounded `VerifierContextV1` (worker taskId/status/failureCode, bounded
  selected fields, bounded artifact refs, limits, prior decision) into the
  attempt — later outcomes can never change a frozen input.
- `resolveWait`: explicit WAIT resolution — approve rechecks run-level hard
  limits and continues the loop; deny terminalizes FAILED.
- The full deterministic loop is proven end-to-end with deterministic
  Workers through the existing claim/outbox/inbox machinery: two CONTINUE
  iterations, bounded aggregation at the Verifier claim, ACCEPT releasing
  the completion hold, required-worker failure → FAILED, WAIT →
  approve/deny.

## Authority integration (slice 5 — implemented)

- Loop wall-clock budget: `loopDeadlineAt` is rechecked at CONTINUE,
  batch admission, WAIT resolution, and in every live phase during
  reconciliation — expiry is deterministic `LIMIT_REACHED` evidence, no
  more workers.
- Run-level budget account: when `budgetAccountId` is configured, CONTINUE
  and batch admission project the ledger account; an exhausted or missing
  account stops the loop deterministically (per-worker spend stays the
  existing per-step claim reserves).
- M8 revocation: a batch may only admit workers whose selected connections
  are currently claimable — a REVOKED (or missing) connection rejects the
  batch deterministically before anything reaches PlanPatch.
- Cancellation: cancelling a coordinated execution mid-loop terminalizes
  the run CANCELLED through the existing whole-execution semantics.
- Capsules project the loop: bounded `coordination` section (run phase,
  iteration numbers, worker/required counts, verifier step, consumed
  decision action + hash, outcome) — provenance only, never duplicated
  authority.
- Replay of a coordinated execution creates a NEW CoordinationRun from the
  frozen team template with a FRESH deadline; current connections,
  credentials, policy, approvals, budgets, and permissions re-resolve
  through the normal claim/consume authority.

## Deterministic team example (slice 6 — implemented)

`services/orchestrator/src/m9-team-example.spec.ts` runs a real team —
deterministic Planner, Worker, and Verifier agents on the reviewed
`@tenvyr/worker` SDK — through the CURRENT HTTP Worker transport end to
end against PostgreSQL: engine reconcile, outbox dispatch, signed
callbacks, result inbox, the Coordinator loop (Planner → batch → workers →
fan-in → bounded aggregation → Verifier → CONTINUE → iteration 2 → ACCEPT),
completion-hold release (Execution COMPLETED), and the Capsule projection.
The Verifier echoes its iteration identity from the frozen context; the
Coordinator rejects mismatched identity (anti-replay).

## M9 milestone surface

- Loop authority: `CoordinationRun` (one-to-one with an Execution) +
  `CoordinationIteration` (unique per run/number; frozen planner proposal,
  accepted plan revision, bounded worker manifest, immutable consumed
  decision + canonical hash, unique consumed verifier attempt).
- Coordinator is the only writer of loop truth: Planner/Verifier produce
  untrusted proposals/decisions; the Coordinator validates, compiles,
  activates, schedules, waits, and terminalizes. No Planner recursion, no
  Verifier smuggling, no partial materialization, deterministic
  LIMIT_REACHED/FAILED/CANCELLED evidence.
- Completion hold: a live loop prevents the generic engine from marking the
  Execution COMPLETED; ACCEPTED releases it.
- Authority rechecks: hard limits, loop deadline, run-level budget account,
  M8 connection revocation at batch admission, cancellation propagation,
  and approval rechecks — all from PostgreSQL only.
- Capsule `coordination` projection (bounded, provenance-only); replay
  re-creates a fresh run from the frozen team template with a fresh
  deadline.

## Guarantees

- Hard bounds live in one frozen place and cannot be raised by any proposal
  or decision payload.
- Planner/Verifier input is untrusted and validated at every trust
  boundary; nothing they return can create authority.
- Decisions are idempotent by canonical identity; stale or conflicting
  decisions change nothing.
- Aggregation is explicit-selection and byte-bounded with deterministic
  truncation metadata.
