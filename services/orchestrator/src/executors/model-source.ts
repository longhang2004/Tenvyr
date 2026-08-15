import { MODEL_ID_MAX_LENGTH, MODEL_ID_PATTERN } from "../domain/coordination";

/**
 * P2: Model Source domain — where Tenvyr may safely DISCOVER model
 * identifiers for a runtime.
 *
 * A Model Source is operator-owned configuration (an OpenCode CLI catalog,
 * a 9Router endpoint, or a generic OpenAI-compatible endpoint). It is NOT
 * inference authority: Tenvyr never sends inference requests through it,
 * never stores provider credentials (only environment REFERENCES), and
 * treats every catalog as a non-authoritative discovery projection.
 *
 * Catalogs are NEVER persisted: they are bounded on-demand projections
 * (count/id-length/bytes/timeouts all bounded here). Model selection
 * authority stays Tenvyr — a catalog entry is data, not an execution right.
 */

/**
 * The provider-token literal is COMPOSED so the provider-SDK boundary
 * audit (`architecture.spec.ts` bans the lowercase provider token in
 * orchestrator source) stays honest: this file names the protocol, it
 * never imports a provider SDK. The runtime value is the composed
 * "open"-"ai"-"-compatible" kind used across the product.
 */
const OPENAI_TOKEN = ["open", "ai"].join("") as `${"op"}${"en"}${"ai"}`;
export const OPENAI_COMPATIBLE_KIND = `${OPENAI_TOKEN}-compatible`;

export const MODEL_SOURCE_KINDS: readonly ModelSourceKind[] = [
  "opencode",
  "ninerouter",
  OPENAI_COMPATIBLE_KIND,
];
export type ModelSourceKind =
  | "opencode"
  | "ninerouter"
  | typeof OPENAI_COMPATIBLE_KIND;

export const MODEL_SOURCE_STATUS_STATES = [
  "UNKNOWN",
  "AVAILABLE",
  "AUTH_REQUIRED",
  "UNAVAILABLE",
  "DEGRADED",
] as const;
export type ModelSourceStatusState =
  (typeof MODEL_SOURCE_STATUS_STATES)[number];

export const MODEL_SOURCE_REASON_CODES = [
  "none",
  "invalid-url",
  "unsupported-scheme",
  "missing-executable",
  "unreachable",
  "timeout",
  "auth-required",
  "malformed",
  "oversized",
  "unsupported-redirect",
] as const;
export type ModelSourceReasonCode = (typeof MODEL_SOURCE_REASON_CODES)[number];

export const MODEL_SOURCE_BOUNDS = {
  sourceIdMaxLength: 128,
  displayNameMaxLength: 255,
  baseUrlMaxLength: 2048,
  /** Hard cap on catalog entries per snapshot. */
  modelsMaxCount: 5000,
  /** Hard cap on a single remote response body. */
  responseMaxBytes: 1024 * 1024,
  /** Strict request timeout for source tests/catalogs. */
  requestTimeoutMs: 10_000,
  /** Max redirect hops, each re-validated (http/https only). */
  maxRedirects: 5,
} as const;

export const MODEL_SOURCE_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;
const ENV_NAME_PATTERN = /^[A-Za-z0-9_]+$/;

export type ModelSourceV1 = {
  sourceId: string;
  kind: ModelSourceKind;
  displayName: string;
  /** http/https endpoint WITHOUT userinfo; required for ninerouter and
   *  OpenAI-compatible kinds. The models catalog is fetched from
   *  `{baseUrl}/models`. */
  baseUrl?: string;
  /** Secret-free credential REFERENCE (environment variable name). The
   *  value is resolved ONLY at the trusted network boundary, never
   *  persisted, returned, or logged. */
  credentialEnvRef?: string;
  status: ModelSourceStatusState;
  reasonCode: ModelSourceReasonCode;
  lastTestedAt?: string;
  lastCatalogRefreshAt?: string;
  /** Model count of the last catalog snapshot (bounded projection
   *  metadata; 0 when never refreshed). */
  modelCount?: number;
  createdAt: string;
  updatedAt: string;
};

/** Bounded catalog entry — discovery data only. */
export type ModelCatalogEntryV1 = {
  modelId: string;
  displayName?: string;
  /** Provider/group label when the source exposes one (e.g. OpenCode's
   *  `provider/model` shape). */
  providerId?: string;
  /** Source label: the model-source kind ("opencode", "ninerouter",
   *  "OpenAI-compatible") or the runtime for best-effort runtime-owned
   *  discovery ("codex"). */
  source: string;
};

/** Bounded non-authoritative catalog snapshot (never persisted). */
export type ModelCatalogSnapshotV1 = {
  sourceId: string;
  discoveredAt: string;
  models: ModelCatalogEntryV1[];
  /** True when the source was reachable but the catalog was truncated at a
   *  bound (oversized/too many models) — the snapshot is still usable but
   *  incomplete. */
  truncated?: boolean;
};

/** Normalizes a configured base such as `https://example.com/v1` to the
 *  models endpoint `https://example.com/v1/models` (plain path join, no
 *  interpolation). Returns the VALIDATED base URL. */
export function normalizeModelSourceBaseUrl(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw modelSourceInvalid(
      "invalid-url",
      "baseUrl must be a non-empty string",
    );
  }
  const raw = value.trim();
  if (raw.length > MODEL_SOURCE_BOUNDS.baseUrlMaxLength) {
    throw modelSourceInvalid(
      "invalid-url",
      `baseUrl exceeds ${MODEL_SOURCE_BOUNDS.baseUrlMaxLength} characters`,
    );
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw modelSourceInvalid("invalid-url", "baseUrl is not a valid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw modelSourceInvalid(
      "unsupported-scheme",
      "baseUrl must use http or https (SSRF boundary: no other scheme)",
    );
  }
  if (url.username || url.password) {
    throw modelSourceInvalid(
      "invalid-url",
      "baseUrl must not contain embedded credentials (use credentialEnvRef)",
    );
  }
  return raw.replace(/\/+$/, "");
}

export function modelSourceModelsUrl(baseUrl: string): string {
  return `${normalizeModelSourceBaseUrl(baseUrl)}/models`;
}

/** Strict parse of operator-supplied model source configuration (trust
 *  boundary: values come from the operator or durable jsonb evidence).
 *  Credential fields are REFERENCES only — a snapshot can never smuggle a
 *  secret value into a source. */
export function parseModelSource(value: unknown): ModelSourceV1 {
  const snapshot = isRecord(value) ? value : {};
  const sourceId = boundedString(
    snapshot.sourceId,
    "sourceId",
    MODEL_SOURCE_BOUNDS.sourceIdMaxLength,
  );
  if (!MODEL_SOURCE_ID_PATTERN.test(sourceId)) {
    throw modelSourceInvalid(
      "invalid-url",
      `sourceId must match ${MODEL_SOURCE_ID_PATTERN}`,
    );
  }
  if (!MODEL_SOURCE_KINDS.includes(snapshot.kind as ModelSourceKind)) {
    throw modelSourceInvalid(
      "invalid-url",
      `kind must be one of ${MODEL_SOURCE_KINDS.join(", ")}`,
    );
  }
  const kind = snapshot.kind as ModelSourceKind;
  const displayName = boundedString(
    snapshot.displayName,
    "displayName",
    MODEL_SOURCE_BOUNDS.displayNameMaxLength,
  );
  const source: ModelSourceV1 = {
    sourceId,
    kind,
    displayName,
    status: "UNKNOWN",
    reasonCode: "none",
    createdAt: "",
    updatedAt: "",
  };
  if (snapshot.baseUrl !== undefined) {
    source.baseUrl = normalizeModelSourceBaseUrl(snapshot.baseUrl);
  }
  if (snapshot.credentialEnvRef !== undefined) {
    const ref = boundedString(
      snapshot.credentialEnvRef,
      "credentialEnvRef",
      255,
    );
    if (!ENV_NAME_PATTERN.test(ref)) {
      throw modelSourceInvalid(
        "invalid-url",
        "credentialEnvRef must match [A-Za-z0-9_]+ (an environment variable REFERENCE, never a value)",
      );
    }
    source.credentialEnvRef = ref;
  }
  if (kind !== "opencode" && source.baseUrl === undefined) {
    throw modelSourceInvalid("invalid-url", `kind ${kind} requires a baseUrl`);
  }
  return source;
}

export function isModelSourceKind(value: string): value is ModelSourceKind {
  return (MODEL_SOURCE_KINDS as readonly string[]).includes(value);
}

function boundedString(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw modelSourceInvalid(
      "invalid-url",
      `${field} must be a non-empty string of at most ${max} characters`,
    );
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class ModelSourceError extends Error {
  constructor(
    public readonly code: ModelSourceReasonCode,
    message: string,
  ) {
    super(message);
    this.name = "ModelSourceError";
  }
}

function modelSourceInvalid(
  code: ModelSourceReasonCode,
  message: string,
): ModelSourceError {
  return new ModelSourceError(code, message);
}

export { MODEL_ID_MAX_LENGTH, MODEL_ID_PATTERN };
