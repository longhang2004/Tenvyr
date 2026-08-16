import type { JsonValue } from "@tenvyr/contracts";
import { canonicalJson } from "./canonical-json";
import {
  jsonValueUtf8Size,
  validateStateKey,
  type ExecutionState,
} from "./execution-state";

/**
 * M2C/M2D domain semantics: the declarative ContextProjection and the
 * immutable attempt-owned ContextSnapshot envelope.
 *
 * ContextProjection is pipeline configuration authorizing which execution
 * state keys (M2C) and artifact references (M2D) Tenvyr may expose to one
 * attempt. ContextSnapshot is the versioned, bounded, immutable envelope
 * committed with the attempt and its DispatchOutbox invocation.
 *
 * The reserved Tenvyr envelope lives in AgentInvocationV1.context under the
 * single `tenvyr` member. M2C emits an empty `artifacts` list; M2D fills it
 * with bounded Tenvyr-owned artifact references plus append-only exposure
 * edges committed atomically with the attempt.
 */
export const CONTEXT_SNAPSHOT_BOUNDS = {
  /** maximum selected state keys per projection */
  maxStateKeys: 128,
  /** maximum configured artifact selectors per projection */
  maxArtifactSelectors: 128,
  /** maximum resolved artifact references per attempt */
  maxArtifactReferences: 128,
  /** maximum complete canonical UTF-8 context.tenvyr envelope bytes */
  maxEnvelopeBytes: 65_536,
} as const;

/**
 * Declarative artifact selector: exact references produced by a declared
 * transitive dependency step. `name` and `ordinal` are mutually exclusive
 * filters; no filter selects every authoritative artifact of the eligible
 * producer result. `includeMetadata` defaults false (metadata is absent, not
 * an empty object, when false).
 */
export type ArtifactSelector = {
  fromStep: string;
  name?: string;
  ordinal?: number;
  includeMetadata?: boolean;
};

/**
 * Declarative pipeline configuration: exact top-level ExecutionState keys
 * (a dot is an ordinary key character) and optional artifact selectors.
 */
export type ContextProjection = {
  stateKeys: string[];
  artifacts?: ArtifactSelector[];
};

/**
 * Bounded Tenvyr-owned artifact reference placed in the context envelope.
 * `uri` stays opaque producer data: the Orchestrator never fetches, probes,
 * resolves, normalizes, or logs it. Optional source fields stay absent when
 * absent; metadata appears only when explicitly requested.
 */
export type ArtifactContextReference = {
  artifactId: string;
  producerStepId: string;
  producerAttemptId: string;
  descriptorOrdinal: number;
  name?: string;
  mediaType?: string;
  uri?: string;
  metadata?: Record<string, JsonValue>;
};

/** The reserved, versioned Tenvyr context envelope (deep-equal snapshot/outbox). */
export type TenvyrContextEnvelope = {
  tenvyr: {
    schemaVersion: 1;
    executionState: {
      version: number;
      values: Record<string, JsonValue>;
    };
    artifacts: ArtifactContextReference[];
  };
};

/**
 * Deterministic claim-time projection failure. `code` is a stable Tenvyr
 * error code; the message never contains state values or keys.
 */
export class ContextProjectionError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "ContextProjectionError";
  }
}

/**
 * Validate untrusted projection configuration at pipeline ingress. Rejects
 * malformed shapes, unknown fields, empty or duplicate selections, unsafe
 * keys, over-bounds selections, and malformed artifact selectors. Returns a
 * defensive copy so a caller mutating its input cannot change the frozen step
 * specification. `stateKeys` may be empty only when artifact selectors give
 * the projection meaning; an explicit empty `artifacts` array is rejected.
 */
export function validateContextProjection(input: unknown): ContextProjection {
  if (!isPlainObject(input)) {
    throw new Error("contextProjection must be an object");
  }
  const source = input as Record<string, unknown>;
  const unknownField = Object.keys(source).find(
    (key) => key !== "stateKeys" && key !== "artifacts",
  );
  if (unknownField !== undefined) {
    throw new Error(
      `contextProjection contains unknown field "${unknownField}"`,
    );
  }
  if (source.stateKeys === undefined) {
    throw new Error('contextProjection requires "stateKeys"');
  }
  if (!Array.isArray(source.stateKeys)) {
    throw new Error("contextProjection.stateKeys must be an array of strings");
  }
  if (source.stateKeys.length > CONTEXT_SNAPSHOT_BOUNDS.maxStateKeys) {
    throw new Error(
      `contextProjection.stateKeys exceeds ${CONTEXT_SNAPSHOT_BOUNDS.maxStateKeys} keys`,
    );
  }
  const seen = new Set<string>();
  for (const key of source.stateKeys) {
    if (typeof key !== "string") {
      throw new Error("contextProjection.stateKeys entries must be strings");
    }
    // M2B key safety and Unicode length rules apply to selectors unchanged.
    validateStateKey(key);
    if (seen.has(key)) {
      throw new Error(
        `contextProjection.stateKeys contains duplicate key "${key}"`,
      );
    }
    seen.add(key);
  }

  const artifacts =
    source.artifacts === undefined
      ? undefined
      : validateArtifactSelectors(source.artifacts);

  if (source.stateKeys.length === 0 && (artifacts ?? []).length === 0) {
    throw new Error(
      "contextProjection must select state keys or artifact references",
    );
  }
  return {
    stateKeys: [...source.stateKeys],
    ...(artifacts === undefined ? {} : { artifacts }),
  };
}

/**
 * Validate untrusted artifact selector configuration. Rejects non-arrays,
 * empty arrays, over-bounds counts, malformed selectors, unknown fields,
 * mutual name/ordinal conflicts, unsafe values, and duplicate selectors.
 * The graph eligibility of `fromStep` is validated by the pipeline DAG check.
 */
export function validateArtifactSelectors(input: unknown): ArtifactSelector[] {
  if (!Array.isArray(input)) {
    throw new Error("contextProjection.artifacts must be an array");
  }
  if (input.length === 0) {
    throw new Error(
      "contextProjection.artifacts must not be empty; omit it when no artifacts are wanted",
    );
  }
  if (input.length > CONTEXT_SNAPSHOT_BOUNDS.maxArtifactSelectors) {
    throw new Error(
      `contextProjection.artifacts exceeds ${CONTEXT_SNAPSHOT_BOUNDS.maxArtifactSelectors} selectors`,
    );
  }
  const selectors: ArtifactSelector[] = [];
  for (const entry of input) {
    if (!isPlainObject(entry)) {
      throw new Error("contextProjection.artifacts entries must be objects");
    }
    const source = entry as Record<string, unknown>;
    const unknownField = Object.keys(source).find(
      (key) =>
        key !== "fromStep" &&
        key !== "name" &&
        key !== "ordinal" &&
        key !== "includeMetadata",
    );
    if (unknownField !== undefined) {
      throw new Error(
        `contextProjection.artifacts contains unknown field "${unknownField}"`,
      );
    }
    if (typeof source.fromStep !== "string" || source.fromStep.trim() === "") {
      throw new Error(
        "contextProjection.artifacts.fromStep must be a non-empty string",
      );
    }
    const selector: ArtifactSelector = { fromStep: source.fromStep };
    if (source.name !== undefined) {
      if (typeof source.name !== "string") {
        throw new Error("contextProjection.artifacts.name must be a string");
      }
      selector.name = source.name;
    }
    if (source.ordinal !== undefined) {
      if (
        typeof source.ordinal !== "number" ||
        !Number.isInteger(source.ordinal) ||
        source.ordinal < 0
      ) {
        throw new Error(
          "contextProjection.artifacts.ordinal must be a non-negative integer",
        );
      }
      selector.ordinal = source.ordinal;
    }
    if (source.name !== undefined && source.ordinal !== undefined) {
      throw new Error(
        "contextProjection.artifacts.name and ordinal are mutually exclusive",
      );
    }
    if (source.includeMetadata !== undefined) {
      if (typeof source.includeMetadata !== "boolean") {
        throw new Error(
          "contextProjection.artifacts.includeMetadata must be a boolean",
        );
      }
      selector.includeMetadata = source.includeMetadata;
    }
    selectors.push(selector);
  }
  // Duplicate selectors are rejected deterministically; overlapping selectors
  // that resolve the same artifact are rejected at resolution time.
  const serialized = selectors.map((selector) => canonicalJson(selector));
  if (new Set(serialized).size !== serialized.length) {
    throw new Error("contextProjection.artifacts contains duplicate selectors");
  }
  return selectors;
}

/**
 * P3: select and canonically order exactly the state values a projection
 * would place in the Tenvyr context envelope, WITHOUT building the full
 * envelope. Used to compute the ContextBundle fingerprint before the
 * materialization/validation pass. Mirrors the selection inside
 * `materializeContextSnapshot` exactly (same validation, same clones, same
 * deterministic key order) so a cache miss produces identical semantics.
 */
export function selectProjectedValues(
  projection: unknown,
  state: ExecutionState,
): Record<string, JsonValue> {
  let validated: ContextProjection;
  try {
    validated = validateContextProjection(projection);
  } catch {
    throw new ContextProjectionError("TENVYR_CTX_INVALID_PROJECTION");
  }

  const values: Record<string, JsonValue> = {};
  for (const key of validated.stateKeys) {
    if (!Object.prototype.hasOwnProperty.call(state, key)) {
      throw new ContextProjectionError("TENVYR_CTX_MISSING_STATE_KEY");
    }
    values[key] = structuredClone(state[key] as JsonValue);
  }

  // Canonical lexicographic key order, independent of caller insertion order.
  const ordered: Record<string, JsonValue> = {};
  for (const key of Object.keys(values).sort()) {
    ordered[key] = values[key];
  }
  return ordered;
}

/**
 * Materialize the immutable Tenvyr context envelope for one attempt from the
 * authoritative state version read under the execution lock and the resolved
 * artifact references (M2D; empty by default).
 *
 * - selects only exact top-level keys (a dot is an ordinary key character);
 * - explicit JSON null is included; missing keys are a deterministic claim
 *   failure (TENVYR_CTX_MISSING_STATE_KEY);
 * - output keys are canonically sorted, independent of input ordering;
 * - selected values are isolated clones; the envelope is re-validated for
 *   JSON safety and the complete 65,536-byte bound after it is formed.
 */
export function materializeContextSnapshot(
  projection: unknown,
  state: ExecutionState,
  version: number,
  artifactReferences: ArtifactContextReference[] = [],
): TenvyrContextEnvelope {
  const ordered = selectProjectedValues(projection, state);

  const envelope: TenvyrContextEnvelope = {
    tenvyr: {
      schemaVersion: 1,
      executionState: { version, values: ordered },
      artifacts: artifactReferences.map((reference) =>
        structuredClone(reference),
      ),
    },
  };

  // Complete-envelope bound, not per-value: the size of the whole canonical
  // UTF-8 envelope is the ceiling. Reuses M2B JSON safety (rejects non-JSON,
  // non-finite numbers, cycles, unsafe nesting).
  let size: number;
  try {
    size = jsonValueUtf8Size(envelope);
  } catch {
    throw new ContextProjectionError("TENVYR_CTX_UNSAFE_VALUE");
  }
  if (size > CONTEXT_SNAPSHOT_BOUNDS.maxEnvelopeBytes) {
    throw new ContextProjectionError("TENVYR_CTX_ENVELOPE_TOO_LARGE");
  }
  return envelope;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  let proto: object | null;
  try {
    proto = Object.getPrototypeOf(value);
  } catch {
    return false;
  }
  if (proto === null) return true;
  try {
    return Object.getPrototypeOf(proto) === null;
  } catch {
    return false;
  }
}
