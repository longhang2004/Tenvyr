import { Inject, Injectable } from "@nestjs/common";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, realpathSync, statSync } from "node:fs";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DataSource, In, type EntityManager, Repository } from "typeorm";
import { WorkspaceExecutionEntity } from "../entities/workspace-execution.entity";
import { CoordinationRunEntity } from "../entities/coordination-run.entity";
import { OperatorActionEntity } from "../entities/operator-action.entity";
import type { WorkspaceSnapshotV1 } from "../domain/workspace";
import {
  WORKSPACE_EXECUTION_BOUNDS,
  WorkspaceExecutionError,
  executionWorkspaceIdentityFromRow,
  type ExecutionWorkspaceIdentityV1,
  type WorkspaceExecutionModeV1,
} from "../domain/workspace-execution";

/**
 * PP1 — Workspace Execution / Isolation V1.
 *
 * Tenvyr's authoritative execution boundary for a Team Run. Allocation
 * deliberately commits the ALLOCATING row BEFORE any external `git worktree`
 * mutation; READY is only written after the worktree demonstrably exists;
 * interrupted allocations are reconciled to FAILED (never falsely READY);
 * UNIQUE(ownerRunId) makes concurrent ownership of one lease impossible.
 *
 * Git mutations are bounded local process executions (no shell, no network,
 * GIT_TERMINAL_PROMPT=0) — the same discipline as captureGitIdentity.
 * Preservation over destruction: release removes a worktree only when Git
 * itself proves it clean (`git worktree remove` without --force); dirty
 * trees stay PRESERVED for operator inspection.
 */

const GIT_WORKTREE_BOUNDS = {
  wallTimeMs: 120_000,
  maxOutputBytes: 16 * 1024,
} as const;

export type GitResult = {
  status: number | null;
  stdout: string;
  stderr: string;
};

export type GitRunner = (cwd: string, args: string[]) => GitResult;

let defaultGitRunner: GitRunner = (cwd, args) => {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    shell: false,
    timeout: GIT_WORKTREE_BOUNDS.wallTimeMs,
    maxBuffer: GIT_WORKTREE_BOUNDS.maxOutputBytes,
    env: {
      PATH: process.env.PATH ?? "",
      GIT_OPTIONAL_LOCKS: "0",
      GIT_TERMINAL_PROMPT: "0",
    },
  });
  return {
    status: result.status ?? (result.error ? -1 : null),
    stdout: (result.stdout ?? "").slice(0, GIT_WORKTREE_BOUNDS.maxOutputBytes),
    stderr: (result.stderr ?? "").slice(0, GIT_WORKTREE_BOUNDS.maxOutputBytes),
  };
};

let currentGitRunner: GitRunner = defaultGitRunner;
let removeInvocationCount = 0;
let beforeRemoveHook: (() => Promise<void>) | null = null;

export function setGitRunner(runner: GitRunner | null): void {
  currentGitRunner = runner ?? defaultGitRunner;
}

export function getGitRunner(): GitRunner {
  return currentGitRunner;
}

export function setBeforeRemoveHook(hook: (() => Promise<void>) | null): void {
  beforeRemoveHook = hook;
}

export function getRemoveInvocationCount(): number {
  return removeInvocationCount;
}

export function resetRemoveInvocationCount(): void {
  removeInvocationCount = 0;
}

export function runBoundedGit(cwd: string, args: string[]): GitResult {
  return currentGitRunner(cwd, args);
}

/** Is `executionPath` registered as a git worktree of the repo at
 *  `sourceRepoRoot`? Verified via `git worktree list --porcelain` — never
 *  assumed from a failed `add`. Each porcelain block is
 *  `worktree <path>\nHEAD <sha>\nbranch ...\n\n` — compare the block's
 *  first line against the CANONICAL path (git reports realpaths, e.g.
 *  /private/tmp on macOS, so the compared path is realpath-normalized when
 *  it exists). */
export function worktreeIsRegistered(
  sourceRepoRoot: string,
  executionPath: string,
): boolean {
  let canonical = executionPath;
  try {
    canonical = fs.realpathSync(executionPath);
  } catch {
    // Path does not exist (yet) — compare the raw form.
  }
  const listed = runBoundedGit(sourceRepoRoot, ["worktree", "list", "--porcelain"]);
  return listed.stdout.split("worktree ").some((block) => {
    const firstLine = block.trim().split("\n")[0];
    return firstLine === canonical;
  });
}

export function assertAllocationCompatible(
  existing: WorkspaceExecutionEntity,
  workspace: WorkspaceSnapshotV1,
  mode: WorkspaceExecutionModeV1,
): void {
  if (
    existing.sourceWorkspaceId !== workspace.workspaceId ||
    existing.mode !== mode ||
    (existing.baseHeadSha &&
      workspace.headSha &&
      existing.baseHeadSha !== workspace.headSha) ||
    (mode === "shared" && existing.sourcePath !== workspace.path)
  ) {
    throw new WorkspaceExecutionError(
      "ALLOCATION_CONFLICT",
      `Allocation key "${existing.allocationKey}" already used with conflicting parameters`,
    );
  }
}

/** Create one isolated git worktree (no network, no clone, no shell).
 *  Returns null on success; a bounded error message when creation failed
 *  and the path is not already registered (retry idempotency). */
export function addGitWorktree(
  sourceRepoRoot: string,
  executionPath: string,
  branch: string,
  frozenHeadSha?: string | null,
): string | null {
  const args = ["worktree", "add", "-b", branch, executionPath];
  if (frozenHeadSha) {
    args.push(frozenHeadSha);
  }
  const added = runBoundedGit(sourceRepoRoot, args);
  if (added.status === 0) {
    if (frozenHeadSha) {
      const headCheck = runBoundedGit(executionPath, ["rev-parse", "HEAD"]);
      if (headCheck.status !== 0 || headCheck.stdout.trim() !== frozenHeadSha) {
        return `Worktree HEAD mismatch: expected ${frozenHeadSha}, got ${headCheck.stdout.trim()}`;
      }
    }
    return null;
  }
  // Retry idempotency: an interrupted previous attempt may have created the
  // worktree before the DB update. Verify registration before success.
  if (worktreeIsRegistered(sourceRepoRoot, executionPath)) {
    if (frozenHeadSha) {
      const headCheck = runBoundedGit(executionPath, ["rev-parse", "HEAD"]);
      if (headCheck.status === 0 && headCheck.stdout.trim() === frozenHeadSha) {
        return null;
      }
    } else {
      return null;
    }
  }
  return (added.stderr || "git worktree add failed").slice(0, 512);
}

/** Remove a worktree WITHOUT --force (Git refuses dirty trees — operator
 *  work is preserved). Returns "removed" | "already-removed" | { refused:
 *  reason, code } where code distinguishes proven-dirty vs unknown/operational. */
export function removeGitWorktree(
  sourceRepoRoot: string,
  executionPath: string,
): "removed" | "already-removed" | { refused: string; code: "WORKTREE_DIRTY" | "WORKTREE_REMOVE_FAILED" | "WORKTREE_STATE_UNKNOWN" } {
  removeInvocationCount++;
  const removed = runBoundedGit(sourceRepoRoot, [
    "worktree",
    "remove",
    executionPath,
  ]);
  if (removed.status === 0) return "removed";
  if (!worktreeIsRegistered(sourceRepoRoot, executionPath)) {
    return "already-removed";
  }
  const stderrLower = (removed.stderr || "").toLowerCase();
  const refused = (removed.stderr || "git worktree remove failed").slice(0, 512);
  // Only claim dirty when Git's refusal indicates dirty/untracked changes;
  // otherwise the failure is operational/unknown and must not set hasUncommittedWork.
  // Git's message varies: "contains modified files", "contains untracked files", or combined "contains modified or untracked files"
  const looksDirty =
    stderrLower.includes("contains modified") ||
    stderrLower.includes("contains untracked") ||
    stderrLower.includes("untracked files") ||
    stderrLower.includes("modified files") ||
    (stderrLower.includes("cannot remove") && (stderrLower.includes("dirty") || stderrLower.includes("modified") || stderrLower.includes("untracked")));
  if (looksDirty || stderrLower.includes("dirty")) {
    return { refused, code: "WORKTREE_DIRTY" };
  }
  // Deterministic operational failure vs unknown state
  if (removed.status !== null && removed.status !== 0) {
    return { refused, code: "WORKTREE_REMOVE_FAILED" };
  }
  return { refused, code: "WORKTREE_STATE_UNKNOWN" };
}

/** Tenvyr-owned root for isolated execution workspaces. Operator-configurable
 *  via TENVYR_WORKSPACE_ROOT; MUST resolve inside the local executor host's
 *  EXECUTOR_HOST_ALLOWED_ROOT for the pivot invariant to hold. */
export function workspaceExecutionRoot(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.TENVYR_WORKSPACE_ROOT;
  return configured ? path.resolve(configured) : path.join(os.tmpdir(), "tenvyr-workspaces");
}

@Injectable()
export class WorkspaceExecutionService {
  private readonly executions: Repository<WorkspaceExecutionEntity>;

  constructor(@Inject("DATA_SOURCE") private readonly dataSource: DataSource) {
    this.executions =
      typeof dataSource?.getRepository === "function"
        ? dataSource.getRepository(WorkspaceExecutionEntity)
        : ({} as any);
  }

  /**
   * Allocate a Tenvyr-owned execution workspace for a run (BEFORE the
   * authority transaction — external git mutations are never transactional).
   * Returns the row in READY state, or throws WorkspaceExecutionError with a
   * precise failureCode when allocation failed (never silently shared).
   * Retry-safe: an interrupted previous attempt whose worktree already
   * exists is verified via `git worktree list --porcelain` and succeeds.
   */
  async allocateExecutionWorkspace(
    workspace: WorkspaceSnapshotV1,
    mode: WorkspaceExecutionModeV1,
    allocationKey?: string | null,
  ): Promise<WorkspaceExecutionEntity> {
    await this.reconcileWorkspaceExecutions();

    // Idempotency: check if an existing allocation exists for this allocationKey
    if (allocationKey) {
      const existing = await this.executions.findOne({
        where: { allocationKey },
      });
      if (existing) {
        assertAllocationCompatible(existing, workspace, mode);
        if (existing.state === "READY" || existing.state === "IN_USE") {
          return existing;
        }
        if (existing.state === "ALLOCATING" && existing.executionPath) {
          if (
            workspace.repoRoot &&
            worktreeIsRegistered(workspace.repoRoot, existing.executionPath)
          ) {
            const headCheck = runBoundedGit(existing.executionPath, [
              "rev-parse",
              "HEAD",
            ]);
            if (
              !existing.baseHeadSha ||
              headCheck.stdout.trim() === existing.baseHeadSha
            ) {
              return this.transition(existing.id, "READY");
            }
          }
        }
      }
    }

    if (mode === "shared") {
      try {
        const entity = await this.executions.save(
          this.executions.create({
            sourceWorkspaceId: workspace.workspaceId,
            sourcePath: workspace.path,
            mode,
            executionPath: workspace.path,
            baseBranch: workspace.branch ?? null,
            baseHeadSha: workspace.headSha ?? null,
            ownerRunId: null,
            allocationKey: allocationKey ?? null,
            state: "READY",
          }),
        );
        return entity;
      } catch (err: any) {
        if (
          allocationKey &&
          (err?.code === "23505" ||
            String(err?.message).toLowerCase().includes("unique") ||
            String(err?.message).toLowerCase().includes("duplicate key"))
        ) {
          const existing = await this.executions.findOne({
            where: { allocationKey },
          });
          if (existing) {
            assertAllocationCompatible(existing, workspace, mode);
            return existing;
          }
        }
        throw err;
      }
    }

    // git-worktree mode: the source must be a detectable git repository
    // with a HEAD — otherwise fail closed with a precise reason (never
    // silently fall back to shared).
    if (!workspace.repoRoot || !workspace.headSha) {
      throw new WorkspaceExecutionError(
        "NOT_A_GIT_REPOSITORY",
        `Workspace "${workspace.workspaceId}" is not a detectable git repository with a HEAD; git-worktree isolation cannot be created (no silent fallback)`,
      );
    }
    const root = workspaceExecutionRoot();
    try {
      mkdirSync(root, { recursive: true });
    } catch {
      throw new WorkspaceExecutionError(
        "EXECUTION_ROOT_UNWRITABLE",
        `Execution workspace root "${root}" is not writable`,
      );
    }

    const shortId = randomUUID().slice(0, 12);
    const executionPath = path.join(root, `run-${shortId}`);
    const branch = `tenvyr/run-${shortId}`;

    // Persist ALLOCATING row with intended executionPath, baseBranch, baseHeadSha BEFORE git add
    let entity: WorkspaceExecutionEntity;
    try {
      entity = await this.executions.save(
        this.executions.create({
          sourceWorkspaceId: workspace.workspaceId,
          sourcePath: workspace.path,
          mode,
          executionPath,
          baseBranch: workspace.branch ?? null,
          baseHeadSha: workspace.headSha,
          ownerRunId: null,
          allocationKey: allocationKey ?? null,
          state: "ALLOCATING",
        }),
      );
    } catch (err: any) {
      if (
        allocationKey &&
        (err?.code === "23505" ||
          String(err?.message).toLowerCase().includes("unique") ||
          String(err?.message).toLowerCase().includes("duplicate key"))
      ) {
        const existing = await this.executions.findOne({
          where: { allocationKey },
        });
        if (existing) {
          assertAllocationCompatible(existing, workspace, mode);
          if (existing.state === "READY" || existing.state === "IN_USE") {
            return existing;
          }
          for (let attempt = 0; attempt < 50; attempt++) {
            await new Promise((resolve) => setTimeout(resolve, 100));
            const reloaded = await this.executions.findOne({
              where: { id: existing.id },
            });
            if (reloaded) {
              if (reloaded.state === "READY" || reloaded.state === "IN_USE") {
                return reloaded;
              }
              if (reloaded.state === "FAILED") {
                throw new WorkspaceExecutionError(
                  reloaded.failureCode ?? "WORKTREE_CREATE_FAILED",
                  `Concurrent allocation failed with code ${reloaded.failureCode}`,
                );
              }
            }
          }
        }
      }
      throw err;
    }

    const addedError = addGitWorktree(
      workspace.repoRoot,
      executionPath,
      branch,
      workspace.headSha,
    );
    if (addedError !== null) {
      await this.transition(entity.id, "FAILED", {
        failureCode: "WORKTREE_CREATE_FAILED",
      });
      throw new WorkspaceExecutionError(
        "WORKTREE_CREATE_FAILED",
        `git worktree add failed for run ${shortId}: ${addedError}`,
      );
    }
    let real: string;
    try {
      real = realpathSync(executionPath);
    } catch {
      await this.transition(entity.id, "FAILED", {
        failureCode: "WORKTREE_MISSING",
      });
      throw new WorkspaceExecutionError(
        "WORKTREE_MISSING",
        `git worktree add reported success but "${executionPath}" is not a directory`,
      );
    }
    if (!statSync(real).isDirectory()) {
      await this.transition(entity.id, "FAILED", {
        failureCode: "WORKTREE_MISSING",
      });
      throw new WorkspaceExecutionError(
        "WORKTREE_MISSING",
        `git worktree add reported success but "${real}" is not a directory`,
      );
    }
    return this.transition(entity.id, "READY", { executionPath: real });
  }

  /**
   * Bind a READY lease to its exclusive run owner inside the authority
   * transaction (UNIQUE(ownerRunId) + guarded UPDATE make concurrent or
   * double ownership impossible; a FAILED allocation aborts the run start
   * with its precise code).
   */
  async bindExecutionWorkspace(
    manager: EntityManager,
    workspaceExecutionId: string,
    runId: string,
  ): Promise<WorkspaceExecutionEntity> {
    const repository = manager.getRepository(WorkspaceExecutionEntity);
    const result = await repository
      .createQueryBuilder()
      .update(WorkspaceExecutionEntity)
      .set({ ownerRunId: runId, state: "IN_USE" })
      .where("id = :id AND ownerRunId IS NULL AND state = 'READY'", {
        id: workspaceExecutionId,
      })
      .execute();
    if (result.affected === 1) {
      const bound = await repository.findOneOrFail({
        where: { id: workspaceExecutionId },
      });
      return bound;
    }
    const row = await repository.findOne({ where: { id: workspaceExecutionId } });
    if (!row) {
      throw new WorkspaceExecutionError(
        "LEASE_NOT_FOUND",
        `Execution workspace "${workspaceExecutionId}" does not exist`,
      );
    }
    if (row.state === "FAILED") {
      throw new WorkspaceExecutionError(
        row.failureCode ?? "ALLOCATION_FAILED",
        `Execution workspace allocation failed: ${row.failureCode ?? "unknown"}`,
      );
    }
    throw new WorkspaceExecutionError(
      "LEASE_NOT_AVAILABLE",
      `Execution workspace "${workspaceExecutionId}" is already owned (state ${row.state})`,
    );
  }

  /** The frozen reserved invocation identity for a run's lease, when the
   *  run owns a READY/IN_USE execution workspace (null otherwise). */
  async executionWorkspaceIdentityForRun(
    manager: EntityManager,
    runId: string,
  ): Promise<ExecutionWorkspaceIdentityV1 | null> {
    const row = await manager
      .getRepository(WorkspaceExecutionEntity)
      .findOne({ where: { ownerRunId: runId } });
    if (!row) return null;
    return executionWorkspaceIdentityFromRow(row);
  }

  /**
   * PP1 Slice C: allocate + bind a SHARED lease inside the caller's
   * transaction (no external git mutation — safe transactionally). Shared
   * mode executes against the source workspace itself.
   */
  async allocateSharedExecutionWorkspaceWithManager(
    manager: EntityManager,
    workspace: WorkspaceSnapshotV1,
    runId: string,
  ): Promise<WorkspaceExecutionEntity> {
    const repository = manager.getRepository(WorkspaceExecutionEntity);
    const entity = await repository.save(
      repository.create({
        sourceWorkspaceId: workspace.workspaceId,
        sourcePath: workspace.path,
        mode: "shared",
        baseBranch: workspace.branch ?? null,
        baseHeadSha: workspace.headSha ?? null,
        ownerRunId: null,
        state: "ALLOCATING",
      }),
    );
    await repository.update(entity.id, {
      state: "READY",
      executionPath: workspace.path,
    });
    return this.bindExecutionWorkspace(manager, entity.id, runId);
  }

  /**
   * PP1 Slice C: transfer a PRESERVED git-worktree lease to a continuation
   * run under EXCLUSIVE ownership. The SOURCE lease keeps its identity
   * (state TRANSFERRED — the source run's Capsule/provenance never loses
   * where it executed); the DESTINATION receives a NEW lease row for the
   * SAME physical worktree (base identity copied), so two runs never share
   * an IN_USE lease. Guarded rebind: a concurrent continuation fails
   * closed (never a false READY, never double ownership).
   */
  async transferExecutionWorkspaceWithManager(
    manager: EntityManager,
    sourceLeaseId: string,
    fromRunId: string,
    toRunId: string,
  ): Promise<WorkspaceExecutionEntity> {
    const repository = manager.getRepository(WorkspaceExecutionEntity);
    const transferred = await repository
      .createQueryBuilder()
      .update(WorkspaceExecutionEntity)
      .set({ state: "TRANSFERRED" })
      .where(
        "id = :id AND ownerRunId = :fromRunId AND state = 'PRESERVED'",
        { id: sourceLeaseId, fromRunId },
      )
      .execute();
    if (transferred.affected !== 1) {
      const row = await repository.findOne({ where: { id: sourceLeaseId } });
      throw new WorkspaceExecutionError(
        "LEASE_NOT_AVAILABLE",
        `Execution workspace "${sourceLeaseId}" is not transferable (state ${row?.state ?? "missing"}); the continuation cannot safely own it`,
      );
    }
    const source = await repository.findOneOrFail({
      where: { id: sourceLeaseId },
    });
    if (!source.executionPath) {
      throw new WorkspaceExecutionError(
        "LEASE_PATH_MISSING",
        `Execution workspace "${sourceLeaseId}" has no execution path`,
      );
    }
    // The physical worktree already exists + is registered; the destination
    // lease documents the same base identity.
    const destination = await repository.save(
      repository.create({
        sourceWorkspaceId: source.sourceWorkspaceId,
        sourcePath: source.sourcePath,
        mode: "git-worktree",
        executionPath: source.executionPath,
        baseBranch: source.baseBranch ?? null,
        baseHeadSha: source.baseHeadSha ?? null,
        ownerRunId: toRunId,
        state: "IN_USE",
      }),
    );
    return destination;
  }

  /**
   * Crash-recovery reconciliation (fail-closed): interrupted allocations
   * become FAILED (never READY); terminal-run leases become PRESERVED with
   * `hasUncommittedWork` captured once for git-worktree mode.
   */
  async reconcileWorkspaceExecutions(
    now: Date = new Date(),
  ): Promise<number> {
    const interruptedBoundary = new Date(
      now.getTime() - WORKSPACE_EXECUTION_BOUNDS.allocationInterruptMs,
    );
    const repository = this.dataSource.getRepository(WorkspaceExecutionEntity);
    let transitions = 0;
    // ALLOCATING rows: check if worktree was created and valid before failing
    const interrupted = await repository
      .createQueryBuilder("lease")
      .where("lease.state = 'ALLOCATING'")
      .getMany();
    for (const row of interrupted) {
      if (row.mode === "git-worktree" && row.executionPath && row.sourcePath) {
        if (worktreeIsRegistered(row.sourcePath, row.executionPath)) {
          const headCheck = runBoundedGit(row.executionPath, [
            "rev-parse",
            "HEAD",
          ]);
          if (
            !row.baseHeadSha ||
            headCheck.stdout.trim() === row.baseHeadSha
          ) {
            await this.transition(row.id, "READY");
            transitions++;
            continue;
          } else {
            await this.transition(row.id, "FAILED", {
              failureCode: "ALLOCATION_MISMATCH",
            });
            transitions++;
            continue;
          }
        }
      }
      if (
        now.getTime() - new Date(row.createdAt).getTime() >
        WORKSPACE_EXECUTION_BOUNDS.allocationInterruptMs
      ) {
        await this.transition(row.id, "FAILED", {
          failureCode: "ALLOCATION_INTERRUPTED",
        });
        transitions++;
      }
    }
    // READY rows never bound to a run (crash between allocation and the
    // authority transaction).
    const unboundCandidates = await repository
      .createQueryBuilder("lease")
      .where("lease.state = 'READY'")
      .andWhere("lease.ownerRunId IS NULL")
      .getMany();
    for (const row of unboundCandidates) {
      if (
        now.getTime() - new Date(row.createdAt).getTime() >
        WORKSPACE_EXECUTION_BOUNDS.allocationInterruptMs
      ) {
        await this.transition(row.id, "FAILED", {
          failureCode: "RUN_NOT_BOUND",
        });
        transitions++;
      }
    }
    // IN_USE leases whose owner run reached a terminal phase → PRESERVED.
    const inUse = await repository
      .createQueryBuilder("lease")
      .where("lease.state = 'IN_USE'")
      .getMany();
    if (inUse.length > 0) {
      const runIds = inUse
        .map((row) => row.ownerRunId)
        .filter((id): id is string => id !== null);
      const runs = runIds.length
        ? await this.dataSource
            .getRepository(CoordinationRunEntity)
            .find({ where: { id: In(runIds) } })
        : [];
      const terminalByRun = new Map(
        runs
          .filter((run) =>
            (
              ["ACCEPTED", "FAILED", "CANCELLED", "LIMIT_REACHED"] as string[]
            ).includes(run.phase),
          )
          .map((run) => [run.id, run]),
      );
      for (const row of inUse) {
        if (!row.ownerRunId || !terminalByRun.has(row.ownerRunId)) continue;
        let hasUncommittedWork: boolean | null = null;
        if (row.mode === "git-worktree" && row.executionPath) {
          const porcelain = runBoundedGit(row.executionPath, [
            "status",
            "--porcelain",
          ]);
          hasUncommittedWork =
            porcelain.status === 0
              ? porcelain.stdout.trim().length > 0
              : null;
        }
        await this.transition(row.id, "PRESERVED", { hasUncommittedWork });
        transitions++;
      }
    }
    // RELEASE_REQUESTED: generic reconciliation must NEVER perform the external Git mutation
    // except for two non-destructive cases: already-removed worktree (just mark REMOVED) and legacy/unmatched (fail-closed).
    // The single authorized path for the actual Git mutation is WorkspaceExecutionService.releaseExecutionWorkspace via WorkbenchCommandService.
    const releasing = await repository
      .createQueryBuilder("lease")
      .where("lease.state = 'RELEASE_REQUESTED'")
      .getMany();
    for (const row of releasing) {
      if (!row.executionPath) {
        await this.transition(row.id, "REMOVED");
        transitions++;
        continue;
      }
      const opId = (row as unknown as { releaseOperationId?: string | null }).releaseOperationId;
      if (!opId) {
        await this.transition(row.id, "PRESERVED", {
          failureCode: "RELEASE_UNAUTHORIZED",
          hasUncommittedWork: null,
        });
        transitions++;
        continue;
      }
      const hasAuthority = await this.hasReleaseAuthority(row);
      if (!hasAuthority) {
        await this.transition(row.id, "PRESERVED", {
          failureCode: "RELEASE_UNAUTHORIZED",
          hasUncommittedWork: null,
        });
        transitions++;
        continue;
      }
      // Matched RELEASE_REQUESTED: if worktree already gone, just mark REMOVED (non-destructive check); otherwise leave for operation recovery.
      if (!worktreeIsRegistered(row.sourcePath, row.executionPath)) {
        await this.transition(row.id, "REMOVED");
        transitions++;
        continue;
      }
      // Matched and still registered — do NOT Git here; the owning release operation's recovery (stale takeover + target CAS) will handle it.
    }

    // Reconcile any pending release-execution-workspace OperatorActions
    try {
      const actionsRepo = this.dataSource.getRepository(OperatorActionEntity);
      const pendingActions = await actionsRepo
        .createQueryBuilder("action")
        .where("action.action = 'release-execution-workspace'")
        .getMany();

      for (const act of pendingActions) {
        const outcome = act.outcome as Record<string, unknown> | undefined;
        if (outcome?.pending === true && act.targetId) {
          const lease = await repository.findOne({ where: { id: act.targetId } });
          if (!lease) {
            await actionsRepo.update(
              { id: act.id },
              {
                outcome: {
                  workspaceExecutionId: act.targetId,
                  state: "NOT_FOUND",
                  failureCode: "LEASE_NOT_FOUND",
                  error: `Execution workspace "${act.targetId}" does not exist`,
                  refusal: true,
                },
              },
            );
            continue;
          }
          const phase = (outcome as { phase?: string }).phase;
          if (lease.state === "REMOVED") {
            await actionsRepo.update(
              { id: act.id },
              {
                outcome: {
                  workspaceExecutionId: lease.id,
                  state: lease.state,
                },
              },
            );
          } else if (lease.state === "PRESERVED") {
            // PP1 FINAL: never fabricate success for a clean PRESERVED that is not the result of this exact operation.
            // A PRESERVED with matching releaseOperationId and a failureCode is a truthful refusal from this operation.
            // A clean PRESERVED (or mismatched operation) with pending EXECUTING/REQUESTED is a crash-before-release → INTERRUPTED or keep pending for takeover.
            if (lease.releaseOperationId === act.id && lease.failureCode) {
              const isRefusal = true;
              await actionsRepo.update(
                { id: act.id },
                {
                  outcome: {
                    workspaceExecutionId: lease.id,
                    state: lease.state,
                    failureCode: lease.failureCode,
                    error: lease.failureCode ?? "Worktree preserved",
                    refusal: true,
                    ...(lease.hasUncommittedWork !== null && lease.hasUncommittedWork !== undefined
                      ? { hasUncommittedWork: lease.hasUncommittedWork }
                      : {}),
                  },
                },
              );
            } else if (phase === "REQUESTED") {
              // Crash before claim: keep pending for takeover (matrix A) — do not finalize as success
            } else if (phase === "EXECUTING") {
              // Crash before RELEASE_REQUESTED: EXECUTING but lease never became RELEASE_REQUESTED for this operation → INTERRUPTED
              await actionsRepo.update(
                { id: act.id },
                {
                  outcome: {
                    workspaceExecutionId: lease.id,
                    state: "INTERRUPTED",
                    failureCode: "RELEASE_INTERRUPTED",
                    error: `Release intent committed but lease is ${lease.state}; retry with the same idempotency key to resume`,
                    retryRequired: true,
                  },
                },
              );
            } else {
              // Fallback: treat as INTERRUPTED to avoid false success
              await actionsRepo.update(
                { id: act.id },
                {
                  outcome: {
                    workspaceExecutionId: lease.id,
                    state: "INTERRUPTED",
                    failureCode: "RELEASE_INTERRUPTED",
                    error: `Release pending but lease is ${lease.state}; retry required`,
                    retryRequired: true,
                  },
                },
              );
            }
          } else if (lease.state === "IN_USE" || lease.state === "READY" || lease.state === "ALLOCATING") {
            if (phase === "REQUESTED") {
              // Crash before claim: keep pending for takeover (matrix A)
            } else {
              // Crash before RELEASE_REQUESTED: pending EXECUTING whose lease never entered release → INTERRUPTED
              await actionsRepo.update(
                { id: act.id },
                {
                  outcome: {
                    workspaceExecutionId: lease.id,
                    state: "INTERRUPTED",
                    failureCode: "RELEASE_INTERRUPTED",
                    error: `Release intent committed but lease is ${lease.state}; retry with the same idempotency key to resume`,
                    retryRequired: true,
                  },
                },
              );
            }
          } else if (lease.state === "RELEASE_REQUESTED") {
            // Still in-flight — leave pending for the owner to complete only if exact correlation;
            // unmatched RELEASE_REQUESTED is handled by the lease reconciliation (fail closed), but a pending act
            // that does not match the lease's releaseOperationId should be marked INTERRUPTED
            const leaseOp = (lease as unknown as { releaseOperationId?: string | null }).releaseOperationId;
            if (leaseOp !== act.id) {
              await actionsRepo.update(
                { id: act.id },
                {
                  outcome: {
                    workspaceExecutionId: lease.id,
                    state: "INTERRUPTED",
                    failureCode: "RELEASE_INTERRUPTED",
                    error: `Release pending but lease RELEASE_REQUESTED is owned by a different operation; retry required`,
                    retryRequired: true,
                  },
                },
              );
            }
            // else keep pending for the exact owner
          } else {
            // FAILED, TRANSFERRED, etc. — surface truth
            await actionsRepo.update(
              { id: act.id },
              {
                outcome: {
                  workspaceExecutionId: lease.id,
                  state: lease.state,
                  ...(lease.failureCode ? { failureCode: lease.failureCode } : {}),
                  ...(lease.state === "FAILED" ? { refusal: true, error: lease.failureCode ?? "Lease failed" } : {}),
                },
              },
            );
          }
        } else if (outcome?.pending === true && !act.targetId) {
          // No target — mark interrupted so it doesn't stay pending forever
          await actionsRepo.update(
            { id: act.id },
            {
              outcome: {
                state: "INTERRUPTED",
                failureCode: "RELEASE_INTERRUPTED",
                error: "Release intent has no target",
                retryRequired: true,
              },
            },
          );
        }
      }
    } catch {
      // Best-effort audit reconciliation if tables or connections are unavailable
    }

    return transitions;
  }

  /**
   * Authoritatively transitions an IN_USE lease to PRESERVED upon run terminal completion.
   * Measures uncommitted work once for git-worktree mode (tri-state: clean/dirty/unknown).
   */
  async preserveExecutionWorkspaceForRun(
    manager: EntityManager,
    runId: string,
  ): Promise<WorkspaceExecutionEntity | null> {
    const repository = manager.getRepository(WorkspaceExecutionEntity);
    const row = await repository.findOne({
      where: { ownerRunId: runId, state: "IN_USE" },
    });
    if (!row) return null;
    let hasUncommittedWork: boolean | null = null;
    if (row.mode === "git-worktree" && row.executionPath) {
      const porcelain = runBoundedGit(row.executionPath, [
        "status",
        "--porcelain",
      ]);
      hasUncommittedWork =
        porcelain.status === 0
          ? porcelain.stdout.trim().length > 0
          : null;
    }
    row.state = "PRESERVED";
    row.hasUncommittedWork = hasUncommittedWork;
    row.updatedAt = new Date();
    return repository.save(row);
  }

  /**
   * Preservation-first release (audited command path). For git-worktree
   * leases: `git worktree remove` WITHOUT --force — Git itself refuses when
   * the tree contains operator/agent work, which stays PRESERVED.
   * Idempotent: an already-removed worktree transitions to REMOVED.
   * Shared mode has nothing to remove and is refused with an explanation.
   */
  async releaseExecutionWorkspace(
    workspaceExecutionId: string,
    releaseOperationId?: string | null,
  ): Promise<WorkspaceExecutionEntity> {
    if (!releaseOperationId) {
      throw new WorkspaceExecutionError(
        "RELEASE_UNAUTHORIZED",
        `Release operation id is required for workspace "${workspaceExecutionId}"`,
      );
    }
    const row = await this.executions.findOne({
      where: { id: workspaceExecutionId },
    });
    if (!row) {
      throw new WorkspaceExecutionError(
        "LEASE_NOT_FOUND",
        `Execution workspace "${workspaceExecutionId}" does not exist`,
      );
    }
    if (row.state === "REMOVED") return row; // idempotent
    if (row.mode === "shared") {
      throw new WorkspaceExecutionError(
        "SHARED_MODE_NO_REMOVAL",
        `Execution workspace "${workspaceExecutionId}" runs in shared mode against the source workspace itself — there is no isolated workspace to remove`,
      );
    }
    if (!row.executionPath) {
      throw new WorkspaceExecutionError(
        "LEASE_PATH_MISSING",
        `Execution workspace "${workspaceExecutionId}" has no execution path`,
      );
    }
    // Target-level atomic claim: only PRESERVED/FAILED may become RELEASE_REQUESTED.
    // Two different idempotency keys targeting the same workspace must not both acquire.
    if (row.state === "RELEASE_REQUESTED") {
      const existingOp = (row as unknown as { releaseOperationId?: string | null }).releaseOperationId;
      if (existingOp === releaseOperationId) {
        // Idempotent resume: we already own the target, proceed to Git
      } else if (existingOp) {
        throw new WorkspaceExecutionError(
          "RELEASE_IN_PROGRESS",
          `Execution workspace "${workspaceExecutionId}" release is already in progress by operation ${existingOp}`,
        );
      } else {
        throw new WorkspaceExecutionError(
          "RELEASE_UNAUTHORIZED",
          `Execution workspace "${workspaceExecutionId}" RELEASE_REQUESTED has no authorizing operation; refusing Git mutation`,
        );
      }
    } else if (row.state === "PRESERVED" || row.state === "FAILED") {
      const { acquired, fresh } = await this.tryAcquireTarget(workspaceExecutionId, releaseOperationId);
      if (acquired) {
        // Acquired target ownership, proceed
      } else if (fresh) {
        if (fresh.state === "RELEASE_REQUESTED" && (fresh as unknown as { releaseOperationId?: string | null }).releaseOperationId === releaseOperationId) {
          // We raced but the winner is us (e.g. retry), proceed
        } else if (fresh.state === "RELEASE_REQUESTED") {
          const owner = (fresh as unknown as { releaseOperationId?: string | null }).releaseOperationId;
          throw new WorkspaceExecutionError(
            "RELEASE_IN_PROGRESS",
            `Execution workspace "${workspaceExecutionId}" release is already in progress by operation ${owner ?? "unknown"}`,
          );
        } else if (fresh.state === "REMOVED") {
          return fresh;
        } else {
          throw new WorkspaceExecutionError(
            "LEASE_NOT_RELEASABLE",
            `Execution workspace "${workspaceExecutionId}" is ${fresh.state}; release requires PRESERVED (or FAILED for an interrupted allocation)`,
          );
        }
      } else {
        throw new WorkspaceExecutionError(
          "LEASE_NOT_FOUND",
          `Execution workspace "${workspaceExecutionId}" does not exist`,
        );
      }
    } else {
      throw new WorkspaceExecutionError(
        "LEASE_NOT_RELEASABLE",
        `Execution workspace "${workspaceExecutionId}" is ${row.state}; release requires PRESERVED (or FAILED for an interrupted allocation)`,
      );
    }
    // Matrix D: if filesystem already shows worktree absent, transition to REMOVED without destructive Git call
    if (!worktreeIsRegistered(row.sourcePath, row.executionPath)) {
      return this.transition(row.id, "REMOVED", {});
    }
    if (beforeRemoveHook) await beforeRemoveHook();
    const sourcePath = row.sourcePath;
    const outcome = removeGitWorktree(sourcePath, row.executionPath);
    if (outcome === "removed" || outcome === "already-removed") {
      return this.transition(row.id, "REMOVED", {});
    }
    // Anything else is preserved (dirty or unknown) — never force-removed.
    const reason = outcome.refused;
    const code = (outcome as { code?: string }).code ?? "WORKTREE_REMOVE_FAILED";
    const provenDirty = code === "WORKTREE_DIRTY";
    await this.transition(row.id, "PRESERVED", {
      failureCode: code,
      hasUncommittedWork: provenDirty ? true : null,
    });
    throw new WorkspaceExecutionError(
      code,
      `Execution workspace "${workspaceExecutionId}" ${provenDirty ? "contains uncommitted work" : "removal failed"}: ${reason}. It is preserved for inspection; destructive cleanup is refused by default`,
    );
  }

  private async transition(
    id: string,
    state: WorkspaceExecutionEntity["state"],
    fields: Partial<WorkspaceExecutionEntity> = {},
  ): Promise<WorkspaceExecutionEntity> {
    await this.executions.update(id, { state, ...fields });
    const updated = await this.executions.findOneOrFail({ where: { id } });
    return updated;
  }

  /**
   * Atomic target claim for per-workspace release ownership.
   * Only one ACTIVE release operation per workspaceExecutionId is allowed.
   * This is the sole writer of RELEASE_REQUESTED+releaseOperationId.
   */
  private async tryAcquireTarget(
    workspaceExecutionId: string,
    releaseOperationId: string,
  ): Promise<{ acquired: boolean; fresh: WorkspaceExecutionEntity | null }> {
    return this.dataSource.transaction(async (manager) => {
      await manager.query("SELECT pg_advisory_xact_lock(hashtext($1))", [workspaceExecutionId]);
      const repo = manager.getRepository(WorkspaceExecutionEntity);
      const row = await repo
        .createQueryBuilder("w")
        .setLock("pessimistic_write")
        .where("w.id = :id", { id: workspaceExecutionId })
        .getOne();
      if (!row) return { acquired: false, fresh: null };
      if (row.state !== "PRESERVED" && row.state !== "FAILED") {
        return { acquired: false, fresh: row };
      }
      const currentOp = (row as unknown as { releaseOperationId?: string | null }).releaseOperationId;
      if (currentOp) {
        return { acquired: false, fresh: row };
      }
      const insertResult: any = await manager.query(
        `INSERT INTO "workspace_release_locks" ("workspaceExecutionId", "releaseOperationId") VALUES ($1, $2) ON CONFLICT ("workspaceExecutionId") DO NOTHING RETURNING "workspaceExecutionId"`,
        [workspaceExecutionId, releaseOperationId],
      );
      const inserted = Array.isArray(insertResult) ? insertResult.length > 0 : (insertResult?.rowCount ?? 0) > 0 || (insertResult as any)?.length > 0;
      const didInsert = (insertResult as any)?.rowCount === 1 || inserted;
      if (!didInsert) {
        const existingLock: any = await manager.query(`SELECT "releaseOperationId" FROM "workspace_release_locks" WHERE "workspaceExecutionId" = $1`, [workspaceExecutionId]);
        const existingOp = Array.isArray(existingLock) ? existingLock[0]?.releaseOperationId : (existingLock as any)?.rows?.[0]?.releaseOperationId;
        if (existingOp === releaseOperationId) {
        } else {
          const fresh2 = await repo.findOne({ where: { id: workspaceExecutionId } });
          return { acquired: false, fresh: fresh2 };
        }
      }
      const result = await repo
        .createQueryBuilder()
        .update(WorkspaceExecutionEntity)
        .set({ state: "RELEASE_REQUESTED", releaseOperationId } as unknown as Record<string, unknown>)
        .where("id = :id", { id: workspaceExecutionId })
        .andWhere("state IN (:...states)", { states: ["PRESERVED", "FAILED"] })
        .andWhere("releaseOperationId IS NULL")
        .execute();
      if ((result.affected ?? 0) !== 1) {
        await manager.query(`DELETE FROM "workspace_release_locks" WHERE "workspaceExecutionId" = $1 AND "releaseOperationId" = $2`, [
          workspaceExecutionId,
          releaseOperationId,
        ]);
        const fresh2 = await repo.findOne({ where: { id: workspaceExecutionId } });
        console.log(`tryAcquireTarget ${workspaceExecutionId} op ${releaseOperationId} not acquired fresh state ${fresh2?.state} currentOp ${(fresh2 as any)?.releaseOperationId}`);
        return { acquired: false, fresh: fresh2 };
      }
      const fresh = await repo.findOne({ where: { id: workspaceExecutionId } });
      console.log(`tryAcquireTarget ${workspaceExecutionId} op ${releaseOperationId} acquired fresh state ${fresh?.state}`);
      return { acquired: true, fresh };
    });
  }

  private async hasReleaseAuthority(row: WorkspaceExecutionEntity): Promise<boolean> {
    try {
      const opId = (row as unknown as { releaseOperationId?: string | null }).releaseOperationId;
      if (!opId) return false;
      const actionsRepo = this.dataSource.getRepository(OperatorActionEntity);
      const action = await actionsRepo.findOne({
        where: {
          id: opId,
          action: "release-execution-workspace",
          targetId: row.id,
        } as unknown as Record<string, unknown>,
      });
      if (!action) return false;
      return true;
    } catch {
      return false;
    }
  }
}