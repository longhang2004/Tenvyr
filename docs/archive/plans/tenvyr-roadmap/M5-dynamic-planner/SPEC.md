---
title: "M5 Specification: Dynamic Planner and Immutable Plan Revision"
status: historical
superseded_by:
  - docs/reference/implementation-status.json
audience:
  - developer
last_verified: 2026-08-11
sources:
  - docs/archive/plans/tenvyr-roadmap/M5-dynamic-planner/PLAN.md
  - services/orchestrator/src/entities/execution-plan-revision.entity.ts
  - services/orchestrator/src/services/execution.service.ts
  - services/orchestrator/src/services/pipeline-validation.service.ts
---

# M5 planner specification

## Concepts

- `Planner`: supervised runtime that returns an untrusted proposal only.
- `PlanPatchProposal`: immutable versioned operations, `baseRevision`, reason,
  identity/hash, source attempt/request, and bounded metadata.
- `PlanPatchDecision`: ACCEPTED, REJECTED, or STALE with stable reasons.
- `ExecutionPlanRevision`: immutable validated full plan after an accepted patch.
- `Frozen step`: scheduling/gate decision already authoritative; its semantics cannot
  change in future revisions.

TypeORM `rowVersion` is not Planner `baseRevision`.

## Initial operation contract

Support only:

```text
addStep(complete PipelineStepConfig)
replaceUnfrozenStep(stepId, complete PipelineStepConfig with same ID)
```

Operations are ordered. Existing plan order is preserved; replacement stays in
place; additions append in proposal order. No merge patch, arbitrary path operation,
remove, rename, reorder, or full-plan replacement.

Replacement is permitted only when the durable logical step has zero attempts and
both `frozenSpecHash` and `frozenAt` are null. A patch cannot add prerequisites to,
replace, rename, remove, or reinterpret frozen work. Added/unfrozen steps may depend
on prior frozen/completed work or other new/unfrozen work if the final DAG validates.

Planner-supplied conditions must already be bounded declarative objects. Reject
legacy condition strings from Planner even if interactive pipeline compatibility
continues to compile them.

## Proposal state behavior

```text
PROPOSED
  → validate shape, bounds, authority, complete candidate plan
  → baseRevision mismatch → STALE
  → invalid/policy denied → REJECTED
  → approval needed → M4 WAITING → recheck all facts
  → atomic activation succeeds → ACCEPTED + new active revision
```

Terminal proposal decisions are immutable. Duplicate identical request is idempotent;
same identity/different proposal becomes conflict evidence. STALE is never silently
rebased. A human/Planner may submit a new proposal against the new revision.

## Atomic activation invariants

Within one transaction:

1. lock affected logical steps in deterministic order, then execution, compatible
   with current logical-step → execution authority order;
2. load active revision and compare its revision number to `baseRevision`;
3. on mismatch persist STALE and create no revision;
4. prove every frozen step remains byte-semantically identical by canonical hash;
5. apply operations purely and validate the complete candidate plan;
6. run/recheck M4 policy, approval validity, and budget allocation;
7. insert revision `current + 1` with parent/base/hash/source/reason/validation;
8. materialize newly added logical rows and safely represent replacements;
9. switch `activePlanRevisionId` and accept proposal.

Revision insertion, logical-row changes, active pointer, proposal decision, and M4
authority evidence commit or roll back together. After commit call normal
`reconcileExecution`; recovery must rediscover work if the process crashes first.

Do not insert invalid revisions merely to retain rejected proposals. Proposal/
decision storage carries rejection evidence.

## Authority boundaries

Planner receives bounded context/artifact references and no repositories,
transactions, ExecutionService, DispatchOutbox, secrets, or mutable pipeline entity.
Planner result enters a validation boundary. Only Tenvyr activation creates work.
Planner invocation/retry consumes M4 budget and uses M3 lifecycle/cancellation.

## Failure semantics

- malformed/oversized/too-many operations: REJECTED, no revision;
- cycle/missing dependency/depth/fanout/step overflow: REJECTED;
- frozen step conflict: REJECTED or STALE stable code, no mixed state;
- base mismatch after approval: STALE, approval cannot override CAS;
- DB failure during activation: no partial revision/rows/pointer/decision;
- crash after commit before reconcile: recovery progresses new work;
- Planner timeout/failure: ordinary supervised attempt failure/retry policy;
- terminal/cancelled execution: no new revision;
- duplicate/conflicting proposal: idempotent/conflict evidence.

## Security/trust boundaries

All proposal JSON, reasons, conditions, refs, metadata, executor/agent choices, and
growth are untrusted. Apply complete canonical byte/operation/step/depth/fanout
bounds, unsafe-key/own-property protection, safe declarative conditions, policy
allowlists, and safe logging. Never execute proposal strings or resolve secret refs
from proposal data.

## Backward compatibility

Initial revision behavior, old pipelines, frozen retry semantics, attempt revision
lookup, failure policy, conditions, outbox/inbox, M2 context/artifacts, and M4
authority remain unchanged when no proposal exists. Historical revisions are never
mutated or backfilled with proposals.

## Cross-runtime behavior

Any Planner runtime emits the same canonical proposal shape. Runtime/model metadata
is evidence only and cannot alter validation/activation.

## Product example

After `investigate` completes, an explicit Planner step proposes two new review
steps against revision 1. While it waits for approval, another branch finishes and a
different proposal activates revision 2. The original approval arrives, but Tenvyr
rechecks `baseRevision`, records the proposal STALE, and creates no work. The Planner
may generate a new revision-2 proposal; completed attempts remain tied to revision 1.

## Non-goals

No direct Planner authority, arbitrary code, full replacement/removal, silent rebase,
reusable pipeline mutation, autonomous infinite planning, or delegated child work.
