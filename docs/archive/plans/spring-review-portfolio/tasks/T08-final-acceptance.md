---
title: "T08 — Close crash/security acceptance and publish truthful portfolio docs"
status: historical
audience:
  - developer
last_verified: 2026-11-17
superseded_by:
  - docs/architecture/review-service.md
sources:
  - backend/control-plane/src/main/java/io/tenvyr/control/Main.java
  - backend/control-plane/src/main/java/io/tenvyr/control/engine/ExecutionService.java
  - scripts/backend-checks.sh
---

# T08: Close crash/security acceptance and publish truthful portfolio docs

Dependencies: T07. Estimate: 5–7 focused engineering hours.
Read [SPEC](../SPEC.md), [DISCOVERY](../DISCOVERY.md), [WORKER](../WORKER.md) and [VERIFY](../VERIFY.md) first.
Status: accepted (all 9 of 9 tasks accepted locally; plan completed and archived).

## Deliverable and files

Add review-api `ReviewRecoveryIT`, `ReviewConcurrencyIT`,
`ReviewAccessMatrixIT` and extend only existing task checks where appropriate.
Wire review unit/integration/launcher checks into
`.github/workflows/release-ci.yml`. Create
`docs/reference/review-api.openapi.yaml` and update README, docs index,
`docs/showcase/case-study.md`, `docs/showcase/demo-guide.md`,
`docs/architecture/review-service.md`, review operations and implementation
ledger. Keep historical facts separated from the new default portfolio path.

## Interfaces

Consumes all prior reviewed task handoffs. Produces complete verification
evidence and a 5-minute Java/Spring business-backend demonstration. No new
product APIs or framework features are introduced here.

## References to copy

Read VERIFY's full matrix, existing ControlIntegrationCheck real restart/
database-lock shutdown tests, schema parity/canonical comparison and current
CI's explicit check invocation. Read all previous task reports before closing.

## Steps and acceptance

- [x] Add deterministic process-crash checks: (a) kill before submit transaction
  commit -> no bound request/execution; (b) kill after commit before HTTP
  response -> replay same owner/key returns same identity and recovery starts
  work. Re-login after restart; never rely on in-memory session persistence.
- [x] Exercise selected Worker death before callback and duplicate/conflicting/
  stale callbacks after retry. Assert bounded retry or truthful terminal
  failure, same immutable plan, and no stale result overwriting the final state.
  No claim that Worker compute/paid calls execute exactly once.
- [x] Run the complete role/object/state matrix, including old session after
  user disable, missing/stale CSRF, hidden UUID on report/audit/cancel, malicious
  unknown fields/path/URL and chunked/Unicode limits. Reuse existing test helpers
  rather than adding parallel suites for the same behavior.
- [x] Run both cancellation/decision race outcomes under real transaction
  barriers. Prove SIGTERM stops admission, drains held DB work, closes pool
  last, and restarts into consistent work. Record failure logs safely.
- [x] Add explicit CI jobs/steps for review-checks unit/integration and launcher
  tests with dedicated disposable PostgreSQL. Verify Surefire/Failsafe reports
  contain actual tests; unavailable infrastructure fails. Retain the full
  original Java/Go/SDK/Kafka compatibility gates.
- [x] Write OpenAPI for exactly implemented API/status/errors, session+CSRF,
  cursor ordering, idempotency and limits. Update README to lead with the fixed
  business workflow and accurate Java/Spring source paths; keep legacy demo
  documented separately. Add measured 100-request/concurrency4 evidence
  (environment,p50,p95,throughput,rejections), no invented SLA.
- [x] Execute all final gates in VERIFY, preserve exact results and limitations,
  run docs/identity verifiers. Review spec coverage and effective dependencies.
  Mark only delivered capabilities implemented; global exposure/release gates
  and process-local Worker limitations remain open. On acceptance archive this
  completed plan and fix links.

Representative assertions:
```java
assertEquals(originalRequestId, replayAfterCrash.id());
assertEquals(1, requestAndExecutionBindingCount(owner, key));
assertEquals(404, auditForForeignRequestAsSubmitter().statusCode());
assertEquals(1, successfulTerminalBusinessOutcomeCount(requestId));
```

## Reject conditions

No test-pass claims copied from historical evidence, disabled integration
profiles, mock-only crash/race proof, live provider credentials in CI, unbounded
benchmark, silent feature expansion, package publication or public deployment.
If a real blocker remains, record it and keep the task/plan incomplete.
