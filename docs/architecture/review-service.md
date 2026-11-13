---
title: Review Service Architecture and Seam
status: current
audience:
  - developer
  - operator
last_verified: 2026-11-13
sources:
  - backend/platform/src/main/java/io/tenvyr/platform/Db.java
  - backend/control-plane/src/main/java/io/tenvyr/control/ControlPlaneRuntime.java
  - backend/control-plane/src/main/java/io/tenvyr/control/Main.java
  - backend/review-api/src/main/java/io/tenvyr/review/EngineConfiguration.java
  - backend/review-api/src/main/java/io/tenvyr/review/EngineLifecycle.java
  - backend/review-api/src/main/resources/application.yml
  - backend/review-api/src/test/java/io/tenvyr/review/ReviewLifecycleIT.java
---

# Review Service Architecture and Seam

## Overview

The review service reuses the existing Tenvyr execution engine composition without altering legacy control plane behaviors, database schema migrations, or protocol identities. Task T00 establishes the runtime seam allowing caller-controlled execution and transactional embedding.

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
  - Configures `ControlPlaneRuntime` as a managed singleton bean using `Db.fromDataSource(dataSource)`.
  - Rejects explicit nonblank `KAFKA_BROKERS`, `ORCHESTRATOR_EVENT_TOPICS`, and `ORCHESTRATOR_RESULT_TOPICS`, configured Kafka agents, or non-HTTP `code-reviewer` definitions before runtime resources are allocated.
- `EngineLifecycle`:
  - Implements Spring `SmartLifecycle` at phase 100 (< `Integer.MAX_VALUE - 2048`).
  - Executes base database migrations (`Migrator.migrate(db)`) and starts the engine runtime (`startAfterMigrations()`) before web server traffic admission.
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

## Verification Boundary and Next Migration Seam

T01 was accepted on 2026-11-13 with 11 unit tests, 13 integration tests,
9 retained pure programs, and 93 retained PostgreSQL/HTTP/restart checks.
The runner and both direct IT URL guards validate the disposable JDBC target,
reject routing query overrides/aliases and raw `#` fragments, and preserve
normal options such as `sslmode`/`currentSchema` and IPv6 hosts.
The [T01 report](../plans/active/spring-review-portfolio/reports/T01.md) records
commands, dependency closure, red-to-green evidence, and verification results.
The full retained Kafka/polyglot compatibility suite remains a T08 gate.

T02 consumes the managed runtime and shared pooled `DataSource`, adding the
review Flyway migration after retained base migrations and before runtime
start/web admission. Review schema and typed contracts are future T02 work;
authentication/session policy and business routes remain T03/T04 work.
