---
title: "T01 — Add isolated Spring application, signed callbacks and lifecycle gates"
status: historical
audience:
  - developer
last_verified: 2026-11-13
superseded_by:
  - docs/architecture/review-service.md
sources:
  - backend/control-plane/src/main/java/io/tenvyr/control/Main.java
  - backend/control-plane/src/main/java/io/tenvyr/control/engine/ExecutionService.java
  - scripts/backend-checks.sh
---

# T01: Add isolated Spring application, signed callbacks and lifecycle gates

Dependencies: T00. Estimate: 5–7 focused engineering hours.
Read [SPEC](../SPEC.md), [DISCOVERY](../DISCOVERY.md), [WORKER](../WORKER.md) and [VERIFY](../VERIFY.md) first.
Status: completed and accepted on 2026-11-13 ([report](../reports/T01.md)).
Report: [reports/T01.md](../reports/T01.md)

## Deliverable and files

Create `backend/review-api/pom.xml`, `src/main/java/io/tenvyr/review/ReviewApplication.java`,
`EngineConfiguration.java`, `EngineLifecycle.java`,
`AgentCallbackController.java`, `ReviewSecurityConfiguration.java`, and
`src/main/resources/application.yml` under that module. Create tests
`ReviewContractCompatibilityTest`, `ReviewCallbackIT`, `ReviewLifecycleIT`.
Register the module in `backend/pom.xml`. Create `scripts/review-checks.sh`
with the exact modes in VERIFY. Update current review architecture/operations
docs and ledger; no business routes are open yet.

## Interfaces

Consumes T00 runtime and Db.fromDataSource. Produces Boot application and:
```java
ControlPlaneRuntime engineRuntime() // managed singleton bean
POST /internal/agent-callbacks/http/code-reviewer // existing raw HMAC contract
GET /actuator/health/liveness
GET /actuator/health/readiness
```

Callback success is 204. Delegate adapter status mapping on rejection. Deny all
other new/legacy business routes until T03/T04, without generated default
passwords or anonymous management endpoints.

## References to copy

Read DISCOVERY's Boot version/transaction docs, Main lifecycle, existing
ControlRoutes callback and HttpAgentAdapter.handleCallback. Copy existing
canonical/hash/HMAC fixtures into an executable test on the Boot dependency
closure; do not regenerate expected values.

## Steps and acceptance

- [x] Add independent Boot 3.5.16 parent with Java 17, explicit internal artifact
  versions and initial Web/Validation/JDBC/Security/Actuator/test dependencies.
  Keep root BOM/pins unchanged. Configure Surefire unit tests and a
  `review-integration` Failsafe profile for `*IT`.
- [x] Add failing tests for unsigned/bad-signature callbacks, exact raw bytes,
  and known canonical vectors under the new runtime dependency tree.
- [x] Wire pooled Db and T00 runtime exactly once. At this stage base Migrator
  runs before runtime start; T02 inserts review migration before that start.
  Validate code-reviewer resolves to HTTP and explicit Kafka configuration is
  absent in review mode. Do not register ControlRoutes on the public server.
- [x] Configure one exact callback CSRF exemption and permit its authentication
  to be handled by HMAC; leave all remaining unsafe requests protected. Bound
  callback streaming body to 1 MiB. A valid HMAC request needs no user session.
- [x] Implement admission/readiness and draining lifecycle with integration
  evidence. Use Spring SmartLifecycle ordering: runtime start before web
  admission, runtime stop after web admission/drain; depend explicitly on
  completed database initialization. Do not rely on bean registration order.
  Preserve the following existing shutdown requirements with integration
  evidence: hold an actual database lock across shutdown; close waits, then
  releases all resources after the lock clears. Startup failure leaves no timer
  or adapter running. Pool closes last even if another close throws.
- [x] Create runner modes using Maven reactor `-pl review-api -am`; unit uses
  `test`, integration uses `verify -Preview-integration` and fails on missing
  disposable database. Print executed tests; build-with-skip is not evidence.
- [x] Run unit/integration modes and retained pure/lifecycle regressions. Record
  effective dependency tree and verify all Jackson components converge. Update
  docs/ledger, run verifiers and hand off. Accepted with 11 unit tests,
  13 ITs, 9 pure programs, 93 retained PostgreSQL/HTTP/restart checks and both
  verifiers. Final runner/direct-IT routing-query and fragment guards passed.
  Full retained Kafka/polyglot compatibility remains the T08 gate.

Representative checks:
```java
assertEquals(401, postUnsignedCallback().statusCode());
assertEquals(204, postSignedOriginalBytes().statusCode());
assertFalse(shutdownFuture.isDone()); // while real recovery holds/waits on DB
```

## Reject conditions

No global CSRF disable, JSON reserialization before HMAC, global Json.MAPPER
changes, legacy API proxying, new scheduler or change to compatibility hashes.
Health responses must not expose secrets/database URLs. Use a real database
for lifecycle ITs; unit doubles are allowed only for isolated boundary tests.
