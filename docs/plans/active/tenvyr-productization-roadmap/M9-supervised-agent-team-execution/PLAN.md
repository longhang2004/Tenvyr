---
title: "M9 Plan: Supervised Agent Team Execution"
status: planned
audience:
  - product
  - developer
last_verified: 2026-08-12
sources:
  - docs/architecture/control-plane.md
  - docs/reference/implementation-status.json
  - docs/archive/plans/tenvyr-roadmap/M5-dynamic-planner/SPEC.md
  - docs/archive/plans/tenvyr-roadmap/M6-delegation-subagents/SPEC.md
---

# M9 Supervised Agent Team Execution plan

## Product outcome

A user goal runs through Planner, bounded parallel Workers, fan-in, Verifier, and
zero or more Tenvyr-authorized iterations. PostgreSQL recovery can always answer
which iteration is active, which Workers belong to it, and which decision is
pending. Two replicas cannot create the same next iteration.

## Problem being solved

M0–M7 can execute DAGs, patches, and child executions, but no authority state
machine owns autonomous Planner/Worker/Verifier repetition. Native delegation does
not provide parent fan-in, and an LLM decision cannot be allowed to spawn work
until it chooses to stop.

## Existing capabilities reused

Immutable plan revisions and bounded PlanPatch; LogicalSteps/StepAttempts and DAG
fan-out/fan-in; outbox/inbox recovery; ContextSnapshots and ArtifactRefs; planner
proposal restrictions; policy, approvals/WAITING, hierarchical budgets, deadlines;
delegation/capsules/replay; M8 frozen Runtime Connections.

## Missing capabilities

Durable loop/iteration identity, bounded TaskBatch proposal, worker membership and
required/optional semantics, aggregation contract, Verifier decision contract,
pre-terminal completion hold, one-winner continuation, cumulative limits, explicit
loop WAIT/FAIL behavior, recovery, Capsule iteration projection, and a deterministic
team example.

## Architectural choice

Use a combination:

- first-class **behavioral** `CoordinationLoop` owned by a deterministic Tenvyr
  Coordinator;
- minimal durable coordination run/iteration state only where existing tables
  cannot express phase, uniqueness, consumed decision, or completion hold;
- existing ExecutionPlanRevisions/LogicalSteps/Attempts for Planner, Workers, and
  Verifier; existing PlanPatch for actual work materialization;
- `TaskBatchProposalV1` and `VerifierDecisionV1` as bounded contracts, not new
  workflow engines or persistence entities for naming convenience.

ExecutionState remains bounded semantic state, not lifecycle authority. Supervised
delegation remains available inside a Worker but does not substitute for the team
loop.

## Dependencies

M4–M7 and independently closed M8. External exposure gate stays open; M9 surfaces
service/internal APIs and a local example, not a secure public control API.

## Engineering slices

1. Pure semantics: team configuration, phases, TaskBatch, worker membership,
   Verifier decision, aggregation and hard limits with deterministic validators.
2. Durable authority: minimal run/iteration persistence, migrations, completion
   hold, deterministic lock order, unique iteration/decision constraints, recovery.
3. Planner-to-batch: invoke configured Planner, validate TaskBatch, compile it plus
   Tenvyr-owned verifier step into existing PlanPatch and immutable revision.
4. Fan-out/fan-in/decision: execute Workers, build bounded aggregate context, invoke
   Verifier, atomically apply ACCEPT/CONTINUE/FAIL/WAIT_FOR_HUMAN and next iteration.
5. Authority integration: budgets, deadlines, policy, approvals, cancellation,
   connection revocation, retries, capsules/replay/comparison, malicious bounds.
6. Product example/closure: deterministic and real-runtime optional team example,
   docs/ledger, crash/race battery and full verification.

## Product-impacting alternatives

- Rejected: arbitrary recursive Planner agents or LLM-owned loop control.
- Rejected: one new workflow engine or full `AgentTeamRun` copy of Execution.
- Rejected: opaque child executions for fan-in; current child completion does not
  terminalize or pause the parent.
- Chosen: workers in the parent Execution DAG for first release. Later remote/A2A
  workers may map through executors without changing Coordinator authority.

## Risks

Duplicate iterations, premature execution completion, recursive amplification,
runaway cost/fanout, stale verifier decision, partial PlanPatch/iteration commit,
deadlock and multi-replica races, unbounded aggregate context, required-worker
ambiguity, cancellation mismatch, revoked runtime use, approval after authority
changes, artifact/resource exhaustion, and Capsule graphs exceeding bounds.

## Research-required items

No vendor API is required for core correctness. Recheck selected Planner/Verifier
runtime structured-output and cancellation capabilities only for optional live
examples; deterministic Workers are the closure authority.

## Explicit non-goals

No general multi-agent reasoning framework, recursive planner creation, arbitrary
loop until model stop, new provider routing, hidden subagent inference, universal
pause/resume, giant workflow designer, cross-execution distributed team graph,
MCP/A2A, artifact bytes, or public multi-user API.

## Closure definition

Sol may close M9 only when hard bounds survive every entry path, fan-in and failure
semantics are deterministic, CONTINUE is only a proposal evaluated under current
authority, iteration creation is exactly-once across replicas/restarts, execution
cannot finish before the decision, aggregation stays bounded, replay re-evaluates
authority, Capsules explain the loop, and VERIFY passes.

# Milestone handoff

## What was delivered

## User/operator value

## How it works

## Guarantees

## Known limitations

## Architecture decisions

## What this unlocks

## Verification summary

## Recommended next milestone
