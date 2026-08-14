---
title: "M10 DeepSeek Goal: Operator Workbench and Product Wedge"
status: planned
audience:
  - developer
last_verified: 2026-08-12
sources:
  - docs/plans/active/tenvyr-productization-roadmap/M10-operator-workbench/PLAN.md
  - docs/plans/active/tenvyr-productization-roadmap/M10-operator-workbench/SPEC.md
  - docs/plans/active/tenvyr-productization-roadmap/M10-operator-workbench/VERIFY.md
---

# M10 Goal Mode

## Objective

Turn closed M8–M9 authority into a focused, truthful local operator experience and
the primary product demo.

## Slice order

1. Inspect current Gateway/frontend/services. Add bounded read projections with
   focused contract/redaction/pagination tests; render no new UI state yet.
2. Add idempotent internal/local commands for launch, WAIT, cancel, replay and
   connection actions through existing authority services plus audit evidence.
3. Build the smallest accessible Workbench workflow: connections, team/goal/limits,
   live roles/iteration/status/budget, WAIT actions and terminal outcome.
4. Add bounded artifacts/delegation/history/Capsule/replay/compare inspection with
   refresh/reconnect, large-run, responsive and keyboard/screen-reader checks.
5. Deliver deterministic offline demo and optional installed-runtime preflight;
   update current docs/ledger and record design-partner evidence.
6. Run VERIFY, create provisional report and request Sol audit. Do not start M11
   before closure and evidence review.

## Rules and stops

Copy existing UI/API patterns after reading them; do not invent endpoints or a
parallel state machine. Stop if external identity/ownership is required, if sensitive
metadata cannot be bounded, or if a product workflow choice changes SPEC. Never hide
limits, claim unsupported cancel/sandbox/bytes, or promote discovery programs.
