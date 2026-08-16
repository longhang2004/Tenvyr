import { canonicalJson, sha256Json } from "./canonical-json";

/**
 * PP1 Slice C — Portable Handoff V1.
 *
 * An explicit bounded projection of durable Tenvyr truth that lets a NEW
 * Team Run (possibly on a DIFFERENT runtime connection) safely continue
 * work started by a TERMINAL source run. It is NOT hidden session
 * migration, chat-history copying, chain-of-thought migration, or
 * deterministic replay: references instead of raw logs, and the source
 * execution's historical runtime/model identity is NEVER rewritten.
 *
 * The bundle is bounded and strictly parsed (unknown fields rejected);
 * it never embeds credentials, runtime session files, hidden reasoning,
 * arbitrary tool output, or Capsule blobs.
 */

export const HANDOFF_BOUNDS = {
  reasonMax: 512,
  workerSummaryBytes: 2048,
  maxWorkers: 64,
  maxArtifactRefs: 64,
  maxProvenanceEntries: 64,
  bundleBytes: 16 * 1024,
} as const;

export type HandoffBundleV1 = {
  schemaVersion: 1;
  sourceExecutionId: string;
  sourceRunId: string | null;
  /** Bounded goal (already bounded at launch). */
  goal: string;
  /** Source workspace identity (references, no capture time). */
  workspace: {
    workspaceId: string;
    path: string;
    branch: string | null;
    headSha: string | null;
  } | null;
  /** Source execution workspace lease identity, when the run had one. */
  executionWorkspace: {
    workspaceExecutionId: string;
    mode: string;
    path: string;
    baseHeadSha: string | null;
    state: string;
  } | null;
  /** Latest plan revision reference (never the full plan). */
  planRevision: { id: string; planHash: string } | null;
  /** Latest iteration number. */
  iterationNumber: number | null;
  /** Latest verifier decision (bounded reason). */
  verifierDecision: { action: string; reason: string } | null;
  /** Bounded worker outcome summaries of the latest iteration. */
  workerOutcomes: Array<{ taskId: string; status: string; summary: string | null }>;
  /** Selected artifact references. */
  artifactRefs: Array<{ artifactId: string; name: string | null }>;
  /** Operator-declared acceptance evidence (run metadata). */
  acceptanceEvidence: unknown;
  /** Bounded unresolved/recommended-next-work description. */
  nextWork: string | null;
  /** Source runtime/model provenance (from frozen attempt evidence). */
  sourceRuntimeProvenance: Array<{
    agent: string;
    connectionId: string | null;
    requestedModelId: string | null;
  }>;
  createdAt: string;
};

export function handoffBundleHash(bundle: HandoffBundleV1): string {
  return sha256Json(bundle);
}

export function handoffBundleBytes(bundle: HandoffBundleV1): number {
  return Buffer.byteLength(canonicalJson(bundle), "utf8");
}

/** Strict parse of a persisted/crossed HandoffBundle (trust boundary).
 *  Unknown keys/shapes are rejected — a bundle can never smuggle
 *  unbounded content. */
export function parseHandoffBundle(value: unknown): HandoffBundleV1 {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw handoffInvalid("HandoffBundleV1 must be an object");
  }
  const source = value as Record<string, unknown>;
  assertOnlyKeys(
    source,
    [
      "schemaVersion",
      "sourceExecutionId",
      "sourceRunId",
      "goal",
      "workspace",
      "executionWorkspace",
      "planRevision",
      "iterationNumber",
      "verifierDecision",
      "workerOutcomes",
      "artifactRefs",
      "acceptanceEvidence",
      "nextWork",
      "sourceRuntimeProvenance",
      "createdAt",
    ],
    "HandoffBundleV1",
  );
  if (source.schemaVersion !== 1) {
    throw handoffInvalid(
      `HandoffBundleV1 schemaVersion "${String(source.schemaVersion)}" is not supported`,
    );
  }
  const bundle: HandoffBundleV1 = {
    schemaVersion: 1,
    sourceExecutionId: boundedString(source.sourceExecutionId, "sourceExecutionId", 255),
    sourceRunId: nullableString(source.sourceRunId, "sourceRunId", 255),
    goal: boundedString(source.goal, "goal", 4096),
    workspace: null,
    executionWorkspace: null,
    planRevision: null,
    iterationNumber: nullableNonNegativeInteger(source.iterationNumber, "iterationNumber"),
    verifierDecision: null,
    workerOutcomes: parseWorkerOutcomes(source.workerOutcomes),
    artifactRefs: parseArtifactRefs(source.artifactRefs),
    acceptanceEvidence: source.acceptanceEvidence ?? null,
    nextWork: nullableString(source.nextWork, "nextWork", HANDOFF_BOUNDS.reasonMax),
    sourceRuntimeProvenance: parseProvenance(source.sourceRuntimeProvenance),
    createdAt: boundedString(source.createdAt, "createdAt", 64),
  };
  if (source.workspace !== null && source.workspace !== undefined) {
    const ws = record(source.workspace, "workspace");
    assertOnlyKeys(ws, ["workspaceId", "path", "branch", "headSha"], "workspace");
    bundle.workspace = {
      workspaceId: boundedString(ws.workspaceId, "workspace.workspaceId", 255),
      path: boundedString(ws.path, "workspace.path", 4096),
      branch: nullableString(ws.branch, "workspace.branch", 255),
      headSha: nullableString(ws.headSha, "workspace.headSha", 40),
    };
  }
  if (
    source.executionWorkspace !== null &&
    source.executionWorkspace !== undefined
  ) {
    const ew = record(source.executionWorkspace, "executionWorkspace");
    assertOnlyKeys(
      ew,
      ["workspaceExecutionId", "mode", "path", "baseHeadSha", "state"],
      "executionWorkspace",
    );
    bundle.executionWorkspace = {
      workspaceExecutionId: boundedString(
        ew.workspaceExecutionId,
        "executionWorkspace.workspaceExecutionId",
        255,
      ),
      mode: boundedString(ew.mode, "executionWorkspace.mode", 32),
      path: boundedString(ew.path, "executionWorkspace.path", 4096),
      baseHeadSha: nullableString(ew.baseHeadSha, "executionWorkspace.baseHeadSha", 40),
      state: boundedString(ew.state, "executionWorkspace.state", 32),
    };
  }
  if (source.planRevision !== null && source.planRevision !== undefined) {
    const plan = record(source.planRevision, "planRevision");
    assertOnlyKeys(plan, ["id", "planHash"], "planRevision");
    bundle.planRevision = {
      id: boundedString(plan.id, "planRevision.id", 255),
      planHash: boundedString(plan.planHash, "planRevision.planHash", 64),
    };
  }
  if (
    source.verifierDecision !== null &&
    source.verifierDecision !== undefined
  ) {
    const decision = record(source.verifierDecision, "verifierDecision");
    assertOnlyKeys(decision, ["action", "reason"], "verifierDecision");
    bundle.verifierDecision = {
      action: boundedString(decision.action, "verifierDecision.action", 64),
      reason: boundedString(
        decision.reason,
        "verifierDecision.reason",
        HANDOFF_BOUNDS.reasonMax,
      ),
    };
  }
  return bundle;
}

function parseWorkerOutcomes(value: unknown): HandoffBundleV1["workerOutcomes"] {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value) || value.length > HANDOFF_BOUNDS.maxWorkers) {
    throw handoffInvalid(
      `workerOutcomes must be an array of at most ${HANDOFF_BOUNDS.maxWorkers} entries`,
    );
  }
  return value.map((entry, index) => {
    const item = record(entry, `workerOutcomes[${index}]`);
    assertOnlyKeys(item, ["taskId", "status", "summary"], `workerOutcomes[${index}]`);
    return {
      taskId: boundedString(item.taskId, `workerOutcomes[${index}].taskId`, 255),
      status: boundedString(item.status, `workerOutcomes[${index}].status`, 32),
      summary: nullableString(
        item.summary,
        `workerOutcomes[${index}].summary`,
        HANDOFF_BOUNDS.workerSummaryBytes,
      ),
    };
  });
}

function parseArtifactRefs(value: unknown): HandoffBundleV1["artifactRefs"] {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value) || value.length > HANDOFF_BOUNDS.maxArtifactRefs) {
    throw handoffInvalid(
      `artifactRefs must be an array of at most ${HANDOFF_BOUNDS.maxArtifactRefs} entries`,
    );
  }
  return value.map((entry, index) => {
    const item = record(entry, `artifactRefs[${index}]`);
    assertOnlyKeys(item, ["artifactId", "name"], `artifactRefs[${index}]`);
    return {
      artifactId: boundedString(item.artifactId, `artifactRefs[${index}].artifactId`, 255),
      name: nullableString(item.name, `artifactRefs[${index}].name`, 255),
    };
  });
}

function parseProvenance(
  value: unknown,
): HandoffBundleV1["sourceRuntimeProvenance"] {
  if (value === null || value === undefined) return [];
  if (
    !Array.isArray(value) ||
    value.length > HANDOFF_BOUNDS.maxProvenanceEntries
  ) {
    throw handoffInvalid(
      `sourceRuntimeProvenance must be an array of at most ${HANDOFF_BOUNDS.maxProvenanceEntries} entries`,
    );
  }
  return value.map((entry, index) => {
    const item = record(entry, `sourceRuntimeProvenance[${index}]`);
    assertOnlyKeys(
      item,
      ["agent", "connectionId", "requestedModelId"],
      `sourceRuntimeProvenance[${index}]`,
    );
    return {
      agent: boundedString(item.agent, `sourceRuntimeProvenance[${index}].agent`, 255),
      connectionId: nullableString(
        item.connectionId,
        `sourceRuntimeProvenance[${index}].connectionId`,
        255,
      ),
      requestedModelId: nullableString(
        item.requestedModelId,
        `sourceRuntimeProvenance[${index}].requestedModelId`,
        256,
      ),
    };
  });
}

function record(value: unknown, what: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw handoffInvalid(`${what} must be an object`);
  }
  return value as Record<string, unknown>;
}

function assertOnlyKeys(
  value: Record<string, unknown>,
  allowed: string[],
  what: string,
): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw handoffInvalid(`${what} contains an unsupported field "${unknown[0]}"`);
  }
}

function boundedString(value: unknown, field: string, maxLength: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxLength
  ) {
    throw handoffInvalid(
      `${field} must be a non-empty string of at most ${maxLength} characters`,
    );
  }
  return value;
}

function nullableString(
  value: unknown,
  field: string,
  maxLength: number,
): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || value.length > maxLength) {
    throw handoffInvalid(`${field} must be a string of at most ${maxLength} characters or null`);
  }
  return value;
}

function nullableNonNegativeInteger(
  value: unknown,
  field: string,
): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw handoffInvalid(`${field} must be a non-negative integer or null`);
  }
  return value;
}

export class HandoffError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "HandoffError";
  }
}

function handoffInvalid(message: string): HandoffError {
  return new HandoffError("HANDOFF_INVALID", message);
}