---
title: "P2 Closure Plan: Provider Connection UX + Contract Correctness"
status: planned
audience:
  - developer
  - product
last_verified: 2026-08-16
sources:
  - services/orchestrator/src/services/workbench-command.service.ts
  - services/orchestrator/src/services/model-source.service.ts
  - services/orchestrator/src/model-sources.controller.ts
  - frontend/src/lib/tenvyr-api/client.ts
  - frontend/src/lib/tenvyr-api/guards.ts
  - frontend/src/app/runtimes/page.tsx
---

# P2 closure plan (Technical Lead audit)

## Audit findings (root causes)

1. **Model-source command crash — undefined dependency.** `WorkbenchCommandService`
   declares `private readonly modelSources: ModelSourceService;` but its constructor
   never receives or assigns it. Every `model-source-*` command calls
   `this.modelSources.*` and throws `TypeError: Cannot read properties of
undefined`. Root cause: the P2 field was added without the constructor
   parameter/assignment.

2. **M10 atomicity invariant broken.** The `runCommand(manager)` callback calls
   `ModelSourceService` methods that use `this.dataSource.getRepository(...)` —
   their own connection, outside the Workbench transaction. A failure after the
   authority mutation (e.g. during the OperatorAction outcome update) would
   commit the `model_sources` row without evidence, or vice versa. Root cause:
   the P2 service was written connection-first instead of manager-first.

3. **Frontend command envelope mismatch (AUTH_REQUIRED→READY class).** The
   orchestrator returns `{ success, data: { action, outcome, result } }` and the
   gateway passes it through verbatim, but the client types model-source
   commands as `WorkbenchCommandResultV1<T>` and the `/runtimes` handlers read
   `res.outcome` at the top level — always `undefined`, so every command result
   falls into the error branch. The same defect exists for ALL Workbench command
   methods (onboard-runtime, create-workspace, start-team-run, resolve-wait,
   cancel, replay, compare). Root cause: the command envelope was never typed or
   guarded; consumers read a fabricated shape.

4. **Product-model misunderstanding.** "Model Source" with a first-class
   `ninerouter` kind does not match the desired product UX. The operator concept
   is **Provider Connection** (which provider/account/key is available THROUGH
   this runtime; is it authenticated; which models does it expose; can it be
   tested). 9Router inspired the UX but is NOT a Tenvyr architecture concept.

## Fixes

1. **DI**: constructor gains `modelSources?: ModelSourceService` and assigns
   `this.modelSources = modelSources ?? new ModelSourceService(this.dataSource)`
   (same pattern as every other optional service).
2. **Atomicity**: `ModelSourceService` gains manager-aware variants
   (`createWithManager`, `updateWithManager`, `deleteWithManager`,
   `testWithManager`, `refreshWithManager`) — every authority mutation and
   status update uses the `EntityManager` from `runCommand`. Non-manager
   variants remain for direct service use. Fault-injection regression: a
   test-only PostgreSQL trigger on `operator_actions` aborts the outcome update
   → the whole transaction rolls back → NO `model_sources` row remains; inverse:
   audit row exists ⟺ matching authority row exists.
3. **Envelope**: `parseWorkbenchCommandResult<T>` strict guard; the five
   model-source client methods (and the other command methods of the same class)
   are typed `ApiResponse<WorkbenchCommandResultV1<T>>`; every page consumer
   parses `res.data`. Tests: executed / duplicate / rejected / malformed.
4. **Provider Connection reframe**:
   - `model_sources` keeps its generic role: kind `openai-compatible` ONLY
     (advanced generic catalog endpoint). `ninerouter` and `opencode` kinds are
     removed (option A of the audit: keep the table, reframe the concept).
   - Runtime-owned provider discovery (first-class): OpenCode via official CLI
     only — `opencode auth list` (authenticated providers), `opencode models
[provider]` (per-provider catalog), `opencode models --refresh`; auth file
     never read. `discoverRuntimeCatalog` returns `providers[]` with
     `{ providerId, authenticated, loginCommand }` and per-provider model
     grouping.
   - Codex: single provider OpenAI, auth = `codex login status`, sign-in =
     `codex login`. Claude: single provider Anthropic, auth = `claude auth
status`, sign-in = `claude auth login`.
   - API-key providers (e.g. DeepSeek): represented as a provider OF a runtime
     that can actually invoke it (OpenCode), env REFERENCE only. Catalog
     visibility never creates execution authority: the model picker only offers
     providers of the SELECTED runtime, so an incompatible runtime/provider/model
     combination is impossible by construction.
5. **9Router removal**: no `ninerouter` kind, no 9Router template/default/NINEROUTER_KEY
   UI, no "Open 9Router". An existing 9Router instance is connectable only as the
   generic OpenAI-compatible endpoint. Docs updated.
6. **UI**: `/runtimes` Agent Runtimes cards expand into providers (status,
   [Models], [Test], [Connect] with official command + Copy/Check Again);
   Model Sources tab becomes Advanced Catalogs (generic endpoints). Team run
   picker: Runtime → Provider → Model, review shows the exact target. Provider
   is hidden when implicit.
7. **Preserved (no regressions)**: plannerTarget/verifierTarget/allowedTargets,
   MODEL_NOT_ALLOWED, metadata.tenvyrModelId, requestedModelId through
   descriptor/invocation/argv, modelArgvPrefix, retry freezing, Capsule
   provenance, observedModelId only when evidenced, no Tenvyr-side fallback.

## Storage

No table rename (option A). `model_sources` stays authoritative, unchanged
inventory (33 tables). Kind validation narrows to `openai-compatible`.
No migration is rewritten.

## Verification

Frontend lint/typecheck/test/build; orchestrator unit + build; Postgres suite
TWICE (incl. new provider-command integration regression + existing dogfood);
test:all; build:all; python sync + pytest; self-hosted contract-test;
test:docs + verify:docs; test:identity + verify:identity; verify:package-packs;
git diff --check. No live provider credentials anywhere.
