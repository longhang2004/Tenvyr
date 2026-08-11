---
title: "M5 Plan: Dynamic Planner and Immutable Plan Revision"
status: planned
audience:
  - product
  - developer
last_verified: 2026-08-11
sources:
  - services/orchestrator/src/entities/execution-plan-revision.entity.ts
  - services/orchestrator/src/services/execution.service.ts
  - services/orchestrator/src/services/pipeline-validation.service.ts
  - services/orchestrator/src/services/condition-evaluator.service.ts
  - docs/architecture/control-plane.md
---

# M5 dynamic planner plan

## Product outcome

An execution may adapt its unstarted work through untrusted structured Planner
proposals. Tenvyr validates a restricted `PlanPatch`, enforces policy/budget, and
atomically activates a new immutable `ExecutionPlanRevision`. The Planner never
receives execution authority.

## User/operator value

Long-running workflows can add or refine future work based on current evidence
without rewriting completed/running attempts, mutating reusable pipelines, or
letting a model dispatch unlimited work.

## Existing repository state

- revision 1 is created with the execution; `ExecutionPlanRevisionEntity` already
  has unique revision number, `parentRevisionId`, nullable `baseRevision`, plan,
  hash, source, reason, and validation result;
- execution points to `activePlanRevisionId`;
- logical steps materialize unfrozen and freeze at claim/condition decision;
- attempts retain `planRevisionId` and retries retain the frozen spec hash;
- result failure policy reads the attempt's own revision;
- pipeline validation enforces identifiers, max 100 steps, depth 20, fanout 20,
  DAG validity, durations, retries, and declarative conditions;
- no later revision creation, PlanPatch, proposal, stale decision, or Planner exists.

## Gaps

- `baseRevision` has no runtime CAS semantics;
- no bounded patch operation contract or immutable proposal/conflict evidence;
- no atomic new-revision + logical-step materialization + active-pointer switch;
- no frozen-step safety validation during patch races;
- no Planner trigger, executor integration, policy/budget charge, or amplification
  control;
- active revision referential/same-execution integrity needs review.

## Dependencies

- M2 bounded context/artifacts for proposal input and provenance;
- M3 executor boundary for supervised Planner invocation;
- M4 budget/policy/approval before Planner can allocate new work;
- external exposure gate before public Planner/approval controls.

## Proposed engineering slices

### M5-S1 — pure restricted PlanPatch domain

Versioned bounded proposal with only `addStep` and `replaceUnfrozenStep`. Replacement
supplies a complete step config, not merge/JSON Patch. Define operation/payload/new
step limits as configured documented defaults; deterministically apply and validate
the full candidate plan through existing safe validation.

### M5-S2 — durable proposal and atomic activation

Persist immutable proposal/hash plus terminal decision (`ACCEPTED`, `REJECTED`,
`STALE`). Under deterministic locks compare `baseRevision`, protect every frozen
step, insert revision, materialize added logical rows, and switch active revision in
one transaction. Reconcile normally after commit/restart.

### M5-S3 — supervised Planner proposal generation

Choose one bounded trigger (recommended: explicit Planner logical step or trusted
internal planning request). Invoke through M3 with M2 bounded context and M4 budget/
deadline/cancellation. Structured output becomes only a proposal.

### M5-S4 — policy, approval, and amplification enforcement

Evaluate proposed agents/executors, step/depth/fanout growth, budget allocation,
and relevant action permissions before activation. Approval must recheck base
revision and all authority; stale approved proposals remain STALE.

### M5-S5 — races, recovery, security, and closure

Close same-base proposal races, claim-versus-patch, crash activation, retry/failure
policy stability, malicious proposal bounds, provenance, current docs/ledger, and
full verification.

## Risks

- stale proposal silently rebased or overriding another accepted revision;
- frozen/running step semantics rewritten;
- active pointer committed without new logical rows;
- removed step leaving an endlessly rediscovered row;
- Planner prompt injection/amplification/arbitrary executable conditions;
- policy/approval checked before a long wait but not rechecked at activation;
- Planner recursively creating Planner work or unlimited fanout;
- revision/hash inconsistency across replicas.

## Explicit non-goals

- no full-plan replacement, arbitrary JSON Patch, step removal/rename/reorder, or
  mutable revision in the first milestone contract;
- no arbitrary code/string conditions from Planner;
- no silent rebase, auto-merge, or LLM resolution of conflicts;
- no Planner DB/service/dispatch access;
- no mutation of reusable `PipelineDefinition`;
- no autonomous "plan whenever useful" loop without an approved trigger;
- no M6 delegation or M7 replay.

## Decisions requiring PO/BA input

- Planner trigger model and who may request planning;
- whether replacement of an unstarted step is needed at initial launch or add-only
  would cover the product case;
- configured default patch-operation/new-step/payload limits;
- which proposal changes require approval;
- whether rejected/stale proposals and Planner raw output require retention limits.

## Closure definition

Sol may close M5 only when `baseRevision` CAS is authoritative, same-base races have
one accepted/one stale result, frozen work cannot change, activation is all-or-none,
Planner remains a supervised proposal producer consuming budget, malicious output is
bounded/declarative, and VERIFY passes.

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
