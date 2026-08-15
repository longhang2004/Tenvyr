---
title: "P2 Plan: Runtime Model Sources + Model Selection + Auth UX"
status: planned
audience:
  - product
  - developer
  - operator
last_verified: 2026-08-15
sources:
  - docs/architecture/executors/runtime-connections.md
  - docs/architecture/workbench.md
  - services/orchestrator/src/domain/coordination.ts
  - services/orchestrator/src/services/workbench-command.service.ts
  - services/orchestrator/src/executors/executor-descriptor.ts
  - services/local-executor-host/src/main.ts
  - frontend/src/app/runtimes/page.tsx
---

# P2 Runtime Model Sources + Model Selection plan

## Problem being solved

The Runtime UI can display "Authentication: Sign-in required" while the
connection test shows "READY" for the same connection. Root cause: the
connection test response is nested under the Workbench command result
(`data.result.receipt`), but the frontend reads `res.data.status || res.data.state`
and falls through to a fabricated `"READY"` literal. The fix is a typed DTO +
runtime guard; `READY` must never be invented (missing/malformed server state
renders as an error). Beyond the bug, model choice is not frozen execution
configuration today: a run cannot reconstruct which model a role requested.

## Existing capabilities reused

- Immutable Runtime Connections + revisions + claim freezing (M8).
- Frozen `CoordinationConfigV1` allowlists + `validateTaskBatchProposal` (M9).
- `metadata.tenvyrConnectionId` step typing → attempt claim (M9-S3/M8-S6).
- `ExecutorDescriptorV1` frozen secret-free descriptor + `AgentInvocationV1`
  wire contract (M3/M8) — `connection` triple precedent.
- Local Executor Host fail-closed binding validation (M8-S6).
- Workbench `runCommand` idempotent audited command layer (M10).
- `cli-probe.ts` bounded spawn/escalation (M8-S3).
- Backup inventory contract (`scripts/self-hosted/anchors.mjs` + contract test).

## Design decisions (bounded)

1. **Model identity is data, not argv.** Model IDs are bounded strings
   (`/^[A-Za-z0-9][A-Za-z0-9._/\-:@+]*$/`, ≤256 chars). The runtime-specific
   argv prefix (`--model`) is FIXED operator configuration on the host
   (`modelArgvPrefix`), never pipeline input. The host composes
   `[...fixedArgs, ...modelArgvPrefix, modelId]` — fixed argv separation, no
   shell. No model → argv unchanged (Runtime default).
2. **Frozen target flow:** operator config (`plannerTarget` / `verifierTarget` /
   `allowedTargets`) → Planner task `modelId` (allowlist-validated) → step
   `metadata.tenvyrModelId` → claim-time `ExecutorDescriptorV1.requestedModelId`
   → invocation `requestedModelId` → host argv. Retries and replays reuse the
   frozen descriptor; a later catalog refresh can never rewrite history.
3. **Planner authority:** a Planner task may only use `allowedTargets`
   entries (connectionId + modelId). Connection-only emission resolves
   deterministically only when that connection has exactly one allowed
   target (or zero model entries — legacy behavior). Two+ models for one
   connection without a Planner modelId → DENIED. `plannerTarget`/
   `verifierTarget` freeze the Coordinator-owned role models.
4. **Model Sources:** one authoritative `model_sources` table (operator
   config: sourceId/kind/displayName/baseUrl/credential env REF only/status/
   lastTestedAt/lastCatalogRefreshAt). Catalogs are NON-authoritative
   projections: fetched on demand, bounded, never persisted as authority —
   no catalog table, no revisions table (attempts never reference a source
   revision; the frozen target is connection+modelId).
5. **Discovery per runtime (primary docs re-fetched 2026-08-15):**
   - OpenCode (first-class): `opencode models [provider]`, `opencode models
     --refresh`, `opencode auth list` — bounded CLI output parsing; never
     reads `~/.local/share/opencode/auth.json`.
   - Codex: `--model` documented invocation option; `codex debug models`
     experimental catalog = BEST-EFFORT only; execution never depends on it.
   - Claude: `--model` documented; no model-list CLI — manual entry /
     Runtime default.
   - 9Router: optional source, `GET {baseUrl}/models` OpenAI-compatible,
     default candidate `http://localhost:20128/v1`, bearer env ref only.
   - Generic OpenAI-compatible: same client, auth none | bearer env ref.
6. **Auth UX:** guided official commands only (`codex login`,
   `claude auth login`, `opencode auth login`) rendered as
   "Run: <command> [Copy Command] [Check Again]". No terminal proxy, no
   credential capture, no OAuth integration invented. OpenCode providers via
   `opencode auth list`; 9Router via "[Open 9Router Dashboard]" + refresh.
7. **Test Runtime / Test Model Source / Test Runtime Target** are distinct
   semantics; target tests only run on explicit operator request with a
   credit-consumption warning, THROUGH the runtime adapter.
8. **SSRF:** model-source endpoints are single-owner operator config;
   http/https only, no embedded credentials, bounded URL length, strict
   timeouts, bounded response bytes/count/id length, redirects re-validated
   per hop, no credential values in logs/errors. Documented in
   `docs/architecture/model-sources.md`.

## Work slices

1. Contract bug fix: frontend typed DTOs + guard + regression (AUTH_REQUIRED
   → AUTH_REQUIRED, malformed → error, never READY).
2. Coordination domain: `RuntimeTargetRefV1`, `allowedTargets`,
   `plannerTarget`/`verifierTarget`, `TaskProposalV1.modelId`, validation
   (MODEL_NOT_ALLOWED), deterministic single-model resolution,
   `compileIterationPlanPatch` + `createPlannerStep` metadata.
3. Attempt claim: `ExecutorDescriptorV1.requestedModelId` (parse + bounds),
   `stepModelIdOf`, invocation `requestedModelId` (contracts schema + types +
   validation + conformance + python-worker sync).
4. Host: `modelArgvPrefix` config, fail-closed binding extension, argv
   composition, tests.
5. Model Sources: entity + migration + inventory (33 tables) + audited
   command surface + controller + gateway proxy.
6. Discovery: bounded CLI runner reuse, OpenCode first-class, Codex
   best-effort, 9Router/generic OpenAI-compatible client, fake-server tests.
7. Frontend: `/runtimes` IA (Agent Runtimes | Model Sources), sign-in
   guidance, `RuntimeTargetPicker`, `/runs/new` targets, review step,
   attempt/capsule requested-model display.
8. Deterministic dogfood: Postgres e2e with distinct models per role through
   the REAL local executor host + fake children; authz denials.
9. Docs: runtime-connections.md, workbench.md, supervised-coding-team.md,
   model-sources.md (new), user-manual EN/VI, README,
   implementation-status, RESEARCH_REGISTER recheck, EXECUTION_STATUS receipt.

## Bounds kept

No new dependencies. No shell. No credential values in any persisted or
returned shape. `READY` never fabricated. All live-runtime gates stay
env-gated; CI needs no paid credentials.
