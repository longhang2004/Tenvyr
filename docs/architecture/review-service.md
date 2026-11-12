---
title: Review Service Architecture and Seam
status: current
audience:
  - developer
  - operator
last_verified: 2026-11-12
sources:
  - backend/platform/src/main/java/io/tenvyr/platform/Db.java
  - backend/control-plane/src/main/java/io/tenvyr/control/ControlPlaneRuntime.java
  - backend/control-plane/src/main/java/io/tenvyr/control/Main.java
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
