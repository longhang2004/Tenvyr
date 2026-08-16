/**
 * PP1 — Workspace Execution / Isolation V1.
 *
 * A WorkspaceExecution is Tenvyr's authoritative execution boundary for a
 * Team Run: the concrete path every local coding-runtime child of the run
 * executes against, plus its durable lifecycle state. This is NOT a sandbox
 * and NOT a snapshot: for `git-worktree` mode it is a real isolated Git
 * worktree of the source repository; for `shared` mode it is the source
 * workspace itself.
 *
 * The reserved `ExecutionWorkspaceIdentityV1` rides INSIDE the existing
 * AgentInvocationV1 `metadata` member (a closed v1 contract — no new
 * top-level fields). It is Tenvyr-owned: planner/worker task input lives
 * under `input` and can never override it. The local executor host
 * validates the path against its allowlisted root before spawn and fails
 * closed otherwise.
 */

export const WORKSPACE_EXECUTION_BOUNDS = {
  /** Maximum absolute execution path length. */
  pathMax: 4096,
  /** Maximum source workspace id length. */
  sourceWorkspaceIdMax: 255,
  /** Maximum git branch name length (frozen base branch). */
  branchMax: 255,
  headShaShape: /^[0-9a-f]{40}$/,
  /** Reconciliation bound: an ALLOCATING row older than this is FAILED. */
  allocationInterruptMs: 5 * 60 * 1000,
} as const;

export const WORKSPACE_EXECUTION_MODES = ["shared", "git-worktree"] as const;
export type WorkspaceExecutionModeV1 = (typeof WORKSPACE_EXECUTION_MODES)[number];

export const WORKSPACE_EXECUTION_STATES = [
  "ALLOCATING",
  "READY",
  "IN_USE",
  "PRESERVED",
  "REMOVED",
  "FAILED",
] as const;
export type WorkspaceExecutionStateV1 = (typeof WORKSPACE_EXECUTION_STATES)[number];

/**
 * Reserved Tenvyr-owned invocation member:
 * `invocation.metadata.tenvyr.executionWorkspace`.
 *
 * `path` is the authoritative execution path the runtime child must run in;
 * `baseHeadSha` is the frozen source HEAD the worktree was created from
 * (null for shared mode when the source is not a git repository).
 */
export type ExecutionWorkspaceIdentityV1 = {
  schemaVersion: 1;
  workspaceExecutionId: string;
  path: string;
  mode: WorkspaceExecutionModeV1;
  sourceWorkspaceId: string;
  baseHeadSha: string | null;
};

/** Strict parse of the reserved member at the host boundary (trust
 *  boundary: the value crosses the wire). Unknown keys/shapes are
 *  rejected — an invocation can never smuggle an unvalidated path. */
export function parseExecutionWorkspaceIdentity(
  value: unknown,
): ExecutionWorkspaceIdentityV1 | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw workspaceExecutionInvalid("metadata.tenvyr.executionWorkspace must be an object");
  }
  const source = value as Record<string, unknown>;
  assertOnlyKeys(
    source,
    ["schemaVersion", "workspaceExecutionId", "path", "mode", "sourceWorkspaceId", "baseHeadSha"],
    "executionWorkspace",
  );
  if (source.schemaVersion !== 1) {
    throw workspaceExecutionInvalid(
      `executionWorkspace schemaVersion "${String(source.schemaVersion)}" is not supported`,
    );
  }
  const workspaceExecutionId = boundedString(
    source.workspaceExecutionId,
    "workspaceExecutionId",
    WORKSPACE_EXECUTION_BOUNDS.sourceWorkspaceIdMax,
  );
  const path = boundedString(
    source.path,
    "path",
    WORKSPACE_EXECUTION_BOUNDS.pathMax,
  );
  const mode = source.mode;
  if (
    typeof mode !== "string" ||
    !(WORKSPACE_EXECUTION_MODES as readonly string[]).includes(mode)
  ) {
    throw workspaceExecutionInvalid(
      `executionWorkspace mode "${String(mode)}" is not supported`,
    );
  }
  const sourceWorkspaceId = boundedString(
    source.sourceWorkspaceId,
    "sourceWorkspaceId",
    WORKSPACE_EXECUTION_BOUNDS.sourceWorkspaceIdMax,
  );
  const baseHeadSha = nullableHeadSha(source.baseHeadSha);
  return {
    schemaVersion: 1,
    workspaceExecutionId,
    path,
    mode: mode as WorkspaceExecutionModeV1,
    sourceWorkspaceId,
    baseHeadSha,
  };
}

/** Extract the reserved member from an invocation's metadata (host side);
 *  absent member → null; malformed member → throws (fail closed). */
export function executionWorkspaceFromMetadata(
  metadata: unknown,
): ExecutionWorkspaceIdentityV1 | null {
  if (metadata === null || metadata === undefined) return null;
  if (typeof metadata !== "object" || Array.isArray(metadata)) {
    throw workspaceExecutionInvalid("metadata must be an object");
  }
  const tenvyr = (metadata as Record<string, unknown>).tenvyr;
  if (tenvyr === undefined) return null;
  if (typeof tenvyr !== "object" || Array.isArray(tenvyr)) {
    throw workspaceExecutionInvalid("metadata.tenvyr must be an object");
  }
  return parseExecutionWorkspaceIdentity(
    (tenvyr as Record<string, unknown>).executionWorkspace,
  );
}

/** Build the reserved identity from a READY/IN_USE lease row; null for
 *  every other state (shared rows are READY/IN_USE too — their path is the
 *  source workspace itself). */
export function executionWorkspaceIdentityFromRow(row: {
  id: string;
  executionPath: string | null;
  mode: WorkspaceExecutionModeV1;
  sourceWorkspaceId: string;
  baseHeadSha: string | null;
  state: string;
}): ExecutionWorkspaceIdentityV1 | null {
  if (row.executionPath === null) return null;
  if (row.state !== "READY" && row.state !== "IN_USE") return null;
  return {
    schemaVersion: 1,
    workspaceExecutionId: row.id,
    path: row.executionPath,
    mode: row.mode,
    sourceWorkspaceId: row.sourceWorkspaceId,
    baseHeadSha: row.baseHeadSha ?? null,
  };
}

function boundedString(value: unknown, field: string, maxLength: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxLength
  ) {
    throw workspaceExecutionInvalid(
      `${field} must be a non-empty string of at most ${maxLength} characters`,
    );
  }
  return value;
}

function nullableHeadSha(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || !WORKSPACE_EXECUTION_BOUNDS.headShaShape.test(value)) {
    throw workspaceExecutionInvalid("baseHeadSha must be 40 lowercase hex characters or null");
  }
  return value;
}

function assertOnlyKeys(
  value: Record<string, unknown>,
  allowed: string[],
  what: string,
): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw workspaceExecutionInvalid(
      `${what} contains an unsupported field "${unknown[0]}"`,
    );
  }
}

export class WorkspaceExecutionError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "WorkspaceExecutionError";
  }
}

export function workspaceExecutionInvalid(message: string): WorkspaceExecutionError {
  return new WorkspaceExecutionError("WORKSPACE_EXECUTION_INVALID", message);
}