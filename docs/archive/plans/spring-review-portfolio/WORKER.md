---
title: "Spring Review Portfolio — worker execution instructions"
status: historical
audience:
  - developer
last_verified: 2026-11-11
superseded_by:
  - docs/architecture/review-service.md
sources:
  - AGENTS.md
  - docs/plans/README.md
  - scripts/backend-checks.sh
---

# Worker execution instructions

Use this with OpenCode, Antigravity or another coding agent. [SPEC.md](SPEC.md)
defines proposed behavior; the [task graph](README.md) defines dependencies.

## Copy-ready assignment prompt

```text
Repository: Tenvyr. Execute ONLY task <Txx> from:
docs/archive/plans/spring-review-portfolio/tasks/<task-file>.md

Read before editing:
1. Root AGENTS.md and any applicable nested instructions.
2. docs/README.md; docs/archive/plans/spring-review-portfolio/SPEC.md.
3. DISCOVERY.md, WORKER.md, VERIFY.md in that same plan directory.
4. Your complete task file and the prerequisite workers' handoff records.

Goal: reuse the existing engine for a fixed Java/Spring asynchronous code-review
business workflow. Do not broaden it into a new multi-agent platform or rewrite
the engine. New APIs named in the task are planned APIs, not APIs already present.

First report current HEAD, dirty paths, prerequisite status, and the exact
existing symbols you will reuse. Preserve existing user changes. Use an isolated
branch/worktree when other workers are running. Do not reset, clean, broadly
format, or stage all files. Routine terminal commands must run in Ubuntu WSL2
Bash as required by AGENTS.md. Missing WSL is a blocker, not permission to switch.

Implement the smallest task diff. Add the specified failing checks, observe the
failure, implement, then run task checks and the applicable legacy regression
gates. Use real PostgreSQL for transaction/race/crash evidence. Do not replace
that evidence with mocks/H2 or skip a required gate to obtain a green result.

Do not expose legacy ControlRoutes, invent provider results, change protocol
identities, or put network dispatch in the business transaction. Update current
docs and implementation-status.json only for behavior actually delivered.
Run verify:docs and verify:identity. Finish with the handoff template below.

Stop at this task's acceptance boundary. Do not start the next task, publish,
deploy, push, or mark unrelated plans/milestones complete. If source drift changes
an agreed public interface, identify the precise conflict and propose the
smallest amendment before changing downstream contracts.
```

## Ownership and parallel work

Only T04/T05 have an approved parallel window. They start from a reviewed T03
commit, in different worktrees. Shared files (`backend/pom.xml`, package scripts,
ledger and documentation index) are integrated serially; record proposed edits
instead of overwriting another worker's changes. T00–T03 and T06–T08 are serial.

Use the task's estimated hours as a planning aid, not a reason to rush past
tests. Give a short progress update after each significant finding or blocker.
Never report an unexecuted command as passing.

## Handoff template

```text
Task / branch / base commit / resulting commit (or "uncommitted"):
Prerequisites and source drift checked:
Behavior delivered:
Files changed (and pre-existing dirty files preserved):
Tests first observed failing:
Verification commands + exit status + concise actual results:
Infrastructure prerequisites / unexecuted checks:
Transaction, security and compatibility invariants verified:
Current docs / implementation ledger changes:
Known limitations and explicit deferred scope:
Next task and the exact interfaces it can now consume:
```

Store durable task evidence in `reports/Txx.md` under this directory while
active, with normal planned/current frontmatter and a link added to that task.
Do not create reports claiming success in advance. Scratch logs and temporary
prompt experiments belong in ignored `docs/_scratch/`.

## Reviewer instructions

Read the diff and actual checks, not just the worker's summary. Confirm spec
coverage, scope, public interface consistency, failure-path behavior, and that
the new tests are actually invoked. Inspect ownership checks below controllers,
raw callback byte handling, transaction connection ownership and rollback.
For T00/T01 rerun lifecycle regressions; for T04/T06 rerun real concurrent
transactions; for T05 inspect mock labeling and invalid-output behavior.

A task is accepted only when its deliverable works and applicable checks pass.
An incomplete dependency remains incomplete even if another worker can code
against its draft. Do not dispatch another agent automatically if your harness
or the user has not authorized delegation.
