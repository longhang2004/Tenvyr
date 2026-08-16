---
title: Provider Connections and Runtime Targets
status: current
audience:
  - developer
  - operator
last_verified: 2026-08-16
sources:
  - services/orchestrator/src/executors/model-source.ts
  - services/orchestrator/src/services/model-source.service.ts
  - services/orchestrator/src/services/model-discovery.service.ts
  - services/orchestrator/src/domain/coordination.ts
  - services/orchestrator/src/executors/executor-descriptor.ts
  - services/local-executor-host/src/supervisor.ts
  - packages/contracts/src/types.ts
---

# Provider Connections and Runtime Targets (P2)

## Product model

Four distinct concepts, never conflated:

1. **Runtime Connection** — which agent runtime/executor executes the work
   (`conn:codex`, `conn:claude`, `conn:opencode`, generic CLI). Owned since
   M8; immutable revisions, secret-free.
2. **Provider Connection** — which provider/account/key is available
   THROUGH a runtime; is it authenticated; which models does it expose; can
   it be tested. Provider state is RUNTIME-OWNED: Tenvyr discovers it via
   the runtime's official CLI surfaces and NEVER stores provider
   credentials (environment REFERENCES only, and only for the generic
   advanced endpoint case). A Provider Connection does NOT mean Tenvyr
   routes inference traffic — the chain stays
   `Tenvyr -> Executor -> Agent Runtime -> Provider`.
3. **Model** — a bounded data identifier discovered through a provider of a
   runtime. Catalog visibility NEVER equals execution compatibility: a
   model is selectable only when the SELECTED runtime can actually invoke
   that provider/model (the picker only offers the runtime's own providers).
4. **Runtime Target** — the usable unit selected for Planner / Worker /
   Verifier roles: `{ connectionId, modelId? }` (absent model = Runtime
   default). Model selection authority stays Tenvyr.

## Provider-auth ownership rules

- **OpenCode (first-class provider management)**: official CLI only —
  `opencode auth login`, `opencode auth login --provider <id>`, `opencode
  auth list`, `opencode models [provider]`, `opencode models --refresh`.
  The auth file is NEVER read; raw auth output is never persisted; Tenvyr
  never proxies credentials. The UI renders the official command with
  [Copy Command] / [Check Again].
- **Codex**: ONE provider (OpenAI). Auth state = `codex login status`;
  sign-in guidance = `codex login`. ChatGPT session credentials are never
  persisted.
- **Claude Code**: ONE provider (Anthropic). Auth state = `claude auth
  status`; sign-in guidance = `claude auth login`. No credential capture.
- **API-key providers (e.g. DeepSeek via OpenCode)**: the KEY is owned by
  the runtime (env reference such as `DEEPSEEK_API_KEY` resolved by the
  runtime at invocation). Tenvyr stores only environment-variable NAMES
  when a generic endpoint needs one. A provider is never selectable for a
  Runtime Target unless the selected runtime can actually invoke it.

## No routing / fallback / rotation

Tenvyr contains NO provider load balancing, priority order, failover,
quota-based switching, account rotation, subscription arbitrage, model
aliases, combos, protocol translation, or inference proxy. Agents/runtimes
own inference. Tenvyr chooses an authorized FROZEN Runtime Target.

9Router inspired the provider-management UX but is NOT a Tenvyr product
concept. An existing 9Router instance is connectable only as the generic
OpenAI-compatible endpoint (advanced surface); Tenvyr never copies 9Router's
routing, fallback, quota, combo/alias, or account machinery.

## model_sources table

`model_sources` keeps a GENERIC role: operator configuration for
OpenAI-compatible catalog endpoints (kind `openai-compatible` only) —
baseUrl (http/https, no userinfo, bounded) + optional credentialEnvRef
(environment variable NAME only). Catalogs are bounded on-demand
projections (≤ 5000 models, ≤ 1 MiB response, ≤ 256 chars per id, strict
10 s timeout, redirects re-validated per hop), NEVER persisted as
authority. Mutations go through the audited Workbench command layer with
the M10 atomicity invariant (authority row + OperatorAction evidence +
stored outcome commit in ONE transaction).

## Model selection is execution provenance

```text
operator selects model M through a provider of the runtime
  -> Tenvyr validates M against the frozen target/source (allowedTargets)
  -> M becomes frozen execution configuration (step metadata.tenvyrModelId)
  -> attempt claim freezes ExecutorDescriptorV1.requestedModelId
  -> invocation carries requestedModelId (wire contract)
  -> the executor host composes FIXED argv: [...args, ...modelArgvPrefix, M]
  -> Capsule/provenance can reconstruct requested M
```

- Retries reuse the frozen descriptor; catalog refreshes never rewrite
  historical attempts; `observedModelId` only when the runtime itself
  reports it; NO Tenvyr-side model fallback.

## Test semantics

- **Check Authentication**: provider account/key/session appears configured
  (auth-list / auth-status projections).
- **Refresh Models**: the provider/runtime can enumerate models.
- **Test Provider / Runtime Target**: explicit operator action using a
  bounded runtime-owned invocation (e.g. `opencode models <provider>`);
  never inference from the Orchestrator, never a chat-completions client.

## Security

Raw API keys never persisted/returned/logged; credential env refs only;
bounded remote responses; strict timeouts; no shell; URL validation
(http/https, no userinfo); redirects re-validated; SSRF documented
(single-owner operator feature, External Production Exposure Gate stays
open); no runtime credential files read; no OAuth proxy; model IDs are data
with fixed argv separation.
