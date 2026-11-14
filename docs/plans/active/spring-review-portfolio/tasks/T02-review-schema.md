---
title: "T02 — Define review schema, fixed pipeline and typed shared contracts"
status: planned
audience:
  - developer
last_verified: 2026-11-14
sources:
  - backend/control-plane/src/main/java/io/tenvyr/control/Main.java
  - backend/control-plane/src/main/java/io/tenvyr/control/engine/ExecutionService.java
  - scripts/backend-checks.sh
---

# T02: Define review schema, fixed pipeline and typed shared contracts

Dependencies: T01. Estimate: 4–6 focused engineering hours.
Read [SPEC](../SPEC.md), [DISCOVERY](../DISCOVERY.md), [WORKER](../WORKER.md), [VERIFY](../VERIFY.md), and [report](../reports/T02.md) first.
Status: **Accepted locally on 2026-11-14**. Controller verification: 19 unit
tests and 30 real PostgreSQL ITs, all with zero failures/errors/skips; 9 retained
pure programs and exact 27-migration schema parity. See the [report](../reports/T02.md)
for counts, failure proofs, and DTO handoff.

## Deliverable and files

Create review-api `domain/ReviewTypes.java`, `PipelineCatalog.java`,
`ReviewMigrationConfiguration.java`, and
`src/main/resources/db/review/V1__review_domain.sql`.
Create `backend/agents/src/main/java/io/tenvyr/agents/ReviewReportContract.java`
and `contracts/schemas/review-report.v1.schema.json` as a business-output schema,
not a change to Agent Protocol v1. Add `ReviewSchemaIT`, `PipelineCatalogIT`,
`ReviewTypesTest`; extend AgentCheck for the report validator.
Add Flyway core/PostgreSQL dependencies to review-api only, Boot-managed versions.

## Interfaces

Consumes T01 runtime and pooled DataSource. Produces:
```java
// nested public records/enums in io.tenvyr.review.domain.ReviewTypes
enum Role { SUBMITTER, REVIEWER }
enum ReviewStatus { PROCESSING, FAILED, CANCELLED, AWAITING_REVIEW,
                    APPROVED, CHANGES_REQUESTED }
enum DecisionAction { APPROVE, REQUEST_CHANGES }
record Actor(UUID id, String username, Role role) {}
record CreateReview(String title, String language, String code) {}
record Submission(UUID id, String status, Instant createdAt, UUID executionId) {}
record ReviewSummary(UUID id, String title, String language,
                     ReviewStatus status, Instant createdAt) {}
record Page<T>(List<T> items, String nextCursor) {}
record ReportEvidence(String mode, String provider, String model,
                      boolean fallbackUsed, String usageSource) {}
record ReviewReport(int score, List<String> findings, ReportEvidence evidence) {}
record DecisionCommand(DecisionAction action, String comment) {}
record DecisionView(UUID id, UUID requestId, UUID actorId, DecisionAction action,
                    String comment, UUID stepAttemptId, String resultHash,
                    Instant createdAt) {}
record ReviewDetail(UUID id, String title, String language, String code,
                    ReviewStatus status, Instant createdAt, UUID executionId,
                    int attemptCount, String errorCode, DecisionView decision) {}
record AuditEntry(UUID id, UUID actorId, String action, Instant createdAt) {}
// concrete catalog, not a new workflow framework
ObjectNode PipelineCatalog.ensure(Connection connection) // static; requires autoCommit=false
ObjectNode ReviewReportContract.requireOutput(JsonNode output) // static; throws IllegalArgumentException
```

Use immutable/copy-safe list values. Detail/error/decision nullable fields follow
SPEC; report output validator accepts score/findings and optional legacy
`_tenvyr` object metadata only. Empty findings are allowed (`0..50`); each finding
must be nonblank and at most 1,000 UTF-16 code units. Java additionally enforces
the 65,536-byte serialized UTF-8 bound beyond the JSON Schema code-point limits.
Metadata is projected separately into ReportEvidence.

## References to copy

Copy pipeline input templates from scripts/smoke-e2e.mjs and definition/hash
construction from PipelineService.create. Read Migrator, the 27-migration parity
check, and Boot FlywayMigrationStrategy docs in DISCOVERY.

## Steps and acceptance

- [x] Add failing boundary/invalid report tests and real migration tests.
  Assert 65,536 UTF-8 bytes accepted, 65,537 rejected; distinguish Unicode byte
  bounds from Java string length. Invalid score type/range and excessive
  findings fail, not coerce.
- [x] Implement exact SPEC tables/constraints/indexes in tenvyr_review. Add a
  Boot FlywayMigrationStrategy: retained Migrator first, Flyway review schema
  second, then catalog initialization in its caller transaction. Runtime
  construction depends on completed database initialization; lifecycle starts
  recovery before admission and does not rerun migrations. Use Flyway's own
  versioned migration mechanism, no custom second migration framework or schema.sql.
- [x] Implement PipelineCatalog.ensure on the supplied Connection with an
  advisory transaction lock and version binding. Validate fixed definition;
  create pipeline/binding atomically; repeat/concurrent startup reuses the same
  pipeline. Definition hash drift fails startup rather than silently rewriting.
- [x] Add typed contracts and strict report validator. Reuse Json.hash and
  existing protocol fixtures; no source/secret logging or score fallback.
- [x] On real PostgreSQL, prove two startups create one catalog binding; base
  ledger remains the same 27 entries/identities; a business-schema failure
  prevents readiness. Assert pooled sessions still address the engine's
  original schema after Flyway returns.
- [x] Run review unit/integration and existing schema parity gate. Update
  current docs/ledger and verifiers, then publish the exact DTO handoff.

Representative assertions:
```java
assertEquals(firstPipelineId, catalog.ensure(connection).path("id").asText());
assertEquals(27, retainedMigrationRows());
assertThrows(IllegalArgumentException.class,
    () -> ReviewReportContract.requireOutput(Json.object("score", "90")));
```

## Reject conditions

No edits to retained db/migrations.json, TypeORM migration history, legacy
entities.json, canonical fixtures or AgentProtocol enums. No public configurable
pipeline. No persisted business status shadowing executions. Do not claim the
new schema itself supplies authentication before T03.
