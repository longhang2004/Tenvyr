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

3. **Area 3: Safe Release Durable Operator Audit & Allocation Barriered Concurrency (P1)**
   - Implemented `assertAllocationCompatible(existing, workspace, mode)` across all allocation reuse paths in `WorkspaceExecutionService`. Conflicting mode or non-existent/mismatched HEAD throws `ALLOCATION_CONFLICT`.
   - Normalized `workspace` in `startTeamRun` audit payload to exclude volatile `capturedAt` millisecond timestamp, enabling deterministic idempotent replay.
   - Fixed elapsed time calculation in `reconcileWorkspaceExecutions` to prevent false positive `RUN_NOT_BOUND` / `ALLOCATION_INTERRUPTED` failures on newly created leases.
   - Added 14 unit and integration recovery tests in `services/orchestrator/src/workspace-execution-recovery.spec.ts` covering allocation HEAD conflicts, startTeamRun concurrency idempotency, and crash recovery.

4. **Area 4: True Dynamic Local Runtime Bridge Acceptance Proof (Dogfood)**
   - Converted `services/orchestrator/src/pivot1-workspace-dogfood.integration.spec.ts` to pure dynamic bridge mode (`agents: []`).
   - Local Executor Host dynamically resolves runtime connections from PostgreSQL via `RuntimeConnectionEntity` and `RuntimeConnectionRevisionEntity`.
   - Propagated model targets: `conn:codex` + `gpt-4o`, `conn:opencode` + `claude-3-5-sonnet`.
   - Verified that CLI child processes receive exact `--model <modelId>` arguments in `process.argv`.
   - Verified that worktree lease transitions to `PRESERVED` on terminal run completion without requiring manual lease reconciliation.
   - Verified exclusive worktree transfer in Handoff vertical (A → B).

## Verification Results

- `pnpm test:all`: 63/63 test suites passed (796 tests passed, 0 failed).
- `pnpm build:all`: 9/9 projects built successfully including Next.js frontend production bundle.
- `node scripts/verify-docs.mjs`: 0 doc errors.
- `node scripts/verify-product-identity.mjs`: 0 violations.
- PostgreSQL integration test suite: 2 consecutive passes (17/17 passed in both runs).
