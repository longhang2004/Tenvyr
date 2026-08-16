---
title: "P2 Goal: Runtime Model Sources + Model Selection + Auth UX"
status: planned
audience:
  - developer
  - operator
  - product
last_verified: 2026-08-15
sources:
  - docs/plans/active/tenvyr-productization-roadmap/P2-runtime-model-sources/PLAN.md
  - docs/plans/active/tenvyr-productization-roadmap/P2-runtime-model-sources/SPEC.md
  - docs/plans/active/tenvyr-productization-roadmap/P2-runtime-model-sources/VERIFY.md
---

# P2 Goal: Runtime Model Sources + Model Selection + Auth UX

Slice documents: [PLAN](PLAN.md) · [SPEC](SPEC.md) · [VERIFY](VERIFY.md) ·
[CLOSURE-PLAN](CLOSURE-PLAN.md) · [implementation report](IMPLEMENTATION_REPORT.md)

## Product outcome

The operator can select a concrete **Runtime Target** (connection + model) for
Planner / Worker / Verifier from the Workbench, Tenvyr freezes that exact
target into every attempt, and the Capsule shows the requested model per role.
Model discovery comes from bounded Model Sources (OpenCode CLI catalog,
9Router, generic OpenAI-compatible endpoints); authentication stays
runtime-owned with guided official login commands.

## Non-goals (unchanged)

No native provider credential vault, no subscription/account rotation, no
Tenvyr-side inference routing, no 9Router clone, no OAuth proxy, no automatic
model fallback engine.

## Problem being solved

M8–M11 freeze connection + revision but not the model. Model choice lives only
in frontend state, so a retry or a later catalog refresh can silently change
what actually ran, and the Capsule cannot reconstruct which model a role
requested. Operators also cannot discover models safely today.

## Milestone closure

M0–M11 are CLOSED (owner direction). This slice is bounded: it must not turn
Tenvyr into an LLM gateway or credential vault. Acceptance = the exact
acceptance flow in SPEC §0 with all VERIFY gates green.
