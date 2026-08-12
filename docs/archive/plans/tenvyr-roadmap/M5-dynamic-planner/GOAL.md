---
title: "M5 DeepSeek Goal: Dynamic Planner and Immutable Plan Revision"
status: historical
superseded_by:
  - docs/reference/implementation-status.json
audience:
  - developer
last_verified: 2026-08-11
sources:
  - docs/archive/plans/tenvyr-roadmap/M5-dynamic-planner/PLAN.md
  - docs/archive/plans/tenvyr-roadmap/M5-dynamic-planner/SPEC.md
  - docs/archive/plans/tenvyr-roadmap/M5-dynamic-planner/VERIFY.md
---

# M5 Goal Mode

## Objective

Implement dynamic adaptation as restricted proposals plus immutable revision
activation. Planner remains supervised untrusted input, never authority.

## Slice order

### Slice 1 — pure PlanPatch

Implement only addStep/replaceUnfrozenStep with versioned bounded payload,
deterministic application/order/hash, unsafe-key-safe declarative conditions, and
full candidate pipeline validation. No persistence or model call yet.

### Slice 2 — proposal evidence and activation

Add immutable proposal/decision persistence and exact `baseRevision` CAS. Atomically
protect frozen steps, insert revision/materialize new rows/switch pointer, prove
rollback, same-base race, claim race, and crash recovery in PostgreSQL.

### Slice 3 — Planner invocation

After the PO/BA trigger decision, add one explicit bounded Planner invocation through
M3 with M2 context and M4 budget/deadline/cancellation. Structured output only;
never repositories/services/dispatch or mutable pipeline.

### Slice 4 — policy/approval

Enforce proposed executors/agents/growth/budget at activation. Approval rechecks
base revision and authority; stale stays stale.

### Slice 5 — closure

Run malicious proposal, concurrency, recovery, compatibility, docs/ledger, full
commands and PostgreSQL twice. Create provisional report and request Sol review.

## Rules and stops

Re-read current code and PLAN/SPEC/VERIFY each slice. Do not add remove/rename/full
replacement, executable condition strings, silent rebase, autonomous planning loop,
or M6 delegation. Stop for an unresolved trigger/approval/operation product choice
or required protocol break; ordinary repair is not a blocker.
