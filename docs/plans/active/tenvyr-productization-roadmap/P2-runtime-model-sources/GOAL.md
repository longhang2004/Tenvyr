---
title: "P2 Goal: Provider Connections + Model Selection + Auth UX (final)"
status: planned
audience:
  - developer
  - operator
  - product
last_verified: 2026-08-16
sources:
  - docs/plans/active/tenvyr-productization-roadmap/P2-runtime-model-sources/PLAN.md
  - docs/plans/active/tenvyr-productization-roadmap/P2-runtime-model-sources/SPEC.md
  - docs/plans/active/tenvyr-productization-roadmap/P2-runtime-model-sources/VERIFY.md
---

# P2 Goal: Provider Connections + Model Selection + Auth UX (final)

Slice documents: [PLAN](PLAN.md) · [SPEC](SPEC.md) · [VERIFY](VERIFY.md) ·
[CLOSURE-PLAN](CLOSURE-PLAN.md) · [implementation report](IMPLEMENTATION_REPORT.md)
· [round-1 report (superseded)](IMPLEMENTATION_REPORT-2026-08-15.md)

## Product outcome

The operator selects a concrete **Runtime Target** (runtime + runtime-owned
**Provider Connection** + **Model**) for Planner / Worker / Verifier from the
Workbench. The final product model is:

**Runtime Connection → Provider Connection (runtime-owned) → Model → Runtime Target**

- **Runtime Connection** — which runtime/executor executes the work (M8,
  immutable secret-free revisions, unchanged).
- **Provider Connection** — which provider/account/key is available THROUGH a
  runtime: its auth state, its models, its testability. Provider state is
  RUNTIME-OWNED and discovered exclusively through the official OpenCode
  Server API (`opencode serve` on 127.0.0.1, ephemeral port, random
  `OPENCODE_SERVER_PASSWORD`: GET /provider, GET /provider/auth, POST
  /provider/{id}/oauth/authorize, POST /provider/{id}/oauth/callback) and the
  documented `opencode models [provider]` CLI — never by parsing TUI output
  (`opencode auth list`) and never by reading the auth file.
- **Model** — a bounded model identifier from that provider's catalog
  (Runtime default when none selected).
- **Runtime Target** — the frozen `{ connectionId, modelId }` unit Tenvyr
  freezes into every attempt.

Discovery is CONNECTION-SCOPED: the backend resolves the connection's CURRENT
revision and uses ITS fixed secret-free profile; two same-kind connections are
fully independent. Auth repair (Sign in / Check again / Advanced) exists for
EXISTING connections — connection state and runtime auth state are separate
states. Only AUTHENTICATED providers are Team Run targets: unauthenticated
providers are shown disabled in the picker, their models never appear, and a
launch BLOCKS with an explanation if a selected target became unavailable.
**Test Runtime Target** is a SMALL BOUNDED REAL INVOCATION through the actual
runtime adapter, audited, with a credit-consumption warning, and failure is
surfaced as failure — never READY.

9Router is NOT a Tenvyr concept: it inspired the provider-management UX only.
No routing/fallback/quota/rotation/alias logic exists anywhere in Tenvyr; an
existing 9Router instance connects only as a generic OpenAI-compatible
catalog endpoint (`model_sources`, advanced surface).

## Non-goals (unchanged)

No native provider credential vault (tokens never persisted or seen), no
subscription/account rotation, no Tenvyr-side inference routing, no 9Router
clone, no OAuth proxy, no automatic model fallback engine.

## Problem being solved

M8–M11 freeze connection + revision but not the model; model choice lived only
in frontend state, so a retry or a later catalog refresh could silently change
what actually ran. Operators also could not discover which providers/models a
runtime actually has, nor repair runtime auth safely, and the old "model source"
framing mixed runtime-owned auth state with Tenvyr-side catalog config.

## Milestone closure

M0–M11 are CLOSED (owner direction). This slice is bounded: it must not turn
Tenvyr into an LLM gateway or credential vault. Acceptance = the exact
acceptance flow in SPEC §0 with all VERIFY gates green.
