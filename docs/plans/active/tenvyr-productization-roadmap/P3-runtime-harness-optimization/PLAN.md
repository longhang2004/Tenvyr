---
title: "P3 Plan: Runtime Harness Optimization & Context Efficiency — bounded baseline"
status: planned
audience:
  - developer
last_verified: 2026-08-16
sources:
  - docs/plans/active/tenvyr-productization-roadmap/P3-runtime-harness-optimization/GOAL.md
---

# P3 Plan: bounded Invocation Efficiency / Context Projection baseline

## Architecture map (audited from code, 2026-08-16)

Real context path for a runtime invocation:

```text
Execution / Coordination
        ↓
LogicalStep / Attempt (claim under the execution lock)
        ↓
ContextProjection (pipeline step config; M2C validateContextProjection)
        ↓
materializeProjectedContext → ArtifactProjectionResolver + materializeContextSnapshot
        ↓   (immutable TenvyrContextEnvelope, ≤ 65,536 canonical UTF-8 bytes)
StepAttempt.contextSnapshot (jsonb) + DispatchOutbox.invocation.context (same envelope, atomic)
        ↓
ExecutorDescriptorV1 frozen at claim (agent/kind/configHash/connection/revision/requestedModelId/localProfile)
        ↓
AgentInvocationV1 (HTTP adapter / local executor host; CLI argv fixed operator config)
        ↓
Codex / Claude / OpenCode / generic runtime (child stdin receives the canonical invocation verbatim)
```

- Where context is selected: claim-time `materializeProjectedContext`
  (`services/orchestrator/src/services/execution.service.ts`), under the
  execution row lock.
- Where it is materialized/serialized: `materializeContextSnapshot`
  (`domain/context-snapshot.ts`); the SAME envelope is persisted on the
  attempt row and embedded in the outbox invocation atomically.
- Is the same context rebuilt multiple times? YES — every attempt re-runs
  artifact resolution + envelope construction + the 65,536-byte validation
  pass, even when the deterministic inputs are identical.
- Deterministic inputs: selected state values + state version + resolved
  artifact references + context schemaVersion + projection validation; key
  order is canonicalized by `materializeContextSnapshot`.
- Runtime-specific prompt/input construction: NONE in Tenvyr — the local
  executor host composes fixed argv (operator config + `--model` prefix) and
  passes the canonical invocation JSON on child stdin; codex/claude/opencode
  decide how to use it. No AGENTS.md/CLAUDE.md/rules reading in Tenvyr code.

## Cache boundary classification

- SAFE deterministic reuse: immutable context envelope, resolved artifact
  references, content hashes, workspace structural identity
  (workspaceId/branch/headSha/dirty), plan hash, frozen harness identity.
- CONDITIONAL runtime reuse: runtime session reuse, provider prompt cache
  evidence, runtime-native memory/session handles — recorded truthfully,
  never assumed.
- FORBIDDEN authority cache: approval state, connection revocation, budget
  remaining, deadline, policy authority, active plan revision, runtime/
  provider health, auth readiness. The projection cache only ever holds the
  immutable envelope; every authority gate (policy → budget → deadline →
  connection claim/revision → dispatch) executes on every claim regardless
  of cache hit/miss.

## Slices

1. Contracts: extend `AgentResultV1.usage` with optional
   `cachedInputTokens`/`cacheWriteTokens` (absence = not reported; never
   synthesize zero); sync Python worker schema resources.
2. Domain: `ContextBundleV1` identity algorithm (canonical SHA-256),
   `SessionModeV1` vocabulary (fresh/reused/resumed/unknown), bounded
   `ContextMetricsV1`, immutable `InvocationEfficiencyEvidenceV1` record +
   strict parse, usage extraction from `AgentResultV1.usage`.
3. Projection cache: bounded in-memory content-addressed
   `ContextProjectionCache` (LRU-ish, bytes-capped) — the ONE optimization.
4. Claim-time wiring: bundle identity computed from canonical deterministic
   projection inputs; cache MISS → normal materialization + store, HIT → the
   already-materialized immutable envelope (deep-cloned), with authority
   gates unchanged; efficiency record written on every attempt (bundle
   null for non-projection invocations).
5. Completion wiring: result acceptance completes the efficiency record with
   observed usage + timing in the same transaction as the terminal attempt
   transition.
6. Projection: Workbench per-attempt + aggregate efficiency; Capsule attempts
   carry the frozen efficiency evidence.
7. UI: one bounded "Efficiency" tab on the run detail page.
8. Deterministic no-paid-provider dogfood: same immutable context, twice →
   MISS then HIT, identical envelope + hash, authority still enforced after
   cache population, one mutated load-bearing input → MISS + new fingerprint.
9. Docs/status: plan set, architecture doc, implementation-status, execution
   status receipt.

## Dogfood fixture design

Real Postgres + real engine claim/dispatch + real in-process deterministic
HTTP workers (same pattern as the Phase 1 dogfood). No paid provider, no
credentials. Assertions: run 1 cached-bundle MISS; run 2 same inputs HIT with
byte-identical envelope and identical hash; policy DENY after cache
population still blocks (durable FAILED attempt, no outbox); state-value
mutation → MISS + new fingerprint; usage reported by the deterministic worker
appears as observed usage (never zero when absent); Capsule reconstruction
reproduces the recorded bundle identity + evidence.

## Non-goals (explicit)

- No full runtime session reuse implementation (vocabulary only; every
  current invocation is single-shot → truthful FRESH / UNKNOWN).
- No rtk-compress wiring into production; the raw-result → evidence / bounded
  projection → agent context boundary already exists (result inbox vs
  context envelope) and is documented, not re-implemented.
- No giant analytics dashboard, no new tables beyond one jsonb column on the
  existing attempts table, no Redis, no TTL-primary invalidation.
- Workspace dirty-state: NO full-repo scan. `dirty` participates in the
  fingerprint (fail-closed on clean↔dirty transitions); dirty file CONTENT is
  not hashed because no production path projects workspace file bytes into
  the context envelope. Documented tradeoff.