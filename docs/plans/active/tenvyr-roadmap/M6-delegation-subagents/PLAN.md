---
title: "M6 Plan: Native Agents, Delegation, and Supervised Subagents"
status: planned
audience:
  - product
  - developer
last_verified: 2026-08-11
sources:
  - services/orchestrator/src/services/execution.service.ts
  - services/orchestrator/src/services/engine.service.ts
  - services/orchestrator/src/services/agent-event.service.ts
  - services/orchestrator/src/entities/step-attempt.entity.ts
  - docs/architecture/control-plane.md
  - docs/architecture/contracts/agent-protocol-v1.md
---

# M6 delegation and supervised subagents plan

## Product outcome

Users retain native runtime delegation while choosing how much Tenvyr supervises:
opaque, observed, or supervised. Supervised child work receives explicit inherited
authority, budget, deadline, cancellation, retry, provenance, depth, and fanout
bounds; it can never exceed its parent.

## User/operator value

Teams can use native Codex/Claude/custom/A2A delegation without adopting a Tenvyr
reasoning framework, while selected high-risk or expensive child work becomes
durable, cancellable, auditable, and budget-enforced.

## Existing repository state

- no delegation, parent-child execution, authority inheritance, or native-subagent
  production model exists;
- `EngineService.startExecution` and `ExecutionService.createExecution` create a
  full execution/revision/logical-step graph, but the latter owns its own transaction;
- attempt claim/outbox and cancel/result lock order are durable reusable patterns;
- AgentEvents are bounded evidence and cannot schedule/terminalize work;
- attempt status has no WAITING/suspended state;
- M3/M4/M5 must establish executor capability, authority/budget, and controlled
  dynamic-work foundations before supervised delegation.

## Gaps

- no exact semantics/labels for opaque, observed, supervised;
- no portable bounded native delegation evidence contract;
- no idempotent delegation request/conflict or parent-attempt relation;
- no atomic child Execution materialization inside an owning transaction;
- no parent suspend/resume contract for an in-runtime subagent;
- no bounded cascade cancellation/recovery across executions;
- no server-derived depth/fanout or authority subset enforcement;
- no delegation graph projection/query.

## Dependencies

- M3 stable executor identity/capability and supported pause/resume/action-proposal
  seams;
- M4 hierarchical authority/budget/policy/approval;
- M5 controlled dynamic work and roadmap order, though child materialization should
  reuse execution primitives rather than Planner internals;
- current official research for native Codex/Claude delegation and A2A;
- external exposure gate before public delegation graph/control APIs.

## Proposed engineering slices

### M6-S1 — modes and observed evidence

Freeze mode semantics. Opaque creates no invented child lineage. Observed accepts
bounded runtime-asserted delegation evidence correlated to one parent attempt, with
hash/idempotency/conflict patterns like AgentEvents; it never schedules, spends,
cancels, or terminalizes.

### M6-S2 — authoritative supervised delegation request

Add idempotent parent-attempt-scoped request/decision. Create a child Execution as
the preferred supervised primitive only after repository-fit confirmation. Add a
manager-aware execution materializer so delegation, M4 reservation/authority
snapshot, child Execution/revision/logical steps, and relation commit all-or-none.

### M6-S3 — parent wait/resume and lifecycle

Resolve the load-bearing contract explicitly. Preferred directions:

- runtimes with durable pause/resume capability may enter a Tenvyr-owned delegation
  wait state that supervision understands; or
- runtimes without it support opaque/observed only, while supervised child work is
  represented as explicit workflow work outside a paused in-runtime attempt.

Do not keep an un-heartbeating RUNNING attempt indefinitely or misuse AgentEvent/
terminal AgentResult as a delegation request.

### M6-S4 — inheritance, cancellation, and failure policy

Enforce authority/budget/deadline subset, server-derived depth/fanout, allowed
executor/agent classes, and credential refs only. Implement bounded durable
cancellation propagation with deterministic ordering/recovery. Define child outcome
effect on parent and late-result behavior.

### M6-S5 — native/A2A adapters, graph projection, closure

Research and implement supported runtime capability negotiation outside Orchestrator
reasoning. Query/project observed versus supervised edges clearly; keep sensitive
public APIs closed. Complete race/security/scale/compatibility verification.

## Risks

- privilege/budget/deadline escalation;
- delegation explosion or depth based on untrusted runtime claims;
- duplicate request creating multiple children;
- parent cancellation leaving runnable orphan;
- recursive cross-execution locks causing deadlock/partial cascade;
- parent attempt held RUNNING without heartbeat or capacity release;
- observed evidence presented as supervised authority;
- provider-specific subagent protocol in Orchestrator;
- child credentials copied rather than referenced/narrowed.

## Explicit non-goals

- no proprietary subagent reasoning/decomposition framework;
- no assumption that every native subagent is a child Execution;
- no inference of hidden opaque subagents;
- no child creation from AgentEvent or arbitrary result metadata;
- no child with broader authority/budget/deadline;
- no public graph/control API before exposure gate;
- no M7 replay/capsule implementation.

## Decisions requiring PO/BA input

- initial default mode and which delegation actions require supervision;
- whether supervised in-runtime parent pause/resume is required for first closure;
- child failure propagation (`fail parent`, `return failure to parent`, `continue`);
- cancellation semantics across descendants and grace periods;
- configured default depth/fanout/delegated-budget limits;
- which Codex/Claude/A2A integrations are mandatory for closure.

## Closure definition

Sol may close M6 only when mode labels are truthful, observed reports cannot gain
authority, duplicate supervised requests create one child, child grants are strict
subsets, parent wait/resume is safe for supported runtimes, cancellation/restart
leaves no orphan, depth/fanout races cannot bypass limits, and VERIFY passes.

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
