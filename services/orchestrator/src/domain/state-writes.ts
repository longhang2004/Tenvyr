import type { JsonValue } from "@tenvyr/contracts";
import { canonicalJson } from "./canonical-json";
import { validateStateKey } from "./execution-state";

/**
 * M2E domain semantics: pipeline-declared controlled state writes from a
 * successful canonical AgentResultV1.output. Authority belongs to the frozen
 * pipeline definition and the canonical ResultInbox transaction — never to an
 * agent-supplied patch or metadata field. No `statePatch` field is added to
 * AgentResultV1.
 *
 * `fromOutput` is a restricted RFC 6901 JSON Pointer: the empty pointer and
 * URI-fragment forms, wildcards, filters, recursive descent, expressions, and
 * the `-` array append token are rejected. Only `~0`/`~1` escapes decode.
 * Array index tokens must be canonical non-negative base-10 integers without
 * leading zeros (except `0`).
 */
export const STATE_WRITES_BOUNDS = {
  /** maximum mappings per step */
  maxMappings: 128,
} as const;

export type StateWriteMapping = {
  /** exact top-level ExecutionState key (M2B key rules; dots are ordinary). */
  key: string;
  /** restricted RFC 6901 JSON Pointer into AgentResultV1.output. */
  fromOutput: string;
};

/** Deterministic post-result mapping failure; code never embeds values. */
export class StateWriteResolutionError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "StateWriteResolutionError";
  }
}

/**
 * Validate untrusted `stateWrites` configuration at pipeline ingress.
 * Rejects non-arrays, empty arrays, over-bounds counts, malformed mappings,
 * unknown fields, unsafe/duplicate target keys, malformed pointers, and
 * duplicate mappings. Returns a defensive copy.
 */
export function validateStateWrites(input: unknown): StateWriteMapping[] {
  if (!Array.isArray(input)) {
    throw new Error("stateWrites must be an array");
  }
  if (input.length === 0) {
    throw new Error("stateWrites must not be empty");
  }
  if (input.length > STATE_WRITES_BOUNDS.maxMappings) {
    throw new Error(
      `stateWrites exceeds ${STATE_WRITES_BOUNDS.maxMappings} mappings`,
    );
  }
  const mappings: StateWriteMapping[] = [];
  const targetKeys = new Set<string>();
  for (const entry of input) {
    if (!isPlainObject(entry)) {
      throw new Error("stateWrites entries must be objects");
    }
    const source = entry as Record<string, unknown>;
    const unknownField = Object.keys(source).find(
      (key) => key !== "key" && key !== "fromOutput",
    );
    if (unknownField !== undefined) {
      throw new Error(`stateWrites contains unknown field "${unknownField}"`);
    }
    if (typeof source.key !== "string" || source.key.trim() === "") {
      throw new Error("stateWrites.key must be a non-empty string");
    }
    validateStateKey(source.key);
    if (targetKeys.has(source.key)) {
      throw new Error(
        `stateWrites contains duplicate target key "${source.key}"`,
      );
    }
    targetKeys.add(source.key);
    if (
      typeof source.fromOutput !== "string" ||
      source.fromOutput.trim() === ""
    ) {
      throw new Error("stateWrites.fromOutput must be a non-empty string");
    }
    // Syntax is validated at ingress so malformed pointers fail fast.
    parseJsonPointer(source.fromOutput);
    mappings.push({ key: source.key, fromOutput: source.fromOutput });
  }
  const serialized = mappings.map((mapping) => canonicalJson(mapping));
  if (new Set(serialized).size !== serialized.length) {
    throw new Error("stateWrites contains duplicate mappings");
  }
  return mappings;
}

/**
 * Parse a restricted RFC 6901 JSON Pointer into reference tokens.
 * Rejects the empty pointer, the URI-fragment form, invalid `~` escapes,
 * and the `-` array append token.
 */
export function parseJsonPointer(pointer: string): string[] {
  if (pointer === "" || pointer.startsWith("#")) {
    throw new Error(
      "stateWrites.fromOutput must be a plain RFC 6901 pointer starting with '/'",
    );
  }
  if (!pointer.startsWith("/")) {
    throw new Error(
      "stateWrites.fromOutput must be a plain RFC 6901 pointer starting with '/'",
    );
  }
  const raw = pointer.slice(1).split("/");
  if (raw.includes("-")) {
    throw new Error(
      "stateWrites.fromOutput must not use the '-' array append token",
    );
  }
  return raw.map((token) => {
    let decoded = "";
    for (let index = 0; index < token.length; index += 1) {
      const char = token[index];
      if (char !== "~") {
        decoded += char;
        continue;
      }
      const next = token[index + 1];
      if (next === "0") {
        decoded += "~";
      } else if (next === "1") {
        decoded += "/";
      } else {
        throw new Error(
          `stateWrites.fromOutput contains an invalid escape "~${next ?? ""}"`,
        );
      }
      index += 1;
    }
    return decoded;
  });
}

/**
 * Resolve parsed pointer tokens against a JSON value. Missing keys, missing
 * array indices, and non-canonical array index tokens are `not found`
 * (deterministic mapping failure). Array index tokens must be canonical
 * non-negative base-10 integers without leading zeros except `0`.
 */
export function resolveJsonPointer(
  output: unknown,
  tokens: string[],
): { found: true; value: JsonValue } | { found: false } {
  let current: unknown = output;
  for (const token of tokens) {
    if (Array.isArray(current)) {
      if (!/^(0|[1-9][0-9]*)$/.test(token)) {
        return { found: false };
      }
      const index = Number(token);
      if (index >= current.length) return { found: false };
      current = current[index];
    } else if (isPlainObject(current)) {
      if (!Object.prototype.hasOwnProperty.call(current, token)) {
        return { found: false };
      }
      current = (current as Record<string, unknown>)[token];
    } else {
      return { found: false };
    }
  }
  return { found: true, value: current as JsonValue };
}

/**
 * Build the M2B patch for one successful result from its declared mappings.
 * Every mapping is required: the first missing pointer or non-JSON selected
 * value throws StateWriteResolutionError, and no key is applied partially.
 */
export function buildStateWritesPatch(
  output: unknown,
  mappings: StateWriteMapping[],
): { set: Record<string, JsonValue> } {
  const set: Record<string, JsonValue> = {};
  for (const mapping of mappings) {
    const tokens = parseJsonPointer(mapping.fromOutput);
    const resolved = resolveJsonPointer(output, tokens);
    if (!resolved.found) {
      throw new StateWriteResolutionError("TENVYR_STATE_WRITE_POINTER_MISSING");
    }
    set[mapping.key] = structuredClone(resolved.value);
  }
  return { set };
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
