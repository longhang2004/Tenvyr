---
title: "P3 SPEC: Runtime Harness Optimization & Context Efficiency — bounded baseline"
status: planned
audience:
  - developer
last_verified: 2026-08-16
sources:
  - docs/plans/active/tenvyr-productization-roadmap/P3-runtime-harness-optimization/PLAN.md
---

# P3 SPEC — behavioral contract

## §0 Acceptance

The following must hold after the slice:

1. For every attempt (claim-time), a bounded immutable
   `InvocationEfficiencyEvidenceV1` is recorded on the attempt row covering:
   invocationId; contextBundle `{hash, reused}` (null when the invocation has
   no Tenvyr context envelope); bounded harness identity (agent, executor
   kind, configHash, connectionId/revision, requestedModelId when present);
   workspace structural identity when the execution belongs to a coordinated
   run with a frozen workspace; bounded context metrics when a projection
   exists; session mode; usage `{reported:false}` at claim; timing.
2. `ContextBundleV1` identity = canonical SHA-256 over deterministic inputs:
   bundle schema version, context schema version, selected state values +
   state version, resolved artifact references, harness identity, plan hash,
   workspace structural identity (when applicable). Random invocation IDs,
   timestamps, attempt ids, and workspace `capturedAt` NEVER participate.
   The fingerprint is a provenance/optimization primitive, NOT execution
   authority.
3. Context Projection Reuse: identical deterministic projection inputs →
   identical hash → the already-materialized immutable envelope is reused
   (deep-cloned to callers). A MISS performs the normal non-cache path and
   yields identical semantic output. All authority gates (deadline, policy,
   budget, connection claim/revocation, capability negotiation) execute on
   every claim regardless of hit/miss. Cache failure is fail-closed: no
   stale envelope can ever be served under a different hash, and process
   restart simply starts an empty cache.
4. Usage evidence: `cachedInputTokens`/`cacheWriteTokens` are supported by
   the `AgentResultV1.usage` contract as OPTIONAL integers. Absence means
   NOT REPORTED — never zero. A ContextBundle hash match never implies
   provider cache evidence; the two are recorded separately
   (`contextBundle.reused` vs observed usage numbers).
5. Operator projection exposes: per-attempt Context projected (bytes/items/
   artifacts + bundle short hash), bundles reused, provider cached-input
   evidence when the runtime reported it ("Not reported by runtime"
   otherwise), session mode, runtime duration. No raw prompts/context/usage
   fabrication.
6. Capsule: historical execution reconstructs the recorded bundle identity
   and efficiency evidence from the frozen attempt rows (no cache needed).
7. Deterministic dogfood proves MISS → HIT → mutation → MISS and
   authority-after-cache; no real provider credentials.
8. Telemetry safety: efficiency telemetry never contains raw prompts,
   chain-of-thought, credentials, token values, or arbitrary tool output —
   only hashes, sizes, counts, ids, bounded status, observed usage numbers,
   and the bundling metadata.

## §1 ContextBundleV1 identity algorithm

```
inputs := {
  bundleSchemaVersion: 1,
  contextSchemaVersion: 1,           # the frozen Tenvyr context envelope schema
  stateProjection: { version, values },  # values = exactly the selected state keys,
                                         # isolated clones, lexicographic key order
  artifacts: [ArtifactContextReference], # canonical resolved references
  harness: { agent, executorKind, configHash,
             connectionId?, connectionRevision?, requestedModelId? },
  planHash: string,                  # active immutable plan revision hash
  workspace?: { workspaceId, branch, headSha, dirty }   # when applicable
}
hash := SHA-256(canonicalJson(inputs))
```

`canonicalJson`/`sha256Json` are the repository-standard utilities
(`domain/canonical-json.ts`). Ordering is canonical; identical semantic
inputs with different caller ordering produce identical hashes.

## §2 Context Projection Cache

- Content-addressed map `hash -> { envelope, metrics }`, in-memory, bounded
  (entry cap + total envelope-bytes cap), process-local, no TTL-primary
  invalidation. Correctness never depends on the cache; PostgreSQL attempts
  and the Capsule are the durable record.
- Invalidation is by content/version identity: any change to the
  deterministic inputs changes the hash and misses. Workspace
  clean↔dirty transitions change the hash (fail-closed). Dirty file content
  is not scanned/hashed (documented tradeoff — no production path projects
  file bytes into the envelope).
- On HIT the exposure edges for previously resolved artifact references are
  re-derived from the cached envelope's references (same-execution, same
  artifact ids by hash equality), so append-only exposure evidence is
  preserved without re-querying.
- The cache NEVER stores or supplies: approvals, revocation state, budgets,
  deadlines, policy authority, plan authority, health, auth readiness.

## §3 Session strategy vocabulary

`SESSION_MODES = ["fresh", "reused", "resumed", "unknown"]`.

Current truthful behavior: every runtime invocation is a new single-shot
non-interactive process (codex `exec --ephemeral`, claude `-p`, opencode
`run`); no session flags exist. Claims that create a dispatchable outbox
record `fresh`; pre-dispatch terminal/WAITING attempts record `unknown`
(no runtime session was established). Full session reuse is NOT implemented.

## §4 Evidence schema

```text
InvocationEfficiencyEvidenceV1 {
  schemaVersion: 1
  invocationId: string
  contextBundle: { hash: string; reused: boolean } | null
  harness: { agent, executorKind, configHash, connectionId?, connectionRevision?, requestedModelId? }
  workspace?: { workspaceId, branch, headSha, dirty }
  context: { projectedBytes, projectedCharacters, selectedContextItemCount,
             selectedArtifactCount, executionStateBytes } | null
  session: { mode: "fresh"|"reused"|"resumed"|"unknown" }
  usage: { reported: boolean; inputTokens?, outputTokens?,
           cachedInputTokens?, cacheWriteTokens? }
  timing: { startedAt: string; completedAt: string|null; durationMs: number|null }
}
```

`usage.reported` is false at claim; result acceptance completes the record
with the ACTUAL `AgentResultV1.usage` numbers (only when the runtime reported
usage) and terminal timing, in the same transaction as the terminal attempt
transition. Absent usage fields stay absent.

## §5 Harness profile (design-only)

`HarnessProfileV1` is intentionally NOT built as a system. The frozen harness
identity inside each evidence record (agent, executor kind, config hash,
connection revision, requested model) is the immutable per-execution harness
boundary; a larger profile system (contextProjectionPolicy,
stableInstructionsRevision, nativeSkillRefs, sessionStrategy,
outputCompactionPolicy) is a future design only, documented in
`docs/architecture/executors/invocation-efficiency.md`.

## §6 Telemetry safety

Efficiency telemetry contains only: hashes, byte/char sizes, counts, ids,
bounded status strings, observed bounded usage numbers, and workspace
structural identity. Never: raw prompts, chain-of-thought, credentials,
API keys, OAuth tokens, full tool output, sensitive environment values.