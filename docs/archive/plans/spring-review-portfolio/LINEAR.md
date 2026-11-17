---
title: "Spring Review Portfolio — Linear task mapping"
status: historical
audience:
  - developer
last_verified: 2026-11-12
superseded_by:
  - docs/architecture/review-service.md
sources:
  - docs/archive/plans/spring-review-portfolio/PLAN.md
---

# Linear task mapping

Project: [Tenvyr — Specs & flows](https://linear.app/long-hang/project/tenvyr-specs-and-flows-b8470ada36bf).

Parent: [LON-125 — Tenvyr Review: Java/Spring portfolio workflow](https://linear.app/long-hang/issue/LON-125/tenvyr-review-javaspring-portfolio-workflow-using-the-existing-engine).
Created on 2026-11-12 after explicit user approval to upload the complete SPEC
and nine detailed tasks. Parent contains the full proposed specification and
execution index; each child contains its complete task instructions.

## Published issue set

| Task | Linear issue | Repository task | Blocked by |
| --- | --- | --- | --- |
| T00 | [LON-126](https://linear.app/long-hang/issue/LON-126/tenvyr-review-t00-extract-reusable-engine-composition-and-pooled-jdbc) | [T00-runtime-seam.md](tasks/T00-runtime-seam.md) | none |
| T01 | [LON-127](https://linear.app/long-hang/issue/LON-127/tenvyr-review-t01-add-isolated-spring-application-signed-callbacks-and) | [T01-spring-boundary.md](tasks/T01-spring-boundary.md) | LON-126 |
| T02 | [LON-128](https://linear.app/long-hang/issue/LON-128/tenvyr-review-t02-define-review-schema-fixed-pipeline-and-typed-shared) | [T02-review-schema.md](tasks/T02-review-schema.md) | LON-127 |
| T03 | [LON-129](https://linear.app/long-hang/issue/LON-129/tenvyr-review-t03-implement-sessions-csrf-durable-actors-and) | [T03-session-security.md](tasks/T03-session-security.md) | LON-128 |
| T04 | [LON-130](https://linear.app/long-hang/issue/LON-130/tenvyr-review-t04-deliver-atomic-idempotent-submission-and-authorized) | [T04-submit-and-read.md](tasks/T04-submit-and-read.md) | LON-129 |
| T05 | [LON-131](https://linear.app/long-hang/issue/LON-131/tenvyr-review-t05-reuse-agentprocessor-in-a-strict-http-review-worker) | [T05-review-worker.md](tasks/T05-review-worker.md) | LON-129 |
| T06 | [LON-132](https://linear.app/long-hang/issue/LON-132/tenvyr-review-t06-implement-business-verdicts-cancellation-and-atomic) | [T06-decisions-and-audit.md](tasks/T06-decisions-and-audit.md) | LON-130, LON-131 |
| T07 | [LON-133](https://linear.app/long-hang/issue/LON-133/tenvyr-review-t07-ship-http-only-review-showcase-with-bounded) | [T07-showcase-and-metrics.md](tasks/T07-showcase-and-metrics.md) | LON-132 |
| T08 | [LON-134](https://linear.app/long-hang/issue/LON-134/tenvyr-review-t08-close-crashsecurity-acceptance-and-publish-truthful) | [T08-final-acceptance.md](tasks/T08-final-acceptance.md) | LON-133 |

All ten issues were read back: Backlog, unassigned, no delegate, correct project,
parent/child links and blockedBy relations. Description text matches the uploaded
documents after accounting for Linear Markdown/table/issue-link normalization
and automatic links on Java identifiers. No task body or specification section
was omitted.

## Execution handoff

Start with T00 / LON-126. Read [WORKER.md](WORKER.md) before assigning it.
Only T04/T05 may run concurrently in isolated worktrees after T03 is accepted.
Creating these issues did not start implementation or dispatch an agent.

Ensure the plan files exist in the worker checkout. The repository task files,
[SPEC.md](SPEC.md), [DISCOVERY.md](DISCOVERY.md) and [VERIFY.md](VERIFY.md) remain
the versioned plan. Current executable contracts take precedence for existing
behavior. The older September Linear specifications were not rewritten.

## Authorization record

The first upload attempt on 2026-11-11 was rejected by automatic review because
sending detailed repository architecture to Linear lacked explicit approval.
The user approved that exact destination and content in this chat on
2026-11-12; the subsequent upload succeeded. No alternative route was used.
