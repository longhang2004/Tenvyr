---
title: "P2 Verify: Runtime Model Sources + Model Selection + Auth UX"
status: planned
audience:
  - developer
last_verified: 2026-08-15
sources:
  - docs/operations/testing-and-verification.md
  - package.json
---

# P2 Verify

## Focused gates

```bash
pnpm --filter frontend lint
pnpm --filter frontend typecheck
pnpm --filter frontend test
pnpm --filter frontend build
pnpm --filter orchestrator test -- --runInBand    # unit incl. coordination/model-source/descriptor/host
TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/tenvyr_roadmap_test \
  pnpm --filter orchestrator test -- --runInBand  # Postgres suite TWICE (incl. phase2 dogfood + authz + host e2e)
pnpm self-hosted:contract-test
```

## Full gates (exact order from the task)

```bash
pnpm --filter frontend lint && pnpm --filter frontend typecheck && pnpm --filter frontend test && pnpm --filter frontend build
pnpm self-hosted:contract-test
pnpm test:all
pnpm build:all
pnpm test:docs && pnpm verify:docs
pnpm test:identity && pnpm verify:identity
python scripts/sync-python-worker-schemas.py check
python -m pytest sdks/python-worker/tests
git diff --check
```

## Deterministic tests required

1. **Contract regression (frontend):** receipt `AUTH_REQUIRED` → UI state
   AUTH_REQUIRED; malformed/absent receipt → error, never READY.
2. **Coordination unit:** unauthorized model DENIED; revoked connection
   DENIED; connection-only + exactly-one allowed target → deterministic
   resolution; two allowed models without Planner model → DENIED; model
   without connection → DENIED.
3. **Descriptor/host unit:** requestedModelId parse/bounds; host fails
   closed when modelArgvPrefix missing or modelId invalid; argv composition
   `[...args, "--model", modelId]` per runtime; no model → unchanged argv.
4. **Model source (fake server):** no auth / correct bearer env ref / bad
   credential / timeout / malformed JSON / oversized response / duplicate
   model IDs / URL with userinfo rejected / redirect to unsafe scheme
   rejected / http(s) only.
5. **9Router template:** fake local server only; no real 9Router in CI.
6. **OpenCode fake CLI:** auth list → providers; models → catalog; models
   --refresh; run --model provider/model argv evidence. Never reads auth.json.
7. **Team run dogfood (Postgres, real host + fake children):** planner
   conn:claude+A, workers conn:opencode+B + conn:codex+C, verifier
   conn:codex+D → every frozen attempt's invocation argv contains exactly
   its requested model; retry keeps the same model; model disappears after
   run start → historical frozen config unchanged.
8. **Backup inventory:** anchors TABLES = 33; entities == migrations ==
   TABLES; restore/recovery E2E green.

## Completion criteria

All gates green; no fabricated READY anywhere; no credential value in any
persisted/returned/logged shape; docs + implementation-status updated;
EXECUTION_STATUS receipt appended; commit pushed and the exact GitHub
Actions commit watched until green.
