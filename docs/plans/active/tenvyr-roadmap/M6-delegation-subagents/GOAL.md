---
title: "M6 DeepSeek Goal: Native and Supervised Delegation"
status: planned
audience:
  - developer
last_verified: 2026-08-11
sources:
  - docs/plans/active/tenvyr-roadmap/M6-delegation-subagents/PLAN.md
  - docs/plans/active/tenvyr-roadmap/M6-delegation-subagents/SPEC.md
  - docs/plans/active/tenvyr-roadmap/M6-delegation-subagents/VERIFY.md
---

# M6 Goal Mode

## Objective

Add truthful opaque/observed/supervised delegation and bounded child authority
without replacing native reasoning.

## Slice order

### Slice 1 — modes and observed evidence

Research current native/A2A reporting first. Implement exact labels, bounded
evidence/idempotency/conflicts, and prove observed data cannot schedule, spend,
cancel, or terminalize. Old runtimes remain opaque.

### Slice 2 — supervised child creation

Add request/decision and manager-aware execution materialization. Atomically commit
M4 reservation/authority snapshot, child execution/revision/steps, and relation.
Prove 100-way exactly-one creation and rollback failures.

### Slice 3 — parent wait/resume

Implement only for a runtime capability proven by M3/current research. Otherwise
keep that runtime opaque/observed and model supervised work outside a suspended call
stack. Integrate heartbeat/supervision/capacity/deadline/continuation exactly.

### Slice 4 — inheritance/cancellation/outcomes

Enforce permission/budget/deadline/depth/fanout subset, durable bounded cascade,
frozen child failure policy, late results, and restart recovery.

### Slice 5 — adapters/graph/closure

Finish approved Codex/Claude/A2A paths, internal bounded graph projection, security/
race/compatibility, PostgreSQL twice, docs/ledger, and provisional report. No public
API while exposure gate is open.

## Rules and stops

Do not create children from AgentEvents/metadata, promote observed evidence, copy
parent credentials/authority, infer opaque children, or recursively cancel without
recovery. Stop for unresolved parent suspend/resume, failure policy, mandatory
runtime integration, or exposure decision; ordinary engineering repair continues.
