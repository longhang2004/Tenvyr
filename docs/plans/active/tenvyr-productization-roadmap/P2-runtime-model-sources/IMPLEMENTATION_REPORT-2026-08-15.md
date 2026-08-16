---
title: "P2 Implementation Report (round 1, superseded)"
status: historical
audience:
  - developer
  - product
last_verified: 2026-08-15
superseded_by: IMPLEMENTATION_REPORT.md
sources:
  - docs/plans/active/tenvyr-productization-roadmap/P2-runtime-model-sources/PLAN.md
  - docs/plans/active/tenvyr-productization-roadmap/P2-runtime-model-sources/SPEC.md
  - docs/plans/active/tenvyr-productization-roadmap/P2-runtime-model-sources/VERIFY.md
---

> SUPERSEDED on 2026-08-16 by the P2 closure (round 2) — kept for history; the
> current report is [IMPLEMENTATION_REPORT.md](IMPLEMENTATION_REPORT.md).

# P2 implementation report

## Root cause of the false READY UI

`POST /api/connections/:id/test` returns the audited Workbench command
envelope; the bounded receipt is nested at `data.result.receipt`
(`{ state, reasonCode, testedVersion, ... }`). The frontend read
`res.data.status || res.data.state` — both undefined at the envelope's top
level — and fell through to a fabricated `"READY"` literal, so an
`AUTH_REQUIRED` connection displayed "test passed: READY".

Fix: typed frontend DTOs (`ConnectionTestReceiptV1` / `ConnectionTestResultV1`)
with strict runtime guards (`parseConnectionTestResult` in
`frontend/src/lib/tenvyr-api/guards.ts`). Missing or malformed server state
renders "Unknown / malformed response"; `READY` is never invented; status
enums are exhaustive. Regressions: `AUTH_REQUIRED` receipt -> AUTH_REQUIRED
displayed; malformed receipt -> error.

## Final Runtime Connection / Model Source / Runtime Target model

- **Runtime Connection** — which runtime/executor executes the work
  (M8, unchanged; immutable secret-free revisions).
- **Model Source** — where Tenvyr safely discovers model identifiers:
  OpenCode CLI catalog, 9Router, generic OpenAI-compatible endpoint.
  Authoritative operator config in `model_sources` (33rd backup table),
  credential env REFERENCES only. Catalogs are bounded on-demand
  projections, NEVER persisted as authority.
- **Runtime Target** — `{ connectionId, modelId? }`, the frozen unit for
  Planner / Worker / Verifier roles. Model selection authority stays
  Tenvyr.

## Supported model-discovery behavior per runtime

| Runtime  | Discovery                                                                                                                                | Invocation flag          | Auth command          |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ | --------------------- |
| Codex    | `codex debug models` EXPERIMENTAL best-effort (empty catalog on any failure; Runtime default / manual entry)                             | `--model <id>`           | `codex login`         |
| Claude   | None documented — manual full model ID entry                                                                                             | `--model <id>`           | `claude auth login`   |
| OpenCode | First-class: `opencode models [provider]`, `opencode models --refresh`, `opencode auth list` (bounded CLI parsing; auth file NEVER read) | `--model provider/model` | `opencode auth login` |

Primary sources re-fetched 2026-08-15 and recorded in
`RESEARCH_REGISTER.md` (learn.chatgpt.com/docs/codex, code.claude.com/docs/
en/cli-reference, opencode.ai/docs/cli).

## 9Router integration

Optional external router/model source. Tenvyr reads only
`GET {baseUrl}/models` (OpenAI-compatible) with an optional bearer env REF;
default candidate `http://localhost:20128/v1` (operator-configurable,
never assumed). UI: [Open 9Router Dashboard] + [Refresh Models]. Tenvyr
does not copy 9Router's provider-account/OAuth/quota/routing machinery.

## Authentication UX

Guided official login commands only (`codex login` / `claude auth login` /
`opencode auth login`) rendered as "Run: <command>" + [Copy Command] +
[Check Again]. No terminal proxy, no credential capture, no invented OAuth,
no reading runtime credential files.

## Model freezing / provenance

allowedTargets authorization (MODEL_NOT_ALLOWED) -> step
`metadata.tenvyrModelId` (incl. deterministic single-model resolution) ->
`ExecutorDescriptorV1.requestedModelId` at claim -> `AgentInvocationV1.
requestedModelId` (schema + python-worker sync) -> host fixed argv
`[...args, --model, id]` with fail-closed binding. Retries reuse the frozen
descriptor; catalog/source changes never rewrite history (dogfood-proven);
`observedModelId` only when the runtime reports it; no Tenvyr-side fallback.

## Team Run UX

`/runs/new` freezes Planner target, multiple Worker Targets, and Verifier
target via `RuntimeTargetPicker` (searchable, provider groups, Runtime
default, stale indicator, manual entry); the review step displays the exact
target per role.

## Security decisions

Raw keys never persisted/returned/logged; env refs only; bounded remote
responses; strict timeouts; no shell; URL validation (http/https, no
userinfo); per-hop redirect re-validation; SSRF documented (single-owner
operator feature, External Production Exposure Gate stays open); model IDs
are data with fixed argv separation; no fallback engine.

## Migrations / backup inventory

Migration `1722270019000-ModelSources` + entity registered in
`database.provider.ts`; `model_sources` added to `anchors.mjs` TABLES and
the contract test (32 -> 33); self-hosted docs updated; restore/recovery
E2E re-run in CI.

## Tests

- Frontend: 16/16 (guards + client regressions: AUTH_REQUIRED -> shown,
  malformed -> error, never READY).
- Orchestrator focused P2: 34/34 (`coordination-p2-model-targets`,
  `model-source-p2` fake OpenAI server + fake CLIs: no auth / bearer env
  ref / bad credential / timeout / malformed JSON / oversized / duplicates /
  unsafe redirect / userinfo rejection).
- Postgres dogfood `phase2-model-targets-dogfood`: 4/4 through the REAL
  local executor host — exact per-role composed argv, retry keeps model,
  unauthorized model DENIED with zero materialization, source deletion
  mid-run never rewrites history.
- Local executor host: 49/49 (argv composition + fail-closed binding).
- Contracts: 65/65 (schema identity updated); python-worker 261/261 +
  schema sync.
- `pnpm self-hosted:contract-test`: 42/42 (33 tables).

## Full verification

`pnpm --filter frontend lint/typecheck/test/build`; `pnpm test:all`;
`pnpm build:all`; Postgres suite twice; `pnpm test:docs` + `verify:docs`;
`pnpm test:identity` + `verify:identity`; `verify:package-packs`;
`python scripts/sync-python-worker-schemas.py check`; `pytest` 261/261;
`git diff --check` — see the EXECUTION_STATUS receipt for final numbers.

Product Phase 2 remains READY FOR INDEPENDENT TECH LEAD VERIFICATION — NOT
CLOSED; only the Technical Lead may close.
