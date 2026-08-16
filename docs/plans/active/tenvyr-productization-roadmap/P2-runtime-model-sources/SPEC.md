---
title: "P2 Spec: Runtime Model Sources + Model Selection + Auth UX"
status: planned
audience:
  - developer
last_verified: 2026-08-16
sources:
  - services/orchestrator/src/domain/coordination.ts
  - services/orchestrator/src/executors/executor-descriptor.ts
  - packages/contracts/src/types.ts
  - services/local-executor-host/src/config.ts
  - frontend/src/lib/tenvyr-api/types.ts
---

# P2 Provider Connections + Model Selection + Auth UX spec (final)

## 0. Product model and acceptance flow

**Runtime Connection → Provider Connection (runtime-owned) → Model → Runtime
Target.**

Acceptance flow: the operator opens the Runtime, sees the provider state of
the connection's CURRENT revision (structured), connects a provider (OAuth
completed in the provider's own UI, or a guided official command for API-key
providers), picks a model, freezes the target into an attempt, and the Capsule
shows the requested model per role.

## 1. Connection-scoped discovery contract

All discovery is CONNECTION-SCOPED:

- `discoverRuntimeProviders(connectionId)` → provider state
  (all/default/connected) for the connection's CURRENT revision, via ITS fixed
  secret-free profile. Two same-kind connections are fully independent.
- `refreshRuntimeModels(connectionId, providerId?)` → model catalog, using the
  documented `opencode models [provider]` CLI executed through the exact
  connection profile.
- `getRuntimeProviderAuthMethods(connectionId, providerId)` → structured auth
  methods.

Provider state is RUNTIME-OWNED. TUI output (`opencode auth list`) is NEVER
parsed; the auth file is NEVER read.

## 2. OpenCode Server API contract + session security

`opencode serve` is spawned on demand with STRICT session bounds:

- Bind 127.0.0.1 only; EPHEMERAL port; random `OPENCODE_SERVER_PASSWORD`
  (basic auth) generated per session, never reused, never logged.
- Endpoints used: GET /provider (all/default/connected), GET /provider/auth,
  POST /provider/{id}/oauth/authorize, POST /provider/{id}/oauth/callback.
- Strict timeouts and bounded response sizes on every call.
- DETERMINISTIC teardown after each operation: server killed, port released,
  session secrets wiped. No orphaned processes; no password in any log or
  persisted shape.

## 3. Provider Connect (OAuth + API key)

- OAuth providers: authorize → operator completes in the provider's OWN UI →
  callback → refresh. Tenvyr never persists tokens and never sees keys.
- API-key providers: guided official command only (runtime-owned) — documented
  limitation.
- Provider Connect / auth repair applies to EXISTING connections (Sign in /
  Check again / Advanced); it never creates connections. Connection state
  (Tenvyr) and runtime auth state are SEPARATE.

## 4. Provider-selectable-IFF-authenticated rule

- A provider is selectable as a Team Run target ONLY when it is authenticated
  in the connection's CURRENT revision's runtime state.
- Unauthenticated providers: picker shows them DISABLED; their models never
  appear; launch BLOCKS with an explanation if a selected target became
  unavailable (e.g. auth revoked mid-session).

## 5. Test Runtime Target semantics

A SMALL BOUNDED REAL INVOCATION through the actual runtime adapter, only on
explicit operator request:

- Bounds: 30s timeout, 64KB output cap, NO shell, exact connection-profile
  argv + `--model <id>`.
- Audited operator action with a credit-consumption warning.
- Failure is surfaced as failure — NEVER READY.
- Distinct from Check Authentication (structured state only) and Refresh
  Models (enumeration).

## 6. Runtime Target freeze (provenance unchanged)

`RuntimeTargetRefV1 { connectionId, modelId? }` → `TaskProposalV1.modelId`
(allowlist-validated, MODEL_NOT_ALLOWED) → step `metadata.tenvyrModelId`
(incl. deterministic single-model resolution) →
`ExecutorDescriptorV1.requestedModelId` at claim →
`AgentInvocationV1.requestedModelId` → host fixed argv
`[...profile.args, ...(modelArgvPrefix ?? []), modelId]` with fail-closed
binding. Retries/replays reuse the frozen descriptor; a catalog refresh never
rewrites history. Model IDs are bounded data
(`/^[A-Za-z0-9][A-Za-z0-9._/\-:@+]*$/`, ≤256), never shell input.

## 7. model_sources (advanced surface only)

`model_sources` = generic OpenAI-compatible catalog endpoints ONLY
(kind: `"openai-compatible"`). No runtime/provider catalog kinds; the
33-table backup inventory is unchanged.

- 9Router-as-generic-endpoint rule: an existing 9Router instance connects ONLY
  as a generic OpenAI-compatible endpoint (baseUrl + optional bearer env REF,
  advanced surface). No 9Router template, no first-class 9Router behavior.
- No-routing statement: Tenvyr contains NO routing/fallback/quota/rotation/
  alias logic; runtime-internal fallback is documented as outside Tenvyr's
  model-selection authority.
- Catalogs are non-authoritative bounded projections (never persisted as
  authority); selection authority stays Tenvyr.

## 8. Security requirements

- Session secrets (`OPENCODE_SERVER_PASSWORD`) random per session, never
  persisted, never logged, wiped at deterministic teardown.
- Raw API keys never persisted/returned/logged; env refs only.
- Bounded remote responses, strict timeouts, no shell, URL validation
  (http/https, no userinfo), per-hop redirect re-validation.
- No reading runtime credential files; no OAuth proxy; no terminal proxy.
- Model IDs are data with fixed argv separation.
- SSRF documented (single-owner operator feature; External Production
  Exposure Gate stays open).
