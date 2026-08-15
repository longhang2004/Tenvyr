/**
 * Product Phase 1: first-class Workspace identity for supervised coding
 * team runs.
 *
 * A Workspace is the stable identifier + available repository identity of
 * the local working tree a team run executes against. A run FREEZES a
 * bounded snapshot at start; the snapshot is injected into worker task
 * inputs and the Verifier context so the run can reconstruct what it
 * executed against — without claiming snapshot isolation (execution runs
 * against the mutable local working tree; the limitation is documented).
 *
 * The snapshot is BEST-EFFORT where the repository is not detectable
 * (non-git directory, missing git binary): fields are nullable, never a
 * crash. Tenvyr never reads credentials and never copies runtime-owned
 * session files.
 */

export const WORKSPACE_BOUNDS = {
  pathMax: 4096,
  repoRootMax: 4096,
  branchMax: 255,
  headShaShape: /^[0-9a-f]{40}$/,
  notesMax: 1024,
} as const;

export type WorkspaceSnapshotV1 = {
  schemaVersion: 1;
  /** Stable workspace identifier (workspace entity id or a derived id). */
  workspaceId: string;
  /** The operator-selected local path (absolute). */
  path: string;
  /** Detected git repository root, when detectable. */
  repoRoot: string | null;
  /** Detected branch name, when detectable. */
  branch: string | null;
  /** Detected HEAD commit SHA (40 hex), when detectable. */
  headSha: string | null;
  /** Dirty working tree indicator (true when `git status --porcelain`
   *  produced any output), when detectable. */
  dirty: boolean | null;
  /** When the identity was captured. */
  capturedAt: string;
  /** Bounded note (e.g. why repository identity is unavailable). */
  note?: string;
};

/** Optional operator-declared acceptance evidence for a coding team run.
 *  Run METADATA only — commands are never executed by the orchestrator;
 *  workers/verifier reference evidence through the existing bounded
 *  evidence/artifact model. */
export type AcceptanceEvidenceV1 = {
  testCommand?: string;
  buildCommand?: string;
  lintCommand?: string;
  typecheckCommand?: string;
  /** Required artifact file names (relative to the workspace root). */
  requiredArtifacts?: string[];
};

export const ACCEPTANCE_EVIDENCE_BOUNDS = {
  commandMax: 1024,
  artifactMax: 255,
  artifactCountMax: 16,
} as const;

/** Bounded parse of an acceptance-evidence block; unknown fields are
 *  rejected. Returns null when the input is absent/empty. */
export function parseAcceptanceEvidence(
  value: unknown,
): AcceptanceEvidenceV1 | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("acceptanceEvidence must be an object");
  }
  const source = value as Record<string, unknown>;
  const result: AcceptanceEvidenceV1 = {};
  for (const key of [
    "testCommand",
    "buildCommand",
    "lintCommand",
    "typecheckCommand",
  ] as const) {
    const raw = source[key];
    if (raw === undefined || raw === null) continue;
    if (typeof raw !== "string" || raw.length === 0) {
      throw new Error(`acceptanceEvidence.${key} must be a non-empty string`);
    }
    if (raw.length > ACCEPTANCE_EVIDENCE_BOUNDS.commandMax) {
      throw new Error(`acceptanceEvidence.${key} exceeds the bound`);
    }
    result[key] = raw;
  }
  const rawArtifacts = source.requiredArtifacts;
  if (rawArtifacts !== undefined && rawArtifacts !== null) {
    if (
      !Array.isArray(rawArtifacts) ||
      rawArtifacts.some((entry) => typeof entry !== "string") ||
      rawArtifacts.length > ACCEPTANCE_EVIDENCE_BOUNDS.artifactCountMax
    ) {
      throw new Error("acceptanceEvidence.requiredArtifacts must be a bounded string array");
    }
    result.requiredArtifacts = rawArtifacts.map((entry) =>
      entry.slice(0, ACCEPTANCE_EVIDENCE_BOUNDS.artifactMax),
    );
  }
  return Object.keys(result).length > 0 ? result : null;
}
