---
title: "Tenvyr M9 Implementation Report: Supervised Agent Team Execution"
status: planned
audience:
  - product
  - developer
last_verified: 2026-08-12
sources:
  - docs/plans/active/tenvyr-productization-roadmap/EXECUTION_STATUS.md
  - docs/plans/active/tenvyr-productization-roadmap/M9-supervised-agent-team-execution/PLAN.md
  - docs/plans/active/tenvyr-productization-roadmap/M9-supervised-agent-team-execution/SPEC.md
  - docs/plans/active/tenvyr-productization-roadmap/M9-supervised-agent-team-execution/VERIFY.md
---

# M9 Supervised Agent Team Execution — implementation report

Provisional implementer report. Sol audits closure; this document cannot
write `PASS`, `SAFE TO CLOSE`, or `CLOSED`.

## Implemented

- Pure Coordinator semantics (`domain/coordination.ts`): frozen
  `CoordinationConfigV1` with hard bounds (maxIterations ≤100,
  maxWorkersPerIteration ≤64, maxTotalWorkers ≤1024, deadline, budget
  account reference, delegation depth, executor allowlist), full phase
  machine with terminal absorption, `TaskBatchProposalV1` parse +
  `validateTaskBatchProposal` (allowlist, iteration/total limits,
  acyclicity, hostile metadata rejected), `VerifierDecisionV1` parse with
  canonical-hash idempotency and same-identity-different-payload conflict,
  `fanInReady` required/optional semantics, bounded deterministic
  `buildVerifierContext` with truncation metadata.
- Durable run/iteration authority (migration
  `1722270015000-MilestoneNineCoordination`): `coordination_runs`
  (one-to-one with an Execution; frozen config, phase, current iteration,
  cumulative workers, loop deadline, active iteration, guarded version) and
  `coordination_iterations` (stable id, `UNIQUE (run, number)`, planner
  attempt/proposal, planner step id, accepted plan revision, bounded worker
  manifest referencing LogicalStep ids with required/optional, verifier
  step/attempt, immutable consumed decision + canonical hash, outcome;
  `UNIQUE (run, verifierAttemptId)` one-winner backstop).
- `RuntimeCoordinationService`: idempotent `startRun`; `createNextIteration`
  (exactly-once); guarded `transitionRun`; `consumeDecision` (one-winner
  guarded update, idempotent identical deliveries, conflict on different
  payload while live, `DECISION_STALE` on identity mismatch; ACCEPT/FAIL/
  WAIT_FOR_HUMAN/CONTINUE/LIMIT_REACHED); `resolveWait` approve/deny with
  authority recheck; `recoverRun` (PostgreSQL-only recovery);
  `isCompletionHeld`; deterministic `reconcileCoordination`.
- Lock order (documented): CoordinationRun row first, then iteration, then
  existing records — 100-way same-decision CONTINUE serializes to exactly
  one next iteration.
- Planner-to-batch over the existing PlanPatch/proposal/activation
  authority: `createPlannerStep` (Coordinator-owned planner step with its
  iteration-number input; NOT `planner: true` so the M5 result-inbox does
  not intercept the TaskBatchProposalV1 output) and `submitIterationBatch`
  (validate → compile workers + ONE Coordinator-owned verifier step →
  propose/activate → atomic bind of proposal, attempt, revision, manifest,
  verifier step id, cumulative workers, phase). No Planner recursion (the
  batch can never select the Planner or Verifier agent), no partial
  materialization.
- Fan-out/fan-in/decision loop wired into the engine: auto planner-step
  creation per iteration, planner result → batch, fan-in (required workers
  terminal; required failure terminalizes), verifier result → atomic
  consume; execution CANCELLED/FAILED propagation; claim-time bounded
  Verifier aggregation (`buildVerifierInput` — taskId/status/failureCode,
  bounded selected fields, bounded artifact refs, limits, prior decision)
  frozen in the attempt, secret-free.
- Authority integration: loop wall-clock deadline rechecked at
  CONTINUE/admission/WAIT/reconcile (deterministic LIMIT_REACHED);
  run-level budget account gate via the ledger projection; M8 connection
  revocation gate at batch admission; cancellation propagation; Capsule
  `coordination` projection (bounded, provenance-only); replay re-creates
  a fresh run from the frozen team template with a fresh deadline.
- Completion hold at the engine choke point: a live loop prevents the
  generic engine from marking the Execution COMPLETED; ACCEPTED releases.
- Deterministic team example (`m9-team-example.spec.ts`): real Planner/
  Worker/Verifier agents on the reviewed `@tenvyr/worker` SDK through the
  CURRENT HTTP Worker transport end to end — engine reconcile, outbox
  dispatch, signed callbacks, result inbox, Coordinator loop to ACCEPT,
  completion-hold release, Capsule projection.

## Product outcome and operator evidence

An operator configures a supervised team (Planner, Verifier, worker
allowlist, hard limits, deadline, optional budget account) for an
Execution. The Coordinator creates the Planner step, validates the
untrusted batch, compiles workers plus the Coordinator-owned Verifier step
into the plan through the existing proposal authority, fans out, aggregates
bounded worker evidence at the Verifier claim, consumes the Verifier
decision atomically, and either continues to the next iteration or
terminalizes ACCEPTED/FAILED/CANCELLED/LIMIT_REACHED. A live loop holds the
Execution's completion; ACCEPT releases it. Replay of a coordinated
execution creates a fresh run from the frozen team template, resolving
current connections, credentials, policy, approvals, budgets, and deadline.

## Architectural decisions and deviations permitted by SPEC

- M9 Planner steps are NOT marked `planner: true`: the M5 result-inbox
  would parse a TaskBatchProposalV1 output as a PlanPatch and fail the
  attempt. M9 batch recursion is guarded in `validateTaskBatchProposal`.
  Legacy M5 planner steps are unchanged.
- `fail`/`cancel`/`deadline`/`limitReached` terminal transitions are
  reachable from every live phase (execution-failure and deadline
  propagation are phase-independent).
- Verifier aggregation selects bounded output fields from each worker's
  terminal attempt result; per-field contextProjection selection and
  ExecutionState keys are recorded as explicit limitations (arriving with
  later milestones).
- WAIT resolution: approve rechecks run-level hard limits (budget/
  deadline/policy rechecks at consume time) and continues the loop; deny
  terminalizes FAILED.
- One worker per worker SDK instance (the SDK is one agent per worker by
  design); the team example runs four workers.

## Verification evidence

- Orchestrator unit suite: 652 passed (Postgres-gated suites skipped
  without TEST_DATABASE_URL).
- Real-PostgreSQL suite: 937 passed, run twice sequentially (includes the
  M9-S2 race/immutability/100-way-CONTINUE, M9-S3 planner-to-batch, M9-S4
  loop, M9-S5 authority, and the real-HTTP team example).
- `npx tsc --noEmit -p tsconfig.json` clean; `git diff --check` clean.
- Doc tests 20/20; `verify-docs` passed (117 Markdown files, 225 local
  links, 58 current documents, 41 capabilities); identity 25/25.

## Limitations

- M9 is `READY FOR INDEPENDENT SOL VERIFICATION`; M8 Sol review is still
  pending at owner direction (recorded in EXECUTION_STATUS).
- Connection-kind worker selectors are recorded on compiled steps and
  enforced at batch admission; dispatch-time enforcement is the existing
  M8 mechanism.
- The External Production Exposure Gate remains OPEN: connections admin is
  local/internal only.

## Closure hardening (2026-08-14, implementer)

- Run-creation authority parity: `startRunWithManager` now enforces the
  FULL chain inside the create transaction — role connection claims
  (manager-aware; REVOKED denies) and the frozen executor allowlist for
  the Planner and Verifier selections — so the Workbench/managed path can
  never bypass run-level restrictions.
- Concurrent-start convergence: equivalent concurrent `startRun` calls
  serialize on the execution row lock and converge on exactly one
  CoordinationRun; the DB unique constraint remains the backstop and a
  leaked 23505 is translated into a re-read, never surfaced raw.
- Exact iteration identity: batch admission requires
  `iterationNumber == run.currentIterationNumber` (old and future
  iterations rejected deterministically).
- Planner attempt ownership: the referenced StepAttempt must exist,
  belong to the same execution, be the attempt of this run's
  Coordinator-owned Planner step for this iteration, be terminal SUCCESS,
  and carry a frozen plan revision. Unrelated successful attempts are
  never accepted.
- Strict baseRevision: the proposal's baseRevision must equal the Planner
  attempt's FROZEN plan revision and the execution's active plan revision
  at admission; if the active revision moved while the Planner ran, the
  proposal is deterministically STALE — the run fails with bounded
  evidence and NO worker work is activated. The Planner step input now
  carries the frozen plan revision so truthful planners can declare it.
  No silent rebase exists anywhere in the admission path.
- Real-PostgreSQL regressions: old/future iteration rejection, wrong
  Planner attempt, 8-way concurrent identical starts, stale-planner race
  (authorized PlanPatch activates N+1 while the Planner is on N; the
  stale batch activates nothing), plus fixture updates so every batch
  admission test uses a REAL Planner attempt and the truthful frozen
  revision.

## Closure hardening 2 (2026-08-14, implementer)

- EXACT TaskBatch iteration identity: the untrusted proposal's embedded
  `iterationNumber` must equal `run.currentIterationNumber`. A proposal
  naming an OLDER or FUTURE iteration is rejected with the same bounded
  `ITERATION_NOT_FOUND` evidence as the caller-declared identity — before
  any worker/verifier materialization and before any plan revision can be
  created from the batch. Real-PostgreSQL regressions: current=2, input=2,
  proposal.iterationNumber=1 and =3 both rejected with zero
  materialization (no batch revision, no worker steps, counters unchanged).
- Precheck/propose silent-rebase race closed: the authoritative
  active-revision check now runs UNDER the execution row lock
  (`SELECT ... FOR UPDATE`), acquired before the check and held through
  proposal creation and activation (the re-lock inside
  proposeWithManager/activateWithManager is a no-op on the same
  transaction). An authorized PlanPatch activating N+1 can never
  interleave between the check and the proposal's base-revision pin:
  either the batch linearizes first and its proposal keeps base N, or the
  activation wins first and the batch is deterministically STALE — a
  Planner result produced against N is never silently proposed/activated
  against N+1. Real-PostgreSQL race tests with explicit interleaving
  barriers (raw driver-pool connections holding row locks, verified via
  `pg_stat_activity` lock-wait polling) prove both linearizations: (T1
  first) the concurrent authorized activation queues behind the batch and
  becomes STALE while the batch's persisted proposal baseRevision and the
  activated revision's baseRevision both equal N; (T2 first) the
  in-flight batch fails PLANNER_BASE_STALE with zero worker
  materialization and no planner-sourced proposal ever persisted.
