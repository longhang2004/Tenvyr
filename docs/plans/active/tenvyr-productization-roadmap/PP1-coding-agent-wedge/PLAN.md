---
title: "PP1 Plan: Coding-Agent Control Plane Wedge"
status: planned
audience:
  - developer
last_verified: 2026-08-17
sources:
  - services/local-executor-host/src/config.ts
  - services/local-executor-host/src/supervisor.ts
  - services/orchestrator/src/services/workbench-command.service.ts
  - services/orchestrator/src/services/execution.service.ts
  - services/orchestrator/src/services/runtime-coordination.service.ts
  - services/orchestrator/src/services/workspace.service.ts
---

# PP1 Plan — Coding-Agent Control Plane Wedge

## Repository truth found (audited from source)

- The local executor host launches every runtime child with the STATIC
  operator-configured `HostAgentConfig.cwd` (`supervisor.ts`:
  `spawn(profile.command, ..., { cwd: profile.cwd, ... })`), resolved at
  config-parse time against `EXECUTOR_HOST_ALLOWED_ROOT`. The selected
  Workspace NEVER reaches `process.cwd()` — workspace identity is
  provenance only (Technical Lead audit confirmed).
- `WorkspaceSnapshotV1` captures only git identity (repoRoot/branch/headSha/
  dirty); NO code creates git worktrees today (`grep worktree` = 0 matches).
- `startTeamRun` freezes the workspace snapshot BEFORE the authority
  transaction, then creates pipeline + execution + CoordinationRun +
  iteration 1 inside `runCommand` (audited + idempotent).
- The claim (`claimRunnableStep`) already loads `coordination_runs` per
  claim (P3 workspace identity) and builds the outbox invocation metadata
  `{ orchestration: { maxAttempts } }` — the natural reserved seam.
- `approval.service.ts approve()` writes a SECOND outbox invocation for
  resumed WAITING attempts — it must carry the same reserved member.
- `AgentInvocationV1` is a closed v1 contract: `metadata` is an
  `additionalProperties` jsonValue map, so a RESERVED Tenvyr-owned member
  (`metadata.tenvyr.executionWorkspace`) is backward-compatible; user/
  planner input lives under `input` and can never override it.
- Host config validation already fails closed on cwd traversal/symlink
  escape; the same containment discipline applies per-invocation.

## Slice A — workspace execution binding + Isolation V1

### A1. Reserved invocation member (Pivot Invariant 1)

```jsonc
// outbox invocation metadata — Tenvyr-owned, never planner-authored:
"metadata": {
  "orchestration": { "maxAttempts": 1 },
  "tenvyr": {
    "executionWorkspace": {
      "schemaVersion": 1,
      "workspaceExecutionId": "<uuid>",
      "path": "/abs/execution/path",
      "mode": "shared" | "git-worktree",
      "sourceWorkspaceId": "ws:...",
      "baseHeadSha": "40hex" | null
    }
  }
}
```

Host behavior (fail closed BEFORE spawn): when present, the path must be an
absolute existing directory whose realpath resolves INSIDE
`EXECUTOR_HOST_ALLOWED_ROOT` (no traversal, no symlink escape); spawn cwd =
the validated realpath; invalid/missing (when `requireExecutionWorkspace:
true`) → `EXECUTOR_HOST_WORKSPACE_PATH_INVALID` refusal. Absent member +
no requirement → today's static cwd (backward compatible).

### A2. WorkspaceExecution lease (durable, recoverable)

New table `workspace_executions` (migration `1722270021000-...`):

```text
id, sourceWorkspaceId, sourcePath, mode (shared|git-worktree),
executionPath (null until READY), baseBranch, baseHeadSha,
ownerRunId (UNIQUE — one run per lease), state, failureCode,
hasUncommittedWork, createdAt, updatedAt
```

Lifecycle: `ALLOCATING → READY → IN_USE → PRESERVED → REMOVED` (+ `FAILED`).

- ALLOCATING row is committed BEFORE any external git mutation (crash leaves
  a durable row); git-worktree allocation = `git worktree add <path> -b
  tenvyr/run-<id>` from the source repo (no network, no clone, no shell);
  "already exists" verified via `git worktree list --porcelain` for retry
  idempotency; success = directory exists → READY; failure → FAILED with a
  precise code — never READY, never silently shared.
- Non-git directory + git-worktree requested → FAILED with precise reason.
- IN_USE → PRESERVED when the owner run reaches a terminal phase; for
  git-worktree mode `hasUncommittedWork` is captured once at that point
  (`git status --porcelain`, bounded, like captureGitIdentity).
- Reconciliation: ALLOCATING older than the bound → FAILED
  (ALLOCATION_INTERRUPTED); READY whose owner run never materialized →
  FAILED (RUN_NOT_BOUND). Runs lazily on run start + attention read.
- Cleanup (audited command `workspace-release`): PRESERVED git-worktree →
  `git worktree remove` WITHOUT `--force` — git itself refuses dirty trees
  (operator work preserved); already-removed → REMOVED (idempotent);
  shared mode → refused with explanation. No auto-merge/push/branch delete.

### A3. Wiring

- `startTeamRun` gains `executionIsolation?: "shared" | "git-worktree"`
  (default shared): allocate BEFORE the authority transaction (external git
  mutation), bind `ownerRunId` + IN_USE inside it.
- Claim + approval-resume outbox writers embed the reserved member when the
  run owns a READY/IN_USE execution workspace.
- Capsule + Workbench projections expose a bounded `executionWorkspace`
  block (mode, path, base, state) — never huge internal ids unless useful.

### A4. Dogfood (Slice A)

Real temporary git repo A; real local-executor-host with ≥2 fake coding
runtime children; team run with git-worktree isolation → execution path B;
assert B ≠ A, planner/worker/verifier child cwds == B, worker mutation lands
in B, A unchanged, task input cannot override cwd, traversal/symlink fails
closed, Capsule/Workbench preserve the identity. No provider credentials.

## Slice B — Attention Queue V1 (read projection, no new authority)

Derived from durable rows with deterministic ids (`attention:<kind>:<id>`):
HUMAN_APPROVAL_REQUIRED (approval_requests PENDING), RUN_FAILED (terminal
FAILED/CANCELLED executions), LIMIT_REACHED (run phase), WORKSPACE_REQUIRES_ATTENTION
(preserved git-worktree with uncommitted work). Resolution = existing
authoritative commands (approve/deny/cancel/workspace-release). New `GET
workbench/attention` + `/attention` page + exception-first dashboard.

## Slice C — Portable Handoff V1

Bounded `HandoffBundleV1` (references, never raw logs/credentials/COT) +
strict parse; audited `continue-run` command: source run must be TERMINAL;
execution-workspace transfer only under exclusive ownership (UNIQUE
ownerRunId; concurrent transfer fails closed); new execution/run with
lineage row (handoffs table, mirror of execution_replays); destination
runtime target frozen through existing P2 authority; source Capsule +
runtime target untouched; destination Capsule records handoff lineage.

## Docs/roadmap reset

README first-screen wedge + technical architecture below; docs truth
cleanup (opencode auth-list drift, P3 status, host cwd truth); new
architecture docs (workspace-execution, attention, handoff); roadmap reset
to PP1 sequence; Workbench IA (Setup/Work/Advanced).