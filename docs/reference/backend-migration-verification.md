---
title: Backend migration verification
status: current
audience:
  - developer
  - operator
last_verified: 2026-10-15
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

Default launch/deployment files select Java/Go. The complete 21-program suite
and all 17 Docker recovery cases passed again on these defaults. PR #7 remains draft until
committed-source cutover, source-build upgrade and remote CI are verified.
No external production installation has been changed.

## Runs completed on 2026-10-15

| Actual command/gate                                                                                           | Observed result                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sh scripts/backend-build.sh`                                                                                 | Clean Java reactor and Go helper build passed; all seven modules resolve actual dependencies.                                                                                                                           |
| `sh scripts/backend-checks.sh --integration` with disposable PostgreSQL 15/Kafka and public SDK prerequisites | All 21 Java check programs passed, plus Node canonical/database comparison and actual Socket.IO gates; all 17 real Docker recovery cases passed.                                                                        |
| `node scripts/backend-canonical-check.mjs 100000`                                                             | Additional differential: 100,000 binary64 values and 1,000 Unicode objects match original Node bytes/SHA-256. The normal runner uses 20,000 values plus the retained 5,018 goldens.                                     |
| Expanded `ControlIntegrationCheck` and `NativeRuntimeIntegrationCheck`                                        | 71 and 23 checks passed respectively, including original production capsule/hash, connection cards, summaries, execution projection and Attention comparisons on the same settled PostgreSQL rows.                      |
| `node scripts/backend-dev-check.mjs`                                                                          | Default launcher passed actual Java/Go build, PostgreSQL/Kafka startup, control/gateway/native host/frontend readiness on configured ports, and SIGINT teardown.                                                        |
| `node --test scripts/dev-ux.test.mjs`                                                                         | All 25 lifecycle/bridge/frontend-port regressions passed.                                                                                                                                                               |
| `node scripts/backend-showcase-check.mjs`                                                                     | Full candidate Docker showcase passed: success/retry-once, Python HTTP Worker, Kafka, original Java runner using mock provider, frontend, all four actual Java backend processes, no Node executable in backend images. |
| Docker `operations` target build, `docker --version`, `docker compose version`                                | Java maintenance image built; Docker 29.6.1 and Compose 5.2.0 execute inside it. Host Java maintenance performed the recovery tests.                                                                                    |
| `node --test scripts/self-hosted/contract.test.mjs`                                                           | All 42 deployment/maintenance contract tests passed with default Java image/command expectations. Retained original maintenance helper tests remain reference checks.                                                   |
| Setup/identity/documentation verifier tests                                                                   | 52 tests passed; documentation and identity verifiers passed before the default cutover edits. They must pass again on the published changes.                                                                           |
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
diagnostics. Kafka Compose readiness now proves metadata availability.

Earlier Docker runs encountered a full host disk, damaged build caches and a
stopped daemon. Subsequent runs passed after the host recovered. Harness fixes
corrected the runner URL, accepted both shell absence statuses (1/127), included
the mandatory PID column in Docker process listings, and drained final Worker
events before comparing point-in-time captures. Concurrent heavy builds caused
request timeouts; acceptance is run sequentially. Failed invocations are not
counted as passing evidence.

## Pending verification

- Clean committed-source default showcase cutover and original-to-Java upgrade.
- Automatic development source rebuild/restart, final repository verifiers and remote CI.

Native tests use actual supervised fixture CLI processes, not installed paid
model agents. Live paid model calls and interactive account authentication were
not run. Existing planned/partial capabilities and public-release approval
blocks remain intact; the migration does not make new release-readiness claims.
