---
title: "Workspace Execution and Isolation"
status: current
audience:
  - developer
  - operator
last_verified: 2026-08-17
sources:
  - services/orchestrator/src/domain/workspace-execution.ts
  - services/orchestrator/src/services/workspace-execution.service.ts
  - services/orchestrator/src/entities/workspace-execution.entity.ts
  - services/orchestrator/src/services/execution.service.ts
  - services/local-executor-host/src/config.ts
  - services/local-executor-host/src/main.ts
---

# Workspace Execution and Isolation

## Pivot invariant 1

> If a Team Run selects Workspace W, every local coding-runtime process
> admitted for that run executes against Tenvyr's authoritative execution
> path for W.

Workspace identity is no longer provenance-only: it is an execution
boundary. The selected workspace is frozen into a `WorkspaceSnapshotV1`
(identity only), a Tenvyr-owned **WorkspaceExecution lease** is allocated
for the run, and every Planner / Worker / Verifier runtime child of the run
spawns with `process.cwd()` equal to that lease's execution path.

## Execution path authority

The execution path rides the invocation inside the **reserved Tenvyr-owned
metadata member** — `invocation.metadata.tenvyr.executionWorkspace`
(`ExecutionWorkspaceIdentityV1`: schemaVersion, workspaceExecutionId, path,
mode, sourceWorkspaceId, baseHeadSha). `AgentInvocationV1` stays a closed
v1 contract: the member lives inside the existing `metadata` jsonValue map.
Planner/worker task input lives under `input` and can never override cwd.

The local executor host (`resolveExecutionCwd`) validates the member before
spawn and fails closed (`EXECUTOR_HOST_WORKSPACE_PATH_INVALID`):

- path must be absolute and resolve to an existing directory;
- its REAL path must resolve inside `EXECUTOR_HOST_ALLOWED_ROOT` — no path
  traversal, no symlink escape (the spawn uses the resolved real path, so a
  symlink swapped after validation cannot redirect the spawn);
- agents may declare `requireExecutionWorkspace: true` — an invocation
  without the member is refused (workspace-less dispatch never spawns);
- absent member + no requirement → the static operator-configured cwd
  (backward compatible).

Both outbox writers (claim + approval resume) embed the same member.

## Isolation modes

- **shared** — the run executes against the source workspace itself
  (mutable working tree; today's behavior, now explicit).
- **git-worktree** — Tenvyr creates ONE isolated Git worktree of the source
  repository (`git worktree add <executionRoot>/run-<id> -b
  tenvyr/run-<id>`; no network, no clone, no shell) and every runtime child
  executes there. The source repository stays untouched.

A requested `git-worktree` mode on a non-git directory is **rejected with a
precise reason** — never silently downgraded to shared. Failed allocation
is never reported READY.

## Lease lifecycle (durable, recoverable)

`workspace_executions` row: id, sourceWorkspaceId, sourcePath, mode,
executionPath (null until READY), baseBranch, baseHeadSha, ownerRunId
(UNIQUE — one run per lease), state, failureCode, hasUncommittedWork,
timestamps.

```text
ALLOCATING → READY → IN_USE → PRESERVED → REMOVED
                                ↘ TRANSFERRED (handoff)
ALLOCATING / unbound READY → FAILED (reconciliation, never falsely READY)
```

- The ALLOCATING row commits BEFORE any external `git worktree` mutation;
  READY is only written after the worktree demonstrably exists
  (realpath check); a retry whose worktree already exists is verified via
  `git worktree list --porcelain` and succeeds (idempotent).
- Allocation happens BEFORE the run's authority transaction; binding
  (ownerRunId + IN_USE) happens inside it.
- Terminal-run leases become PRESERVED (lazy reconciliation on run start /
  attention read); for git-worktree mode `hasUncommittedWork` is captured
  once at that point (`git status --porcelain`).
- **Preservation over destruction**: `workspace-release` removes a worktree
  with `git worktree remove` WITHOUT `--force` — Git itself refuses dirty
  trees (operator/agent work is preserved); already-removed worktrees are an
  idempotent success; shared mode has nothing to remove and is refused.
  No automatic merge/push/branch deletion.
- Handoff transfers mark the source lease TRANSFERRED (identity preserved)
  and give the destination a NEW lease on the same physical worktree —
  two runs never share an IN_USE lease.

## Provenance

The Capsule and Workbench projections expose the bounded lease block
(mode, path, base, state, hasUncommittedWork); run launch shows the frozen
base (`branch @ HEAD`); the run detail shows the Execution Workspace
(Source / Mode / Path / Base / State).

## Configuration

- `TENVYR_WORKSPACE_ROOT` (orchestrator): root for isolated execution
  workspaces (default `<tmpdir>/tenvyr-workspaces`). MUST resolve inside
  the host's `EXECUTOR_HOST_ALLOWED_ROOT`.
- `EXECUTOR_HOST_ALLOWED_ROOT` (host): the containment root for every
  runtime child cwd (static or invocation-carried).

## Non-goals

Not a sandbox (trusted-code-only); no snapshot isolation of the source
tree in shared mode; no remote cloning; no automatic merge/push; no
per-invocation full-repo hashing.