---
title: Review Service Architecture and Seam
status: current
audience:
  - developer
  - operator
last_verified: 2026-11-14
sources:
  - backend/platform/src/main/java/io/tenvyr/platform/Db.java
  - backend/control-plane/src/main/java/io/tenvyr/control/ControlPlaneRuntime.java
  - backend/control-plane/src/main/java/io/tenvyr/control/Main.java
  - backend/review-api/src/main/java/io/tenvyr/review/EngineConfiguration.java
  - backend/review-api/src/main/java/io/tenvyr/review/EngineLifecycle.java
  - backend/review-api/src/main/resources/application.yml
  - backend/review-api/src/main/resources/application-https.yml
  - backend/review-api/src/main/java/io/tenvyr/review/ReviewMigrationConfiguration.java
  - backend/review-api/src/main/java/io/tenvyr/review/PipelineCatalog.java
  - backend/review-api/src/main/java/io/tenvyr/review/domain/ReviewTypes.java
  - backend/review-api/src/main/java/io/tenvyr/review/ReviewSecurityConfiguration.java
  - backend/review-api/src/main/java/io/tenvyr/review/security/ActorResolver.java
  - backend/review-api/src/main/java/io/tenvyr/review/security/BootstrapUsers.java
  - backend/review-api/src/main/java/io/tenvyr/review/AuthController.java
  - backend/review-api/src/main/java/io/tenvyr/review/ReviewService.java
  - backend/review-api/src/main/java/io/tenvyr/review/ReviewRepository.java
  - backend/review-api/src/main/java/io/tenvyr/review/ReviewController.java
  - backend/review-api/src/main/java/io/tenvyr/review/ReviewReportMapper.java
  - backend/review-api/src/main/java/io/tenvyr/review/ReviewErrors.java
  - backend/review-api/src/main/java/io/tenvyr/review/RequestBodyLimitFilter.java
  - backend/review-api/src/main/java/io/tenvyr/review/ReviewValidation.java
  - backend/review-api/src/main/resources/db/review/V1__review_domain.sql
  - backend/agents/src/main/java/io/tenvyr/agents/ReviewReportContract.java
  - contracts/schemas/review-report.v1.schema.json
  - backend/review-api/src/test/java/io/tenvyr/review/ReviewLifecycleIT.java
  - backend/review-api/src/test/java/io/tenvyr/review/ReviewValidationTest.java
  - backend/review-api/src/test/java/io/tenvyr/review/ReviewSubmissionIT.java
  - backend/review-api/src/test/java/io/tenvyr/review/ReviewReadsIT.java
  - backend/review-api/src/test/java/io/tenvyr/review/ReviewTestSupport.java
---

# Review Service Architecture and Seam

## Overview

The review service reuses the existing Tenvyr execution engine composition without altering legacy control plane behaviors, database schema migrations, or protocol identities. T00 and T01 are accepted local checkpoints. T02 was accepted locally on 2026-11-14 with the domain schema and contracts described below. T03 was accepted locally on 2026-11-14 with standard Spring sessions, CSRF, current database actors, and explicit atomic user bootstrap. T04 was accepted on 2026-11-14 with atomic idempotent submission and authorized bounded reads. Combined integration with the review worker (T05) passes 89 Surefire tests (44 API + 45 Worker) and 73 PostgreSQL ITs in 5m24s.

## Delivered Components

### 1. Reusable Engine Composition (`ControlPlaneRuntime`)
- `ControlPlaneRuntime` extracts the authority, pipeline, execution, engine, outbox, inbox, event, callback adapter, and recovery graph into an embeddable component.
- Extracted accessors:
  - `pipelines()` (`PipelineService`)
  - `executions()` (`ExecutionService`)
  - `engine()` (`EngineService`)
  - `callbacks()` (`HttpAgentAdapter`)
  - `events()` (`AgentEventService`)
- Lifecycle boundaries:
  - `startAfterMigrations()` initializes leases, starts adapters, and begins runtime recovery after database schema migrations have executed.
  - `close()` drains and closes recovery, adapters, and provider sessions.
  - `registerLegacyRoutes(Http)` binds legacy operator management routes to a platform HTTP server if requested.
- **Resource ownership boundary:** `ControlPlaneRuntime` does NOT own the caller's `Db`, `DataSource`, or HTTP server admission. Legacy `Main` retains ownership of its own `Http` server and `Db` instance.

### 2. Pooled Connection Seam (`Db.fromDataSource`)
- `Db.fromDataSource(javax.sql.DataSource source)` creates a `Db` instance backed by a pooled `DataSource`.
- Connection borrowing semantics:
  - `execute`, `query`, and `one` borrow a connection from the pool, initialize the session with `SET TIME ZONE 'UTC'`, execute the statement, and close (return) the connection to the pool.
  - If statement execution or UTC initialization fails, the borrowed connection is closed and returned to the pool without leaking.
  - Transactions executed via `db.transaction(...)` on a pooled `Db` borrow a connection, set auto-commit to false, commit on success, rollback on error, and return the connection to the pool.
  - Caller-owned transactions via `Db.on(Connection)` preserve the caller's connection: `Db` does not commit, rollback, or close the borrowed connection on transaction error, leaving transaction boundary control to the caller (e.g., Spring `TransactionTemplate` or `DataSourceUtils`).
  - Invoking `close()` on `Db` does not close the underlying `DataSource`.

### 3. Spring Application and Lifecycle Boundary (T01)
- `ReviewApplication` provides the isolated Spring Boot 3.5.16 application entrypoint in module `review-api`.
- `EngineConfiguration`:
  - Injects the Spring Boot-autoconfigured `HikariDataSource`, configured in `application.yml` with maximum pool size 10, acquisition timeout 2,000 ms, and `SET TIME ZONE 'UTC'` initialization SQL. Spring owns pool destruction after dependent beans; `EngineConfiguration` does not define a custom pool bean.
  - Configures `ControlPlaneRuntime` as a managed singleton bean using `Db.fromDataSource(dataSource)`. Its factory method has `@DependsOnDatabaseInitialization`, so runtime construction follows the completed migration strategy.
  - Rejects explicit nonblank `KAFKA_BROKERS`, `ORCHESTRATOR_EVENT_TOPICS`, and `ORCHESTRATOR_RESULT_TOPICS`, configured Kafka agents, or non-HTTP `code-reviewer` definitions before runtime resources are allocated.
- `EngineLifecycle`:
  - Implements Spring `SmartLifecycle` at phase 100 (< `Integer.MAX_VALUE - 2048`).
  - Starts the initialized engine runtime with `startAfterMigrations()` before web server traffic admission. Migration and catalog initialization belong to `ReviewMigrationConfiguration`; lifecycle startup does not repeat them.
  - On shutdown, drains and closes the engine runtime after web admission stops. Startup cleanup attaches engine-close failures as suppressed exceptions. Context destruction closes the pool after dependent cleanup, even if another bean cleanup throws; integration tests assert this and unconditional pool closure after failed startup.
- `AgentCallbackController`:
  - Handles `POST /internal/agent-callbacks/http/code-reviewer`.
  - Enforces raw streaming body bound of 1 MiB (1,048,576 bytes) returning exact 413 Payload Too Large on overflow.
  - Delegates HMAC verification and payload delivery directly to `HttpAgentAdapter.handleCallback`, returning 204 No Content on success and mapped status codes on rejection.
- `ReviewSecurityConfiguration`:
  - Grants a strict CSRF exemption specifically and only for `POST /internal/agent-callbacks/http/code-reviewer`.
  - Enforces CSRF protection on all other unsafe routes, returning 403 Forbidden.
  - Permits actuator liveness and readiness probes (`/actuator/health/liveness`, `/actuator/health/readiness`) without credentials.
  - Since T03, enables standard form login and session logout with CSRF, permits anonymous CSRF-token retrieval, and requires authentication for `/api/v1/**`. Basic auth remains disabled; legacy management routes are denied with safe 401/403 JSON and there is no generated default password.

## Review Domain Slice (T02)

`ReviewMigrationConfiguration` supplies Boot's `FlywayMigrationStrategy`.
Startup follows this order:

1. Validate the HTTP reviewer configuration and reject Kafka configuration.
2. Run the retained `Migrator`, then Flyway's versioned review migrations.
3. Ensure the fixed catalog in `Db.fromDataSource(ds).transaction(...)`, passing
   the transaction's existing connection to `PipelineCatalog.ensure`.
4. After database initialization, construct the runtime and complete singleton
   initialization, including explicit bootstrap when configured. Start adapters
   and recovery through lifecycle phase 100, then admit web traffic.

Flyway owns `tenvyr_review` and its history. V1 creates `users`,
`pipeline_bindings`, `requests`, `decisions`, and `audit`, without a mutable
business-status column. Engine foreign keys explicitly target `public` in the
supported showcase configuration. Requests restrict language to `java`,
`typescript`, or `python` and code to 65,536 UTF-8 bytes. The original 27
migration resources and ledger remain authoritative for the engine schema.
There is no pool-wide search-path reset loop. Real PostgreSQL integration
checks verify that leased pool sessions still address `public` after Flyway.

`PipelineCatalog.ensure(Connection)` requires an existing caller transaction.
It takes a transaction advisory lock, reuses `PipelineService` bound to
`Db.on(connection)`, and creates the pipeline and version binding together.
It never commits, rolls back, closes the caller connection, or borrows another
connection. Reuse checks the binding hash, pipeline schema version,
`contentHash`, and hash of the validated persisted definition. Drift fails
startup. The fixed definition is `review-request-v1`, version `1`, with one
`review` step targeting `code-reviewer`: two retries, `onFailure: retry`, a
30-second timeout, and code/language input templates.

`ReviewTypes` supplies immutable records and enums for the session, review API,
and Worker boundaries. `Page.items` and `ReviewReport.findings` copy their lists;
the exact signatures are in the [T02 handoff](../plans/active/spring-review-portfolio/tasks/T02-review-schema.md#interfaces).
No submission route, authentication system, or human decision behavior is
delivered by the schema itself.

`ReviewReportContract.requireOutput` accepts an integer score from 0 to 100,
zero to 50 nonblank string findings, and optional object-valued `_tenvyr`
metadata. Each finding is at most 1,000 UTF-16 code units; the serialized report
is at most 65,536 UTF-8 bytes. Unknown top-level fields and string/float score
coercion are rejected. The separate business JSON Schema does not change Agent
Protocol v1. Java additionally enforces Unicode blank detection, UTF-16 limits,
and total serialized UTF-8 size; standard JSON Schema `maxLength` counts Unicode
code points and does not express the serialized-byte bound.

## Session Security and User Bootstrap (T03)

T03 was accepted locally on 2026-11-14 with standard Spring sessions, CSRF,
current database actors, and explicit atomic user bootstrap.

1. **Authentication and sessions:** Standard `POST /login` uses form credentials
   and CSRF, returning 204 on success or safe 401 JSON on failure. Standard
   `POST /logout` requires CSRF, invalidates the session, clears its cookie,
   and returns 204. Session fixation defense changes the session ID, while
   the CSRF strategy invalidates the token used before authentication.
2. **CSRF and errors:** `GET /api/v1/auth/csrf` permits anonymous access and
   returns `{headerName,parameterName,token}` with `Cache-Control: no-store`.
   Clients fetch a fresh token after login/logout. Only the exact signed
   callback POST is exempt. Authentication and denied-access responses use
   safe `{code,message,requestId}` JSON with a UUID request ID.
3. **Current actors:** `ActorResolver(JdbcTemplate).current(Authentication)`
   rejects anonymous/unauthenticated inputs before JDBC and resolves the
   principal username to its durable UUID, current database role, and enabled
   state. Disabled/deleted users receive 401. `GET /api/v1/me` returns this
   actor. The real `JdbcUserDetailsManager` reads `tenvyr_review.users` and
   maps each stored role to its exact `ROLE_` authority; the shared
   `JdbcTemplate` has a 5-second query timeout.
4. **Explicit bootstrap:** `BootstrapUsers.parse(Path)` returns
   `List<Entry>` with `Entry(String username,String password,Role role)`.
   The non-empty array has exactly those string fields, lowercase ASCII
   usernames, nonblank supplied passwords, and the two supported roles.
   `review.bootstrap-users-file` enables one transactional write of generated
   UUIDs and bcrypt hashes. Existing users cause a conflict without reset or
   partial writes. With the option absent, no default users are created.
   Validation errors expose field/index information, not raw values or JSON
   causes; failed inserts are translated without raw row/hash details.
5. **Cookies and sessions:** Local HTTP uses HttpOnly, SameSite=Lax,
   Secure=false cookies. The `https` profile sets Secure=true for an HTTPS
   listener or TLS-terminating proxy. In-memory session loss after restart
   requires re-login; persisted PostgreSQL state survives.

Bootstrap is a non-lazy initializer depending on completed database
initialization. All such initialization finishes before SmartLifecycle recovery
start and web admission. Runtime adapters may have been constructed earlier;
managed cleanup still runs on bootstrap failure.

Use an explicit private credential manifest for the initial configured
startup, then remove `review.bootstrap-users-file` on later starts. Missing
credentials fail validation; existing credentials are never silently changed.
The protected T03 visibility/role fixtures use the actual actor resolver, but
T04/T06 must verify authorization again against real business repositories.

## Review Submission and Bounded Reads (T04)

T04 delivers the atomic idempotent submission command, visibility-filtered
keyset pagination, strict report state projection, and streaming request body limit.

1. **Atomic submission command:** `ReviewService.submit` executes within a single
   Spring `TransactionTemplate` transaction on the same connection (`DataSourceUtils.getConnection`).
   It sets local transaction timeouts (`lock_timeout = '2s'`, `statement_timeout = '5s'`),
   acquires an operation advisory lock derived from `(actorId, "SUBMIT", idempotencyKey)`,
   rechecks existing submissions (equivalent returns 202; differing returns 409),
   ensures the fixed internal pipeline `review-request-v1`, materializes the engine
   execution with deadline now + 180s, invokes the package-private
   `PostMaterializationObserver` seam on the same connection, and inserts both the
   request and `SUBMIT` audit row. Connection is released without closing the borrowed
   pool handle; recovery starts executions post-commit.
2. **Streaming body limit filter:** `RequestBodyLimitFilter` filters only review business
   routes, preserving Spring form login and callback's own streaming bounds. It enforces an
   exact 1 MiB (1,048,576 bytes) bound on POST/PUT/PATCH streams before JSON parsing or
   memory allocation, ignoring misleading `Content-Length` headers and returning
   413 `PAYLOAD_TOO_LARGE` with stable bounded JSON error.
3. **Visibility-filtered keyset pagination:** `ReviewRepository.list` enforces that
   `SUBMITTER` sees only own requests, while `REVIEWER` sees all requests. Foreign IDs
   return 404 `NOT_FOUND`. Queries sort `createdAt DESC, id DESC` and use prepared SQL.
   Keyset cursors encode exact `{createdAt, id}` in URL-safe Base64 and are strictly
   bounded to <= 256 bytes. Summaries exclude source code and report bodies.
4. **Report projection:** `ReviewRepository.getReport` projects the report from the
   committed successful attempt of logical step `review` and its `APPLIED` result inbox row
   (persisted status is `APPLIED`, not `COMMITTED`), verifying payload hash and IDs.
   Business contracts are enforced via `ReviewReportMapper` (score 0..100, <= 50 findings,
   finding nonblank <= 1000 units, report JSON <= 65,536 bytes). Truthful metadata is mapped
   to `ReportEvidence`. Non-ready executions return 409 `REPORT_NOT_READY`; invalid terminal
   outputs return 409 `REVIEW_REPORT_INVALID`.
5. **Error mapping:** `ReviewErrors.ReviewControllerAdvice` maps lock timeouts, deadlocks,
   and pool exhaustion to safe 503 `DATABASE_UNAVAILABLE` with `Retry-After: 1` header after
   rollback, and maps validation, authorization, and conflict exceptions to safe bounded JSON
   `{code, message, requestId}`. Transient DB read/write errors produce 503 Retry-After: 1,
   preventing false permanent report failure.

## Verification Boundary

T01 was accepted on 2026-11-13 with 11 unit tests, 13 integration tests,
9 retained pure programs, and 93 retained PostgreSQL/HTTP/restart checks.
The runner and both direct IT URL guards validate the disposable JDBC target,
reject routing query overrides/aliases and raw `#` fragments, and preserve
normal options such as `sslmode`/`currentSchema` and IPv6 hosts.
The [T01 report](../plans/active/spring-review-portfolio/reports/T01.md) records
commands, dependency closure, red-to-green evidence, and verification results.
The full retained Kafka/polyglot compatibility suite remains a T08 gate.

T02 was accepted locally on 2026-11-14: 19 unit tests (11 compatibility,
8 types) and 30 integration tests (11 catalog, 9 callback, 4 lifecycle,
6 schema), all with zero failures, errors, or skips. The integration run took
2 minutes 39 seconds. It verifies two real Spring applications with HTTP
readiness, one fixed pipeline/binding, pooled `public` paths, caller rollback,
persisted-definition/hash drift rejection, and exact schema constraints/indexes.
An actual V1 duplicate-table failure (`42P07`) prevents readiness and runtime
construction while closing the pool; invalid transport configuration leaves
the base ledger absent.

The unchanged production code also passed 9 retained pure programs
(`AgentCheck`: 95 checks), exact parity with the original 27 up/down migrations
and physical schema, and the focused three-case report probe.
The [T02 report](../plans/active/spring-review-portfolio/reports/T02.md) records
the evidence and exact DTO handoff. Business review routes remain T04/T06 work.

T03 was accepted locally on 2026-11-14 with 32 unit tests (11 compatibility,
13 security, 8 types) and 52 real PostgreSQL ITs (7 bootstrap, 11 catalog,
9 callback, 4 lifecycle, 6 schema, 15 security), all zero failures/errors/skips.
The full review run took 4 minutes 1 second and includes the T01/T02 review
regressions. It verifies real CSRF/session rotation, current DB actors,
bootstrap rollback/no implicit seeding, failed-startup pool cleanup, and
local/HTTPS cookie flags. Two manifest-value leak regressions first failed,
then passed with field/index-only parser messages. See the
[T03 report](../plans/active/spring-review-portfolio/reports/T03.md).

T04 was accepted on 2026-11-14 with combined integration (89 Surefire [44 API + 45 Worker including 13 HTTP loopbacks] + 73 real PostgreSQL ITs) passing with zero failures/errors/skips in 5m24s (finished 2026-11-14T13:27:09Z). Unit runner without DB URL passes 89 Surefire tests; 9 retained pure programs pass; retained Engine passes 38 real PostgreSQL checks; unchanged Control passes 93 real PostgreSQL/HTTP/restart checks on serial retry with same 120s timeout. Independent review aaaf9ca5 found 0 actionable findings. Source provenance commit 6e4bec5 (root 049e5cb).
