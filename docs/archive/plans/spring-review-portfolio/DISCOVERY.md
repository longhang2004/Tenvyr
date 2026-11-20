---
title: "Spring Review Portfolio — Phase 0 discovery"
status: historical
audience:
  - developer
last_verified: 2026-11-11
superseded_by:
  - docs/architecture/review-service.md
sources:
  - backend/platform/src/main/java/io/tenvyr/platform/Db.java
  - backend/platform/src/main/java/io/tenvyr/platform/Migrator.java
  - backend/control-plane/src/main/java/io/tenvyr/control/Main.java
  - backend/control-plane/src/main/java/io/tenvyr/control/engine/ExecutionService.java
  - backend/agents/src/main/java/io/tenvyr/agents/AgentProcessor.java
  - scripts/backend-database-check.mjs
  - scripts/backend-checks.sh
---

# Phase 0: documentation discovery

Read these sources before implementation. Line numbers below are discovery-time
anchors; resolve symbols again after changes. This file describes existing APIs;
[SPEC.md](SPEC.md) and [PLAN.md](PLAN.md) define proposed APIs separately.

## Allowed existing APIs and patterns

| Existing source / anchor | API or behavior | Use / restriction |
| --- | --- | --- |
| `backend/platform/src/main/java/io/tenvyr/platform/Db.java:17–25` | `Db.on(Connection)`; `transaction(Work<T>)` on a pinned connection does not commit/close it | Borrow the Spring transaction connection. `Db.fromEnv()` is not transaction propagation. |
| `backend/control-plane/src/main/java/io/tenvyr/control/engine/ExecutionService.java:17` | `ObjectNode materializeExecutionWithManager(Connection,ObjectNode,JsonNode,Instant)` | Atomic review/execution creation. No dispatch in this call. |
| Same class, `cancelExecutionWithManager` | `ObjectNode cancelExecutionWithManager(Connection,String,String) throws Exception` | Commit business cancellation and engine cancellation together. Preserve internal lock order. |
| `backend/control-plane/src/main/java/io/tenvyr/control/authority/AuthorityServices.java:18` | `bind(...)` passes the materialize method to existing consumers | Copy the caller-owned transaction pattern, not private HTTP dual writes. |
| `backend/control-plane/src/main/java/io/tenvyr/control/Main.java:19–70` | Composition, migration-before-admission, adapters/recovery and draining close | Extract once and retain legacy Main as a consumer. Never start two recovery owners in one app. |
| `backend/control-plane/src/main/java/io/tenvyr/control/engine/RuntimeRecoveryService.java:15–18` | `start()`, `recover(Instant)`; initial and 1,000 ms recovery sweep | Existing scheduler finds committed PENDING work. No review scheduler/outbox is needed. |
| `backend/control-plane/src/main/java/io/tenvyr/control/engine/PipelineService.java:14` | `ObjectNode validate(JsonNode)` | Validate the fixed internal definition before persisting it. |
| `backend/control-plane/src/main/java/io/tenvyr/control/engine/HttpAgentAdapter.java` and `ControlRoutes.register` callback route | `handleCallback(agent,keyId,timestamp,deliveryId,signature,rawBytes,remoteAddress,null)` | Delegate raw bytes unchanged; do not reimplement HMAC or trust parsed/re-serialized bytes. |
| `backend/agents/src/main/java/io/tenvyr/agents/AgentProcessor.java:15–21,37–90` | `Runner.run(String,ObjectNode,long)`; injectable Runner constructor; `process(ObjectNode)` | Reuse processor without starting Kafka. Default Runner performs private HTTP. Parser is lenient. |
| `backend/worker/src/main/java/io/tenvyr/worker/Worker.java:21–62` | `Worker(config,agent,inputParser,outputParser)`; `Context.success(...)` | Return business output, not a nested AgentResultV1. Worker owns envelope/callback signing. |
| `backend/control-plane/src/main/java/io/tenvyr/control/authority/ApprovalService.java:21–25` | `approve/deny` resume policy-gated dispatch | NOT business approval after report completion. |

Copy-ready checks: `EngineIntegrationCheck` concurrent claim/inbox conflict;
`ControlIntegrationCheck` real restart and database-lock shutdown;
`AgentCheck` fake Runner and provider metadata;
`FoundationCheck` retained canonical JSON/HMAC fixtures. Preserve their outcomes.

## Compatibility findings

The backend reactor has seven Java 17 modules. Root dependency management pins
Jackson/Netty/Reactor for retained behavior. Give the new Spring module its own
Boot parent and explicit internal dependency versions; do not import its BOM
over all legacy modules. Verify canonical fixtures on the new module's actual
runtime classpath as well as on the retained platform classpath.

`services/agent-runner/pom.xml` already uses Spring Boot 3.1.5. Reuse its
private provider execution when explicitly configured; do not put new business
controllers there or upgrade that service as an incidental prerequisite.

`Migrator` owns the retained TypeORM ledger. The Node/Java schema comparison
expects 27 exact up/down migrations. Business tables therefore use separate
Flyway resources/history in schema `tenvyr_review`; the original ledger and
default engine schema are unchanged. Boot's migration strategy runs the base
migrator first, then the review schema migration. Do not introduce Hibernate DDL.

`scripts/backend-build.sh` uses `-DskipTests`; the old check script explicitly
runs main-based checks. New JUnit tests require explicit Maven test/verify gates.
Simply adding test classes would leave them unexecuted in existing CI.

## Verified primary documentation

- [Boot 3.5.16 requirements](https://docs.spring.io/spring-boot/3.5/system-requirements.html): Java 17 and Maven 3.6.3+; chosen compatibility pin, not a claim it is the latest release.
- [Spring DataSourceUtils](https://docs.spring.io/spring-framework/docs/6.2.x/javadoc-api/org/springframework/jdbc/datasource/DataSourceUtils.html): `getConnection(DataSource)`, `releaseConnection(Connection,DataSource)`.
- [TransactionTemplate](https://docs.spring.io/spring-framework/docs/6.2.x/javadoc-api/org/springframework/transaction/support/TransactionTemplate.html): caller-controlled transaction boundary.
- [Boot Flyway initialization](https://docs.spring.io/spring-boot/3.5/how-to/data-initialization.html) and [FlywayMigrationStrategy](https://docs.spring.io/spring-boot/3.5/api/java/org/springframework/boot/autoconfigure/flyway/FlywayMigrationStrategy.html): custom migration ordering; Boot-managed PostgreSQL Flyway dependencies.
- [Spring Security form login](https://docs.spring.io/spring-security/reference/6.5/servlet/authentication/passwords/form.html), [CSRF](https://docs.spring.io/spring-security/reference/6.5/servlet/exploits/csrf.html), [JDBC authentication](https://docs.spring.io/spring-security/reference/6.5/servlet/authentication/passwords/jdbc.html): standard sessions, CSRF tokens, custom PostgreSQL queries. The sample `varchar_ignorecase` DDL is H2-specific.
- [Boot metrics](https://docs.spring.io/spring-boot/3.5/reference/actuator/metrics.html): Actuator/Micrometer instead of a custom telemetry framework.

Confidence: high for source seams; no implementation tests were run during
discovery. Effective dependency convergence and task implementations still need
their executable checks. Linear's September snapshot predates Java/Go cutover;
current code and implementation ledger take precedence.
