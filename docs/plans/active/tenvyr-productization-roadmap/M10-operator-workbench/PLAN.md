---
title: "M10 Plan: Operator Workbench and Product Wedge"
status: planned
audience:
  - product
  - developer
last_verified: 2026-08-12
sources:
  - docs/architecture/overview.md
  - docs/showcase/demo-guide.md
  - docs/reference/implementation-status.json
  - docs/plans/active/tenvyr-productization-roadmap/PRODUCT_DISCOVERY.md
---

# M10 Operator Workbench plan

## Product outcome

A single trusted operator can connect runtimes, select a bounded agent-team
configuration, submit a goal, watch Planner/Workers/Verifier and current iteration,
inspect budgets/policy/approvals/artifacts/delegation, cancel or resolve waits, and
open the final Execution Capsule. One deterministic offline demo and one opt-in
real-runtime example prove the adoption wedge end to end.

## Problem being solved

The current dashboard shows basic pipeline steps but not M3–M9 authority. Operators
would need service calls and database knowledge to use the product. Infrastructure
without a coherent run/control experience cannot validate the product hypothesis.

## Existing capabilities reused

Gateway/Socket.IO and dashboard; execution/event services; M4 approval/budget/policy;
M6 delegation; M7 Capsule/replay/compare; M8 connection status; M9 coordination
projection. PostgreSQL remains authoritative.

## Missing capabilities

Bounded internal query/command APIs, authoritative workbench projections, team
configuration/start form, runtime connection cards, iteration/fanout view,
approvals/cancel/replay controls, safe artifact/capsule views, deterministic demo,
accessibility/responsive tests, and design-partner evidence capture.

## Dependencies

Independently closed M8 and M9. External Production Exposure Gate remains open, so
the supported surface is loopback/private trusted-operator only and must display
that limitation.

## Engineering slices

1. Read projections/API: one bounded server projection over current authoritative
   services for connections, team loop, execution, budgets, policy, approvals,
   artifacts, delegation and Capsule links; no frontend-owned state model.
2. Command surface: local/internal create team run, approval decision, cancel,
   retry/replay and connection test/revoke with idempotency, current-authority recheck,
   safe errors, audit evidence and request bounds.
3. Workbench shell: runtime cards, goal/team/limits launch, execution and current
   iteration, Planner/Worker/Verifier roles, status and budget, WAIT actions.
4. Inspection: artifacts as references, delegation graph, history, comparison,
   controlled replay and Capsule. Safe preview/truncation and explicit non-claims.
5. Wedge/demo/discovery: offline Codex/Claude/OpenCode-labeled fake profiles plus an
   opt-in installed-runtime example; 5–10 minute guide; record qualified design-
   partner findings against `PRODUCT_DISCOVERY.md`.
6. Hardening/closure: accessibility, responsive behavior, refresh/reconnect,
   stale-command races, performance/cardinality, docs/identity and full verification.

## Product-impacting alternatives

Chosen: a focused control-plane workbench. Rejected: giant no-code workflow designer,
prompt builder, provider console, proprietary trace store, or frontend shadow state.
The first launch configuration is opinionated Planner/Workers/Verifier plus limits;
advanced pipeline editing remains outside this milestone.

## Risks

Stale UI issuing authority actions, leaking secrets/context/artifact metadata,
misleading optimistic state, unbounded polling/graphs, duplicated command delivery,
unsafe unauthenticated exposure, approval/replay confusion, cancellation claims that
opaque runtimes cannot meet, inaccessible graph-only UI, vendor demo dependence, and
demo polish displacing core correctness.

## Research-required items

Recheck current runtime UX patterns in 9router/cockpit-tools only for status/test
ergonomics. Conduct real design-partner interviews; feature votes alone do not
promote later programs.

## Explicit non-goals

No multi-user auth/RBAC claim, SaaS admin, account/credential router, prompt studio,
generic workflow canvas, model catalog, proprietary observability backend, artifact
byte viewer, MCP/A2A management, or mobile-native app.

## Closure definition

Sol may close M10 only when a trusted local operator completes the whole wedge from
connection test to Capsule without service/database knowledge; every view/action
maps to authoritative state and survives refresh/restart/races; secret and payload
bounds hold; accessibility and offline demo gates pass; limitations are visible; and
design-partner evidence is recorded without auto-promoting later work.

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
