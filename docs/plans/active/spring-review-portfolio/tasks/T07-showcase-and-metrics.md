---
title: "T07 — Ship HTTP-only review showcase with bounded resources and metrics"
status: current
audience:
  - developer
last_verified: 2026-11-16
sources:
  - backend/review-api/src/main/java/io/tenvyr/review/ReviewMetrics.java
  - backend/review-api/src/test/java/io/tenvyr/review/ReviewMetricsIT.java
  - docker-compose.review.yml
  - scripts/review-showcase.sh
  - scripts/review-smoke.mjs
---

# T07: Ship HTTP-only review showcase with bounded resources and metrics

Dependencies: T06. Estimate: 4–6 focused engineering hours.
Read [SPEC](../SPEC.md), [DISCOVERY](../DISCOVERY.md), [WORKER](../WORKER.md) and [VERIFY](../VERIFY.md) first.
Status: accepted locally (T00–T07 accepted 8/9; T08 planned).

## Deliverable and files

Create `docker-compose.review.yml`, `backend/review-api/Dockerfile`,
`backend/review-worker/Dockerfile`, `scripts/review-showcase.sh`,
`scripts/review-smoke.mjs`, `scripts/review-showcase.test.mjs`.
Create review-api `ReviewMetrics.java`; extend application.yml with capacity
settings. Add scoped package scripts if useful. Create current
`docs/operations/review-showcase.md`; leave scripts/dev.mjs and legacy Compose
defaults untouched (they already have unrelated user edits).

## Interfaces

Consumes completed workflow and exact auth/API contract. Produces
`review-showcase.sh up|down|status` and `node scripts/review-smoke.mjs` as in VERIFY.
Existing `pnpm showcase:*` commands retain behavior. Default offline topology
has only API+Worker+PostgreSQL and uses explicit MOCK results.

## References to copy

Copy disposable ownership and health polling patterns from existing showcase/
backend-dev scripts without copying their Kafka/SDK requirements. Read Boot
Actuator metrics docs. Reuse WorkerConfig fields, not invented queue options.

## Steps and acceptance

- [x] Add launcher contract tests before implementation: exact Compose project,
  API loopback publication, Worker/DB unpublished, no Kafka/Gateway/paid-model
  requirement, down preserves volumes, failure exits nonzero and cleans only
  newly owned temporary resources.
- [x] Generate secrets and three users (submitter A/B and reviewer) into an
  ignored permission-restricted runtime directory without printing them.
  Explicitly pass bootstrap file on up. Repeated up does not overwrite existing
  users or lose IDs; design bootstrap invocation to skip already-bootstrapped
  installations without converting a general bootstrap conflict into reset.
- [x] Build images from committed source/runtime dependencies, independent of
  developer target directories. Set source revision evidence. Health waits are
  bounded and fail with safe reason/status; never dump environment or secrets.
- [x] Smoke drives real sessions and CSRF tokens, submit/replay, processing,
  MOCK report, different reviewer verdict, audit, foreign submitter denial.
  Include safe fixed fixtures; use request-scoped IDs and do not rely on prior
  dashboard state. Labels make demo/mock mode visible.
- [x] Set Tomcat max threads50/accept-count50, Hikari pool10/acquisition2s and
  existing Worker2/queue16. Map transient admission/database unavailability
  to503+Retry-After. Do not turn these defaults into unmeasured capacity claims.
- [x] Publish authenticated Actuator metrics to REVIEWER only; public health
  reveals minimal status. Add low-cardinality command outcomes/latency and
  current review backlog gauge. No actor/request IDs, code, comments, tokens or
  user URLs as metric labels. No new telemetry pipeline or Prometheus server.
- [x] Execute launcher tests, actual up/smoke/down twice and inspect process/
  port/container evidence for absence of Kafka/native/Node backend requirements.
  Update docs/ledger, both verifiers and handoff.

Representative assertions:
```javascript
assert.equal(firstSubmit.id, replaySubmit.id);
assert.equal(report.evidence.mode, "MOCK");
assert.equal(foreignRead.status, 404);
```

## Reject conditions

No changes to global dev launcher, automatic deletion of volumes, fixed public
passwords, paid calls, remote deployment, additional frontend project, or
metrics that expose source/identities. Tests proving YAML text alone do not
replace the running HTTP/database smoke.
