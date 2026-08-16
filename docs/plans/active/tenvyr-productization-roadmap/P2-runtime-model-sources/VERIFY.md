---
title: "P2 Verify: Runtime Model Sources + Model Selection + Auth UX"
status: planned
audience:
  - developer
last_verified: 2026-08-16
sources:
  - docs/operations/testing-and-verification.md
  - package.json
---

# P2 Verify (round-2 closure)

## Focused gates

- Unit: `provider-discovery-p2` 10/10; `model-source-p2` 23/23.
- Postgres integration: `phase2-provider-command` 10/10 (incl. fault-injection
  rollback) — run TWICE (determinism).
- Frontend: 27/27, plus `pnpm --filter frontend lint` / `typecheck` / `build`
  green.
- `pnpm test:all` + `pnpm build:all` green.
- `python scripts/sync-python-worker-schemas.py check` + `python -m pytest
  sdks/python-worker/tests` green.
- `pnpm self-hosted:contract-test` 42/42 (33 tables).
- `pnpm test:docs` + `pnpm verify:docs`; `pnpm test:identity` + `pnpm
  verify:identity`; `pnpm verify:package-packs`.
- `git diff --check` clean.
- Recovery E2E re-run whenever a schema change lands (inventory contract:
  anchors TABLES = 33; entities == migrations == TABLES).

## Deterministic tests required

1. **Contract regression (frontend):** receipt `AUTH_REQUIRED` → UI state
   AUTH_REQUIRED; malformed/absent receipt → error, never READY.
2. **Provider discovery (structured Server API):** GET /provider,
   /provider/auth, oauth authorize/callback against a fake `opencode serve`
   — bounded session, 127.0.0.1 + ephemeral port, random
   `OPENCODE_SERVER_PASSWORD`, deterministic teardown, no password in logs.
3. **Connection-scoped isolation:** two same-kind connections with different
   revisions → independent provider state; discovery always resolves the
   connection's CURRENT revision and uses ITS fixed secret-free profile.
4. **Provider Connect:** OAuth flow via the provider's own UI + callback +
   refresh; API-key providers → guided official command; tokens never
   persisted, keys never seen.
5. **Auth repair:** Sign in / Check again / Advanced on an EXISTING
   connection; connection state and runtime auth state remain separate.
6. **Connected-only picker:** unauthenticated providers disabled; their
   models never listed; launch blocks with an explanation when a selected
   target became unavailable.
7. **Test Runtime Target:** small bounded real invocation (30s, 64KB, no
   shell, exact connection-profile argv + `--model`); audited; failure →
   failure, never READY.
8. **Descriptor/host:** `requestedModelId` parse/bounds; fail-closed binding
   (missing `modelArgvPrefix` / invalid modelId refused); argv composition
   per runtime; no model → unchanged argv.
9. **Team run dogfood (Postgres, real host + fake children):** distinct
   models per role; every frozen attempt's invocation argv contains exactly
   its requested model; retry keeps the model; catalog refresh never rewrites
   history.
10. **Backup inventory:** anchors TABLES = 33; entities == migrations ==
    TABLES; restore/recovery E2E green.

## Completion criteria

All gates green; no fabricated READY anywhere; no credential value (incl.
session password) in any persisted/returned/logged shape; docs +
implementation-status updated; EXECUTION_STATUS receipt appended; commit
pushed and the exact GitHub Actions commit watched until green.
