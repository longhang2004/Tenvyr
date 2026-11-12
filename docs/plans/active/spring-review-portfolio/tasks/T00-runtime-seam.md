---
title: "T00 — Extract reusable engine composition and pooled JDBC seam"
status: current
audience:
  - developer
last_verified: 2026-11-12
sources:
  - backend/control-plane/src/main/java/io/tenvyr/control/Main.java
  - backend/control-plane/src/main/java/io/tenvyr/control/engine/ExecutionService.java
  - scripts/backend-checks.sh
---

# T00: Extract reusable engine composition and pooled JDBC seam

Dependencies: none. Estimate: 4–6 focused engineering hours.
Read [SPEC](../SPEC.md), [DISCOVERY](../DISCOVERY.md), [WORKER](../WORKER.md) and [VERIFY](../VERIFY.md) first.
Status: completed ([report](../reports/T00.md)).
Report: [reports/T00.md](../reports/T00.md)

## Deliverable and files

Create `backend/control-plane/src/main/java/io/tenvyr/control/ControlPlaneRuntime.java`.
Modify `backend/control-plane/src/main/java/io/tenvyr/control/Main.java` and
`backend/platform/src/main/java/io/tenvyr/platform/Db.java` only as required by
composition/connection ownership. Extend `FoundationCheck` and
`ControlIntegrationCheck`; add a focused runtime composition check if those
cannot exercise the seam. Update `docs/architecture/review-service.md` (new
current document describing only delivered reuse), its docs index link, and
the existing implementation ledger without overwriting user edits.

## Interfaces

Consumes existing Main composition, ExecutionService and RuntimeRecoveryService.

Produces:
```java
Db.fromDataSource(javax.sql.DataSource source) // public static Db
new ControlPlaneRuntime(Db db, Map<String,String> environment,
                        java.util.function.Consumer<String> projection)
PipelineService pipelines()
ExecutionService executions()
EngineService engine()
HttpAgentAdapter callbacks()
AgentEventService events()
void registerLegacyRoutes(io.tenvyr.platform.Http http)
void startAfterMigrations() throws Exception
void close() throws Exception
```

The accessors belong to ControlPlaneRuntime. It owns engine/adapters/recovery/
provider sessions, NOT HTTP admission or the caller's DataSource. Legacy Main
owns its Http and Db and remains the original executable entry point. No
Spring dependency is introduced into platform/control-plane.

## References to copy

Read Main's full constructor/start/close; Db's pinned connection/transaction;
ControlIntegrationCheck's lock-held shutdown regression. Preserve existing
legacy configuration validation, readiness and failure cleanup ordering.

## Steps and acceptance

- [x] Record baseline HEAD/dirty paths and run existing pure checks before edits.
- [x] Add failing checks: borrowed transaction rollback does not commit or close
  the connection; pooled borrow is returned after success/failure; closing Db
  does not close caller-owned DataSource; UTC is retained on both connection paths.
- [x] Extract the exact Main graph into ControlPlaneRuntime. Keep one set of
  authority/inbox/outbox/adapters and one recovery owner; Main delegates routes
  and lifecycle. Supply a no-op projection from the future Spring path, while
  legacy Main retains its existing Gateway projection.
- [x] Preserve startup exception cleanup and idempotent close. Real integration
  checks must prove partial startup releases resources, recovery drains before
  database closure, and a control-plane restart still applies a signed result.
- [x] Run baseline commands in VERIFY, plus existing ControlIntegrationCheck
  with real PostgreSQL. Inspect the diff for scheduling/SQL/contract changes:
  none are allowed except DataSource plumbing and construction access.
- [x] Update current docs/ledger accurately; run both verifiers; produce handoff.

Representative assertions:
```java
assertFalse(borrowed.isClosed()); // after Db.on(borrowed).transaction(...)
assertEquals(0, countRowsCreatedByRolledBackOperation());
assertTrue(dataSourceStillUsableAfterRuntimeClose());
```

## Reject conditions

Do not construct a second engine in Spring, run legacy Main from a bean, close
Hikari from Db, introduce a generic service registry, or reformat unrelated
legacy services. A green mock-only check does not prove borrowed PostgreSQL
transaction ownership.
