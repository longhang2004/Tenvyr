import type { JsonValue } from "@tenvyr/contracts";
import { canonicalJson, sha256Json } from "./canonical-json";
import { jsonValueUtf8Size, type ExecutionState } from "./execution-state";
import type {
  ArtifactContextReference,
  TenvyrContextEnvelope,
} from "./context-snapshot";

/**
 * P3 — Invocation Efficiency / Context Projection baseline.
 *
 * Bounded deterministic identity ("ContextBundleV1") for the exact context
 * projection an invocation received, bounded projection metrics
 * ("Deliverable B"), the session-strategy vocabulary (model only), and the
 * immutable per-attempt efficiency evidence record ("Deliverable D").
 *
 * The fingerprint is a PROVENANCE/OPTIMIZATION primitive, never execution
 * authority: it identifies the immutable envelope content plus the ambient
 * invocation facts frozen at claim time. Random invocation ids, timestamps,
 * attempt ids, and workspace capture times NEVER participate unless they
 * semantically alter the projected agent context.
 */
export const CONTEXT_BUNDLE_SCHEMA_VERSION = 1;

export const SESSION_MODES = ["fresh", "reused", "resumed", "unknown"] as const;
export type SessionModeV1 = (typeof SESSION_MODES)[number];

/** Bounded workspace structural identity (no local paths, no capture time).
 *  `dirty` participates so a clean↔dirty transition fails the fingerprint
 *  closed; dirty file CONTENT is deliberately not scanned (no production
 *  path projects workspace file bytes into the context envelope). */
export type ContextWorkspaceIdentityV1 = {
  workspaceId: string;
  branch: string | null;
  headSha: string | null;
  dirty: boolean | null;
};

/** Project a frozen WorkspaceSnapshotV1 down to its deterministic structural
 *  identity. Local paths and wall-clock capture times NEVER participate. */
export function workspaceIdentityOf(workspace: {
  workspaceId: string;
  branch?: string | null;
  headSha?: string | null;
  dirty?: boolean | null;
}): ContextWorkspaceIdentityV1 {
  return {
    workspaceId: workspace.workspaceId,
    branch: workspace.branch ?? null,
    headSha: workspace.headSha ?? null,
    dirty: workspace.dirty ?? null,
  };
}

/** Frozen harness/role identity of the executing runtime (claim-frozen). */
export type HarnessIdentityV1 = {
  agent: string;
  executorKind: string;
  configHash: string;
  connectionId?: string;
  connectionRevision?: number;
  requestedModelId?: string;
};

/**
 * Canonical deterministic projection inputs. Two invocations share a bundle
 * hash IFF these are identical: same selected state values (+ version),
 * same resolved artifact references, same frozen harness identity, same
 * active immutable plan revision hash, and (when applicable) the same
 * workspace structural identity.
 */
export type ContextBundleIdentityInputsV1 = {
  bundleSchemaVersion: typeof CONTEXT_BUNDLE_SCHEMA_VERSION;
  contextSchemaVersion: 1;
  stateProjection: {
    version: number;
    values: Record<string, JsonValue>;
  };
  artifacts: ArtifactContextReference[];
  harness: HarnessIdentityV1;
  planHash?: string;
  workspace?: ContextWorkspaceIdentityV1;
};

/** SHA-256 (hex) content fingerprint over the canonical inputs. */
export function computeContextBundleHash(
  inputs: ContextBundleIdentityInputsV1,
): string {
  return sha256Json(inputs);
}

/** Bounded context projection metrics measured on the materialized envelope.
 *  Bytes/characters, never fake token estimates — Tenvyr does not claim
 *  tokenizer/model semantics. */
export type ContextMetricsV1 = {
  /** Canonical UTF-8 bytes of the complete context envelope (the M2 bound
   *  measure: jsonValueUtf8Size). */
  projectedBytes: number;
  /** Canonical JSON string length (UTF-16 code units). */
  projectedCharacters: number;
  /** Selected execution-state keys placed in the envelope. */
  selectedContextItemCount: number;
  /** Resolved artifact references placed in the envelope. */
  selectedArtifactCount: number;
  /** Canonical UTF-8 bytes of the FULL bounded execution state at
   *  projection time (how much evidence the selection drew from). This is
   *  NOT a function of the context envelope — it must be measured against
   *  the CURRENT full state on every claim and must never be served from
   *  the projection cache. */
  executionStateBytes: number;
};

/** Envelope-derived metrics only — the subset that IS a function of the
 *  cached envelope and therefore safe to store under the ContextBundle
 *  hash. `executionStateBytes` is deliberately excluded (see
 *  ContextMetricsV1). */
export type EnvelopeMetricsV1 = Omit<ContextMetricsV1, "executionStateBytes">;

/** Measure the FULL bounded execution state bytes for the CURRENT claim
 *  (never cacheable under the projected-context identity). */
export function executionStateBytesOf(state: ExecutionState): number {
  return jsonValueUtf8Size(state ?? {});
}

export function measureContextEnvelope(
  envelope: TenvyrContextEnvelope,
  fullState: ExecutionState,
): ContextMetricsV1 {
  return {
    projectedBytes: jsonValueUtf8Size(envelope),
    projectedCharacters: canonicalJson(envelope).length,
    selectedContextItemCount:
      envelope.tenvyr.executionState.values === undefined
        ? 0
        : Object.keys(envelope.tenvyr.executionState.values).length,
    selectedArtifactCount: envelope.tenvyr.artifacts.length,
    executionStateBytes: executionStateBytesOf(fullState),
  };
}

/** Bounded provider/runtime usage evidence as REPORTED by the runtime.
 *  Absent fields mean NOT REPORTED — never zero, never inferred from a
 *  Tenvyr context-bundle match. */
export type ReportedUsageV1 = {
  reported: boolean;
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  cacheWriteTokens?: number;
};

/** Immutable bounded efficiency evidence for one runtime invocation,
 *  recorded on the attempt at claim time and completed once at result
 *  acceptance (usage + timing). */
export type InvocationEfficiencyEvidenceV1 = {
  schemaVersion: 1;
  invocationId: string;
  /** Tenvyr ContextBundle identity + whether the materialized projection
   *  was reused from the projection cache instead of rebuilt. Null when the
   *  invocation carried no Tenvyr context envelope (no projection). */
  contextBundle: { hash: string; reused: boolean } | null;
  harness: HarnessIdentityV1;
  workspace?: ContextWorkspaceIdentityV1;
  context: ContextMetricsV1 | null;
  session: { mode: SessionModeV1 };
  usage: ReportedUsageV1;
  timing: {
    startedAt: string;
    completedAt: string | null;
    durationMs: number | null;
  };
};

export type EfficiencyClaimInput = {
  invocationId: string;
  harness: HarnessIdentityV1;
  workspace?: ContextWorkspaceIdentityV1;
  contextBundle: { hash: string; reused: boolean } | null;
  context: ContextMetricsV1 | null;
  /** true when the attempt is created with a dispatchable outbox (a real
   *  runtime invocation is intended); false for pre-dispatch
   *  terminal/WAITING attempts that never established a runtime session. */
  dispatchable: boolean;
  startedAt: string;
};

export function buildClaimEfficiencyEvidence(
  input: EfficiencyClaimInput,
): InvocationEfficiencyEvidenceV1 {
  return {
    schemaVersion: 1,
    invocationId: input.invocationId,
    contextBundle: input.contextBundle,
    harness: {
      agent: input.harness.agent,
      executorKind: input.harness.executorKind,
      configHash: input.harness.configHash,
      ...(input.harness.connectionId !== undefined
        ? { connectionId: input.harness.connectionId }
        : {}),
      ...(input.harness.connectionRevision !== undefined
        ? { connectionRevision: input.harness.connectionRevision }
        : {}),
      ...(input.harness.requestedModelId !== undefined
        ? { requestedModelId: input.harness.requestedModelId }
        : {}),
    },
    ...(input.workspace !== undefined ? { workspace: input.workspace } : {}),
    context: input.context === null ? null : { ...input.context },
    session: { mode: input.dispatchable ? "fresh" : "unknown" },
    usage: { reported: false },
    timing: { startedAt: input.startedAt, completedAt: null, durationMs: null },
  };
}

/** Extract only ACTUAL usage numbers from a schema-validated AgentResult
 *  usage block (defense in depth: bounded non-negative integers only).
 *  `reported` is true only when the runtime actually supplied usage; a
 *  present-but-empty usage block stays `reported: true` with no numbers. */
export function extractReportedUsage(usage: unknown): ReportedUsageV1 {
  if (usage === null || usage === undefined || typeof usage !== "object") {
    return { reported: false };
  }
  const source = usage as Record<string, unknown>;
  const result: ReportedUsageV1 = { reported: true };
  const numeric = (field: string) => {
    const value = source[field];
    if (
      typeof value === "number" &&
      Number.isSafeInteger(value) &&
      value >= 0
    ) {
      return value;
    }
    return undefined;
  };
  const inputTokens = numeric("inputTokens");
  const outputTokens = numeric("outputTokens");
  const cachedInputTokens = numeric("cachedInputTokens");
  const cacheWriteTokens = numeric("cacheWriteTokens");
  if (inputTokens !== undefined) result.inputTokens = inputTokens;
  if (outputTokens !== undefined) result.outputTokens = outputTokens;
  if (cachedInputTokens !== undefined) result.cachedInputTokens = cachedInputTokens;
  if (cacheWriteTokens !== undefined) result.cacheWriteTokens = cacheWriteTokens;
  return result;
}

/** Complete a claim-time efficiency record with observed usage + terminal
 *  timing. Returns a NEW immutable record; the caller persists it once. */
export function completeEfficiencyEvidence(
  evidence: InvocationEfficiencyEvidenceV1,
  usage: unknown,
  completedAt: string,
  startedAt: string,
): InvocationEfficiencyEvidenceV1 {
  return {
    ...evidence,
    usage: extractReportedUsage(usage),
    timing: {
      startedAt,
      completedAt,
      durationMs: Math.max(0, Date.parse(completedAt) - Date.parse(startedAt)),
    },
  };
}

/** Strict parse of a persisted efficiency record (trust boundary: the value
 *  comes from durable jsonb evidence). Unknown keys/versions/shapes are
 *  rejected — a snapshot claiming a shape this version does not define is
 *  never silently coerced. */
export function parseEfficiencyEvidence(value: unknown): InvocationEfficiencyEvidenceV1 {
  const snapshot = record(value, "InvocationEfficiencyEvidenceV1");
  if (snapshot.schemaVersion !== 1) {
    throw efficiencyInvalid(
      `Efficiency evidence schemaVersion "${String(snapshot.schemaVersion)}" is not supported`,
    );
  }
  assertOnlyKeys(
    snapshot,
    [
      "schemaVersion",
      "invocationId",
      "contextBundle",
      "harness",
      "workspace",
      "context",
      "session",
      "usage",
      "timing",
    ],
    "Efficiency evidence",
  );
  const invocationId = boundedString(
    snapshot.invocationId,
    "invocationId",
    255,
  );
  const evidence: InvocationEfficiencyEvidenceV1 = {
    schemaVersion: 1,
    invocationId,
    contextBundle: null,
    harness: parseHarness(snapshot.harness),
    context: null,
    session: parseSession(snapshot.session),
    usage: parseUsage(snapshot.usage),
    timing: parseTiming(snapshot.timing),
  };
  // `null` is the LEGITIMATE no-context-bundle variant written by
  // buildClaimEfficiencyEvidence for attempts without a Tenvyr
  // contextProjection; only an absent or object value is valid here.
  if (
    snapshot.contextBundle !== undefined &&
    snapshot.contextBundle !== null
  ) {
    const bundle = record(snapshot.contextBundle, "contextBundle");
    assertOnlyKeys(bundle, ["hash", "reused"], "contextBundle");
    const hash = boundedString(bundle.hash, "contextBundle.hash", 64);
    if (!/^[0-9a-f]{64}$/.test(hash)) {
      throw efficiencyInvalid(
        "Efficiency evidence contextBundle.hash must be 64 lowercase hex characters",
      );
    }
    if (typeof bundle.reused !== "boolean") {
      throw efficiencyInvalid(
        "Efficiency evidence contextBundle.reused must be a boolean",
      );
    }
    evidence.contextBundle = { hash, reused: bundle.reused };
  }
  if (snapshot.workspace !== undefined) {
    const workspace = record(snapshot.workspace, "workspace");
    assertOnlyKeys(
      workspace,
      ["workspaceId", "branch", "headSha", "dirty"],
      "workspace",
    );
    const identity: ContextWorkspaceIdentityV1 = {
      workspaceId: boundedString(workspace.workspaceId, "workspace.workspaceId", 255),
      branch: nullableString(workspace.branch, "workspace.branch", 255),
      headSha: nullableString(workspace.headSha, "workspace.headSha", 64),
      dirty: nullableBoolean(workspace.dirty, "workspace.dirty"),
    };
    evidence.workspace = identity;
  }
  if (snapshot.context !== undefined && snapshot.context !== null) {
    evidence.context = parseContextMetrics(snapshot.context);
  }
  return evidence;
}

function parseHarness(value: unknown): HarnessIdentityV1 {
  const snapshot = record(value, "harness");
  assertOnlyKeys(
    snapshot,
    [
      "agent",
      "executorKind",
      "configHash",
      "connectionId",
      "connectionRevision",
      "requestedModelId",
    ],
    "harness",
  );
  const harness: HarnessIdentityV1 = {
    agent: boundedString(snapshot.agent, "harness.agent", 255),
    executorKind: boundedString(snapshot.executorKind, "harness.executorKind", 32),
    configHash: boundedString(snapshot.configHash, "harness.configHash", 64),
  };
  if (snapshot.connectionId !== undefined) {
    harness.connectionId = boundedString(
      snapshot.connectionId,
      "harness.connectionId",
      255,
    );
  }
  if (snapshot.connectionRevision !== undefined) {
    harness.connectionRevision = nonNegativeInteger(
      snapshot.connectionRevision,
      "harness.connectionRevision",
    );
  }
  if (snapshot.requestedModelId !== undefined) {
    harness.requestedModelId = boundedString(
      snapshot.requestedModelId,
      "harness.requestedModelId",
      256,
    );
  }
  return harness;
}

function parseContextMetrics(value: unknown): ContextMetricsV1 {
  const snapshot = record(value, "context");
  assertOnlyKeys(
    snapshot,
    [
      "projectedBytes",
      "projectedCharacters",
      "selectedContextItemCount",
      "selectedArtifactCount",
      "executionStateBytes",
    ],
    "context",
  );
  return {
    projectedBytes: nonNegativeInteger(snapshot.projectedBytes, "context.projectedBytes"),
    projectedCharacters: nonNegativeInteger(
      snapshot.projectedCharacters,
      "context.projectedCharacters",
    ),
    selectedContextItemCount: nonNegativeInteger(
      snapshot.selectedContextItemCount,
      "context.selectedContextItemCount",
    ),
    selectedArtifactCount: nonNegativeInteger(
      snapshot.selectedArtifactCount,
      "context.selectedArtifactCount",
    ),
    executionStateBytes: nonNegativeInteger(
      snapshot.executionStateBytes,
      "context.executionStateBytes",
    ),
  };
}

function parseSession(value: unknown): { mode: SessionModeV1 } {
  const snapshot = record(value, "session");
  assertOnlyKeys(snapshot, ["mode"], "session");
  const mode = snapshot.mode;
  if (typeof mode !== "string" || !(SESSION_MODES as readonly string[]).includes(mode)) {
    throw efficiencyInvalid(
      `Efficiency evidence session.mode "${String(mode)}" is not supported`,
    );
  }
  return { mode: mode as SessionModeV1 };
}

function parseUsage(value: unknown): ReportedUsageV1 {
  const snapshot = record(value, "usage");
  assertOnlyKeys(
    snapshot,
    ["reported", "inputTokens", "outputTokens", "cachedInputTokens", "cacheWriteTokens"],
    "usage",
  );
  if (typeof snapshot.reported !== "boolean") {
    throw efficiencyInvalid("Efficiency evidence usage.reported must be a boolean");
  }
  const usage: ReportedUsageV1 = { reported: snapshot.reported };
  const optionalTokens = (
    field: "inputTokens" | "outputTokens" | "cachedInputTokens" | "cacheWriteTokens",
  ) => {
    if (snapshot[field] !== undefined) {
      usage[field] = nonNegativeInteger(snapshot[field], `usage.${field}`);
    }
  };
  optionalTokens("inputTokens");
  optionalTokens("outputTokens");
  optionalTokens("cachedInputTokens");
  optionalTokens("cacheWriteTokens");
  return usage;
}

function parseTiming(value: unknown): InvocationEfficiencyEvidenceV1["timing"] {
  const snapshot = record(value, "timing");
  assertOnlyKeys(snapshot, ["startedAt", "completedAt", "durationMs"], "timing");
  const startedAt = boundedString(snapshot.startedAt, "timing.startedAt", 64);
  const completedAt = nullableString(snapshot.completedAt, "timing.completedAt", 64);
  let durationMs: number | null = null;
  if (snapshot.durationMs !== undefined && snapshot.durationMs !== null) {
    durationMs = nonNegativeInteger(snapshot.durationMs, "timing.durationMs");
  }
  return { startedAt, completedAt, durationMs };
}

function record(value: unknown, what: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw efficiencyInvalid(`${what} must be an object`);
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
    throw efficiencyInvalid(
      `${what} contains an unsupported field "${unknown[0]}"`,
    );
  }
}

function boundedString(value: unknown, field: string, maxLength: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxLength
  ) {
    throw efficiencyInvalid(
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
    throw efficiencyInvalid(
      `${field} must be a string of at most ${maxLength} characters or null`,
    );
  }
  return value;
}

function nullableBoolean(value: unknown, field: string): boolean | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "boolean") {
    throw efficiencyInvalid(`${field} must be a boolean or null`);
  }
  return value;
}

function nonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw efficiencyInvalid(`${field} must be a non-negative integer`);
  }
  return value;
}

function efficiencyInvalid(message: string): Error {
  return new Error(`Efficiency evidence invalid: ${message}`);
}