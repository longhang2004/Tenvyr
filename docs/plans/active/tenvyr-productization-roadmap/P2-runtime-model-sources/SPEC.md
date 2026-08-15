---
title: "P2 Spec: Runtime Model Sources + Model Selection + Auth UX"
status: planned
audience:
  - developer
last_verified: 2026-08-15
sources:
  - services/orchestrator/src/domain/coordination.ts
  - services/orchestrator/src/executors/executor-descriptor.ts
  - packages/contracts/src/types.ts
  - services/local-executor-host/src/config.ts
  - frontend/src/lib/tenvyr-api/types.ts
---

# P2 Runtime Model Sources spec

## 0. Contract fix (mandatory first)

Backend (orchestrator → gateway, verbatim): `POST /api/connections/:id/test`
→ `{ success, data: { action, idempotencyKey, outcome, result:
{ connectionId, receipt: { revisionNumber, testedAt, state, reasonCode,
durationMs, testedVersion?, superseded? } } } }`.

Frontend MUST parse `data.result.receipt` with a typed guard. Missing or
malformed server state → error "Unknown / malformed response", never
"READY". Status enums exhaustive:

```ts
export const CONNECTION_STATUS_STATES = ["DRAFT","AVAILABLE","AUTH_REQUIRED","UNAVAILABLE","DEGRADED","REVOKED"] as const;
export const CONNECTION_TEST_STATES = CONNECTION_STATUS_STATES; // receipt state
```

Regression: backend receipt `state: "AUTH_REQUIRED"` → UI shows AUTH_REQUIRED.

## 1. Coordination domain (`domain/coordination.ts`)

```ts
export type RuntimeTargetRefV1 = {
  connectionId: string;      // must match CONNECTION_ID_PATTERN
  modelId?: string;          // MODEL_ID_PATTERN, <= 256 chars
};
export const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/\-:@+]*$/;
export const MODEL_ID_MAX_LENGTH = 256;
```

`CoordinationConfigV1` gains optional (schemaVersion stays 1; strict parse
ignores unknown keys, so stored configs stay valid):

```ts
plannerTarget?: RuntimeTargetRefV1;    // valid only when planner.kind === "connection" AND name === plannerTarget.connectionId
verifierTarget?: RuntimeTargetRefV1;   // same constraint vs verifier
allowedTargets?: RuntimeTargetRefV1[]; // <= maxAllowedWorkers entries; every entry's connectionId must appear in allowedWorkers
```

`TaskProposalV1` gains optional `modelId` (bounded, pattern-validated).

`validateTaskBatchProposal` (new `MODEL_NOT_ALLOWED` error code):
- task.connectionId + task.modelId → must exactly match an `allowedTargets`
  entry (same connectionId AND same modelId). No allowedTargets entry →
  DENIED.
- task.connectionId only → allowed iff that connection has 0 matching
  allowedTargets entries (legacy unrestricted) OR exactly 1 (deterministic
  resolution — the frozen target is that model). 2+ → DENIED with a message
  telling the Planner to specify a model.
- task.modelId without task.connectionId → DENIED.
- Existing agent/connection allowlist checks unchanged.

`compileIterationPlanPatch`:
- worker step: `metadata.tenvyrModelId = task.modelId ?? resolvedSingle(targets)`
  (deterministic single-model resolution applied at compile time so the step
  freezes the resolved model too).
- verifier step: `metadata.tenvyrModelId = config.verifierTarget.modelId`
  when kind connection and modelId present.

`runtime-coordination.service.ts` `createPlannerStep`: planner step
`metadata.tenvyrModelId = config.plannerTarget.modelId` when kind connection.

## 2. Claim + descriptor

`executor-descriptor.ts`: `ExecutorDescriptorV1.requestedModelId?: string`
(parse: MODEL_ID_PATTERN + ≤256, `DESCRIPTOR_KEYS` extended).
`execution.service.ts`: `stepModelIdOf(stepConfig)` reads
`metadata.tenvyrModelId` (bounded); `resolveAttemptSnapshot` accepts it and
freezes `descriptor.requestedModelId`. Retry/redelivery reuse the frozen
descriptor; a later catalog refresh cannot rewrite it.

## 3. Wire contract

`AgentInvocationV1` gains optional `requestedModelId` (same pattern/bounds),
first-class like M8 `connection`: `packages/contracts/src/types.ts`,
`validation.ts`, `contracts/schemas/agent-invocation.v1.schema.json`
(`additionalProperties: false` objects), conformance fixtures, and
`python scripts/sync-python-worker-schemas.py` (schema JSON copy).

## 4. Local executor host

`HostAgentConfig.modelArgvPrefix?: string[]` (fixed argv elements, bounded
like args). `validateInvocationBinding` extension (all fail closed before
spawn):
- invocation carries `requestedModelId` but host declares no
  `modelArgvPrefix` → refuse (EXECUTOR_HOST_MODEL_ARG_UNSUPPORTED).
- modelId fails pattern/length → refuse (EXECUTOR_HOST_MODEL_ID_INVALID).
- `superviseProcess` argv = `[...profile.args, ...(modelArgvPrefix ?? []),
  modelId]` when both present; otherwise `profile.args` unchanged. Evidence:
  fake children record exact argv; tests assert composition per runtime.

## 5. Model sources

Entity `model_sources` (authoritative; joins backup inventory → 33 tables):

```ts
sourceId: string (PK, ^[A-Za-z0-9_.:-]{1,128}$)
kind: "opencode" | "ninerouter" | "openai-compatible"
displayName: string (<= 255)
baseUrl?: string (http/https only, no userinfo, <= 2048; required for ninerouter/openai-compatible)
credentialEnvRef?: string (ENV_NAME_PATTERN; REFERENCE ONLY, never a value)
status: "UNKNOWN" | "AVAILABLE" | "AUTH_REQUIRED" | "UNAVAILABLE" | "DEGRADED"
lastTestedAt?: string; lastCatalogRefreshAt?: string
createdAt, updatedAt: string
```

No `model_source_revisions` (no attempt ever references a source revision)
and NO catalog table (catalogs are on-demand bounded projections). Mutations
go through the audited `runCommand` layer (`model-source-create/update/
delete/test/refresh`), mirroring connections.

Catalog snapshot (non-authoritative, never persisted):

```ts
ModelCatalogSnapshotV1 = { sourceId, discoveredAt, models: [{ modelId, displayName?, providerId?, source }] }
```

`modelId` here is data from the source; Tenvyr validates pattern/length,
dedupes, bounds count (≤5000), and treats it as a discovery projection only —
selection authority stays Tenvyr.

Discovery:
- `opencode`: bounded `opencode auth list` (authenticated providers only:
  parse provider names; never persist/echo auth output) + `opencode models
  [provider]` (parse `provider/model` lines) + `opencode models --refresh`.
  NEVER reads `~/.local/share/opencode/auth.json`.
- `codex` (best-effort): `codex debug models` bounded JSON parse; failure →
  empty catalog (manual entry / Runtime default); execution never depends on it.
- `claude`: no discovery (no documented model-list CLI) → manual entry.
- `ninerouter` / `openai-compatible`: `GET {base}/models`, optional
  `Authorization: Bearer <env-ref value>` resolved at request time only;
  strict timeout (10s), response ≤ 1MB, models ≤ 5000, id ≤ 256, redirects
  re-validated (http/https only), no userinfo in URL, no credential values
  in logs/errors. Normalization: base `https://example.com/v1` →
  `GET https://example.com/v1/models` (path join, no interpolation).

## 6. Runtime onboarding / auth UX

`RuntimeOnboardingStatusV1` gains `loginCommand: string | null` (official
fixed command: `codex login`, `claude auth login`, `opencode auth login`)
from the templates. Frontend: [Sign in] → shows "Run: <command>" +
[Copy Command] + [Check Again] (re-probe). No terminal proxy, no credential
capture, no invented OAuth. OpenCode: [Connect Provider] → same pattern with
`opencode auth login`; providers from `opencode auth list` shown as
authenticated. 9Router: [Open 9Router Dashboard] (baseUrl origin) + [Refresh
Models].

## 7. Frontend

- Typed DTOs + guards in `frontend/src/lib/tenvyr-api/` (types.ts, guards.ts).
- `/runtimes`: tabs "Agent Runtimes | Model Sources". Runtime cards show
  Installed/Authentication/Connection/Default Model + [Test Runtime] [Models]
  [Manage]. Source cards show Detected/Authentication/Endpoint/Models count/
  Last refreshed + [Refresh Models] [Test Source] [Open 9Router].
- `RuntimeTargetPicker`: Runtime select + searchable Model select
  (provider/group labels), "Runtime default" option, loading state, stale
  catalog indicator, Refresh, unavailable state, manual model ID entry.
  Never silently changes a selection after refresh.
- `/runs/new`: Planner/Verifier = one target each; Workers = multi-select
  targets; review step displays the EXACT target per role; payload carries
  `plannerTarget`/`verifierTarget`/`allowedTargets`.
- Run detail + Capsule: per-step "requested model"; when the attempt result
  output carries a validated `observedModelId`, show it separately
  ("observed model"); otherwise no observed claim (router upstreams show
  "actual upstream: Not observed").

## 8. Storage / inventory

Migration `1722270019000-ModelSources` (model_sources + immutability of
credential refs enforced by domain parse; no trigger needed beyond
connections pattern). Register entity in `database.provider.ts`. Add
`model_sources` to `anchors.mjs` TABLES, contract test `32` → `33`, update
"N-table" doc mentions, restore/recovery E2E re-run in CI.

## 9. Security checklist

Raw API keys never persisted/returned/logged; env refs only; bounded remote
responses; strict timeouts; no shell; URL validation; SSRF documented
(single-owner operator feature, External Production Exposure Gate stays
open); no reading runtime credential files; no OAuth proxy; model IDs are
data with fixed argv separation; no fallback engine (runtime-internal
fallback documented as outside Tenvyr's selection authority).
