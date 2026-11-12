---
title: "T06 — Implement business verdicts, cancellation and atomic command audit"
status: planned
audience:
  - developer
last_verified: 2026-11-11
sources:
  - backend/control-plane/src/main/java/io/tenvyr/control/Main.java
  - backend/control-plane/src/main/java/io/tenvyr/control/engine/ExecutionService.java
  - scripts/backend-checks.sh
---

# T06: Implement business verdicts, cancellation and atomic command audit

Dependencies: T04, T05. Estimate: 5–7 focused engineering hours.
Read [SPEC](../SPEC.md), [DISCOVERY](../DISCOVERY.md), [WORKER](../WORKER.md) and [VERIFY](../VERIFY.md) first.
Status: planned, not implemented.

## Deliverable and files

Create review-api `ReviewDecisionService.java`, extend ReviewRepository and
ReviewController for decisions/cancel/audit, and add `ReviewDecisionIT`,
`ReviewCancelIT`, `ReviewAuditIT`. Keep engine policy ApprovalService unchanged.

## Interfaces

Consumes T02 DTOs, T03 actors, T04 visibility/report projection and T00 engine.
```java
DecisionView ReviewDecisionService.decide(Actor actor, UUID requestId,
                                         UUID key, DecisionCommand command)
ReviewDetail ReviewDecisionService.cancel(Actor actor, UUID requestId, UUID key)
Page<AuditEntry> ReviewDecisionService.audit(Actor actor, UUID requestId,
                                           int limit, String after)
```

First decision 201, equivalent replay 200, conflicting final decision/key 409.
Only another REVIEWER can decide a completed valid report. Cancellation is
owner SUBMITTER only while PROCESSING; repeat same successful command is 200.

## References to copy

Read cancelExecutionWithManager fully (including its attempt/step/execution
lock order), ResultInboxService.apply and existing concurrency tests. Read SPEC
command lock order and distinguish business decision from dispatch ApprovalService.

## Steps and acceptance

- [ ] Write failing tests for roles, foreign UUID, self-decision, pending/failed/
  invalid report, same-key replay, changed payload and two final verdicts.
- [ ] Take operation advisory lock then request row lock. Recheck actor,
  execution completion and exact committed successful attempt/result hash in
  the transaction. Insert one decision and one DECIDE audit atomically. No
  execution state change and no call to engine ApprovalService.
- [ ] Test parallel APPROVE vs REQUEST_CHANGES from two reviewers: one decision
  wins, loser409, one audit. Same actor/key/payload converges to one identity;
  same key on a different request/payload conflicts. Disable/role checks still
  apply to an old session.
- [ ] Implement owner cancellation through existing cancelExecutionWithManager
  on the same Connection plus CANCEL audit. Re-read actual cancellation result:
  if result completion won, rollback audit and return409. Best-effort transport
  notification can happen only after commit. No automatic new execution.
- [ ] Use barriers with real PostgreSQL plus signed callback to exercise both
  cancel-vs-result outcomes and a deadlock/lock-timeout failure path. Assert no
  contradictory audit/decision and the application can continue afterward.
- [ ] Implement visibility-filtered, prepared keyset audit pagination ascending
  createdAt/id, limit1..100. Include identifiers/actions/times only. SUBMIT,
  DECIDE,CANCEL audit duplicates are suppressed by durable command identity;
  failed unauthorized/conflicting commands do not create success audit.
- [ ] Run review unit/integration, retained cancellation/inbox checks, update
  current docs/ledger and verifiers, then handoff.

Representative assertions:
```java
assertEquals(1, finalDecisionsFor(requestId));
assertEquals(1, successfulAuditCount(requestId, "DECIDE"));
assertEquals(0, cancelAuditCountWhenCompletionWon(requestId));
assertEquals(terminalEngineStateBeforeDecision, terminalEngineStateAfterDecision);
```

## Reject conditions

No business verdict via ApprovalService.approve/deny, engine terminal rewrite,
extra pending status stored in requests, success audit after failed operation,
GET reconciliation, or transport cancel before durable cancellation. Keep
operation-key scope/action/request/payload binding consistent across replays.
