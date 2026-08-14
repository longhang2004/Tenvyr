---
title: "M10 Specification: Operator Workbench and Product Wedge"
status: planned
audience:
  - developer
last_verified: 2026-08-12
sources:
  - docs/plans/active/tenvyr-productization-roadmap/M10-operator-workbench/PLAN.md
  - docs/architecture/overview.md
  - docs/archive/plans/tenvyr-roadmap/M7-execution-capsule/SPEC.md
  - docs/plans/active/tenvyr-productization-roadmap/EXTERNAL_PRODUCTION_EXPOSURE_GATE.md
---

# M10 Operator Workbench specification

## Trust and product scope

The initial Workbench is for one trusted operator on loopback or a private
operator-controlled network. It is not secure external/multi-user production.
Startup and UI must expose that deployment claim. General APIs remain behind the
open exposure gate.

## Authoritative projection

Workbench read models are bounded projections assembled from current services and
PostgreSQL records. They include execution/coordination phase, iteration and roles;
attempt status/events; connection revision/status/capabilities; remaining hard
limits and budget; policy/approval state; ArtifactRefs/lineage; delegation modes;
replay/comparison and Capsule identities. A projection may be cached, but cache,
Socket.IO, polling, browser storage, and telemetry never decide authority.

Every response has stable IDs, server timestamp/version, safe reason codes,
pagination/item/byte bounds and truncation metadata. Raw secrets, credential refs,
unselected context, raw logs, chain of thought, and external artifact bytes are
never exposed. Artifact Reference is labeled as a reference; exposure is not
semantic consumption. Telemetry is labeled projection.

## Commands

Commands use idempotency identities and current-authority checks:

- test/revise/revoke local Runtime Connection;
- create team run from an approved template, goal, role connections and hard limits;
- approve/deny/expire-compatible WAIT requests;
- cancel execution; retry when current semantics permit; controlled replay as a new
  execution; create/open Capsule; compare two compatible runs.

The UI never dispatches a Worker, applies a PlanPatch, advances an iteration, or
marks completion directly. Stale version/phase/approval/connection commands fail
with actionable safe conflicts. Unsupported runtime cancellation is described as
best-effort or unavailable.

## Primary workflow

```text
Connections -> choose tested team -> enter goal and limits -> RUN
-> observe PLAN / WORK / VERIFY and iteration N of maximum
-> resolve WAIT or cancel if needed
-> DONE / FAILED / CANCELLED
-> inspect history, artifacts, delegation, budget and Execution Capsule
-> optional controlled replay/compare
```

The launch surface provides defaults but requires visible max iterations, per-
iteration workers, total workers, deadline and budget/approval summary. It cannot
hide an unbounded value behind "automatic".

## Connection experience

Cards use `Connected`, `Unavailable`, `Auth required`, `Degraded`, `Revoked`, and
`Capability unsupported`, with last test time and tested runtime version. Detection
does not equal authentication; connection does not equal provider account. Actions
never display or import auth files. Quota/cost appears only from documented runtime
evidence with source/confidence; otherwise `Unavailable`, never guessed.

## Team execution experience

Roles are visually and textually distinct; status is not color-only. Iteration view
shows required/optional Workers, terminal outcomes, bounded report/artifact summary,
Verifier decision and Tenvyr authorization result. CONTINUE displays both the agent
recommendation and the separate authority check. WAIT shows requester, reason,
expiry, current authority changes and exact operator choices.

## Failure/reconnect behavior

Refresh or reconnect reconstructs the same view from server state. Lost Socket.IO
events are recovered by bounded polling/read. Duplicate clicks are idempotent.
Partial projection failure shows unavailable sections without inventing state. Large
runs paginate; graph views have an accessible table/text equivalent. Terminal state
never regresses in UI.

## Demo contract

The offline demo uses deterministic fake runtime profiles clearly labeled mock and
executes at least two iterations including one Worker failure and one approval or
budget boundary, then produces a Capsule. Optional installed-runtime demo is
separate, version/auth preflighted, cost-visible, bounded, and never required for CI.

## Security, compatibility, and audit

Commands create durable operator-action evidence even though initial actor is the
single local operator. Do not fabricate multi-user identity. Apply input/body/query,
pagination, graph, preview and request-rate bounds. Preserve existing Gateway routes,
dashboard behavior and compatibility identifiers unless an explicit versioned API
is added.

## Non-goals

No alternate workflow state, secret manager, model/provider proxy, prompt designer,
artifact store, full trace backend, multi-user ownership, or generic admin console.
