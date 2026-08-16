---
title: "P2 Implementation Report: Runtime Model Sources + Model Selection + Auth UX (incl. closure)"
status: current
audience:
  - developer
  - product
last_verified: 2026-08-16
sources:
  - docs/plans/active/tenvyr-productization-roadmap/P2-runtime-model-sources/CLOSURE-PLAN.md
  - services/orchestrator/src/phase2-provider-command.spec.ts
  - services/orchestrator/src/services/workbench-command.service.ts
  - services/orchestrator/src/services/model-source.service.ts
  - frontend/src/lib/tenvyr-api/guards.ts
  - frontend/src/app/runtimes/page.tsx
  - frontend/src/components/shared/RuntimeTargetPicker.tsx
---

# P2 Closure report (Technical Lead audit, 2026-08-16)

Independent audit found three functional bugs and one product-model
misunderstanding. This closure addresses all of them.

## Root causes

1. **Model-source command crash** — `WorkbenchCommandService` declared
   `private readonly modelSources: ModelSourceService` but the constructor
   never received or assigned the service: every audited model-source
   command threw `TypeError` on an undefined field. Fixed by wiring the
   real `ModelSourceService` (explicit injection + default construction)
   and locking it with a controller → command → service → PostgreSQL
   integration regression that asserts the DI wiring by identity and runs
   a real create.
2. **M10 atomicity violation** — the P2 commands called
   `ModelSourceService` methods that used `this.dataSource.getRepository`
   on their own connection, OUTSIDE the `runCommand` transaction: the
   authority mutation, the OperatorAction evidence, and the stored outcome
   could commit separately (a crash between them leaves an unaudited
   authority row). Fixed with manager-aware variants
   (`createWithManager` / `updateWithManager` / `deleteWithManager` /
   `testWithManager` / `refreshWithManager`) executed inside the
   `runCommand` EntityManager. Fault-injection regression: a DB trigger
   aborts the outcome commit → the WHOLE transaction rolls back → NO
   authoritative row remains; the inverse (operator action exists ⟺
   matching authority row committed) is asserted on the success path.
3. **Frontend command-envelope bug** — the gateway passes the audited
   Workbench envelope through verbatim as
   `{ success, data: { action, idempotencyKey, outcome, result } }`, but
   the client typed and consumed every command result as if `outcome`
   were top-level. Every command UI fell into its error branch (the same
   class as the AUTH_REQUIRED → READY bug). Fixed with
   `parseWorkbenchCommandResult` strict guards, all ten command methods
   retyped to the real envelope, and every page consumer
   (runtimes, workspaces, approvals, runs/new, runs/[executionId],
   advanced/audit) parsing `res.data`. Regressions cover executed /
   duplicate / rejected / malformed envelopes.

## Product-model correction

- **Provider Connection** replaces "Model Source" as the product concept:
  which provider/account/key is available THROUGH a runtime, its auth
  state, its models, and its testability. Provider state is RUNTIME-OWNED
  (official CLI discovery only — OpenCode `auth list` / `models` /
  `models <provider>`, Codex `login status`, Claude `auth status`).
- `model_sources` keeps only the GENERIC role: OpenAI-compatible catalog
  endpoint configuration (advanced surface). No table change (Option A);
  the 33-table backup inventory is unchanged.
- **9Router is NOT a first-class Tenvyr concept**: it inspired the
  provider-management UX only. No routing/fallback/quota/combo/alias/
  account machinery exists or will be copied; an existing instance is a
  generic OpenAI-compatible endpoint.
- The RuntimeTargetPicker is Runtime → Provider → Model with catalogs
  scoped to the selected runtime's own providers: an incompatible
  runtime/provider/model combination is impossible by construction, and a
  catalog entry never creates execution authority.
- Tenvyr contains no routing/fallback/account-rotation logic; the frozen
  model-selection provenance from the original P2 slice is unchanged.

## Test inventory (closure)

- `phase2-provider-command.spec.ts` (Postgres): real-path create
  (DI regression), idempotent replay, update/delete through the same
  transaction, fault-injection rollback (create + update), rejected
  payloads without side effects — 6/6.
- Frontend: `parseWorkbenchCommandResult` guard suite
  (executed/duplicate/rejected/malformed + top-level-read trap) and
  client envelope tests — 20/20 total frontend tests.
- Provider reframe: `model-source-p2.spec.ts` updated (kinds now
  `["openai-compatible"]` only; 9Router and opencode-as-source rejected).
- Unit 721/1076; Postgres suite twice green; recovery E2E 17/17;
  contract-test 42/42 (33 tables); docs/identity/package-packs green.

## Verification (2026-08-16)

Frontend lint/typecheck/test/build; orchestrator unit + Postgres x2;
`pnpm test:all` + `pnpm build:all`; python-worker schema sync + pytest;
self-hosted contract-test; test:docs / verify:docs / test:identity /
verify:identity / verify:package-packs; `git diff --check`.

## Superseded round-1 report

The round-1 implementation report (contract fix, M10 atomicity, command
envelope, provider reframe — the work this closure audits and completes) is
archived at
[IMPLEMENTATION_REPORT-2026-08-15.md](IMPLEMENTATION_REPORT-2026-08-15.md),
superseded by this closure report.


## Final closure (shutdown lifecycle, 2026-08-16)

- `main.ts`: `app.enableShutdownHooks()` before listen.
- `OpenCodeAuthFlowService` implements OnModuleDestroy; graceful
  shutdown runs closeAll() — every live management session terminated,
  every expiry timer cleared. The `closeAll` helper is now exercised by
  production shutdown AND by the signal-lifecycle regression.
- Deterministic TTL: real unref'd expiry timers per flow; expiry removes
  the flow atomically and closes its session with no further auth call;
  complete/cancel/closeAll/expiry are race-safe (session closed at most
  once; flow never resurrected).
- Real prompts[] contract (plural) with oauth/api separation
  (AUTH_METHOD_NOT_OAUTH before any authorize) and runtime-owned guided
  login for API methods.
- Signal regression (Postgres): disposable real Orchestrator child with a
  live fake management session; SIGTERM -> child exits within a bound and
  the management child is proven terminated.
