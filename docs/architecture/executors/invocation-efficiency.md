---
title: "Invocation Efficiency and Context Projection Baseline"
status: current
audience:
  - developer
  - operator
last_verified: 2026-08-16
sources:
  - services/orchestrator/src/domain/context-bundle.ts
  - services/orchestrator/src/executors/context-projection-cache.ts
  - services/orchestrator/src/services/execution.service.ts
  - services/orchestrator/src/services/result-inbox.service.ts
  - services/orchestrator/src/services/workbench-projection.service.ts
  - contracts/schemas/agent-result.v1.schema.json
---

# Invocation Efficiency and Context Projection Baseline

The P3 baseline makes every runtime invocation able to answer, from bounded
telemetry only (hashes, sizes, counts, ids, observed usage numbers):

```text
What exact bounded context bundle did this agent receive?
Was this Tenvyr context projection rebuilt or reused?
How large was it?
Which runtime/model executed it?
Was the runtime session fresh/reused/resumed?
Did the runtime/provider report any cache/token usage?
How long did execution take?
```

## ContextBundle identity (Deliverable A)

`ContextBundleV1` is the deterministic identity of the exact bounded context
projection supplied to one invocation. The fingerprint is SHA-256 (hex) over
the canonical serialization (`domain/canonical-json.ts`) of:

```text
bundleSchemaVersion (1)
contextSchemaVersion (1)            # the frozen Tenvyr context envelope schema
stateProjection { version, values } # exactly the selected state keys, isolated
                                    # clones, lexicographic key order
artifacts [ArtifactContextReference]  # canonical resolved references
harness { agent, executorKind, configHash, connectionId?, connectionRevision?,
          requestedModelId? }        # frozen at claim; secret-free
planHash                              # active immutable plan revision hash
workspace? { workspaceId, branch, headSha, dirty }   # coordinated runs only
```

Random invocation ids, timestamps, attempt ids, and workspace capture times
NEVER participate (they do not semantically alter the projected context). The
fingerprint is a provenance/optimization primitive, NOT execution authority.

## Context projection metrics (Deliverable B)

`ContextMetricsV1` measures the final context envelope reliably:
`projectedBytes` (canonical UTF-8 bytes — the same measure as the M2 65,536
byte bound), `projectedCharacters`, `selectedContextItemCount`,
`selectedArtifactCount`, and `executionStateBytes` (the full bounded
execution state the projection drew from). Tenvyr does NOT fabricate token
counts — it has no tokenizer/model semantics.

## Provider/runtime usage evidence (Deliverable C)

`AgentResultV1.usage` supports optional bounded integers:
`inputTokens`, `outputTokens`, `totalTokens`, `costUsd`, and (P3)
`cachedInputTokens` / `cacheWriteTokens`. Semantics:

- absence means NOT REPORTED — never synthesized zero;
- a ContextBundle hash match never implies provider cache evidence — Tenvyr
  reuse (`contextBundle.reused`) and provider cache evidence (observed usage
  numbers) are recorded separately;
- the budget ledger continues to consume only `totalTokens`/`costUsd`.

## Invocation efficiency evidence (Deliverable D)

`InvocationEfficiencyEvidenceV1` is an immutable bounded record on the
attempt row (`step_attempts.efficiency` jsonb — one column, no duplicate
execution table). Written ONCE at claim time, completed ONCE at result
acceptance (observed usage + terminal timing) in the same transaction as the
terminal attempt transition. Records carry: invocationId, contextBundle
`{hash, reused}`, frozen harness identity, workspace structural identity,
context metrics, session mode, usage, timing.

The Capsule and the Workbench projection reconstruct it from the frozen
attempt rows; nothing depends on the projection cache.

## Session strategy vocabulary (model only)

`fresh | reused | resumed | unknown`. Current truthful behavior: every
runtime invocation is a NEW single-shot non-interactive process (codex
`exec --ephemeral`, claude `-p`, opencode `run`); no session flags exist.
Claims that create a dispatchable outbox record `fresh`; pre-dispatch
terminal/WAITING attempts record `unknown`. Full runtime session reuse is
NOT implemented — this vocabulary establishes the measurable baseline.

## Context Projection Reuse (Deliverable F — the ONE optimization)

`ContextProjectionCache` is a bounded in-memory, content-addressed store of
already-materialized immutable context envelopes, keyed by the ContextBundle
hash. Identical deterministic projection inputs → identical hash → the
already-materialized projection is reused instead of rebuilding the
envelope + the 65,536-byte validation pass. Properties:

- deterministic, fail-closed by content identity: any load-bearing input
  change misses; no wall-clock TTL plays a correctness role;
- immutable: callers receive isolated deep clones;
- NOT authority: approvals, revocation, budget, deadline, policy, plan
  authority, health, and auth readiness NEVER enter the cache; every
  authority gate executes on every claim regardless of hit/miss;
- process-local and disposable: PostgreSQL attempts + Capsule are the
  durable record; a restart starts an empty cache;
- artifact resolution still executes per claim — resolved references are a
  load-bearing fingerprint input and exposure edges are built from live
  resolution.

Invalidation is by content/version identity: ContextSnapshot values/version,
workspace structural identity (including clean↔dirty transitions), plan
revision hash, artifact references, harness configuration, and the bundle
schema versions.

### Workspace dirty-state tradeoff

`dirty` participates in the fingerprint (a clean↔dirty transition misses,
failing closed). Dirty file CONTENT is NOT scanned/hashed per invocation: no
production path projects workspace file bytes into the context envelope, and
hashing the whole repository per claim is not acceptable. Documented
tradeoff; a future bounded dirty-state fingerprint needs measured evidence
first.

## Harness profile (design only)

`HarnessProfileV1` is NOT built as a system. The frozen harness identity in
each evidence record (agent, executor kind, config hash, connection
revision, requested model) is the immutable per-execution harness boundary.
A larger profile (contextProjectionPolicy, stableInstructionsRevision,
nativeSkillRefs, sessionStrategy, outputCompactionPolicy) is a future design
only; native runtime integration (Codex AGENTS.md/skills/hooks/sessions,
Claude Code CLAUDE.md/skills/hooks, OpenCode rules/skills/agents) is a later
mapping exercise and is NOT reimplemented here.

## Tool output compaction

`rtk-compress` and related scripts are developer-only tooling (see
`docs/development/tooling/output-compression.md`); nothing in the P3 slice
wires them into production. The production invariant their design suggests
already exists: raw worker output is preserved as evidence (`result_inbox`,
artifacts) while the bounded projection (`context.tenvyr` envelope, bounded
verifier aggregation) is what the agent receives. No LLM summarization was
added.

## Operator projection (Deliverable E)

The Workbench execution projection carries a bounded per-attempt
`efficiency` block and an execution-level aggregate (context projected
bytes, bundles reused/built, provider cached-input evidence attempts/hits,
runtime duration). The frontend run detail page shows an "Efficiency" tab.
Missing provider usage renders as "Not reported by runtime" — never zero.

## Explicit non-goals

- NO agent result cache / worker-result reuse / semantic answer cache (a
  previous agent result must never be presented as a newly executed worker;
  requires a separate future authority/provenance design);
- NO generic memory system (vector DB, embeddings, autonomous memory agent,
  knowledge graph);
- NO provider KV cache ownership; NO prompt-cache hit guarantee; Tenvyr
  only optimizes context CONSTRUCTION so native runtimes/providers can reuse
  stable prefixes where possible;
- NO analytics dashboard; NO new agent runtime; NO LLM summarization;
- coordination worker inputs remain planner-authored (no execution-state
  projection is added to the M9 worker path in this baseline — extending the
  bundle to planner-authored inputs / verifier aggregation is a follow-up).