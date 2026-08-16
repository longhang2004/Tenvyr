---
title: Model Sources and Runtime Targets
status: current
audience:
  - developer
  - operator
last_verified: 2026-08-15
sources:
  - services/orchestrator/src/executors/model-source.ts
  - services/orchestrator/src/services/model-source.service.ts
  - services/orchestrator/src/services/model-discovery.service.ts
  - services/orchestrator/src/domain/coordination.ts
  - services/orchestrator/src/executors/executor-descriptor.ts
  - services/local-executor-host/src/supervisor.ts
  - packages/contracts/src/types.ts
---

# Model Sources and Runtime Targets (P2)

## Product model

Three distinct concepts, never conflated:

1. **Runtime Connection** — which agent runtime/executor executes the work
   (`conn:codex`, `conn:claude`, `conn:opencode`, generic CLI). Owned since
   M8; immutable revisions, secret-free.
2. **Model Source** — where Tenvyr may safely DISCOVER model identifiers for
   a runtime: an OpenCode CLI catalog, a 9Router endpoint, or a generic
   OpenAI-compatible endpoint. A source is NOT inference authority: Tenvyr
   never sends inference requests through it, never stores provider
   credentials (only environment REFERENCES), and treats every catalog as a
   bounded non-authoritative projection.
3. **Runtime Target** — the usable unit selected for Planner / Worker /
   Verifier roles: `{ connectionId, modelId? }` (absent model = Runtime
   default). Model selection authority stays Tenvyr.

## Model selection is execution provenance

```text
operator selects model M
  -> Tenvyr validates M against the frozen target/source (allowedTargets)
  -> M becomes frozen execution configuration (step metadata.tenvyrModelId)
  -> attempt claim freezes ExecutorDescriptorV1.requestedModelId
  -> invocation carries requestedModelId (wire contract)
  -> the executor host composes FIXED argv: [...args, ...modelArgvPrefix, M]
  -> Capsule/provenance can reconstruct requested M
```

Invariants:

- A retry reuses the frozen descriptor — a retry never silently switches
  models.
- A later catalog refresh or source deletion never rewrites historical
  attempts (verified by the phase-2 dogfood Postgres suite).
- Model aliases/routes may resolve differently externally; Tenvyr records
  the requested identifier EXACTLY (`requestedModelId`).
- An `observedModelId` is recorded ONLY when the runtime/worker itself
  reports it inside the bounded structured result — never fabricated. For
  router-backed sources the UI shows "actual upstream: Not observed".
- NO silent fallback in Tenvyr: `model A unavailable -> model B` never
  happens inside Tenvyr. External runtimes/routers may implement their own
  fallback; that fallback occurs inside the external runtime/router and is
  outside Tenvyr's direct model-selection authority (provenance keeps
  requested vs observed distinct).

## Coordination authority (domain/coordination.ts)

`CoordinationConfigV1` gains optional fields (schemaVersion stays 1; stored
configs stay valid):

- `plannerTarget` / `verifierTarget` — operator-frozen role targets. Valid
  only for connection-kind roles whose name equals the target's
  connectionId (a Planner can never route its own step onto another
  connection).
- `allowedTargets: RuntimeTargetRefV1[]` — the worker Runtime Target
  allowlist. Every entry's connectionId must already be an allowed
  connection worker.

`validateTaskBatchProposal` enforces:

- task `connectionId` + `modelId` must EXACTLY match an `allowedTargets`
  entry — `MODEL_NOT_ALLOWED` otherwise.
- connection-only emission is allowed only when that connection has 0
  allowed targets (legacy) or exactly 1 (deterministic resolution at plan
  compile via `deterministicWorkerModel`). Two or more allowed models
  REQUIRE the Planner to specify one — Tenvyr never chooses arbitrarily.
- `modelId` without `connectionId` is rejected at parse.

Model IDs are DATA: `/^[A-Za-z0-9][A-Za-z0-9._/\-:@+]*$/`, max 256 chars,
validated at every trust boundary (coordination parse, descriptor parse,
invocation schema, executor host).

## Model Source domain (model_sources table)

Authoritative operator configuration; joins the backup inventory (33
tables). Columns: sourceId, kind (`opencode | ninerouter |
openai-compatible`), displayName, baseUrl (http/https, no userinfo, bounded),
credentialEnvRef (environment variable NAME only — values never persist,
never return to the frontend, never log), status projection
(UNKNOWN/AVAILABLE/AUTH_REQUIRED/UNAVAILABLE/DEGRADED), lastTestedAt,
lastCatalogRefreshAt, modelCount (bounded projection metadata).

Catalogs are deliberately NOT persisted: they are bounded on-demand
projections (≤ 5000 models, ≤ 1 MiB response, ≤ 256 chars per id, strict
10 s timeout, redirects re-validated per hop). Mutations go through the
audited Workbench command layer (`model-source-create/update/delete/test/
refresh`).

### Discovery per runtime (official docs re-fetched 2026-08-15)

- **OpenCode (first-class)**: `opencode auth list` (authenticated providers,
  bounded first-column parse), `opencode models [provider]` (catalog lines
  in the documented `provider/model` format), `opencode models --refresh`.
  The auth file (`~/.local/share/opencode/auth.json`) is NEVER read; raw
  auth output is never persisted.
- **Codex (best-effort)**: `codex debug models` is experimental — bounded
  JSON parse; ANY failure yields an empty catalog (Runtime default / manual
  entry). Model execution never depends on this command.
- **Claude**: no model-list CLI exists in the current official docs —
  manual model ID entry / Runtime default only.
- **9Router / generic OpenAI-compatible**: `GET {baseUrl}/models` with
  optional `Authorization: Bearer <env-ref value>` resolved ONLY at request
  time. Normalization is a plain path join (`https://example.com/v1` →
  `https://example.com/v1/models`), no interpolation.

### 9Router integration

9Router is an OPTIONAL external router/model source. It owns upstream
provider login, OAuth, API keys, quota/fallback, and provider routing.
Tenvyr connects only to the operator-configured endpoint (default candidate
`http://localhost:20128/v1` — never assumed to exist) and reads its
OpenAI-compatible `/models` catalog. Tenvyr does NOT copy 9Router's
provider-account database, OAuth implementation, or routing. The UI offers
"[Open 9Router Dashboard]" (the configured base URL) and "[Refresh Models]".

## Invocation composition (executor host)

The host's agent config declares a FIXED `modelArgvPrefix` (e.g.
`["--model"]`) — operator configuration, never pipeline input. When the
invocation carries a validated `requestedModelId`, the composed argv is
`[...fixedArgs, ...modelArgvPrefix, modelId]` (model id is ONE bounded data
element — never concatenated, never shell-interpreted). Without a model the
argv is unchanged (Runtime default). The host FAILS CLOSED before spawn
when an invocation requests a model but the agent declares no
`modelArgvPrefix`, or when the model id is invalid.

## Security

- Raw API keys never persisted, returned, or logged; credential env refs
  only.
- Bounded remote responses, strict timeouts, no shell, endpoint URL
  validation (http/https only, no userinfo), redirects re-validated per hop.
- SSRF: model sources are a single-owner operator feature (the External
  Production Exposure Gate stays open); the operator configures the
  endpoint, and every fetch is bounded and fail-closed.
- No reading runtime credential files; no OAuth callback/token proxy; no
  invented login flows (guided official commands only: `codex login`,
  `claude auth login`, `opencode auth login` — rendered with Copy Command /
  Check Again, never executed or credential-captured by Tenvyr).
- Model IDs are data with fixed argv separation; no automatic model
  fallback engine.
