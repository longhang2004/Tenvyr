---
title: "Spring Review Portfolio Implementation Plan"
status: current
audience:
  - developer
last_verified: 2026-11-16
sources:
  - backend/control-plane/src/main/java/io/tenvyr/control/Main.java
  - backend/control-plane/src/main/java/io/tenvyr/control/engine/ExecutionService.java
  - scripts/backend-checks.sh
---

# Spring Review Portfolio Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. When those skills are unavailable in OpenCode/Antigravity, follow [WORKER.md](WORKER.md) directly; do not install tooling merely to satisfy a harness-specific skill name.

**Goal:** Deliver a fixed, authenticated code-review request workflow using the existing durable execution engine.

**Architecture:** One Spring application embeds a reusable engine composition and commits review/execution state in one PostgreSQL transaction. The existing HTTP Worker/AgentProcessor execute one fixed review step. Legacy entry points and wire contracts remain compatible.

**Tech Stack:** Java 17; Boot 3.5.16 for new API only; JDBC/PostgreSQL; Spring Security sessions; Flyway for business schema only; existing HTTP/HMAC Worker; JUnit/Spring test for new module.

**Spec:** [SPEC.md](SPEC.md). Mandatory existing-API evidence: [DISCOVERY.md](DISCOVERY.md).
**Status:** In progress. Accepted: 7 of 9 tasks (T00–T06). T07 candidate implementation in progress (launcher tests 21/21 PASS, metrics/topology delivered, review closed; actual dual-cycle Docker runs pending). T08 planned.

## Global Constraints

- No scheduler rewrite, private HTTP dual writes, second mutable engine status, or engine policy approval used as a business verdict.
- Preserve retained 27 migrations, canonical JSON/hash identities, all four existing callback authentication headers, and existing legacy behavior.
- Java 17; new Boot parent 3.5.16 isolated to review-api; no root-wide Boot BOM or unrelated runner upgrade.
- New schema `tenvyr_review`; same physical PostgreSQL database/transaction as execution; no H2 substitution for integration evidence.
- Signed callback uses exact raw bytes and existing adapter; session mutations retain CSRF; every business lookup enforces visibility.
- UTF-8 source <=65,536 bytes, raw body <=1 MiB, report <=65,536 bytes; exact limits/error/status contracts are in SPEC.
- Each implementation updates its current architecture/operations contract and ledger entry, then runs documentation/identity verifiers. A plan is not source evidence.
- Preserve pre-existing user edits; no broad staging, reset, blanket formatting, publication or deployment.

## Review Focus

- Lost response after committed submit: same owner/key returns same request/execution; uncommitted crash leaves neither.
- A report that is malformed or labeled mock: never invent a successful score or imply real security analysis.
- A known foreign UUID and stale CSRF/session: access remains denied without leaking payload or bypassing ownership.
- Concurrent decision/cancel/callback: exactly one truthful terminal business result; audit and engine state agree.
- Pool exhaustion, partial startup and shutdown under a held PostgreSQL lock: bounded failure and resource cleanup, with no lost durable work.

Tests for these cases are assigned to T01/T03/T04/T05/T06/T08 below; none is an unowned aspiration.

## Phase 0 — complete discovery; recheck drift

- [x] Identify caller-owned materialization/cancellation, callback and recovery seams.
- [x] Inspect existing reviewer input/output and lenient fallback parser.
- [x] Identify isolated Boot build/test and migration namespace requirements.
- [x] Verify primary Spring documentation and Java 17 compatibility.
- [ ] Executing worker records current HEAD/dirty paths and confirms symbol drift before modifying its task.

## File ownership and produced interfaces

| Task | Main files owned | Public interface delivered |
| --- | --- | --- |
| T00 | platform Db; control-plane Main + new ControlPlaneRuntime; regression checks | `Db.fromDataSource(DataSource)`; runtime accessors/startAfterMigrations/close |
| T01 | review-api POM/application/config/callback; review-checks runner; root reactor | Boot application lifecycle and signed callback; explicit unit/integration test modes |
| T02 | review SQL migration, domain ReviewTypes, fixed pipeline; shared agents ReviewReportContract | stable DTOs/Actor/Role; PipelineCatalog.ensure(Connection); report validator |
| T03 | review security/actor/bootstrap; authentication integration tests | `ActorResolver.current(Authentication): Actor`; session/CSRF/access policy |
| T04 | ReviewService, ReviewRepository, ReviewController, mapper, error/body-limit handling | submit/get/list/report with exact typed signatures |
| T05 | review-worker module/entry/Runner wrapper; bounded Runner seam; worker checks | HTTP code-reviewer with strict mock/runner output and existing result protocol |
| T06 | ReviewDecisionService, decision/audit/cancel endpoints and repository methods | decide/cancel/audit; atomic command replay and concurrency |
| T07 | separate review Compose/Docker targets, launcher, smoke, metrics | reproducible HTTP-only showcase and bounded resource configuration |
| T08 | final integration suites, CI, OpenAPI, README and case study | complete acceptance evidence and truthful portfolio documentation |

The full file lists, tests, references and steps live in the individual task files.
New DTO/type definitions belong to T02; subsequent tasks consume them rather
than inventing alternate names. No `ReviewRequestService` alias for `ReviewService`.

## Phase 1 — protect reuse before adding business behavior

- [x] [T00: runtime/pooled JDBC seam](tasks/T00-runtime-seam.md) ([report](reports/T00.md))
- [x] [T01: Spring boundary and lifecycle](tasks/T01-spring-boundary.md) — accepted ([report](reports/T01.md))
- [x] [T02: schema, fixed pipeline and domain contracts](tasks/T02-review-schema.md) — accepted ([report](reports/T02.md))
- [x] [T03: session security and stable ownership](tasks/T03-session-security.md) — accepted ([report](reports/T03.md))

Gate: retained backend checks pass; new app starts/migrates/drains, rejects
unsigned callbacks and unauthorized business access. No unauthenticated legacy
management routes appear on its port.

## Phase 2 — complete the business workflow

- [x] [T04: atomic submit and bounded reads](tasks/T04-submit-and-read.md) — accepted ([report](reports/T04.md))
- [x] [T05: strict HTTP reviewer Worker](tasks/T05-review-worker.md) — accepted ([report](reports/T05.md))
- [x] [T06: business decisions, cancellation and audit](tasks/T06-decisions-and-audit.md) — accepted ([report](reports/T06.md))

T04/T05 can be assigned to separate isolated worktrees after T03. Merge T04 then
T05; T05 does not edit ReviewTypes, API services, root POM, or shared docs index.
Its reactor registration is performed by the integrator at merge time. A single
worker can execute the same tasks serially without any multi-agent tools.

Gate: submit -> signed result -> report -> different-reviewer decision, plus
idempotency, visibility and cancel-vs-result checks on real PostgreSQL.

## Phase 3 — runnable showcase and final verification

- [ ] [T07: showcase, capacity and metrics](tasks/T07-showcase-and-metrics.md) (candidate implementation delivered; launcher 21/21 PASS; actual dual-cycle Docker runs pending)
- [ ] [T08: final acceptance and portfolio delivery](tasks/T08-final-acceptance.md)

Gate: [VERIFY.md](VERIFY.md) passes; unsupported infrastructure is reported as
blocked/failing, never skipped. Record commands, environment and actual output.
Do not mark this plan completed from test counts copied out of older documents.

## Integration and completion

A reviewer may reject one task independently of its neighbors. Fix that task
before starting dependent work. Each task ends with a small scoped commit if
local commits are permitted by the executing user's instructions; otherwise
provide the exact diff and do not invent a commit identifier.

After T08, update current docs/ledger, move this completed plan under
`docs/archive/plans/`, and fix the documentation index links in the same change.
Leave unrelated active plans intact. Global external production exposure and
package publishing remain open decisions, not acceptance criteria for this slice.
