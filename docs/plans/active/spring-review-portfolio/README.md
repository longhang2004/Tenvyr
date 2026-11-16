---
title: "Spring Review Portfolio — worker entry point"
status: planned
audience:
  - developer
  - product
last_verified: 2026-11-16
sources:
  - backend/control-plane/src/main/java/io/tenvyr/control/Main.java
  - backend/control-plane/src/main/java/io/tenvyr/control/engine/ExecutionService.java
  - docs/reference/implementation-status.json
---

# Spring Review Portfolio

Lifecycle: approved implementation in progress. Direction: reuse Tenvyr for a
Java/Spring business-backend portfolio. **8 of 9 tasks are accepted locally:**
[T00](reports/T00.md), [T01](reports/T01.md), [T02](reports/T02.md),
[T03](reports/T03.md), [T04](reports/T04.md), [T05](reports/T05.md), [T06](reports/T06.md), and [T07](reports/T07.md).
[T08](reports/T08-final-acceptance.md) is currently in progress (full review gate 89+120 PASS in 10m23s; full backend `--integration` running; benchmark pending). Current contracts and verified
reports take precedence over this plan.

Build one fixed asynchronous code-review request workflow on the existing
PostgreSQL-authoritative engine. A user submits a code snippet, receives a
bounded report, and a different reviewer approves or requests changes. Keep
legacy runtimes and contracts working; do not rewrite the scheduler.

## Read and execute

1. Read root `AGENTS.md`, [specification](SPEC.md), and [discovery](DISCOVERY.md).
2. Read [worker instructions](WORKER.md) and the assigned task in [the plan](PLAN.md).
3. Implement only that task, run its checks and the applicable [verification gates](VERIFY.md).
4. Supply evidence and a handoff; a reviewer checks the task before dependants start.

Accepted local implementation is recorded in each task report. This plan makes
no deployment, package publication, or production-readiness claim and does not
close an existing product milestone.

## Task graph

| Task | Deliverable | Dependencies | Estimated focused engineering hours |
| --- | --- | --- | --- |
| [T00](tasks/T00-runtime-seam.md) | Reusable engine composition and pooled JDBC seam | none | 4–6 |
| [T01](tasks/T01-spring-boundary.md) | Spring application, lifecycle, signed callback boundary, test runner | T00 | 5–7 |
| [T02](tasks/T02-review-schema.md) | Business schema, fixed pipeline, typed domain contracts | T01 | 4–6 |
| [T03](tasks/T03-session-security.md) | Session authentication, CSRF, stable actor and ownership rules | T02 | 4–6 |
| [T04](tasks/T04-submit-and-read.md) | Atomic idempotent submit, bounded reads, report projection | T03 | 6–8 |
| [T05](tasks/T05-review-worker.md) | Existing reviewer inside HTTP Worker; strict, honestly labeled reports | T03 | 4–6 |
| [T06](tasks/T06-decisions-and-audit.md) | Concurrent-safe business decisions, cancellation, audit | T04, T05 | 5–7 |
| [T07](tasks/T07-showcase-and-metrics.md) | HTTP-only showcase, capacity settings, useful metrics | T06 | 4–6 |
| [T08](tasks/T08-final-acceptance.md) | Crash/security acceptance, CI, portfolio documentation | T07 | 5–7 |

Estimate: 41–59 focused engineering hours, including testing and review; not an
estimate of agent wall time. A blocked prerequisite is reported, never a skipped
success. T04 and T05 may run concurrently in isolated worktrees after a reviewed T03
checkpoint, provided T05 stays within its owned files. All other integration is
serial.

## Scope decisions

Default topology: Spring review API with one embedded existing engine, one HTTP
review Worker, PostgreSQL. Offline reports use explicit mock fixtures. Optional
real-provider execution reuses the existing Java Runner; it is not required in CI.
Kafka, Gateway/Socket.IO, CLI hosts, Planner/Verifier loops and multi-language
Workers remain compatibility surfaces rather than mandatory review dependencies.

This plan supplies a new, bounded portfolio path. It does not rewrite or mark
the older coding-team, provider, polyglot or M11 plans complete. Their contracts
still apply wherever those paths are used. Do not execute competing product
roadmaps as part of a task from this directory.

## Deliverable map

- [SPEC.md](SPEC.md): product, API, state, transaction and security decisions.
- [DISCOVERY.md](DISCOVERY.md): real repository seams and primary documentation.
- [PLAN.md](PLAN.md): implementation order, interfaces, coverage and review gates.
- [WORKER.md](WORKER.md): copy-ready OpenCode/Antigravity instructions and handoff.
- [VERIFY.md](VERIFY.md): exact commands and evidence requirements.
- [LINEAR.md](LINEAR.md): issue mapping; local task files remain the detailed plan.
