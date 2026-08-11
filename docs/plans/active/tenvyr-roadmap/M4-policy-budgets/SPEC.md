---
title: "M4 Specification: Policy, Budgets, Approvals, and Execution Authority"
status: planned
audience:
  - developer
last_verified: 2026-08-11
sources:
  - docs/plans/active/tenvyr-roadmap/M4-policy-budgets/PLAN.md
  - docs/architecture/control-plane.md
  - services/orchestrator/src/services/execution.service.ts
  - services/orchestrator/src/services/runtime-recovery.service.ts
---

# M4 authority specification

## Concepts

- `AuthorityGrant`: immutable bounded permission/resource envelope for a scope.
- `BudgetDimension`: typed unit such as currency micros, tokens, tool calls,
  wall-time milliseconds, planner operations, delegations, depth, or fanout.
- `BudgetAccount`: durable scope whose ceiling is inherited from a parent account.
- `BudgetReservation`: pre-authorized maximum for one idempotent operation.
- `BudgetLedgerEntry`: append-only reserve/commit/release/adjust evidence.
- `UsageObservation`: actual, estimated, or unknown usage with source/confidence.
- `ActionProposal`: bounded immutable description/hash of a consequential action.
- `PolicyDecision`: ALLOW, DENY, or REQUIRE_APPROVAL under a frozen policy version.
- `ApprovalRequest/Decision`: one-time external authority bound to exact proposal.

## Budget state behavior

```text
available
  → reserve before granting action authority
  → commit actual/estimated usage
  → release unused reserved amount
```

Every transition is append-only and idempotent. Current balance is a projection of
ledger truth or a transactionally maintained cache that can be rebuilt and checked.
Entries never mutate/delete prior evidence.

Use integers in canonical base units; no binary floating-point money. Dimensions do
not silently convert. Negative amounts, overflow, unknown dimensions, and cross-unit
arithmetic are rejected.

### Unknown and estimated usage

- `actual`: authoritative source reported/verified within the supported boundary;
- `estimated`: labeled source/method/version/confidence; charged according to frozen
  policy and reconcilable by an append-only adjustment;
- `unknown`: never zero. A hard-budget action must reserve an approved maximum or be
  denied/require approval. If actual never arrives, the reservation remains consumed
  by default; only explicit policy may release it.

Retries, planner proposals, child allocations, and failed work consume their own
applicable resources. Refund/release means unused reservation only; it does not erase
actual work.

## Hierarchy and concurrency invariants

- child ceiling/allocation is a subset of every ancestor's remaining grant;
- reserve atomically debits child and applicable ancestor availability once;
- one idempotency key cannot reserve twice; same key/different request conflicts;
- concurrent branches cannot collectively exceed a hard ceiling;
- soft limit does not mean unenforced telemetry: it triggers frozen policy behavior;
- deadline/depth/fanout/allowed executor/action permissions can only narrow down the
  hierarchy;
- server derives authoritative depth/parentage, never trusts runtime claims.

## Policy state behavior

```text
ActionProposal
  → deterministic evaluation under frozen PolicySnapshot
  → ALLOW → reserve budget → execute
  → DENY → durable terminal/branch disposition
  → REQUIRE_APPROVAL → durable ApprovalRequest → WAITING
```

An ALLOW decision without successful required reservation grants no authority.
Policy evaluates before dispatch/side effect and stores proposal hash, relevant
bounded facts, policy version/hash, decision/reasons, and timestamps.

Policy configuration is trusted and versioned. Untrusted pipeline/runtime metadata
cannot select a more permissive policy. Start with minimal deterministic rule data;
do not add executable strings or a generic language without a demonstrated need.

## Approval and WAITING behavior

Approval is bound to request ID, proposal hash, policy snapshot, scope, expiry,
actor reference, and one decision. Duplicate identical decision is idempotent;
conflicting/replayed/stale/expired/wrong-scope decisions are retained/rejected.

Only the blocked logical step/action waits. The execution status rule is:

```text
some autonomous branch can progress → Execution RUNNING
no autonomous progress; external decision required → Execution WAITING
```

Capacity, backoff, rate limiting, scheduled retry, and recoverable errors never use
WAITING. Approval resolution wakes ordinary durable reconciliation. Cancellation
may always win; late approval cannot revive cancelled/terminal work.
Execution wall-time budgets and deadlines continue across WAITING unless a frozen
policy explicitly defines a different dimension; waiting never silently creates time.

## Authority boundaries

Tenvyr can enforce only before observable interceptable boundaries: dispatch,
explicit M3 executor action proposal, M5 PlanPatch application, M6 supervised child
creation, replay creation, and other Tenvyr-owned side effects. Opaque runtime tool
calls are outside enforcement unless the runtime opts into an approved interception
contract. UI/telemetry claims must state this limitation.

## Persistence semantics

Budget accounts/reservations/entries, policy snapshots/decisions, approval requests/
decisions, and their execution/attempt/action relations are durable. Use uniqueness,
foreign keys, indexes for outstanding approvals/account history, and transaction
ownership at the intercepted action. No historical backfill invents decisions or
usage. Migrations preserve M0–M3 rows.

## Failure semantics

- insufficient hard budget: DENY or REQUIRE_APPROVAL by frozen policy; no action;
- reservation DB failure: no authority and retry only if idempotent/transient;
- result without usage: settle as unknown policy, never free;
- usage above reservation: deterministic overage policy and evidence; never hide;
- approval service crash: durable request remains WAITING and resumable;
- approval versus cancel/expiry/duplicate: one serialized authority outcome;
- policy unavailable/invalid: default deny at consequential boundary;
- ledger projection mismatch: stop affected authority and surface integrity failure.

## Security/trust boundaries

Proposal parameters, runtime usage, actor assertions, price inputs, and approval
payloads are untrusted. Bound/hash/redact them; authenticate approval actors only
after the exposure gate; use constant-time/signature/replay protections where
remote; never log secrets/full parameters; default deny unknown permission/dimension.

## Cross-runtime behavior

All executors use the same reservation/decision semantics. Runtime-specific usage
is normalized with source/confidence; missing capability remains unknown, not zero.

## Product example

Two parallel research steps share a $1.00 hard execution budget. Each atomically
reserves up to $0.60; only one can start until a reservation releases or policy
approves more. One runtime proposes a repository write: policy requires approval,
so that step waits while an unrelated read-only branch continues and Execution stays
RUNNING. The signed approval resumes the write; its actual $0.42 usage commits and
$0.18 releases with full ledger evidence.

## Non-goals

No opaque tool enforcement claim, provider invoice service, executable policy code,
approval-every-token, or public admin surface without exposure-gate closure.
