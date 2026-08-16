---
title: "P2 Plan: Runtime Model Sources + Model Selection + Auth UX"
status: planned
audience:
  - product
  - developer
  - operator
last_verified: 2026-08-16
sources:
  - docs/architecture/executors/runtime-connections.md
  - docs/architecture/workbench.md
  - services/orchestrator/src/domain/coordination.ts
  - services/orchestrator/src/services/workbench-command.service.ts
  - services/orchestrator/src/executors/executor-descriptor.ts
  - services/local-executor-host/src/main.ts
  - frontend/src/app/runtimes/page.tsx
---

# P2 Provider Connections + Model Selection + Auth UX plan

## Final product model

**Runtime Connection → Provider Connection (runtime-owned) → Model → Runtime
Target.**

- Provider state is RUNTIME-OWNED: discovered exclusively through the official
  OpenCode Server API (`opencode serve` on 127.0.0.1, ephemeral port, random
  `OPENCODE_SERVER_PASSWORD`) — GET /provider, GET /provider/auth, POST
  /provider/{id}/oauth/authorize, POST /provider/{id}/oauth/callback — plus
  the documented `opencode models [provider]` CLI for enumeration.
- TUI output (`opencode auth list`) is NEVER parsed; the auth file is NEVER
  read.
- ALL discovery is CONNECTION-SCOPED: the backend resolves the connection's
  CURRENT revision and uses ITS fixed secret-free profile; two same-kind
  connections are fully independent.
- Auth repair exists for EXISTING connections (Sign in / Check again /
  Advanced) — connection state and runtime auth state are separate states.
- Only authenticated providers are Team Run targets; unauthenticated providers
  are shown disabled and are never launchable.
- Test Runtime Target = small bounded REAL invocation through the actual
  runtime adapter (audited, credit warning; failure is failure, never READY).
- 9Router is NOT a Tenvyr concept (UX inspiration only); an existing instance
  connects as a generic OpenAI-compatible endpoint in `model_sources`
  (advanced surface). No routing/fallback/quota/rotation/alias logic exists.

## Problem being solved

The round-1 audit (2026-08-16) found three functional bugs — the model-source
command crash (service never injected), the M10 atomicity violation (authority
mutation outside the `runCommand` transaction), and the frontend
command-envelope bug (outcome treated as top-level). Round 2 corrected the
product model itself: provider state is runtime-owned and discovered via the
structured OpenCode Server API, not parsed TUI output; discovery is
connection-scoped; OAuth flows run in the provider's own UI; and 9Router is
not a kind.

## Round 1 — closure of the audit findings (landed 2026-08-16)

1. **Contract fix:** typed frontend DTOs + strict guard; AUTH_REQUIRED →
   AUTH_REQUIRED, malformed → error, never READY.
2. **M10 atomicity:** manager-aware `ModelSourceService` variants executed
   inside the `runCommand` EntityManager; fault-injection rollback regression.
3. **Command envelope:** `parseWorkbenchCommandResult` strict guards; all
   command methods + page consumers read `res.data`.
4. **Provider reframe:** `model_sources` keeps only the generic
   OpenAI-compatible role; no table change; 33-table backup inventory
   unchanged.

## Round 2 — final model (landed 2026-08-16)

5. **Structured OpenCode Server API session:** spawn `opencode serve`
   (127.0.0.1, ephemeral port, random `OPENCODE_SERVER_PASSWORD`), call
   GET /provider + /provider/auth, deterministic teardown; never parse TUI
   output, never read the auth file.
6. **Connection-scoped discovery:**
   `discoverRuntimeProviders(connectionId)`,
   `refreshRuntimeModels(connectionId, providerId?)`,
   `getRuntimeProviderAuthMethods(connectionId, providerId)` — always through
   the connection's CURRENT revision profile; two same-kind connections are
   independent.
7. **OAuth flow for OAuth providers:** authorize → operator completes in the
   provider's own UI → callback → refresh. Tenvyr never persists tokens or
   sees keys. API-key providers: guided official command only (documented
   limitation).
8. **Auth repair for EXISTING connections:** Sign in / Check again / Advanced
   when the connection exists and auth is required.
9. **Connected-only picker:** unauthenticated providers disabled; their
   models never listed; launch BLOCKS with an explanation if a selected
   target became unavailable.
10. **Test Runtime Target:** small bounded real invocation (30s, 64KB, no
    shell, exact connection-profile argv + `--model`) with a credit warning;
    audited operator action; failure surfaced as failure.
11. **Docs reconciliation:** 9Router docs corrected; GOAL/PLAN/SPEC/VERIFY
    rewritten to the final model; round-1 report archived as superseded.

## Bounds kept

No new dependencies. No shell. No credential values (incl. session passwords)
in any persisted or returned shape. `READY` never fabricated. All live-runtime
gates stay env-gated; CI needs no paid credentials. No
routing/fallback/quota/rotation/alias logic anywhere.
