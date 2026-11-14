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
  - backend/review-api/src/main/java/io/tenvyr/review/ReviewMigrationConfiguration.java
  - backend/review-api/src/main/java/io/tenvyr/review/PipelineCatalog.java
  - backend/review-api/src/main/java/io/tenvyr/review/domain/ReviewTypes.java
  - backend/review-api/src/main/resources/db/review/V1__review_domain.sql
  - backend/agents/src/main/java/io/tenvyr/agents/ReviewReportContract.java
  - contracts/schemas/review-report.v1.schema.json
  - backend/review-api/src/test/java/io/tenvyr/review/ReviewLifecycleIT.java
---

# Review Service Architecture and Seam

## Overview

The review service reuses the existing Tenvyr execution engine composition without altering legacy control plane behaviors, database schema migrations, or protocol identities. T00 and T01 are accepted local checkpoints. T02 was accepted locally on 2026-11-14 with the domain schema and contracts described below.

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
  - Disables form login and basic auth fallbacks, denying all legacy and unopened business routes with 401/403 JSON responses and no default generated passwords.

## Review Domain Slice (T02)

`ReviewMigrationConfiguration` supplies Boot's `FlywayMigrationStrategy`.
Startup follows this order:

1. Validate the HTTP reviewer configuration and reject Kafka configuration.
2. Run the retained `Migrator`, then Flyway's versioned review migrations.
3. Ensure the fixed catalog in `Db.fromDataSource(ds).transaction(...)`, passing
   the transaction's existing connection to `PipelineCatalog.ensure`.
4. Construct the runtime after database initialization; start adapters and recovery
   through lifecycle phase 100, then admit web traffic.

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

`ReviewTypes` supplies immutable records and enums for the later session, API,
and Worker tasks. `Page.items` and `ReviewReport.findings` copy their lists;
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
the evidence and exact DTO handoff. Session policy and business routes remain
T03/T04 work.
