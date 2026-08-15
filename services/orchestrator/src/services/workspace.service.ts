import { Inject, Injectable } from "@nestjs/common";
import { spawnSync } from "node:child_process";
import { existsSync, realpathSync, statSync } from "node:fs";
import { DataSource, Repository } from "typeorm";
import { WorkspaceEntity } from "../entities/workspace.entity";
import {
  WORKSPACE_BOUNDS,
  type WorkspaceSnapshotV1,
} from "../domain/workspace";

/** Bounded git probes: wall-clock + byte caps; output is parsed for the
 *  identity fields ONLY (never credentials, never arbitrary content). */
const GIT_PROBE_BOUNDS = {
  wallTimeMs: 10_000,
  maxOutputBytes: 4096,
} as const;

export type GitIdentity = {
  repoRoot: string | null;
  branch: string | null;
  headSha: string | null;
  dirty: boolean | null;
  note?: string;
};

function boundedGit(cwd: string, args: string[]): string | null {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    shell: false,
    timeout: GIT_PROBE_BOUNDS.wallTimeMs,
    maxBuffer: GIT_PROBE_BOUNDS.maxOutputBytes,
    env: {
      PATH: process.env.PATH ?? "",
      GIT_OPTIONAL_LOCKS: "0",
      GIT_TERMINAL_PROMPT: "0",
    },
  });
  if (result.status !== 0) return null;
  if (result.error) return null;
  return (result.stdout ?? "").trim();
}

/** Best-effort repository identity for a local path. Non-git directories
 *  and missing git binaries yield nullable fields — never a throw. */
export function captureGitIdentity(path: string): GitIdentity {
  const root = boundedGit(path, ["rev-parse", "--show-toplevel"]);
  if (root === null || root.length === 0) {
    return {
      repoRoot: null,
      branch: null,
      headSha: null,
      dirty: null,
      note: "git repository identity not detectable (not a git work tree, git unavailable, or probe bounded)",
    };
  }
  const branch = boundedGit(path, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const headSha = boundedGit(path, ["rev-parse", "HEAD"]);
  const porcelain = boundedGit(path, ["status", "--porcelain"]);
  return {
    repoRoot: root.slice(0, WORKSPACE_BOUNDS.repoRootMax),
    branch:
      branch !== null && branch.length > 0
        ? branch.slice(0, WORKSPACE_BOUNDS.branchMax)
        : null,
    headSha:
      headSha !== null && WORKSPACE_BOUNDS.headShaShape.test(headSha)
        ? headSha
        : null,
    dirty: porcelain !== null ? porcelain.length > 0 : null,
  };
}

/** Validates + canonicalizes an operator-selected local path. The path
 *  must exist and be a directory; it is resolved to its real path so the
 *  frozen snapshot never depends on symlink aliasing. */
export function resolveWorkspacePath(path: string): string {
  if (typeof path !== "string" || path.length === 0) {
    throw new Error("workspace path must be a non-empty string");
  }
  if (path.length > WORKSPACE_BOUNDS.pathMax) {
    throw new Error("workspace path exceeds the bound");
  }
  if (!existsSync(path)) {
    throw new Error(`workspace path does not exist: ${path}`);
  }
  let real: string;
  try {
    real = realpathSync(path);
  } catch {
    throw new Error(`workspace path is not resolvable: ${path}`);
  }
  const stat = (() => {
    try {
      return statSync(real);
    } catch {
      return null;
    }
  })();
  if (stat === null || !stat.isDirectory()) {
    throw new Error(`workspace path is not a directory: ${path}`);
  }
  return real;
}

@Injectable()
export class WorkspaceService {
  private readonly workspaces: Repository<WorkspaceEntity>;

  constructor(@Inject("DATA_SOURCE") dataSource: DataSource) {
    this.workspaces = dataSource.getRepository(WorkspaceEntity);
  }

  /** Freezes a bounded workspace snapshot for an operator path. The git
   *  identity is best-effort; the snapshot never blocks a run. */
  freezeSnapshot(path: string): WorkspaceSnapshotV1 {
    const real = resolveWorkspacePath(path);
    const identity = captureGitIdentity(real);
    const snapshot: WorkspaceSnapshotV1 = {
      schemaVersion: 1,
      workspaceId: `ws:${real}`,
      path: real,
      repoRoot: identity.repoRoot,
      branch: identity.branch,
      headSha: identity.headSha,
      dirty: identity.dirty,
      capturedAt: new Date().toISOString(),
      ...(identity.note ? { note: identity.note } : {}),
    };
    return snapshot;
  }

  /** Creates a stable workspace row (idempotent by path) and returns the
   *  frozen snapshot with the entity id. */
  async createWorkspace(input: {
    name?: string;
    path: string;
  }): Promise<{ id: string; snapshot: WorkspaceSnapshotV1 }> {
    const real = resolveWorkspacePath(input.path);
    const existing = await this.workspaces.findOne({ where: { path: real } });
    const identity = captureGitIdentity(real);
    const snapshot: WorkspaceSnapshotV1 = {
      schemaVersion: 1,
      workspaceId: existing?.id ?? "",
      path: real,
      repoRoot: identity.repoRoot,
      branch: identity.branch,
      headSha: identity.headSha,
      dirty: identity.dirty,
      capturedAt: new Date().toISOString(),
      ...(identity.note ? { note: identity.note } : {}),
    };
    if (existing) {
      existing.snapshot = snapshot;
      existing.name = (input.name ?? existing.name).slice(0, 255);
      await this.workspaces.save(existing);
      return { id: existing.id, snapshot: { ...snapshot, workspaceId: existing.id } };
    }
    const entity = await this.workspaces.save(
      this.workspaces.create({
        name: (input.name ?? real.split("/").pop() ?? "workspace").slice(0, 255),
        path: real,
        snapshot,
      }),
    );
    return {
      id: entity.id,
      snapshot: { ...snapshot, workspaceId: entity.id },
    };
  }

  /** Re-freezes the identity of an existing workspace row. */
  async refreshWorkspace(workspaceId: string): Promise<WorkspaceSnapshotV1> {
    const entity = await this.workspaces.findOne({ where: { id: workspaceId } });
    if (!entity) {
      throw new Error(`workspace "${workspaceId}" does not exist`);
    }
    const identity = captureGitIdentity(entity.path);
    const snapshot: WorkspaceSnapshotV1 = {
      schemaVersion: 1,
      workspaceId: entity.id,
      path: entity.path,
      repoRoot: identity.repoRoot,
      branch: identity.branch,
      headSha: identity.headSha,
      dirty: identity.dirty,
      capturedAt: new Date().toISOString(),
      ...(identity.note ? { note: identity.note } : {}),
    };
    entity.snapshot = snapshot;
    await this.workspaces.save(entity);
    return snapshot;
  }

  async list(): Promise<WorkspaceEntity[]> {
    return this.workspaces.find({ order: { updatedAt: "DESC" } });
  }
}
