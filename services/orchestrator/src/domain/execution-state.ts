import type { JsonValue } from "@tenvyr/contracts";
import { canonicalJson } from "./canonical-json";

/**
 * M2B domain semantics: deterministic bounded top-level ExecutionState
 * patches. Dependency-free; no schema/validation library.
 *
 * ExecutionState is a top-level JSON object. A patch replaces or deletes
 * whole top-level keys; nested values are replaced, never recursively
 * merged. All bounds are hard ceilings enforced here or by the service
 * (final-state bounds are enforced where the merged state exists).
 */
export const EXECUTION_STATE_BOUNDS = {
  /** maximum top-level state keys */
  maxStateKeys: 128,
  /** maximum key length in Unicode code points */
  maxKeyLength: 128,
  /** maximum operations in one patch (|set| + |delete|) */
  maxPatchOperations: 128,
  /** maximum canonical patch size, UTF-8 bytes */
  maxPatchBytes: 16 * 1024,
  /** maximum final ExecutionState size, UTF-8 bytes */
  maxStateBytes: 64 * 1024,
} as const;

export type ExecutionState = Record<string, JsonValue>;

export interface ExecutionStatePatch {
  set: Record<string, JsonValue>;
  delete: string[];
}

export class ExecutionStateValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExecutionStateValidationError";
  }
}

// Prototype-pollution and accessor-shadowing keys can never be state keys.
const DANGEROUS_KEYS = new Set(["__proto__", "prototype", "constructor"]);

/**
 * Validate untrusted patch input. Returns the validated patch. Throws
 * ExecutionStateValidationError (a bounded validation error) on any
 * structural, key, operation-count, size, or JSON-safety violation — never
 * a database error.
 */
export function validateStatePatch(input: unknown): ExecutionStatePatch {
  if (!isPlainObject(input)) {
    throw new ExecutionStateValidationError("patch must be a plain object");
  }
  const source = input as Record<string, unknown>;
  const unknownField = Object.keys(source).find(
    (key) => key !== "set" && key !== "delete",
  );
  if (unknownField !== undefined) {
    throw new ExecutionStateValidationError(
      `unknown patch field "${unknownField}"`,
    );
  }

  let set: Record<string, JsonValue> = {};
  let deleteKeys: string[] = [];
  let operations = 0;

  if (source.set !== undefined) {
    if (!isPlainObject(source.set)) {
      throw new ExecutionStateValidationError(
        'patch "set" must be a plain object',
      );
    }
    const setKeys = Object.keys(source.set);
    operations += setKeys.length;
    for (const key of setKeys) {
      validateStateKey(key);
      jsonValueUtf8Size(source.set[key]); // JSON-safety; throws on violation
    }
    // Deep-copy so a caller mutating the patch between validation and the
    // service transaction cannot smuggle in unvalidated keys or values.
    set = structuredClone(source.set) as Record<string, JsonValue>;
  }

  if (source.delete !== undefined) {
    if (!Array.isArray(source.delete)) {
      throw new ExecutionStateValidationError(
        'patch "delete" must be an array of strings',
      );
    }
    deleteKeys = [...source.delete];
    operations += deleteKeys.length;
    for (const key of deleteKeys) {
      if (typeof key !== "string") {
        throw new ExecutionStateValidationError(
          'patch "delete" entries must be strings',
        );
      }
      validateStateKey(key);
    }
    if (new Set(deleteKeys).size !== deleteKeys.length) {
      throw new ExecutionStateValidationError(
        'patch "delete" contains duplicate keys',
      );
    }
  }

  if (operations > EXECUTION_STATE_BOUNDS.maxPatchOperations) {
    throw new ExecutionStateValidationError(
      `patch exceeds ${EXECUTION_STATE_BOUNDS.maxPatchOperations} operations`,
    );
  }
  const overlap = Object.keys(set).find((key) => deleteKeys.includes(key));
  if (overlap !== undefined) {
    throw new ExecutionStateValidationError(
      `key "${overlap}" cannot appear in both set and delete`,
    );
  }

  // Canonical patch size: only present fields count, so the same patch
  // always serializes the same way regardless of caller insertion order.
  const patch: Record<string, unknown> = {
    ...(Object.keys(set).length > 0 ? { set } : {}),
    ...(deleteKeys.length > 0 ? { delete: deleteKeys } : {}),
  };
  if (jsonValueUtf8Size(patch) > EXECUTION_STATE_BOUNDS.maxPatchBytes) {
    throw new ExecutionStateValidationError(
      `patch exceeds ${EXECUTION_STATE_BOUNDS.maxPatchBytes} bytes`,
    );
  }
  return { set, delete: deleteKeys };
}

/**
 * Apply a validated patch to a state object. Never mutates caller-owned
 * objects: the result is a fresh object (sorted keys for deterministic
 * output) whose values alias the validated patch values — the caller must
 * deep-clone before persisting or returning across a trust boundary.
 * `changed` is false for empty patches, identical-value sets, and deletes
 * of absent keys.
 */
export function applyStatePatch(
  state: ExecutionState,
  patch: ExecutionStatePatch,
): { state: ExecutionState; changed: boolean } {
  const removed = new Set(patch.delete);
  const result: Record<string, JsonValue> = {};
  let changed = false;

  for (const key of Object.keys(state)) {
    if (removed.has(key)) {
      changed = true;
      continue;
    }
    result[key] = state[key];
  }
  for (const key of Object.keys(patch.set)) {
    if (
      Object.prototype.hasOwnProperty.call(state, key) &&
      jsonValueEqual(state[key], patch.set[key])
    ) {
      continue; // effective no-op for this key
    }
    changed = true;
    result[key] = patch.set[key];
  }
  if (!changed) return { state, changed: false };

  // Deterministic output regardless of set-object insertion order.
  const ordered: Record<string, JsonValue> = {};
  for (const key of Object.keys(result).sort()) {
    ordered[key] = result[key];
  }
  return { state: ordered, changed: true };
}

/**
 * Canonical UTF-8 byte size of a JSON-safe value (the byte count of the
 * sorted-key serialization; byte count is order-independent, so this counts
 * exactly without materializing the sorted string). Iterative explicit-stack
 * walk: adversarial nesting (bounded only by the size caps) can never
 * overflow the call stack. Throws ExecutionStateValidationError on anything
 * that is not valid JSON.
 */
export function jsonValueUtf8Size(value: unknown): number {
  // Explicit-stack walk; every container frame carries its own accumulation.
  type Frame = {
    kind: "leaf" | "container";
    node: unknown;
    entries?: unknown[];
    keys?: string[] | null; // null for arrays
    index?: number;
    size?: number;
  };
  const stack: Frame[] = [{ kind: "leaf", node: value }];
  const active = new Set<object>();
  let completed = 0;

  while (stack.length > 0) {
    const frame = stack[stack.length - 1];
    if (frame.kind === "leaf") {
      const node = frame.node;
      if (node !== null && typeof node === "object") {
        if (active.has(node)) {
          throw new ExecutionStateValidationError("value contains a cycle");
        }
        // Realm-robust plain-object check (a plain object's prototype chain
        // is at most one level deep); a revoked Proxy yields a bounded error.
        let proto: object | null;
        try {
          proto = Object.getPrototypeOf(node);
        } catch {
          throw new ExecutionStateValidationError(
            "value contains a non-plain object",
          );
        }
        let plain = proto === null;
        if (!plain && !Array.isArray(node)) {
          try {
            plain = Object.getPrototypeOf(proto!) === null;
          } catch {
            plain = false;
          }
        }
        if (!Array.isArray(node) && !plain) {
          throw new ExecutionStateValidationError(
            "value contains a non-plain object",
          );
        }
        const keys = Array.isArray(node) ? null : Object.keys(node);
        if (keys?.some((key) => DANGEROUS_KEYS.has(key))) {
          throw new ExecutionStateValidationError(
            "value contains an unsafe object key",
          );
        }
        active.add(node);
        frame.kind = "container";
        frame.entries =
          keys === null
            ? (node as unknown[])
            : keys.map((key) => (node as Record<string, unknown>)[key]);
        frame.keys = keys;
        frame.index = 0;
        frame.size = 2; // { } or [ ]
        continue;
      }
      completed = leafUtf8Size(node);
      stack.pop();
    } else if (frame.index! < frame.entries!.length) {
      stack.push({ kind: "leaf", node: frame.entries![frame.index!] });
      continue;
    } else {
      completed = frame.size!;
      active.delete(frame.node as object);
      stack.pop();
    }

    if (stack.length > 0) {
      const parent = stack[stack.length - 1];
      if (parent.kind === "container") {
        if (parent.keys === null) {
          parent.size = parent.size! + completed + (parent.index! > 0 ? 1 : 0);
        } else {
          parent.size =
            parent.size! +
            Buffer.byteLength(JSON.stringify(parent.keys![parent.index!])) +
            1 + // colon
            completed +
            (parent.index! > 0 ? 1 : 0); // comma
        }
        parent.index = parent.index! + 1;
      }
    }
  }
  return completed;
}

function leafUtf8Size(node: unknown): number {
  switch (typeof node) {
    case "string":
      return Buffer.byteLength(JSON.stringify(node));
    case "number":
      if (!Number.isFinite(node)) {
        throw new ExecutionStateValidationError(
          "value contains NaN or Infinity",
        );
      }
      return Buffer.byteLength(JSON.stringify(node));
    case "boolean":
      return node ? 4 : 5;
    case "object": // null only; containers are handled by the walker
      if (node === null) return 4;
      throw new ExecutionStateValidationError(
        "value contains a non-JSON object",
      );
    default:
      throw new ExecutionStateValidationError(
        `value contains a non-JSON value (${typeof node})`,
      );
  }
}

export function validateStateKey(key: string): void {
  if (DANGEROUS_KEYS.has(key)) {
    throw new ExecutionStateValidationError(`key "${key}" is not allowed`);
  }
  // Unicode code points, not UTF-16 units.
  if (Array.from(key).length > EXECUTION_STATE_BOUNDS.maxKeyLength) {
    throw new ExecutionStateValidationError(
      `key exceeds ${EXECUTION_STATE_BOUNDS.maxKeyLength} Unicode code points`,
    );
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  // Realm-robust: structuredClone (and other realms) can produce objects
  // whose prototype is not this realm's Object.prototype. A plain object's
  // prototype chain is at most one level deep.
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

// ponytail: canonical-string comparison reuses canonicalJson instead of a
// hand-rolled deep equal; a value nested deep enough to overflow its
// recursion is treated as changed (the mutation path re-validates and saves,
// so correctness holds — only no-op detection degrades).
function jsonValueEqual(left: unknown, right: unknown): boolean {
  try {
    return canonicalJson(left) === canonicalJson(right);
  } catch {
    return false;
  }
}
