---
title: "PP1 Implementation Report: Coding-Agent Control Plane Wedge"
status: current
audience:
  - developer
last_verified: 2026-08-17
sources:
  - services/orchestrator/src/domain/coordination.ts
  - services/orchestrator/src/services/workspace-execution.service.ts
  - services/orchestrator/src/services/workbench-command.service.ts
  - services/orchestrator/src/agent-adapters/agent-transport-config.service.ts
  - services/orchestrator/src/pivot1-workspace-dogfood.integration.spec.ts
  - services/orchestrator/src/workspace-execution-recovery.spec.ts
  - services/local-executor-host/src/adapters/native-output-adapter.ts
  - services/local-executor-host/src/main.ts
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

3. **Area 3: Safe Release Dedicated Committed OperatorAction Saga (P1)**
   - Implemented committed multi-phase `OperatorAction` lifecycle in `WorkbenchCommandService.releaseExecutionWorkspace`:
     1. Commits operator intent into PostgreSQL with `{ pending: true, phase: "REQUESTED" }` BEFORE external Git worktree mutation.
     2. Reconciles/executes safe Git worktree removal without `--force`.
     3. Finalizes `OperatorActionEntity` outcome to `{ workspaceExecutionId, state: "REMOVED" }` on clean removal, or `{ state: "PRESERVED", failureCode: "WORKTREE_DIRTY", refusal: true }` on dirty refusal (preventing loss of audit evidence).
   - Added fault-injection / crash recovery tests in `services/orchestrator/src/workspace-execution-recovery.spec.ts` covering:
     - Case 1: Crash before `RELEASE_REQUESTED` / Git -> retry completes release.
     - Case 2: Crash after Git removal before `REMOVED` committed -> retry converges.
     - Case 3: Crash after `REMOVED` before `OperatorAction` finalized -> retry finalizes audit without running Git again.
     - Case 4: Dirty worktree refusal -> durable audit evidence records refusal and preserves uncommitted work.
     - Case 5: Conflicting idempotency payload fails closed (`IDEMPOTENCY_CONFLICT`).

4. **Area 4: Dev Bridge Composition & Dogfood Acceptance Proof (P0)**
   - Updated `buildManifest` in `scripts/dev.mjs` to derive actual ports and inject the Dynamic Local Runtime Bridge loopback environment (`HTTP_AGENT_CALLBACK_BASE_URL`, `LOCAL_EXECUTOR_HOST_URL`, `HTTP_AGENT_ALLOW_INSECURE=true`, `EXECUTOR_HOST_CALLBACK_ALLOWED_ORIGINS`).
   - Added unit test suite `dev launcher dynamic bridge composition (buildManifest)` in `scripts/dev-ux.test.mjs` verifying default ports, custom ports, operator overrides, and secret non-leakage.
   - Pure dynamic bridge mode dogfood verified in `services/orchestrator/src/pivot1-workspace-dogfood.integration.spec.ts` with `--model` argument propagation and exclusive worktree transfer in Handoff (A → B).

5. **Area 5: Documentation Truth Alignment**
   - Reconciled documentation in `README.md`, `docs/operations/local-development.md`, `docs/operations/supervised-coding-team.md`, `docs/reference/implementation-status.json`, and roadmap plan specifications.

## Verification Results

- `pnpm test:all`: 63/63 test suites passed (796 tests passed, 0 failed).
- `node --test scripts/dev-ux.test.mjs`: 22/22 tests passed.
- `pnpm build:all`: 9/9 projects built successfully including Next.js frontend production bundle.
- `node scripts/verify-docs.mjs`: 0 doc errors.
- `node scripts/verify-product-identity.mjs`: 0 violations.
- PostgreSQL integration test suites: 2 consecutive passes with `--runInBand` (21/21 tests passed).
- `pnpm self-hosted:contract-test`: passed.
