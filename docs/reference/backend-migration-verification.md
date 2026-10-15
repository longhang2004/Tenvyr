---
title: Backend migration verification
status: current
audience:
  - developer
  - operator
last_verified: 2026-10-16
sources:
  - scripts/backend-build.sh
  - scripts/backend-checks.sh
  - scripts/backend-canonical-check.mjs
  - scripts/backend-database-check.mjs
  - scripts/backend-capsule-oracle.mjs
  - scripts/backend-socketio-check.mjs
  - scripts/backend-dev-check.mjs
  - scripts/backend-showcase-check.mjs
  - scripts/backend-upgrade-check.mjs
  - scripts/self-hosted/recovery.test.mjs
  - .github/workflows/release-ci.yml
---

# Backend migration verification

Default launch/deployment files select Java/Go. Real local default cutover and
original-to-Java upgrade passed from clean source
`12f3a665de921a6f5aece3da1a861f5354fdc222`, preserving the TypeORM ledger,
frozen plans and existing capsule hash. The complete integration runner and all
17 Docker recovery cases passed locally. Later shutdown cleanup fixes have
additional explicit lock/drain and SDK coverage below. CI repeats the complete
gates on each published commit; the [PR checks](https://github.com/longhang2004/Tenvyr/pull/7/checks)
are authoritative for the latest tree. No external production installation was
changed.

## Runs completed on 2026-10-15 and 2026-10-16

| Actual command/gate                                                                                           | Observed result                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sh scripts/backend-build.sh`                                                                                 | Clean Java reactor and Go helper build passed; all seven modules resolve actual dependencies.                                                                                                                           |
| `sh scripts/backend-checks.sh --integration` with disposable PostgreSQL 15/Kafka and public SDK prerequisites | All 21 Java check programs passed, plus Node canonical/database comparison and actual Socket.IO gates; all 17 real Docker recovery cases passed.                                                                        |
| `node scripts/backend-canonical-check.mjs 100000`                                                             | Additional differential: 100,000 binary64 values and 1,000 Unicode objects match original Node bytes/SHA-256. The normal runner uses 20,000 values plus the retained 5,018 goldens.                                     |
| Expanded `ControlIntegrationCheck` and `NativeRuntimeIntegrationCheck`                                        | 75 and 23 checks passed respectively, including original production capsule/hash, connection cards, summaries, execution projection and Attention comparisons on the same settled PostgreSQL rows.                      |
| `node scripts/backend-dev-check.mjs`                                                                          | Default launcher passed Java/Go build, configured-port readiness, source-change rebuild/restart with the same PostgreSQL/Kafka containers, and SIGINT during reload with complete teardown.                             |
| `node --test scripts/dev-ux.test.mjs`                                                                         | All 25 lifecycle/bridge/frontend-port regressions passed.                                                                                                                                                               |
| `node scripts/backend-showcase-check.mjs`                                                                     | Full candidate Docker showcase passed: success/retry-once, Python HTTP Worker, Kafka, original Java runner using mock provider, frontend, all four actual Java backend processes, no Node executable in backend images. |
| Docker `operations` target build, `docker --version`, `docker compose version`                                | Java maintenance image built; Docker 29.6.1 and Compose 5.2.0 execute inside it. Host Java maintenance performed the recovery tests.                                                                                    |
| `node --test scripts/self-hosted/contract.test.mjs`                                                           | All 42 deployment/maintenance contract tests passed with default Java image/command expectations. Retained original maintenance helper tests remain reference checks.                                                   |
| `pnpm build:all` and `pnpm test:all`                                                                          | Passed with Java/Go build and all 9 backend pure programs included. Reference Orchestrator unit run: 823 passed, 422 infrastructure/live-runtime cases skipped; real infrastructure gates run separately.               |
| Actual shutdown lock/drain and public SDK rerun                                                               | A PostgreSQL table lock proves close waits for active recovery. All 75 control checks and all four SDK loopbacks passed after the cleanup fix.                                                                          |
| `node scripts/backend-showcase-check.mjs --cutover`                                                           | Default full-stack success/retry smoke passed with actual Java-only backend processes and matching committed source identity.                                                                                           |
| `node scripts/backend-upgrade-check.mjs`                                                                      | Original Node installation upgraded through a verified backup to Java. Migration ledger, frozen plans and capsule/hash unchanged; new writes and source identity verified. Also passed in CI run 79.                    |
| Setup/identity/documentation verifier tests                                                                   | 94 repository/deployment verifier tests passed after the default switch; documentation and identity verifiers passed with 51 capabilities and no identity violations.                                                   |
| Retained reviewer/observability/gateway/contracts tests                                                       | 11 / 5 / 13 / 65 tests passed. Public Java SDK Maven tests and C++ CTest also passed.                                                                                                                                   |

The integration runner includes real signed HTTP callbacks, restart without
reexecution, PostgreSQL inbox/outbox authority, planner/worker/verifier/operator
flows, preserved Git worktrees and safe release, exclusive continuation lease
transfer, Node/Python/Java/C++ SDK processes, actual Socket.IO v4 polling,
WebSocket/upgrade/broadcast/reconnect/heartbeat, Kafka offset delivery, Worker
stress/shutdown, Java-to-Go native supervision and Docker backup/restore/crash
recovery. An unavailable prerequisite fails the runner.

## Corrections discovered by real runs

The port required fixes to the shared HTTP origin/bind boundary, exact pinned
ICU canonical ordering, original capsule Date hashing, UTC JDBC timestamps,
control-plane composition/readiness, text/UUID joins, stale coordinator phase
handling, authoritative native profile binding, Kafka consumer assignment,
workspace default-root resolution and atomic maintenance owner publication.
Recovery tests also restored informational drift and exact preservation/retry
diagnostics. Kafka Compose readiness now proves metadata availability. A later
CI run exposed recovery work still using PostgreSQL after close returned. HTTP
handlers and the recovery executor now drain before shutdown returns, and all
owned resources are closed even if another close fails. The regression holds
a real PostgreSQL lock across shutdown, then proves completion after release.
The signal-test fixture now writes its PID before publishing readiness.
CI then exposed a completion-held execution reporting progress without a state
change, repeatedly running all 100 reconciliation passes. The hold now yields
unless state advanced; this preserves human approval authority and lets
shutdown drain. All 38 real PostgreSQL engine checks passed, and the complete
26-check coordinator/restart/handoff/worktree program passed five consecutive
runs after this correction. No shutdown timeout was increased.

Earlier Docker runs encountered a full host disk, damaged build caches and a
stopped daemon. Subsequent runs passed after the host recovered. Harness fixes
corrected the runner URL, accepted both shell absence statuses (1/127), included
the mandatory PID column in Docker process listings, and drained final Worker
events before comparing point-in-time captures. Concurrent heavy builds caused
request timeouts; acceptance is run sequentially. Failed invocations are not
counted as passing evidence.

## CI and verification boundaries

Every published commit runs the complete backend acceptance suite, default
deployment/source-identity cutover, original-to-Java upgrade, real default
development reload/shutdown, recovery and retained reference/SDK gates. Keep
the PR draft until its latest required jobs pass. The Node reference unit run
intentionally skips infrastructure-gated tests without their environment; its
Jest runner also emitted a worker-exit warning. Those are not substitutes for
the separately executed PostgreSQL, SDK and lifecycle gates.

The first local upgrade attempt made a verified backup, then hit a registry
metadata timeout. Pulling the official Java base image and repeating the full
operation passed. That failed invocation is not counted as a successful upgrade.

Native tests use actual supervised fixture CLI processes, not installed paid
model agents. Live paid model calls and interactive account authentication were
not run. Existing planned/partial capabilities and public-release approval
blocks remain intact; the migration does not make new release-readiness claims.
