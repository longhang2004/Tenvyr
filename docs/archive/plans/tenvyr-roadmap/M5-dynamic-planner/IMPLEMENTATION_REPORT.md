---
title: "M5 Implementation Report"
status: historical
superseded_by:
  - docs/reference/implementation-status.json
audience:
  - developer
  - product
last_verified: 2026-08-12
sources:
  - services/orchestrator/src/domain/plan-patch.ts
  - services/orchestrator/src/services/plan-proposal.service.ts
  - services/orchestrator/src/services/result-inbox.service.ts
  - services/orchestrator/src/services/approval.service.ts
  - services/orchestrator/src/services/pipeline-validation.service.ts
---

# M5 implementation report — dynamic planner and immutable plan revisions

Date: 2026-08-12
Status: **CLOSED — independent Tech Lead PASS.** See the
[durable closure review](../../../../archive/reviews/2026-08-12-m3-m7-independent-closure.md).
Slices: 5/5 complete (S1 PlanPatch domain, S2 durable proposals + atomic
activation, S3 supervised Planner trigger, S4 policy/approval enforcement,
S5 races/recovery/security closure). Provisional until the independent SOL
review.

## What M5 delivers

- **Restricted PlanPatch (M5-S1)** — `domain/plan-patch.ts`: versioned
  bounded proposal (`addStep` / `replaceUnfrozenStep`, ≤ 20 ops, ≤ 64 KiB
  UTF-8, sequential deterministic application, replacement id must equal
  stepId, frozen targets rejected). The whole candidate is re-validated
  through the exact same safe pipeline validation (`validateSteps`:
  bounds, identifiers, graph/cycles, fanout/depth, durations, retries,
  budgets, conditions).
- **Durable proposals + atomic activation (M5-S2)** —
  `plan_proposals` (migration 1722270009000): numbered per execution,
  hash-pinned, `PENDING → ACCEPTED|REJECTED|STALE` terminal decisions.
  `activate` runs in ONE transaction under the claim's execution row
  lock: baseRevision CAS (moved base → STALE), frozen-step protection
  (any attempt → REJECTED), candidate validation, new revision (parent +
  base + budget envelope carried), added logical rows materialized,
  pointer switch, terminal decision. Crash → PENDING (retryable);
  committed decisions are final and idempotent (CAS-guarded; concurrent
  same-proposal activations never overwrite).
- **Supervised Planner trigger (M5-S3)** — explicit `planner: true`
  step; its successful output is a bounded PlanPatch persisted as a
  PENDING proposal INSIDE the canonical result transaction with the base
  pinned to the active revision; invalid output is a deterministic
  `PLANNER_PROPOSAL_INVALID` rejection following retry/onFailure; late
  results under terminal executions propose nothing; state-write
  postcondition failures never propose. The planner never receives
  execution authority.
- **Policy/approval enforcement (M5-S4)** — `plan_patch` proposals are
  intercepted inside the activation transaction: DENY → durable REJECTED
  with append-only evidence; REQUIRE_APPROVAL → durable request + PENDING;
  ALLOW → proceeds. Approving re-activates in the same transaction and
  RECHECKS base revision, frozen steps, candidate validity, and policy —
  stale approved proposals stay STALE, a policy rotated (version bump) to
  DENY rejects even approved proposals. deny/expire/sweep handle
  plan_patch requests (proposal REJECTED; the recovery sweep never
  crashes on them). Lock order is execution → request everywhere.
- **Closure (M5-S5)** — planner-sourced proposals can never create new
  planner steps: the candidate's planner-step set must be a SUBSET of the
  base plan's (both adding and converting existing steps to planner are
  operator-only privileges, verified incl. the replaceUnfrozenStep
  bypass); claim-versus-patch races serialize on the execution lock into
  consistent outcomes (claim first → activation REJECTED frozen;
  activation first → claim reads the new revision); pre-terminalized
  proposals return the stored decision with no side effects; a crash
  mid-activation (forced transaction abort) rolls everything back —
  proposal stays PENDING with zero side effects and activates normally
  afterwards (retryable).

## Verification (final state)

- Unit: orchestrator 535 passed / 188 skipped (PG) / 0 failed.
- Real PostgreSQL (tenvyr_roadmap_test): 722/723 ×3 sequential —
  M5-S1 16 (unit), M5-S2 9, M5-S3 6, M5-S4 8, M5-S5 4 = 27 proposal
  tests, incl. concurrent same-base (one ACCEPTED one STALE), concurrent
  same-proposal (single decision), claim-vs-activate race, policy
  rotation, stale approved, planner recursion, expiry sweep survival.
- test:all green (contracts 65, worker 199, host 31, orchestrator 535,
  gateway, agents, example); build:all 15 packages; verify:docs 87
  files / 36 capabilities; verify:identity 0 violations; git diff
  --check.
- Review findings fixed at every slice: S1 byte-bound + id-equality, S2
  same-proposal race + decidedAt alignment, S3 postcondition gate + base
  pin split, S4 deny/expire/sweep crash + lock ordering + CAS-loss abort.

## Known limitations (explicit)

- Growth is bounded STRUCTURALLY by candidate validation
  (step/depth/fanout/step-count); policy rules express action
  permissions (actionType/agents/executors), not numeric growth.
- The plan grant (budget envelope) is carried over unchanged — the patch
  contract has no budget operations; per-step budget allocation policy is
  candidate-validated only.
- Activation is service-level (no external API; the external exposure
  gate stays closed).
- Claim-versus-patch serialization relies on the execution row lock;
  the residual claim-then-remove race cannot occur (patches never remove
  steps — replacement keeps the id).
- Revision/hash consistency across replicas is out of scope (no
  multi-replica consensus layer exists; the plan's risk list item is
  accepted as an explicit limitation).
- One intermittent timing-test flake observed once under combined-suite
  load during M5-S4 (not reproduced in 5+ consecutive full runs).

## Independent closure

**PASS — CLOSED 2026-08-12.** Independent review found that activation rejected
only `CANCELLED` executions, which allowed revisions after `COMPLETED` or
`FAILED`. Activation now returns `STALE` for every terminal execution status,
with a table-driven regression. Final evidence is in the
[durable M3–M7 closure review](../../../../archive/reviews/2026-08-12-m3-m7-independent-closure.md).
