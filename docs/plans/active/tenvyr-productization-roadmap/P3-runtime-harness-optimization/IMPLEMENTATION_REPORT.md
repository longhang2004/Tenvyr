---
title: "P3 Implementation Report: Runtime Harness Optimization & Context Efficiency (bounded baseline)"
status: planned
audience:
  - developer
  - product
last_verified: 2026-08-16
sources:
  - docs/plans/active/tenvyr-productization-roadmap/P3-runtime-harness-optimization/PLAN.md
  - docs/architecture/executors/invocation-efficiency.md
---

# P3 Implementation Report — bounded Invocation Efficiency / Context Projection baseline

Status: provisional implementer report; closure is the Technical Lead's
decision. This slice does NOT close the P3 roadmap.

## Closure — Technical Lead audit fixes (2026-08-16)

Narrow closure only; the accepted architecture is unchanged.

1. **`contextBundle: null` variant accepted.** `parseEfficiencyEvidence`
   previously threw on the legitimate no-context-bundle state written by
   `buildClaimEfficiencyEvidence` for attempts without a Tenvyr
   `contextProjection`, which kept those attempts' usage/timing incomplete
   and hid them from Workbench efficiency projections/aggregates. The
   parser now round-trips `null` (both `contextBundle` and `context`).
   Regressions cover the dispatchable FRESH and pre-dispatch blocked/
   WAITING UNKNOWN paths, including a real-PostgreSQL no-context
   completion through claim → acceptance → Workbench → Capsule.
2. **Cache immutability on WRITE.** `ContextProjectionCache.set` now
   stores deep clones of the caller's envelope and defensive copies of the
   envelope-derived metrics, so mutating the source after `set` can never
   corrupt the content-addressed entry (the read-side clone regression is
   kept).
3. **`executionStateBytes` recomputed per claim.** The full-state metric is
   NOT a function of the cached envelope; the cache now stores only
   envelope-derived metrics (`EnvelopeMetricsV1`) and every claim combines
   the cached envelope metrics with the CURRENT full-state size on HIT.
   PostgreSQL regression: two executions with identical selected values but
   different unselected state sizes share a hash and a HIT, produce
   identical envelopes, and each attempt records its own
   `executionStateBytes`.
4. **SPEC reconciled with implementation truth.** P3 SPEC §2 now states
   artifact resolution executes on EVERY claim (hit and miss) — resolved
   authoritative references are load-bearing fingerprint inputs and
   exposure edges are always built from live resolution; optimizing it away
   is explicitly out of scope.

## What was built (baseline)

1. **Contracts** — `AgentResultV1.usage` extended with optional
   `cachedInputTokens`/`cacheWriteTokens` (absence = not reported; Python
   worker schema resources synced byte-for-byte).
2. **ContextBundle identity** (`domain/context-bundle.ts`) — canonical
   SHA-256 fingerprint over deterministic projection inputs; no random
   invocation ids/timestamps; bounded metrics; session vocabulary
   (`fresh/reused/resumed/unknown`); immutable
   `InvocationEfficiencyEvidenceV1` + strict parse.
3. **Context Projection Reuse** (`executors/context-projection-cache.ts`) —
   the ONE optimization: bounded in-memory content-addressed envelope cache,
   fail-closed by content identity, never authority.
4. **Claim-time wiring** (`execution.service.ts`) — one frozen executor
   snapshot per claim; bundle identity computed before materialization;
   MISS materializes + stores, HIT reuses the immutable envelope; every
   authority gate (capability, policy, budget, deadline, connection
   claim/revocation) executes identically on hit and miss; efficiency
   record written on every attempt (4 creation sites + legacy helper).
5. **Completion wiring** (`result-inbox.service.ts`) — efficiency completed
   with ACTUAL observed usage + terminal timing atomically with the terminal
   attempt transition.
6. **Projection** — Workbench per-attempt + aggregate efficiency;
   Capsule attempts carry the frozen efficiency evidence.
7. **UI** — one bounded "Efficiency" tab on the run detail page (aggregate
   cards + per-attempt table; "Not reported by runtime" for missing usage).
8. **Deterministic dogfood** (`p3-context-dogfood.integration.spec.ts`) —
   real Postgres + real engine + real deterministic in-process HTTP worker:
   run 1 MISS → run 2 HIT (identical envelope + hash) → mutated load-bearing
   input → MISS + new fingerprint; policy DENY after cache population still
   blocks (cache HIT recorded, no outbox); budget reservation on HIT;
   expired deadline still blocks; Capsule + Workbench reconstruction exact.

## Verification (final numbers)

- Focused: `context-bundle.spec.ts` 10/10 · `context-projection-cache.spec.ts`
  5/5 · `p3-context-dogfood.integration.spec.ts` 1/1 (Postgres).
- `pnpm test:all` green (orchestrator 763 passed / 367 documented skips;
  contracts 65/65; worker 199/199; local-executor-host 49/49; gateway 4/4;
  frontend 30/30; observability 5/5; code-reviewer 11/11).
- Real PostgreSQL integration suite twice: 1120 passed each (10 live-gate
  skips, opt-in only).
- `pnpm build:all` green (incl. `next build`); frontend lint + typecheck
  green.
- `pnpm test:docs` 20/20; `pnpm verify:docs` passed (141 Markdown files,
  339 links, 81 current, 60 historical, 46 capabilities).
- `pnpm test:identity` 25/25; `pnpm verify:identity` 0 violations.
- Python worker: schema sync check 5/5 in sync; pytest 261 passed.
- `pnpm self-hosted:contract-test` 42/42; `pnpm self-hosted:recovery-test`
  17/17 (disposable stack, new migration `1722270020000-P3ContextBundle`
  included); `git diff --check` clean.
- Hosted CI requires no paid provider credentials
  (`TENVYR_LIVE_RUNTIME_GATES: "0"`).

## Known limitations

- Projection cache is process-local/disposable; restart = empty cache
  (durability lives in PostgreSQL attempts + Capsule).
- Artifact resolution still executes per claim (load-bearing fingerprint
  input + live exposure edges).
- Workspace dirty CONTENT is not hashed (dirty flag participates;
  documented tradeoff, no repo-wide scans).
- Coordination worker inputs remain planner-authored; the ContextBundle
  covers the context-envelope projection path only (documented follow-up:
  planner-authored inputs / verifier aggregation).
- Full runtime session reuse is NOT implemented (vocabulary only; all
  current invocations are single-shot FRESH/UNKNOWN).
- Usage evidence appears only when a runtime reports it; Tenvyr never
  infers provider cache hits from ContextBundle matches.

## Non-goals honored

No agent result cache, no worker-result reuse, no semantic answer cache, no
generic memory system, no vector DB, no LLM summarization, no provider KV
cache ownership, no analytics dashboard, no new agent runtime, no promotion
of developer tooling (rtk-compress/CodeGraph/skills) into execution.