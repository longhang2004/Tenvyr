---
title: Backend language migration continuation briefing
status: planned
audience:
  - developer
last_verified: 2026-10-15
sources:
  - AGENTS.md
  - CLAUDE.md
  - docs/development/agent-rules.md
  - backend/pom.xml
  - backend/platform/src/main/java/io/tenvyr/platform/Http.java
  - backend/platform/src/main/java/io/tenvyr/platform/Json.java
  - backend/platform/src/test/java/io/tenvyr/platform/FoundationCheck.java
  - backend/platform/src/test/resources/node-canonical-goldens.json
  - scripts/backend-build.sh
  - scripts/backend-checks.sh
  - scripts/java-backend.sh
  - docs/reference/implementation-status.json
---

# Continue the backend language migration

## Continuation checkpoint — 2026-10-15

The shared HTTP boundary now defaults to IPv4 loopback and exact configured
CORS origins. ICU4J 78.2 replaces the approximate JDK collator; the normal
foundation runner now checks all 5,018 retained canonical strings **and** hashes.
`io.tenvyr.control.Main` now composes the Java services and owns lifecycle and
recovery. The runner forwards `--integration` and has concrete implementations
of the formerly missing check programs. Fresh builds clean the reactor first.

The complete integration runner passed all 21 Java check programs plus the
Node differential and real Socket.IO gates. This includes PostgreSQL/Kafka,
all four public Worker SDKs, native processes, coordinator restart and handoff,
Git workspace preservation/release, and all 17 Docker recovery cases. The
100,000-number/1,000-Unicode-object differential also passed against Node.
The genuine Java maintenance image builds and its Docker CLI/Compose execute.

The full Docker candidate gate passed success/retry flows, Python Worker,
Kafka, original Java runner and frontend, and Java-only backend processes.
Both expanded original-service read-model oracles passed, including the native
planner/worker/verifier run. The default launcher passed real configured-port
startup and SIGINT teardown; all 25 launcher regressions and 42 self-hosted
contract tests pass. Default files now select Java/Go.

The complete suite is rerunning on the final defaults. An actual original-to-
Java upgrade, committed-source cutover, remote CI and PR publication remain
unfinished. Keep the PR draft. Docker recovered after the disk-full incident;
use task-owned disposable stacks and run heavy builds/tests sequentially.

See [current candidate mechanics](../../../development/java-backend.md) and the
per-capability `java_go` entries in the implementation ledger. The earlier
inspection findings below describe the original handoff and remain useful as
historical context; re-read current source before applying them.

Generated 2026-10-15. This is a briefing for fresh local agents and an explicit
record of unfinished work. The PR is a **draft**, not a completed migration or a
cutover approval. `last_verified` describes this source inspection, not passing
runtime acceptance gates.

## Goal

Finish migrating Tenvyr's TypeScript/JavaScript backend responsibilities to Java
17 and a small Go native process helper with complete behavioral, operational,
data, security, and protocol parity. Carry the work through real integration
checks, packaging, CI, documentation, and a proven cutover. Preserve existing
features and persisted identities; do not hide the original Node backend behind
the new services, silently remove functionality, or substitute a smaller demo.
The original reference base is
`876fe78fdf9a7f9d053f5dd0a8b83a4d830f7196`.
Continue on `codex/backend-language-migration-handoff-20261015` in
`longhang2004/Tenvyr`; the publication targets a draft PR and leaves `main`
untouched.

## Current state

The candidate lives in `backend/`, with seven Maven modules: `platform`,
`control-plane`, `gateway`, `agents`, `worker`, `executor-host`, and `operations`.
`control-plane` contains engine, authority, and runtime packages. The native
helper is `backend/executor-host/native/` (Go 1.23). These are substantial but
unfinished ports. Many Java methods are compressed onto single lines; review
their logic against the originals rather than assuming source volume proves
parity. Default files now select Java/Go after the candidate gates passed. The
committed-source cutover and upgrade checks still need to pass; no external
production installation has been changed.

At handoff inspection the candidate had 90 Java main source files and 11 test
source files; counts can change. The inventories contain exactly **36 entity
entries**, **27 migration entries**, and **51 implementation-ledger
capabilities**. Those are preservation requirements, not evidence that all of
them work in Java.

### Priority defects and gaps

| Priority | Finding at inspection                                                                                                                                                                                      | Required continuation                                                                                                                                                                                                   |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0       | Shared `platform/Http.java` defaults to `0.0.0.0` and reflects every supplied `Origin` with `Access-Control-Allow-Credentials: true`. Gateway's separate `LocalOrigin` does not fix this shared transport. | Trace all callers, preserve the original explicit-origin/strict-loopback policy, fix the shared boundary, and add a meaningful cross-origin regression check. Reinspect source in case another branch already fixed it. |
| P0       | `platform/Json.java` still uses `java.text.Collator(Locale.US)`. Five Unicode cases failed among 5,018 Node canonical vectors.                                                                             | Reproduce exact original JavaScript `localeCompare` ordering and `JSON.stringify` bytes, including number rendering and Unicode, before trusting persisted hashes. An approximate Collator is unacceptable.             |
| P0       | No complete reactor/build/check/real-infrastructure acceptance result exists for the latest assembled candidate.                                                                                           | Build and test current sources afresh; do not treat older compiled `/tmp` classes as current proof.                                                                                                                     |
| P1       | `scripts/java-backend.sh` selects `io.tenvyr.control.Main`, absent at inspection. The control-plane composition root and runtime wiring are unfinished.                                                    | Complete and verify lifecycle ownership, transport wiring, authority/runtime seams, health/readiness, shutdown, recovery, and launch configuration.                                                                     |
| P1       | `backend-checks.sh` names missing check classes and does not pass `--integration` to the engine integration check, which requires it.                                                                      | Repair the runner and implement meaningful missing checks; never remove a gate merely to obtain a green exit.                                                                                                           |

### Verification evidence: historical versus current

These are previous observations from this working session. This handoff task
only inspected sources/evidence and preserved the golden fixture; it did not
rerun the suites. Local `/tmp` paths below are optional evidence and will not
exist in a fresh clone.

| Area                      | Previously observed                                                                                                         | Limit on the claim                                                                                                                                                                                  |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Foundation                | `/tmp/tenvyr-resume-verify/foundation-warm.log`: `FoundationCheck: 48 checks passed`.                                       | Basic check only. One earlier cold run timed out after 30 seconds. It does not exercise optional Node vectors unless supplied explicitly.                                                           |
| Canonical JSON            | `/tmp/tenvyr-resume-verify/foundation-node-goldens.log`: `java.lang.AssertionError: canonical Node golden failures: 5`.     | Failures are `unicode-keys-0`, `unicode-keys-1`, `unicode-keys-3`, `unicode-keys-5`, `unicode-keys-6`. No verified fix.                                                                             |
| Operations                | Previous implementer reported `OperationsCheck` passing 67 cases.                                                           | This is a prior-session report, not a fresh run. Real Docker/PostgreSQL backup, restore, upgrade and crash recovery remain unproven.                                                                |
| Worker HMAC               | `/tmp/tenvyr-resume-verify/callback-vectors.log`: 8 vectors, 8 failures because expected `v1=` but actual was `sha256=`.    | Current `CallbackDelivery.signature` now emits `v1=`. The retained log predates that fix; no successful independent fixture rerun was found.                                                        |
| Worker/executor/native    | Previous implementer reported Java worker/executor compilation and Go helper tests passing.                                 | Current assembled reactor and HTTP/process lifecycle suites still need fresh verification.                                                                                                          |
| Engine/authority/capsules | Implementer reported the completed engine/authority/capsule slice compiling.                                                | This supersedes the _older_ `/tmp/tenvyr-resume-verify/report.json` compile failures for missing capsule, cancel signature, and `Json.bytes(...).length`; do not assume current integration passes. |
| Gateway                   | Historical `GatewayCheck` failed with `java.net.SocketException: Operation not permitted` when opening a loopback listener. | Environment denial, not a successful Socket.IO test. A later gateway pure check exists; no fresh pass is claimed here.                                                                              |
| Runtime/all modules       | Code and reactor composition changed after earlier verification.                                                            | Current compile and behavioral status is unverified.                                                                                                                                                |

The historical direct-`javac` report compiled then-current platform, gateway,
agents, and worker classes. It also contained older control-plane errors. Those
artifacts are stale after source edits and are useful only to explain prior
attempts. Do not copy temporary classpaths into the permanent build.

## Files in play

| Path                                                                                                                                 | Purpose and comparison source                                                                                                                                                                                                                                               |
| ------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AGENTS.md`, `CLAUDE.md`, `docs/development/agent-rules.md`, `docs/README.md`                                                        | Read first. Executable contracts/code/tests outrank historical prose. Use surgical edits and update the documentation/ledger with implementation changes.                                                                                                                   |
| `backend/pom.xml`, `backend/*/pom.xml`                                                                                               | Java 17 reactor and dependencies. Parent currently pins Netty BOM `4.1.114.Final`; a complete `4.1.119.Final` cache was reported while `4.1.114.Final` was partial. Verify actual resolution; do not mix versions or treat an ad hoc cached classpath as the product build. |
| `backend/platform/src/main/java/io/tenvyr/platform/{Json,Http,Db,Migrator,Entities,Protocol}.java`, `platform/domain/`               | Shared serialization, HTTP/security, JDBC, exact TypeORM ledger compatibility, entity metadata and v1 validation. Compare `packages/contracts/`, original domain helpers and database sources.                                                                              |
| `backend/platform/src/main/resources/db/`, `resources/contracts/`                                                                    | 36 entities, 27 up/down migrations, and contract resources. Compare `services/orchestrator/src/entities/`, `database/migrations/`, and `contracts/schemas/`. Preserve exact schema, migration names/timestamps/order and existing TypeORM `migrations` ledger.              |
| `backend/platform/src/test/resources/node-canonical-goldens.json`                                                                    | Preserved 5,018 generated vectors from `/tmp/tenvyr-foundation-node-goldens.json`, each with name/value/canonical/hash. SHA-256: `b102a62806605f42329784a60c821f2dc01f5682100f6274eb472035d5f929ff`. This is generated test data, not user data.                            |
| `backend/control-plane/src/main/java/io/tenvyr/control/engine/`                                                                      | Pipelines, executions/claims, outbox/inbox, retries/timeouts, events, HTTP/Kafka adapters, recovery and supervision. `EngineAuthority` and `EngineRuntime` are the intended seams. Compare original services and agent adapters end to end.                                 |
| `backend/control-plane/src/main/java/io/tenvyr/control/authority/`                                                                   | Policy, budgets, approval, proposals, state, delegation, context/artifact projection, capsules/export/replay. `AuthorityServices` binds this to the engine using the engine's transaction. Compare original authority services/domains and SQL behavior.                    |
| `backend/control-plane/src/main/java/io/tenvyr/control/runtime/`, `ControlRoutes.java`                                               | Connections/revisions, CLI/provider/model discovery, workspaces, coordination/planner/verifier loops, handoffs, workbench projection/commands and release. Composition/startup remains to be finished. Compare original runtime services and controllers.                   |
| `backend/gateway/`                                                                                                                   | Netty gateway, proxy routes, workbench HTML and handwritten Engine.IO/Socket.IO handling. Compare `services/gateway/` and the actual frontend Socket.IO v4 client.                                                                                                          |
| `backend/agents/`                                                                                                                    | Kafka agents and processors. Compare `services/agent-code-reviewer/`, `services/agent-observability/` and any original shared LLM/runtime behavior; verify provider errors and result shapes.                                                                               |
| `backend/worker/`                                                                                                                    | HTTP worker, callback delivery, cancellation and scheduling. Compare `packages/worker/`, `contracts/conformance/`, and public SDK loops; preserve lifecycle and authentication ordering.                                                                                    |
| `backend/executor-host/`, `backend/executor-host/native/`                                                                            | Java supervisor and Go `setsid`/`exec`/process-group signal helper. Compare `packages/local-executor-host/` and the established Rust host contracts. Native Unix process semantics remain authoritative.                                                                    |
| `backend/operations/`                                                                                                                | Java preflight, maintenance journal/lock, backup/restore/upgrade/invariants. Compare `scripts/self-hosted/*.mjs` and recovery fixtures.                                                                                                                                     |
| `scripts/{backend-build,backend-checks,java-backend}.sh`, `backend/Dockerfile`, `docker-compose.java.self-hosted.yml`                | Additive candidate build/launch/image/Compose. Validate paths/resources/configuration and real deployment behavior before changing production defaults.                                                                                                                     |
| `docs/reference/implementation-status.{json,md}`, `.github/workflows/release-ci.yml`, root `package.json`, developer/operations docs | Preserve all 51 capabilities, make Java gates part of CI, record proof honestly, and update runbooks/default commands only as proven. Existing CI primarily exercises originals.                                                                                            |

## What was tried, and why it did not establish completion

| Attempt                                                                      | Result and lesson                                                                                                                                                                                                                                                                                                |
| ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Standard Java US Collator for canonical key sorting                          | Five retained Unicode vectors fail. Persisted hash identity requires the original ordering/serialization, not a plausible collation approximation. Node used ICU 78.2; a matching ICU dependency was not cached. Obtain/verify an exact implementation on the full machine without a hidden runtime Node bridge. |
| Shared HTTP helper with broad defaults                                       | Inspection exposed credentialed reflection of arbitrary origins and a wildcard bind default. Separate gateway origin code cannot secure control-plane/shared callers. Fix the shared policy and verify all consumers.                                                                                            |
| Initial worker HMAC implementation                                           | Used `sha256=` rather than exact protocol-v1 `v1=`. Source changed after the independent fixtures exposed eight failures; rerun the fixtures against fresh classes.                                                                                                                                              |
| Local listeners, Docker and PostgreSQL initialization in the managed sandbox | Loopback bind was denied; Docker daemon access and PostgreSQL `initdb` shared-memory `shmget` were denied. These gates require the full local machine. Do not convert unavailable integration checks into mocked success.                                                                                        |
| Maven/shell network and temporary cached dependency classpaths               | Dependency/network access was unavailable from shell; GitHub connector remained usable. A partial Netty cache and cold filesystem I/O complicated verification. Fresh normal dependency resolution and a clean reactor build are still required.                                                                 |

## Current best theory

Continue the existing port in bounded slices using the originals as executable
reference. First make shared security and byte identities correct, then finish
composition and prove transaction/process/lifecycle behavior with real local
infrastructure. The existing module split is sufficient; a wholesale rewrite
would discard useful work without resolving the untested boundaries.

## Next steps and exact commands

Run from the repository root with JDK 17+, Maven, Go 1.23+, Node/pnpm for
reference/conformance tooling, PostgreSQL and Kafka, Docker, and permission for
loopback listeners/process groups. Use disposable databases/volumes.

1. **Reestablish current truth and fix shared P0s.** Read the sources above,
   compare with the original base, inspect current branch/PR status, and record
   a 51-capability parity checklist. Fix the shared HTTP origin/bind policy and
   exact canonical serialization. Keep the retained fixture. Build with:

   ```sh
   sh scripts/backend-build.sh
   # Offline only when every dependency and plugin is already available:
   TENVYR_MAVEN_OFFLINE=true sh scripts/backend-build.sh
   (cd backend/executor-host/native && go test ./...)
   (cd backend/executor-host/native && go build -o tenvyr-process-launcher .)
   ```

   `backend-build.sh` runs Maven `package -DskipTests` plus dependency copying;
   it does **not** execute these main-based check programs. After a successful
   build, reproduce canonical hashes explicitly:

   ```sh
   java -ea -cp 'backend/platform/target/test-classes:backend/platform/target/classes:backend/platform/target/dependency/*' \
     io.tenvyr.platform.FoundationCheck "$PWD" \
     backend/platform/src/test/resources/node-canonical-goldens.json
   ```

   `FoundationCheck` currently compares canonical text; also assert the retained
   `hash` fields match. The normal check runner does not supply the optional
   golden argument, so passing it alone cannot establish hash parity.

2. **Finish composition and make the check runner truthful.** Add/verify the
   missing control-plane entrypoint and route/runtime/authority ownership. At
   inspection these named checks were absent: `ControlCheck`, `RuntimeCheck`,
   `FoundationIntegrationCheck`, `ControlIntegrationCheck`,
   `AgentIntegrationCheck`, `ExecutorHostIntegrationCheck`, and
   `OperationsIntegrationCheck`. The current runner's integration flag is not
   forwarded. Once repaired, run:

   ```sh
   sh scripts/backend-checks.sh pure
   TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/tenvyr_migration_test \
     sh scripts/backend-checks.sh --integration
   ```

   Before runner repair, the actual existing engine integration entrypoint can
   be invoked directly after build:

   ```sh
   TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/tenvyr_migration_test \
     java -ea -cp 'backend/control-plane/target/test-classes:backend/control-plane/target/classes:backend/control-plane/target/dependency/*' \
     io.tenvyr.control.engine.EngineIntegrationCheck --integration
   ```

   That check requires a database name containing `test`, `scratch`, or
   `disposable`, creates a private schema, and needs real PostgreSQL. Other
   existing checks accept repository root as their first argument. Repair all
   orchestration rather than skipping missing classes.

3. **Prove parity on real infrastructure.** Exercise an existing migrated
   PostgreSQL database as well as an empty one; compare migration ledgers and
   entity/constraint/index behavior. Test concurrent claims/leases, durable
   inbox/outbox, retry/cancel/timeout races, approval/state/budget/delegation,
   capsule/export/replay, workspace isolation/release and restart recovery.
   Run real Kafka task/result/event paths, frontend Socket.IO v4 polling,
   upgrade/heartbeat/reconnect/broadcast, and Node/Python/Java/C++ SDK callback
   loops against the Java control plane. Verify exact raw-body HMAC vectors
   independently of the Java producer. Test native no-shell argv/environment,
   authoritative cwd/bindings, process-group kill and single terminal ownership.

4. **Prove deployment/operations, then cut over.** Validate candidate images
   and Compose health/readiness. Run Java preflight/backup/restore drills,
   upgrade/rollback and SIGKILL at maintenance journal boundaries on disposable
   volumes, comparing original guarantees. Remove any remaining backend Node
   runtime dependency through real Java/Go implementations. Change default
   dev/Compose/self-hosted commands only after all parity gates pass. Preserve
   a tested recovery path and do not remove original evidence prematurely.

5. **Update current docs/ledger/CI and finish review.** Follow repository
   lifecycle rules, document new mechanics in `CLAUDE.md` and
   `docs/development/agent-rules.md`, update all 51 capability proofs, and add
   meaningful Java/Go/infrastructure gates to `.github/workflows/release-ci.yml`.
   Run the existing checks below plus the complete new acceptance suite. Record
   exact commands, exit statuses, proof artifacts and remaining limitations;
   promote the draft only when the completion claim is supported.

   ```sh
   pnpm test:docs
   pnpm verify:docs
   pnpm test:identity
   pnpm verify:identity
   pnpm exec prettier --check docs/plans/active/backend-language-migration/CONTINUE.md
   git diff --check
   ```

## Non-negotiable compatibility constraints

| Boundary                 | Preserve                                                                                                                                                                                                                                                               |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Protocol and data        | All 51 capabilities; all 36 tables and 27 TypeORM migration identities; immutable invocation/attempt correlation, schema version `"1"`, legacy normalization, closed schemas, existing error/status/envelope semantics and persistence transactions.                   |
| Kafka and HTTP callbacks | Exact retained runtime-v1 topic/group/client IDs; no aliases or dual publication. Exact retained v1 HMAC header names, `v1=` signature prefix, HMAC over `<timestamp>.<deliveryId>.<rawBody>`, timestamp/replay validation, stable delivery ID/bytes on retries.       |
| Persisted identities     | Original JavaScript `localeCompare` plus `JSON.stringify` canonical bytes and hashes for plans, revisions, capsules, bindings, conflicts and context; finite/safe JSON and special keys. Do not rewrite stored hashes to accommodate a new algorithm.                  |
| Network and workers      | Strict loopback defaults, exact explicit origins, auth before body, no unsafe CORS reflection, Socket.IO v4 compatibility, bounded FIFO/concurrency/idempotency, one terminal result, graceful stop only after tracked callbacks/retries settle.                       |
| Runtime and authority    | Fixed no-shell executable/argv, environment restrictions, authoritative cwd/workspace and revision/lease binding, process-group termination, fail-closed recovery/approvals/policy, transaction-owned state, no provider/telemetry layer becoming execution authority. |

## Copy-paste prompt for local agents

```text
Read AGENTS.md, CLAUDE.md, docs/development/agent-rules.md, docs/README.md, and
docs/plans/active/backend-language-migration/CONTINUE.md, then continue the draft
backend language migration through completion in longhang2004/Tenvyr on branch
codex/backend-language-migration-handoff-20261015. Fetch and check out that branch
before working. Original reference base:
876fe78fdf9a7f9d053f5dd0a8b83a4d830f7196. The goal is complete TS/JS backend
migration to Java 17 plus the Go native process helper, with full feature,
wire/data/hash/security/operational parity and a verified default cutover.

The candidate is unfinished in backend/{platform,control-plane,gateway,agents,
worker,executor-host,operations}; control-plane has engine/authority/runtime
packages. Originals remain production/defaults. Do not claim completion,
silently drop features, use a hidden Node bridge, or rewrite whole files without
cause. Preserve all 51 capabilities, 36 entity tables, 27 TypeORM migrations,
retained Kafka v1 IDs, exact raw-body v1 HMAC with v1=, Socket.IO v4,
persisted JS localeCompare + JSON.stringify hashes, strict loopback/origin policy,
native no-shell execution, authoritative cwd/revision/lease binding, recovery,
budgets, policy and approvals.

Start by reproducing the current clean build and the shared P0 defects:
platform/Http reflects arbitrary credentialed origins and defaults 0.0.0.0;
platform/Json uses an approximate Collator and historically fails 5 Unicode
cases in the retained 5,018-vector node-canonical-goldens.json fixture. The
FoundationCheck normal runner omits the optional golden path. Worker HMAC source
was fixed after 8 failed vectors, but needs independent recheck. Finish the
missing control-plane Main/composition and missing/incorrect check runner gates.
Re-read current files before applying these findings; other commits may fix them.

Use the full local machine for real PostgreSQL/Kafka/Socket.IO/worker SDK loops,
native process supervision and Docker backup/restore/upgrade/SIGKILL recovery.
Managed-sandbox denials and older direct-javac outputs are not passing evidence.
Follow CONTINUE.md's commands and acceptance sequence. Audit each port against
original production code/contracts/tests, make bounded fixes, update current
docs and the 51-capability implementation ledger, add Java/Go gates to CI, and
change production/default launch paths only after all parity gates pass. Finish
with exact test evidence, remaining risks, and reviewable commits on the PR.
```
