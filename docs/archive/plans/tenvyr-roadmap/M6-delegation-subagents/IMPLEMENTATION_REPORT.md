---
title: "M6 Implementation Report"
status: historical
superseded_by:
  - docs/reference/implementation-status.json
audience:
  - developer
  - product
last_verified: 2026-08-12
sources:
  - contracts/schemas/agent-result.v1.schema.json
  - services/orchestrator/src/services/delegation.service.ts
  - services/orchestrator/src/services/result-inbox.service.ts
  - services/orchestrator/src/services/runtime-recovery.service.ts
  - services/orchestrator/src/agent-adapters/agent-transport-config.service.ts
---

# M6 implementation report — native agents, delegation, supervised subagents

Date: 2026-08-12
Status: **CLOSED — independent Tech Lead PASS.** See the
[durable closure review](../../../../archive/reviews/2026-08-12-m3-m7-independent-closure.md).
Slices: 5/5 complete (S1 modes + observed evidence, S2 authoritative
requests + child materialization, S3 parent wait/resume contract, S4
inheritance/cancellation/outcome, S5 capability negotiation + graph
projection + closure). Provisional until the independent SOL review.

## What M6 delivers

- **Modes + observed evidence (M6-S1)** — `delegation: opaque|observed`
  per step (supervised rejected until its machinery landed; no silent
  degradation). Bounded `result.delegation` contract (≤ 32 observations,
  provider/childId/assertedAt/attributes; schema-validated at ingress).
  Observed evidence is inert, hash-pinned, correlated to ONE parent
  attempt, idempotent, conflict-retained — it never schedules, spends,
  cancels, or terminalizes.
- **Authoritative requests + child materialization (M6-S2)** —
  `delegation_requests` (unique (parentAttemptId, requestId), PENDING →
  APPROVED|REJECTED|EXPIRED, deterministic expiry + recovery sweep);
  idempotent request with attempt/execution pairing validation; approve
  materializes the child Execution (execution + revision 1 + logical
  steps) via the manager-aware materializer ALL-OR-NONE with the
  CAS-guarded decision; concurrent approves produce exactly one child.
- **Parent wait/resume contract (M6-S3)** — current runtimes have no
  durable pause/resume: supervised child work is EXPLICIT workflow work
  outside a paused attempt. A delegation request never suspends the
  parent; supervision applies unchanged (a pending request is not a
  heartbeat exemption); AgentEvent/terminal AgentResult are never request
  channels (observed evidence never promotes).
- **Inheritance, cancellation, outcome (M6-S4)** — a child can never
  exceed its parent: server-derived depth (parent + 1 via the
  childExecutionId linkage, ≤ 3) and live-only fanout (≤ 10) enforced at
  request + rechecked at approval; budget subset (child grant ≤ parent
  grant per dimension, both budget forms; malformed → durable REJECTED);
  agent/executor classes via the policy boundary on the child's dispatch;
  credentials reference-only; a durable deterministic recovery-owned
  cancellation cascade (ordered, bounded, crash-resumable,
  double-cancel-safe); failed/completed children never terminalize the
  parent.
- **Closure (M6-S5)** — capability negotiation: operators declare each runtime's supported
  `delegationModes` in AGENT_TRANSPORT_CONFIG (absent = unrestricted); a
  step requiring a mode the runtime lacks is a durable
  `runtime_capability` failure before any dispatch authority. Read-only
  bounded graph projection distinguishing supervised (durable relations)
  vs observed (runtime evidence) edges + server depth; service-level
  only — the public API stays behind the exposure gate.

## Verification (final state)

- Unit: orchestrator 441 passed / 212 skipped (PG) / 0 failed.
- Real PostgreSQL: 652/653 ×3 sequential — M6-S1 6, M6-S2 6, M6-S3 3,
  M6-S4 5, M6-S5 3 = 23 delegation tests, incl. concurrent approves,
  depth chains, budget subsets, cascade idempotency, capability
  negotiation, and graph projection.
- test:all green (contracts 65, worker 199, host 31, orchestrator 441,
  gateway, agents, example); build:all 15; verify:docs 88 files / 38
  capabilities; verify:identity 0 violations; git diff --check.
- Review findings fixed at every slice: S1 failure isolation + strict
  validation, S2 pairing validation + DI fix, S3 Nest DI bootstrap hole
  (root-caused to PlanProposalService too), S4 budget parse + live-only
  fanout + recovery stub, S5 (this slice) reviewed below.

## Known limitations (explicit)

- The delegation request CHANNEL is service-level; a runtime-facing
  channel requires runtimes with durable pause/resume and remains a
  documented future capability.
- The observed-evidence conflict table is defense-in-depth (the
  canonical result flow is exactly-once and reaches the result-level
  conflict first).
- Parent/child execution and attempt relations have durable `NO ACTION`
  foreign keys plus bounded traversal indexes. A closure migration upgrades
  provisional schemas without fabricating historical payload hashes.
- "Repository-fit confirmation" for the child-Execution-as-supervised-
  primitive remains a PO/BA research item (the plan's preferred shape
  was implemented).

## Independent closure

**PASS — CLOSED 2026-08-12.** Independent review added payload-aware request
idempotency and durable conflicts, serialized fanout enforcement, delegate
policy evaluation, parent-linked budget authority, server-enforced inherited
deadlines, exact graph totals, relation integrity, and concurrency/deadline/
policy regressions. Legacy requests without a payload hash fail closed instead
of inventing equality. Final evidence is in the
[durable M3–M7 closure review](../../../../archive/reviews/2026-08-12-m3-m7-independent-closure.md).
