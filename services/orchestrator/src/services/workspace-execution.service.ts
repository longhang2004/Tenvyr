import { Inject, Injectable } from "@nestjs/common";
import { spawnSync } from "node:child_process";
import { mkdirSync, realpathSync, statSync } from "node:fs";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DataSource, In, type EntityManager, Repository } from "typeorm";
import { WorkspaceExecutionEntity } from "../entities/workspace-execution.entity";
import { CoordinationRunEntity } from "../entities/coordination-run.entity";
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

export function runBoundedGit(cwd: string, args: string[]): GitResult {
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

/** Create one isolated git worktree (no network, no clone, no shell).
 *  Returns null on success; a bounded error message when creation failed
 *  and the path is not already registered (retry idempotency). */
export function addGitWorktree(
  sourceRepoRoot: string,
  executionPath: string,
  branch: string,
): string | null {
  const added = runBoundedGit(sourceRepoRoot, [
    "worktree",
    "add",
    executionPath,
    "-b",
    branch,
  ]);
  if (added.status === 0) return null;
  // Retry idempotency: an interrupted previous attempt may have created the
  // worktree before the DB update. Verify registration before success.
  if (worktreeIsRegistered(sourceRepoRoot, executionPath)) return null;
  return (added.stderr || "git worktree add failed").slice(0, 512);
}

/** Remove a worktree WITHOUT --force (Git refuses dirty trees — operator
 *  work is preserved). Returns "removed" | "already-removed" | { refused:
 *  reason }. */
export function removeGitWorktree(
  sourceRepoRoot: string,
  executionPath: string,
): "removed" | "already-removed" | { refused: string } {
  const removed = runBoundedGit(sourceRepoRoot, [
    "worktree",
    "remove",
    executionPath,
  ]);
  if (removed.status === 0) return "removed";
  if (!worktreeIsRegistered(sourceRepoRoot, executionPath)) {
    return "already-removed";
  }
  return { refused: (removed.stderr || "git worktree remove failed").slice(0, 512) };
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
    this.executions = dataSource.getRepository(WorkspaceExecutionEntity);
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
  ): Promise<WorkspaceExecutionEntity> {
    await this.reconcileWorkspaceExecutions();
    const entity = await this.executions.save(
      this.executions.create({
        sourceWorkspaceId: workspace.workspaceId,
        sourcePath: workspace.path,
        mode,
        baseBranch: workspace.branch ?? null,
        baseHeadSha: workspace.headSha ?? null,
        ownerRunId: null,
        state: "ALLOCATING",
      }),
    );
    if (mode === "shared") {
      // Shared mode executes against the source workspace itself; the path
      // was canonicalized by resolveWorkspacePath at freeze time.
      return this.transition(entity.id, "READY", {
        executionPath: workspace.path,
      });
    }
    // git-worktree mode: the source must be a detectable git repository
    // with a HEAD — otherwise fail closed with a precise reason (never
    // silently fall back to shared).
    if (!workspace.repoRoot || !workspace.headSha) {
      await this.transition(
        entity.id,
        "FAILED",
        { failureCode: "NOT_A_GIT_REPOSITORY" },
      );
      throw new WorkspaceExecutionError(
        "NOT_A_GIT_REPOSITORY",
        `Workspace "${workspace.workspaceId}" is not a detectable git repository with a HEAD; git-worktree isolation cannot be created (no silent fallback)`,
      );
    }
    const root = workspaceExecutionRoot();
    try {
      mkdirSync(root, { recursive: true });
    } catch {
      await this.transition(entity.id, "FAILED", {
        failureCode: "EXECUTION_ROOT_UNWRITABLE",
      });
      throw new WorkspaceExecutionError(
        "EXECUTION_ROOT_UNWRITABLE",
        `Execution workspace root "${root}" is not writable`,
      );
    }
    const executionPath = path.join(root, `run-${entity.id.slice(0, 12)}`);
    const shortId = entity.id.slice(0, 12);
    const branch = `tenvyr/run-${shortId}`;
    const addedError = addGitWorktree(
      workspace.repoRoot,
      executionPath,
      branch,
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
    // ALLOCATING rows older than the bound were interrupted before any git
    // mutation could complete deterministically.
    const interrupted = await repository
      .createQueryBuilder("lease")
      .where("lease.state = 'ALLOCATING'")
      .andWhere("lease.createdAt < :boundary", { boundary: interruptedBoundary })
      .getMany();
    for (const row of interrupted) {
      await this.transition(row.id, "FAILED", {
        failureCode: "ALLOCATION_INTERRUPTED",
      });
      transitions++;
    }
    // READY rows never bound to a run (crash between allocation and the
    // authority transaction).
    const unbound = await repository
      .createQueryBuilder("lease")
      .where("lease.state = 'READY'")
      .andWhere("lease.ownerRunId IS NULL")
      .andWhere("lease.createdAt < :boundary", { boundary: interruptedBoundary })
      .getMany();
    for (const row of unbound) {
      await this.transition(row.id, "FAILED", {
        failureCode: "RUN_NOT_BOUND",
      });
      transitions++;
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
          hasUncommittedWork = porcelain.status === 0 && porcelain.stdout.length > 0;
        }
        await this.transition(row.id, "PRESERVED", { hasUncommittedWork });
        transitions++;
      }
    }
    return transitions;
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
  ): Promise<WorkspaceExecutionEntity> {
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
    if (row.state !== "PRESERVED" && row.state !== "FAILED") {
      throw new WorkspaceExecutionError(
        "LEASE_NOT_RELEASABLE",
        `Execution workspace "${workspaceExecutionId}" is ${row.state}; release requires PRESERVED (or FAILED for an interrupted allocation)`,
      );
    }
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
    const sourcePath = row.sourcePath;
    const outcome = removeGitWorktree(sourcePath, row.executionPath);
    if (outcome === "removed" || outcome === "already-removed") {
      return this.transition(row.id, "REMOVED", {});
    }
    // Anything else is preserved (dirty or unknown) — never force-removed.
    const reason = outcome.refused;
    await this.transition(row.id, "PRESERVED", {
      failureCode: "WORKTREE_DIRTY",
    });
    throw new WorkspaceExecutionError(
      "WORKTREE_DIRTY",
      `Execution workspace "${workspaceExecutionId}" contains uncommitted work (or removal failed): ${reason}. It is preserved for inspection; destructive cleanup is refused by default`,
    );
  }

  private async transition(
    id: string,
    state: WorkspaceExecutionEntity["state"],
    fields: Partial<WorkspaceExecutionEntity>,
  ): Promise<WorkspaceExecutionEntity> {
    await this.executions.update(id, { state, ...fields });
    const updated = await this.executions.findOneOrFail({ where: { id } });
    return updated;
  }
}