---
title: "PP1 Implementation Report: Coding-Agent Control Plane Wedge"
status: current
audience:
  - developer
last_verified: 2026-08-19
sources:
  - services/orchestrator/src/domain/coordination.ts
  - services/orchestrator/src/services/workspace-execution.service.ts
  - services/orchestrator/src/services/workbench-command.service.ts
  - services/orchestrator/src/entities/workspace-execution.entity.ts
  - services/orchestrator/src/database/migrations/1722270025000-WorkspaceExecutionReleaseOperation.ts
  - services/orchestrator/src/agent-adapters/agent-transport-config.service.ts
  - services/orchestrator/src/pivot1-workspace-dogfood.integration.spec.ts
  - services/orchestrator/src/workspace-execution-recovery.spec.ts
  - services/orchestrator/src/dynamic-bridge.composition.spec.ts
  - services/local-executor-host/src/adapters/native-output-adapter.ts
  - services/local-executor-host/src/main.ts
  - frontend/src/app/attention/page.tsx
  - scripts/dev.mjs
  - scripts/dev-ux.test.mjs
---

# PP1 Implementation Report — Coding-Agent Control Plane Wedge

## Summary of Completed Work

1. **Area 1: Worker RuntimeConnection Routing Authority (P0)**
   - Enforced in `validateTaskBatchProposal`: `task.agent` must match the frozen connection selection's expected transport agent (`expectedAgent = matchingSelection.agent ?? toTransportAgent(matchingSelection.name)`). Any mismatch throws `AGENT_NOT_ALLOWED`.
   - Compiler immunity: `compileIterationPlanPatch` derives `step.agent` strictly from the Tenvyr frozen configuration (`expectedAgent`) rather than untrusted planner proposal output.
   - Comprehensive unit tests added in `coordination.spec.ts` verifying rejection of malicious agent bypass attempts.

2. **Area 2: Worker Role Protocol Ownership (P1)**
   - Strict namespacing in `WorkerInvocationInputV1`: worker task input is encapsulated under `taskInput: task.input ?? null` without destructive flattening into top-level protocol fields (`role`, `schemaVersion`, `goal`, `iterationNumber`, `taskId`).
   - Exported typed validator `parseRoleInvocationInput` in `coordination.ts`.
   - Hostile input overwrite test suite verified in `coordination.spec.ts`.

3. **Area 3: Safe Release Dedicated Committed OperatorAction Saga (P1) — FINAL CLOSURE**
    - **Durable intent + exactly-one Git owner:** `OperatorAction` lifecycle `REQUESTED → EXECUTING (processInstanceId+ownerToken/claimedAt via CAS) → REMOVED/PRESERVED/INTERRUPTED/IN_PROGRESS`; duplicate while owner alive (same `processInstanceId`) returns `IN_PROGRESS` and never runs Git via reconciler; stale `EXECUTING` from dead process may be taken over via CAS to new `processInstanceId`. No DB transaction held over Git; `beforeRemoveHook` barrier for exactly-one proof with `removeInvocationCount`.
    - **Truthful audit:** `truthfulReleaseRefusalOutcome` reads actual durable `WorkspaceExecution` row (`state` is `NOT_FOUND` for `LEASE_NOT_FOUND`, actual `READY`/`IN_USE`/`TRANSFERRED` for `LEASE_NOT_RELEASABLE`, actual `PRESERVED`/`FAILED` for `SHARED_MODE_NO_REMOVAL`/`LEASE_PATH_MISSING`); only `WORKTREE_DIRTY` when proven dirty, otherwise `WORKTREE_REMOVE_FAILED`/`WORKTREE_STATE_UNKNOWN` with `hasUncommittedWork` tri-state.
    - **Exact authority correlation:** `WorkspaceExecution.releaseOperationId` (correlation to `OperatorAction.id` via `varchar(36)` + index, not a DB FK — a FK would couple the lease lifecycle to the audit table) added via migration `1722270025000`; every `RELEASE_REQUESTED` must have exact match to its authorizing `OperatorAction`; legacy/unmatched → `PRESERVED`/`RELEASE_UNAUTHORIZED` fail-closed, never Git.
    - **Crash recovery (matrix A-G):** `REQUESTED` before claim → same operation can progress; `EXECUTING` before `RELEASE_REQUESTED` → takeover or `INTERRUPTED`/`RETRY_REQUIRED` (never false-success `PRESERVED`); `RELEASE_REQUESTED` before Git → exact operation recovered with one recovery owner; Git-removed before `REMOVED` → filesystem absence → `REMOVED` without re-run; `REMOVED` before audit → audit finalized; dirty → `PRESERVED` refusal; unmatched `RELEASE_REQUESTED` → `RELEASE_UNAUTHORIZED`. All with real PostgreSQL + disposable Git worktrees and injectable `GitRunner` for deterministic `WORKTREE_DIRTY`/`UNKNOWN`/`REMOVE_FAILED`.
    - **Frontend:** `attention/page.tsx` never shows “released safely” unless `REMOVED`; `IN_PROGRESS` → “in progress”, `INTERRUPTED` → “interrupted; retry”, `PRESERVED` refusal → error.

4. **Area 4: Dev Bridge Composition & Dogfood Acceptance Proof (P0)**
    - Updated `buildManifest` in `scripts/dev.mjs` to derive actual ports and inject the Dynamic Local Runtime Bridge loopback environment (`HTTP_AGENT_CALLBACK_BASE_URL`, `LOCAL_EXECUTOR_HOST_URL`, `HTTP_AGENT_ALLOW_INSECURE=true`, `EXECUTOR_HOST_CALLBACK_ALLOWED_ORIGINS`); `pnpm dev` now starts orchestrator + gateway + **Local Executor Host** + frontend.
    - Added unit test suite `dev launcher dynamic bridge composition (buildManifest)` in `scripts/dev-ux.test.mjs` verifying default ports, custom ports, operator overrides, and secret non-leakage.
    - Added focused composition integration `services/orchestrator/src/dynamic-bridge.composition.spec.ts` that consumes `buildManifest()` output (never invents `HTTP_AGENT_CALLBACK_BASE_URL`/`LOCAL_EXECUTOR_HOST_URL`/`EXECUTOR_HOST_CALLBACK_ALLOWED_ORIGINS` outside it), creates one dynamic `RuntimeConnection`, and verifies the generated `LOCAL_EXECUTOR_HOST_URL`/`EXECUTOR_HOST_CALLBACK_ALLOWED_ORIGINS` composition and host DB resolvability; full host dispatch + signed callback is covered by the existing `pivot1-workspace-dogfood` dogfood (which uses `buildManifest` env) and `local-executor-host` integration.
    - Pure dynamic bridge mode dogfood verified in `services/orchestrator/src/pivot1-workspace-dogfood.integration.spec.ts` with `--model` argument propagation and exclusive worktree transfer in Handoff (A → B).

5. **Area 5: Documentation Truth Alignment**
   - Reconciled documentation in `README.md`, `docs/operations/local-development.md`, `docs/operations/supervised-coding-team.md`, `docs/reference/implementation-status.json`, and roadmap plan specifications.

## Verification Results (2026-08-19)

- `pnpm test:all`: 68/68 test suites passed (including `dynamic-bridge.composition` and expanded `workspace-execution-recovery` with 26 Safe Release tests).
- `node --test scripts/dev-ux.test.mjs`: 22/22 tests passed (plus buildManifest composition).
- `pnpm build:all`: 9/9 projects built successfully including Next.js frontend production bundle.
- `pnpm --filter frontend lint/typecheck/test/build`: all passed.
- `python scripts/sync-python-worker-schemas.py check` + `pytest sdks/python-worker/tests`: passed.
- `node scripts/verify-docs.mjs` + `node scripts/verify-product-identity.mjs` + `pnpm verify:package-packs`: 0 errors.
- PostgreSQL integration `workspace-execution-recovery` + `dynamic-bridge` + `pivot1` suites: 2 consecutive passes with `--runInBand` (26/26 Safe Release, 1/1 dynamic bridge).
- `pnpm self-hosted:contract-test` + `pnpm self-hosted:recovery-test`: passed.
- `git diff --check`: clean.
