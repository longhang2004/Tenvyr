---
title: "T04 — Deliver atomic idempotent submission and authorized bounded reads"
status: current
audience:
  - developer
last_verified: 2026-11-14
sources:
  - backend/review-api/src/main/java/io/tenvyr/review/ReviewService.java
  - backend/review-api/src/main/java/io/tenvyr/review/ReviewRepository.java
  - backend/review-api/src/main/java/io/tenvyr/review/ReviewController.java
  - backend/review-api/src/main/java/io/tenvyr/review/ReviewReportMapper.java
  - backend/review-api/src/main/java/io/tenvyr/review/ReviewErrors.java
  - backend/review-api/src/main/java/io/tenvyr/review/RequestBodyLimitFilter.java
  - backend/review-api/src/main/java/io/tenvyr/review/ReviewValidation.java
  - backend/review-api/src/test/java/io/tenvyr/review/ReviewValidationTest.java
  - backend/review-api/src/test/java/io/tenvyr/review/ReviewSubmissionIT.java
  - backend/review-api/src/test/java/io/tenvyr/review/ReviewReadsIT.java
  - backend/review-api/src/test/java/io/tenvyr/review/ReviewTestSupport.java
---

# T04: Deliver atomic idempotent submission and authorized bounded reads

Dependencies: T03. Estimate: 6–8 focused engineering hours.
Read [SPEC](../SPEC.md), [DISCOVERY](../DISCOVERY.md), [WORKER](../WORKER.md) and [VERIFY](../VERIFY.md) first.
Status: **LOCAL VERIFIED; SERIAL INTEGRATION/ACCEPTANCE PENDING**; see the [T04 report](../reports/T04.md).
Documentation link: [review-service.md](../../../../architecture/review-service.md).
Shared global ledger and integrator steps remain unchecked until root merge gates.

## Deliverable and files

Created review-api `ReviewService.java`, `ReviewRepository.java`,
`ReviewController.java`, `ReviewReportMapper.java`, `ReviewErrors.java`,
`RequestBodyLimitFilter.java`, and package-private `ReviewValidation.java`;
exercised by `ReviewValidationTest`, `ReviewSubmissionIT`, and `ReviewReadsIT`.
Consumes T02 types and T03 ActorResolver.

## Interfaces

All public Java types below are ReviewTypes members.
```java
Submission ReviewService.submit(Actor actor, UUID key, CreateReview input)
ReviewDetail ReviewService.get(Actor actor, UUID id)
Page<ReviewSummary> ReviewService.list(Actor actor, int limit, String after)
ReviewReport ReviewService.report(Actor actor, UUID id)
```

Exposes submit/list/detail/report routes from SPEC. Default list limit 20,
maximum 100, keyset createdAt DESC/id DESC. Returns 202+Location on first/equivalent
submit and the same request/execution IDs. Reports are mapped from verified
successful review attempt and APPLIED inbox row (never Worker progress events).

## Steps and acceptance

- [x] Write failing validation tests for SPEC limits, unknown fields, invalid
  language/key, blank code, Unicode byte boundaries, invalid/oversize cursor,
  chunked body beyond 1 MiB and misleading Content-Length. Limit streaming
  reads before JSON allocation; configure only new DTO mapping.
- [x] In one TransactionTemplate transaction: apply SPEC's local timeouts,
  derive actor, normalize/hash input, take owner/key advisory lock, resolve
  replay/conflict, load fixed pipeline, materialize engine execution on that
  SAME Connection, and insert request/SUBMIT audit. Return after commit.
  Map timeout/deadlock/pool failure to safe 503+Retry-After after rollback.
  Rely on existing recovery; do not make network dispatch necessary for 202.
- [x] Add a fault-injection seam local to tests (not a public failure-mode API).
  Roll back after engine materialization and before request/audit completion.
  Assert no execution/plan/step/request/audit from the failed operation survives.
- [x] Test 16 parallel same owner/key submissions: identical payload -> one
  request/execution/audit; altered payload -> 409; same key under different owners
  is independent. Lost-response replay returns the original identity.
- [x] Implement visibility-filtered SQL and keyset pagination with prepared
  statements. Test A/B submitters plus reviewer on list/detail/report, including
  guessed UUIDs and every subsequent cursor page. Lists exclude code/report.
- [x] Implement strict report/state projection, including invalid terminal
  result -> FAILED/REVIEW_REPORT_INVALID. Return bounded safe errors, never raw
  engine configuration/credentials. Test status before/after valid result.
- [ ] Prepare review unit/integration and genuine fixture wiring; verification
  checks completed locally (PASS: 44 unit + 73 real PostgreSQL ITs; 5m27s; finished
  2026-11-14T12:52:34Z); final root engine acceptance and global ledger merge
  pending serial integrator gate.