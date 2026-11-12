---
title: "T04 — Deliver atomic idempotent submission and authorized bounded reads"
status: planned
audience:
  - developer
last_verified: 2026-11-11
sources:
  - backend/control-plane/src/main/java/io/tenvyr/control/Main.java
  - backend/control-plane/src/main/java/io/tenvyr/control/engine/ExecutionService.java
  - scripts/backend-checks.sh
---

# T04: Deliver atomic idempotent submission and authorized bounded reads

Dependencies: T03. Estimate: 6–8 focused engineering hours.
Read [SPEC](../SPEC.md), [DISCOVERY](../DISCOVERY.md), [WORKER](../WORKER.md) and [VERIFY](../VERIFY.md) first.
Status: planned, not implemented.

## Deliverable and files

Create review-api `ReviewService.java`, `ReviewRepository.java`,
`ReviewController.java`, `ReviewReportMapper.java`, `ReviewErrors.java`,
`RequestBodyLimitFilter.java`; add `ReviewValidationTest`,
`ReviewSubmissionIT`, `ReviewReadsIT`. Consume T02 types and T03 ActorResolver.
This task may run parallel with T05 only under WORKER's ownership rules.

## Interfaces

All public Java types below are ReviewTypes members.
```java
Submission ReviewService.submit(Actor actor, UUID key, CreateReview input)
ReviewDetail ReviewService.get(Actor actor, UUID id)
Page<ReviewSummary> ReviewService.list(Actor actor, int limit, String after)
ReviewReport ReviewService.report(Actor actor, UUID id)
```

Expose submit/list/detail/report routes from SPEC. Default list limit 20,
maximum 100, keyset createdAt DESC/id DESC. Return 202+Location on first/equivalent
submit and the same request/execution IDs. Reports are mapped from committed
successful review attempt/inbox, never Worker progress events.

## References to copy

Read materializeExecutionWithManager, Db.on, Json.hash and Spring
DataSourceUtils/TransactionTemplate in DISCOVERY. Copy existing PostgreSQL
barrier/concurrent-claim patterns from EngineIntegrationCheck. For fixtures,
tests may feed a valid result directly through the existing authenticated
adapter/engine; do not depend on unfinished T05.

## Steps and acceptance

- [ ] Write failing validation tests for SPEC limits, unknown fields, invalid
  language/key, blank code, Unicode byte boundaries, invalid/oversize cursor,
  chunked body beyond 1 MiB and misleading Content-Length. Limit streaming
  reads before JSON allocation; configure only new DTO mapping.
- [ ] In one TransactionTemplate transaction: apply SPEC's local timeouts,
  derive actor, normalize/hash input, take owner/key advisory lock, resolve
  replay/conflict, load fixed pipeline, materialize engine execution on that
  SAME Connection, and insert request/SUBMIT audit. Return after commit.
  Map timeout/deadlock/pool failure to safe503+Retry-After after rollback.
  Rely on existing recovery; do not make network dispatch necessary for 202.
- [ ] Add a fault-injection seam local to tests (not a public failure-mode API).
  Roll back after engine materialization and before request/audit completion.
  Assert no execution/plan/step/request/audit from the failed operation survives.
- [ ] Test 16 parallel same owner/key submissions: identical payload -> one
  request/execution/audit; altered payload ->409; same key under different owners
  is independent. Lost-response replay returns the original identity.
- [ ] Implement visibility-filtered SQL and keyset pagination with prepared
  statements. Test A/B submitters plus reviewer on list/detail/report, including
  guessed UUIDs and every subsequent cursor page. Lists exclude code/report.
- [ ] Implement strict report/state projection, including invalid terminal
  result ->FAILED/REVIEW_REPORT_INVALID. Return bounded safe errors, never raw
  engine configuration/credentials. Test status before/after valid result.
- [ ] Run review unit/integration, retained engine checks and both verifiers;
  update current API docs/ledger and hand off.

Representative assertions:
```java
assertEquals(1, executionsBoundToOwnerAndKey(owner, key));
assertEquals(first.id(), replay.id());
assertEquals(404, getAsOtherSubmitter(first.id()).statusCode());
assertEquals(0, executionsForRolledBackTestOperation());
```

## Reject conditions

No EngineService.startExecution or private HTTP POST /executions inside submit,
no independent Db.fromEnv transaction, no mutable copied business status,
unbounded list query, GET side effects, raw SQL error text, or client-selected
pipeline/executor/model. Do not mark T06 decisions as implemented.
