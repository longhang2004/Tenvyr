---
title: "M6 Specification: Native Agents, Delegation, and Supervised Subagents"
status: historical
superseded_by:
  - docs/reference/implementation-status.json
audience:
  - developer
last_verified: 2026-08-11
sources:
  - docs/archive/plans/tenvyr-roadmap/M6-delegation-subagents/PLAN.md
  - services/orchestrator/src/services/execution.service.ts
  - services/orchestrator/src/services/agent-event.service.ts
  - docs/architecture/contracts/agent-protocol-v1.md
---

# M6 delegation specification

## Mode semantics

### Opaque

The runtime owns internal delegation. Tenvyr sees one parent attempt and does not
fabricate child identities, graph edges, budgets, cancellation, or provenance.

### Observed

The runtime emits bounded delegation evidence correlated to a parent attempt.
Tenvyr durably records what the runtime reported, including identity/hash/conflict,
timestamps, declared child/runtime/reason/scope/status, and mode. Evidence is labeled
runtime-asserted and cannot schedule/cancel/spend/terminalize or prove authority.

### Supervised

A runtime/operator submits a bounded request through an M3/M4 authority boundary.
Tenvyr decides policy/budget, durably creates/governs child work, and records an
authoritative parent-attempt → child-execution relation. Runtime reasoning remains
native; Tenvyr controls only the selected boundary.

Observed records never silently promote into supervised children. Supervised
creation is a separate authoritative operation.

## Concepts

- `DelegationRequest`: parent-attempt-scoped idempotent request and payload hash.
- `DelegationEvidence`: append-only observed report/conflict.
- `Delegation`: authoritative supervised relation and lifecycle.
- `DelegatedAuthoritySnapshot`: immutable narrowed permissions, budget, deadline,
  depth, fanout, allowed runtime/agent classes, and policy version.
- `ChildExecution`: preferred durable supervised work primitive, reusing revisions,
  logical steps, attempts, outbox/inbox, events, and cancellation.

Exact external report shape waits for current native/A2A research and protocol
compatibility review. Do not smuggle authoritative delegation through AgentEvent
`progress` or free-form metadata.

## Supervised state behavior

```text
REQUESTED
  → policy/budget/limits validate
  → DENIED | REQUIRE_APPROVAL
  → APPROVED
  → child Execution atomically CREATED
  → RUNNING
  → SUCCEEDED | FAILED | CANCELLED | TIMED_OUT
```

Duplicate `(parentAttempt, runtimeRequestId)` with identical payload is idempotent;
different payload is durable conflict. No duplicate creates another child.

## Atomic creation and persistence

Use a manager-aware form of current execution materialization. In one transaction
commit delegation request/decision, M4 reservation, delegated authority snapshot,
child Execution, initial immutable revision, child logical rows, and parent-child
relation. A failure commits none. Do not call current self-transactional
`createExecution` from inside another transaction or duplicate its invariants.

Foreign keys, uniqueness, query indexes, immutable identities, and no historical
backfill are required. Server derives depth from authoritative relations.

## Inheritance invariants

- child permissions/executor classes are subsets of parent/current policy;
- child budget reservation is within parent remaining budget and charged once;
- child deadline is no later than every ancestor deadline;
- depth/fanout are server-derived and bounded under transactional locks;
- child credentials are narrower references resolved by trusted executor config,
  never copied secret values;
- unknown/missing authority defaults deny;
- child retries consume child and ancestor budget under M4.

## Parent wait/resume contract

An in-runtime supervised child may block a parent attempt only when M3 provides a
reviewed durable pause/resume capability. That state must stop inappropriate
heartbeat watchdog failure, release/define runtime capacity, preserve parent
deadline/budget semantics, reject duplicate continuation, and resume with exact
child result/reference through durable authority.

Without that capability, a runtime supports opaque/observed delegation only. A
supervised child may still be represented as explicit workflow work that does not
pretend a suspended native call stack can resume.

At execution level, unrelated runnable branches keep the parent Execution RUNNING.
WAITING is used only when external child/approval signal is required and no
autonomous branch can progress; wall-time budget/deadline does not silently pause.

## Cancellation and outcomes

Parent cancellation creates durable bounded cascade intent or uses a proven global
lock order; do not recursively open uncontrolled transactions. Descendants become
cancelled/retired exactly once. Child cancellation cannot rewrite an already
terminal parent. Late child results remain evidence and cannot revive ancestors.

Child failure effect follows a frozen delegation failure policy and is returned to
the parent/workflow through one durable continuation. Do not reinterpret it from
later config.

## Security/trust boundary

Native reports, child target/scope/reason/input, A2A identities, depth claims, runtime
capabilities, and credentials are untrusted. Bound JSON/counts/strings, authenticate
supported remote requests, rederive authority, prevent cross-execution parenting,
redact sensitive scope/input, and default deny unknown capability/permission.

## Backward/cross-runtime behavior

Old runtimes remain opaque with unchanged AgentInvocation/Result/Event semantics.
Observed/supervised integrations use versioned negotiated capability and exact mode
labels. Official TypeScript/Python/native/A2A paths agree on authority and conflict
semantics even when their internal subagents differ.

## Product example

A Claude runtime internally opens two opaque research subagents; Tenvyr records only
the parent attempt. It reports a third delegation in observed mode, so the dashboard
shows runtime-asserted evidence. For a high-cost code-writing child, it submits a
supervised request. Tenvyr reserves a narrowed $0.50 budget, enforces depth 2 and a
shorter deadline, creates one child Execution, and resumes the capable parent only
after the child result. Cancelling the parent retires both without granting the child
the parent's deployment permission.

## Non-goals

No competing reasoning framework, hidden-child inference, universal child conversion,
event-created child, privilege widening, or public sensitive graph before auth.
