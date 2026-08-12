---
title: "M4 Plan: Policy, Budgets, Approvals, and Execution Authority"
status: historical
superseded_by:
  - docs/reference/implementation-status.json
audience:
  - product
  - developer
last_verified: 2026-08-11
sources:
  - services/orchestrator/src/entities/execution.entity.ts
  - services/orchestrator/src/entities/step-execution.entity.ts
  - services/orchestrator/src/services/execution.service.ts
  - services/orchestrator/src/services/result-inbox.service.ts
  - docs/architecture/control-plane.md
  - docs/reference/implementation-status.json
---

# M4 policy, budgets, approvals, and authority plan

## Product outcome

Tenvyr enforces bounded resource grants and deterministic policy decisions before
work or consequential actions receive authority. Approval pauses only the blocked
work that requires external authority and resumes through durable reconciliation.

## User/operator value

Operators can cap spend, tokens, tools, wall time, planning, and delegation; explain
why work was allowed/denied/paused; safely approve selected side effects; and prove
that retries and child work did not escape parent limits.

## Existing repository state

- execution/step/attempt/outbox/inbox persistence and lock ordering are durable;
- timeouts and retries are enforced, but not modeled as a hierarchical resource
  ledger;
- `Execution` and logical steps support `WAITING`; current docs reserve it for an
  external authority/signal, never capacity/backoff;
- cancellation/result races are deterministic;
- pipeline conditions are safe declarative AST data;
- no policy, budget, approval, principal, authority inheritance, or usage ledger
  exists; current Java usage is estimated and labeled.

## Gaps

- no pre-action reservation or atomic concurrent-spend control;
- no source/confidence semantics for actual, estimated, or unknown usage;
- no immutable authority/policy snapshot per execution/attempt/action;
- no `ActionProposal → PolicyDecision` interception contract;
- no one-time approval identity/hash/expiry/replay protection;
- no branch-aware WAITING/reconciliation behavior for approvals;
- no parent-child grant subset enforcement for M6.

## Dependencies

- M2 closure for context/provenance and bounded state separation;
- M3 descriptor/capability foundation before action proposals can be claimed for
  executor/runtime boundaries;
- External Production Exposure Gate before remote approval/admin APIs;
- M5 and M6 depend on budget/policy enforcement primitives.

## Proposed engineering slices

### M4-S1 — resource vocabulary and append-only budget ledger

Define dimension-specific fixed-unit amounts, immutable budget grants, hierarchical
scope references, reservation/commit/release/adjust entries, idempotency, source/
confidence, and hard/soft/unknown semantics. No UI or policy DSL.

### M4-S2 — atomic enforcement at dispatch/retry/deadline boundaries

Reserve before accepting bounded work authority; reconcile canonical usage after
result; charge retries independently; release unused reservation without deleting
history; enforce concurrency using PostgreSQL locks/constraints.

### M4-S3 — policy decision boundary

Define bounded `ActionProposal` and immutable `PolicyDecision` (`ALLOW`, `DENY`,
`REQUIRE_APPROVAL`) with policy snapshot/version/hash. Intercept only boundaries
Tenvyr can stop before side effects: dispatch, PlanPatch, supervised delegation,
and explicit M3 executor action proposals.

### M4-S4 — durable approval and WAITING semantics

Create one-time approval requests/decisions bound to proposal hash, policy version,
scope, expiry, and actor reference. Mark only blocked work WAITING. Execution becomes
WAITING only when no autonomous branch can progress; otherwise remains RUNNING.
Resume via idempotent reconciliation and preserve cancel/approval races.

### M4-S5 — hierarchy, hardening, and closure

Enforce child/plan grants as subsets of ancestors, bounded fanout allocation,
unknown/estimate behavior, full crash/race/security matrix, queryability, current
docs/ledger, and provisional report. M6 activates child use later.

## Risks

- overspend under concurrent reservation/reconciliation;
- currency/token rounding or negative refund bugs;
- unknown usage treated as free/unlimited;
- decorative policy recorded after action;
- approval replay, stale policy approval, forged actor, or cancel race;
- execution stuck WAITING while another branch is runnable;
- privilege escalation via broader child grant;
- secrets/action parameters in logs or approval UI;
- premature generic policy DSL/enterprise registry.

## Explicit non-goals

- no provider billing system or authoritative provider invoice reconciliation;
- no approval for every reasoning/token step;
- no claim to control opaque runtime-internal tools;
- no arbitrary executable policy expressions;
- no general auth rewrite or public approval UI while exposure gate is open;
- no M5 planner intelligence or M6 child execution creation.

## Decisions requiring PO/BA input

- initial resource dimensions and default hard/soft behavior;
- fixed currency unit/rounding and whether budget uses estimated price tables;
- default unknown usage rule (recommended: reserve a configured maximum or deny;
  unresolved unknown remains consumed for hard-budget safety);
- who/what may approve and required expiry/revocation/audit policy;
- which action classes are consequential and default-deny;
- whether budget increases are an approval action or require execution replacement.

## Closure definition

Sol may close M4 only when reservation/reconciliation is exactly-once and race-safe,
all authoritative action boundaries decide before side effects, approval replay/
cancel/expiry is deterministic, WAITING semantics remain correct, unknown usage
cannot bypass hard limits, descendants cannot exceed ancestors, and VERIFY passes.

# Milestone handoff

## What was delivered

## User/operator value

## How it works

## Guarantees

## Known limitations

## Architecture decisions

## What this unlocks

## Verification summary

## Recommended next milestone
