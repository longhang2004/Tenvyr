import {
  applyStatePatch,
  EXECUTION_STATE_BOUNDS,
  ExecutionStateValidationError,
  jsonValueUtf8Size,
  validateStatePatch,
} from "./execution-state";
import { canonicalJson } from "./canonical-json";

const reject = (patch: unknown): void => {
  expect(() => validateStatePatch(patch)).toThrow(
    ExecutionStateValidationError,
  );
};

describe("validateStatePatch", () => {
  it("accepts empty, set-only, delete-only, and combined patches", () => {
    expect(validateStatePatch({})).toEqual({ set: {}, delete: [] });
    expect(validateStatePatch({ set: { a: 1 } })).toEqual({
      set: { a: 1 },
      delete: [],
    });
    expect(validateStatePatch({ delete: ["a", "b"] })).toEqual({
      set: {},
      delete: ["a", "b"],
    });
    expect(
      validateStatePatch({ set: { a: null, b: [1, 2] }, delete: ["c"] }),
    ).toEqual({
      set: { a: null, b: [1, 2] },
      delete: ["c"],
    });
  });

  it.each([
    ["not an object", "patch"],
    ["unknown field", { set: {}, merge: {} }],
    ["set not a plain object", { set: [] }],
    ["delete not an array", { delete: "a" }],
    ["delete entry not a string", { delete: [1] }],
    ["set and delete share a key", { set: { a: 1 }, delete: ["a"] }],
    ["duplicate delete keys", { delete: ["a", "a"] }],
    ["dangerous set key __proto__", { set: { ["__proto__"]: {} } }],
    ["dangerous set key prototype", { set: { prototype: 1 } }],
    ["dangerous set key constructor", { set: { constructor: 1 } }],
    ["dangerous delete key __proto__", { delete: ["__proto__"] }],
    ["undefined value", { set: { a: undefined } }],
    ["bigint value", { set: { a: 10n } }],
    ["function value", { set: { a: () => 1 } }],
    ["symbol value", { set: { a: Symbol("x") } }],
    ["NaN value", { set: { a: NaN } }],
    ["Infinity value", { set: { a: Infinity } }],
    ["-Infinity value", { set: { a: -Infinity } }],
    ["Date instance", { set: { a: new Date() } }],
    ["Map instance", { set: { a: new Map() } }],
    ["class instance", { set: { a: new (class Foo {})() } }],
    ["non-plain object", { set: { a: Object.create({ inherited: true }) } }],
    [
      "nested dangerous object key",
      {
        set: {
          a: JSON.parse('{"safe":{"__proto__":{"polluted":true}}}'),
        },
      },
    ],
  ])("rejects %s", (_name, patch) => {
    reject(patch);
  });

  it("rejects cyclic values", () => {
    const cycle: Record<string, unknown> = { name: "cycle" };
    cycle.self = cycle;
    reject({ set: { a: cycle } });
    const arrayCycle: unknown[] = [];
    arrayCycle.push(arrayCycle);
    reject({ set: { a: arrayCycle } });
  });

  it("rejects hostile proxies with a bounded validation error", () => {
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    reject({ set: { a: revoked.proxy } });
    expect(() => validateStatePatch({ set: { a: revoked.proxy } })).toThrow(
      ExecutionStateValidationError,
    );
  });

  it("accepts cross-realm plain objects and rejects cross-realm class instances", () => {
    const vm = require("vm") as typeof import("vm");
    const foreign = vm.runInNewContext("({ a: [1, 2] })") as Record<
      string,
      unknown
    >;
    expect(Object.getPrototypeOf(foreign) !== Object.prototype).toBe(true); // genuinely another realm
    const validated = validateStatePatch({ set: { x: foreign } });
    expect(validated.set.x).toEqual({ a: [1, 2] });

    const foreignDate = vm.runInNewContext("new Date(0)") as unknown;
    reject({ set: { x: foreignDate } });
  });

  it("accepts shared (non-cyclic) references and null-prototype objects", () => {
    const shared = { nested: [1, 2] };
    const patch = { set: { a: shared, b: shared, c: Object.create(null) } };
    expect(() => validateStatePatch(patch)).not.toThrow();
    const validated = validateStatePatch(patch);
    // The validated patch is a deep copy: later caller mutation cannot
    // smuggle unvalidated data past validation (TOCTOU guard).
    expect(validated.set.a).toEqual(shared);
    expect(validated.set.a).not.toBe(shared);
    shared.nested.push(3);
    expect(validated.set.a).toEqual({ nested: [1, 2] });
  });

  it("rejects keys longer than 128 Unicode code points but accepts exactly 128", () => {
    const boundary = "😀".repeat(EXECUTION_STATE_BOUNDS.maxKeyLength);
    expect(() => validateStatePatch({ set: { [boundary]: 1 } })).not.toThrow();
    reject({ set: { [boundary + "x"]: 1 } });
    reject({ delete: [boundary + "x"] });
  });

  it("enforces the 128-operation patch ceiling", () => {
    const set128 = Object.fromEntries(
      Array.from({ length: 128 }, (_, i) => [`k${i}`, i]),
    );
    expect(() => validateStatePatch({ set: set128 })).not.toThrow();
    // 100 set + 28 delete = 128 operations: accepted.
    const set100 = Object.fromEntries(
      Array.from({ length: 100 }, (_, i) => [`k${i}`, i]),
    );
    expect(() =>
      validateStatePatch({
        set: set100,
        delete: Array.from({ length: 28 }, (_, i) => `d${i}`),
      }),
    ).not.toThrow();
    reject({ set: { ...set128, overflow: 1 } });
    expect(() =>
      validateStatePatch({ set: set128, delete: ["extra"] }),
    ).toThrow(/128 operations/);
  });

  it("enforces the 16 KiB canonical patch size with exact boundary", () => {
    // `{"set":{"k":"<n chars>"}}` = n + 16 bytes; exactly 16 KiB at n = 16368.
    const atBoundary = { set: { k: "x".repeat(16368) } };
    expect(jsonValueUtf8Size(atBoundary)).toBe(
      EXECUTION_STATE_BOUNDS.maxPatchBytes,
    );
    expect(() => validateStatePatch(atBoundary)).not.toThrow();
    const overBoundary = { set: { k: "x".repeat(16369) } };
    expect(jsonValueUtf8Size(overBoundary)).toBe(
      EXECUTION_STATE_BOUNDS.maxPatchBytes + 1,
    );
    reject(overBoundary);
  });

  it("counts canonical patch size independent of set insertion order", () => {
    const first = { set: { z: 1, a: 2, m: 3 }, delete: ["x"] };
    const second = { set: { m: 3, z: 1, a: 2 }, delete: ["x"] };
    expect(jsonValueUtf8Size(first)).toBe(jsonValueUtf8Size(second));
  });
});

describe("jsonValueUtf8Size", () => {
  it("measures multibyte UTF-8 exactly (escaped strings included)", () => {
    expect(jsonValueUtf8Size("")).toBe(2); // ""
    expect(jsonValueUtf8Size("é")).toBe(4); // "é" = 2 bytes + 2 quotes
    expect(jsonValueUtf8Size("😀")).toBe(6); // "😀" = 4 bytes + 2 quotes
    expect(jsonValueUtf8Size("\n")).toBe(4); // "\n" escaped as \\n
    expect(jsonValueUtf8Size({ "😀": "é" })).toBe(2 + 6 + 1 + 4); // {"😀":"é"}
    expect(jsonValueUtf8Size([1, "é", true, null])).toBe(
      18, // [1,"é",true,null] = 2 brackets + 1+4+4+4 values + 3 commas
    );
  });

  it("rejects values that are not valid JSON", () => {
    expect(() => jsonValueUtf8Size(undefined)).toThrow(
      ExecutionStateValidationError,
    );
    expect(() => jsonValueUtf8Size(10n)).toThrow(ExecutionStateValidationError);
    expect(() => jsonValueUtf8Size(() => 1)).toThrow(
      ExecutionStateValidationError,
    );
    expect(() => jsonValueUtf8Size(NaN)).toThrow(ExecutionStateValidationError);
    expect(() => jsonValueUtf8Size(Infinity)).toThrow(
      ExecutionStateValidationError,
    );
  });

  it("handles adversarial nesting depth without a call-stack overflow", () => {
    let deep: unknown = "leaf";
    for (let i = 0; i < 40_000; i++) deep = [deep];
    const size = jsonValueUtf8Size(deep);
    expect(size).toBe(80_006); // 40000 × 2 bytes of brackets + "leaf" quoted
    // Well beyond any size cap, so it would be rejected by the patch bounds —
    // but the walker itself must never throw a RangeError.
  });

  it("detects cycles hidden inside arrays", () => {
    const outer: unknown[] = [];
    const inner: Record<string, unknown> = {};
    inner.self = inner;
    outer.push(inner);
    expect(() => jsonValueUtf8Size(outer)).toThrow(
      ExecutionStateValidationError,
    );
  });
});

describe("applyStatePatch", () => {
  it("sets, replaces, and deletes top-level keys", () => {
    expect(applyStatePatch({}, { set: { a: 1 }, delete: [] })).toEqual({
      state: { a: 1 },
      changed: true,
    });
    expect(applyStatePatch({ a: 1 }, { set: { a: 2 }, delete: [] })).toEqual({
      state: { a: 2 },
      changed: true,
    });
    expect(applyStatePatch({ a: 1 }, { set: {}, delete: ["a"] })).toEqual({
      state: {},
      changed: true,
    });
  });

  it("combines set/delete with order-independent results", () => {
    const state = { a: 1, b: 2, c: 3 };
    const patch = { set: { a: 10, d: 4 }, delete: ["c"] };
    const result = applyStatePatch(state, patch);
    expect(result).toEqual({ state: { a: 10, b: 2, d: 4 }, changed: true });
    // Reversing the set insertion order yields the identical state.
    const reversed = applyStatePatch(state, {
      set: { d: 4, a: 10 },
      delete: ["c"],
    });
    expect(canonicalJson(reversed.state)).toBe(canonicalJson(result.state));
  });

  it("treats empty, same-value, and absent-key patches as no-ops", () => {
    const state = { a: 1, b: { nested: [1, 2] } };
    expect(applyStatePatch(state, { set: {}, delete: [] })).toEqual({
      state,
      changed: false,
    });
    expect(applyStatePatch(state, { set: { a: 1 }, delete: [] }).changed).toBe(
      false,
    );
    expect(
      applyStatePatch(state, { set: {}, delete: ["missing"] }).changed,
    ).toBe(false);
    // A same-value nested structure is also a no-op.
    expect(
      applyStatePatch(state, { set: { b: { nested: [1, 2] } }, delete: [] })
        .changed,
    ).toBe(false);
  });

  it("replaces nested values wholesale instead of merging", () => {
    const state = { profile: { name: "a", tags: ["x"] } };
    expect(
      applyStatePatch(state, { set: { profile: { name: "b" } }, delete: [] }),
    ).toEqual({ state: { profile: { name: "b" } }, changed: true });
  });

  it("never mutates caller-owned objects (deep-frozen inputs)", () => {
    const deepFreeze = (value: unknown): void => {
      if (
        value !== null &&
        typeof value === "object" &&
        !Object.isFrozen(value)
      ) {
        Object.freeze(value);
        for (const key of Object.keys(value as Record<string, unknown>)) {
          deepFreeze((value as Record<string, unknown>)[key]);
        }
      }
    };
    const state = { keep: { deep: [1, 2] }, drop: 1 };
    const patchValue = { replaced: [3, 4] };
    deepFreeze(state);
    deepFreeze(patchValue);
    const result = applyStatePatch(state, {
      set: { keep: patchValue },
      delete: ["drop"],
    });
    expect(result.state).toEqual({ keep: { replaced: [3, 4] } });
    expect(Object.isFrozen(state)).toBe(true);
    expect(Object.isFrozen(patchValue)).toBe(true);
    expect(state).toEqual({ keep: { deep: [1, 2] }, drop: 1 });
  });

  it("emits deterministic sorted-key output regardless of insertion order", () => {
    const first = applyStatePatch(
      { z: 0 },
      { set: { z: 1, a: 2, m: 3 }, delete: [] },
    );
    const second = applyStatePatch(
      { z: 0 },
      { set: { m: 3, z: 1, a: 2 }, delete: [] },
    );
    expect(Object.keys(first.state)).toEqual(["a", "m", "z"]);
    expect(canonicalJson(first.state)).toBe(canonicalJson(second.state));
  });

  it("handles a 128-key state and stays independent of the service bounds", () => {
    const many = Object.fromEntries(
      Array.from({ length: EXECUTION_STATE_BOUNDS.maxStateKeys }, (_, i) => [
        `k${i}`,
        i,
      ]),
    );
    const result = applyStatePatch({}, { set: many, delete: [] });
    expect(Object.keys(result.state)).toHaveLength(
      EXECUTION_STATE_BOUNDS.maxStateKeys,
    );
  });
});
