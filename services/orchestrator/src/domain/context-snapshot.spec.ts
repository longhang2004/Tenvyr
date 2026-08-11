import {
  CONTEXT_SNAPSHOT_BOUNDS,
  ContextProjectionError,
  materializeContextSnapshot,
  validateArtifactSelectors,
  validateContextProjection,
  type TenvyrContextEnvelope,
} from "./context-snapshot";
import type { JsonValue } from "@tenvyr/contracts";
import { jsonValueUtf8Size } from "./execution-state";

describe("validateContextProjection", () => {
  it.each([
    ["not an object", 42],
    ["null", null],
    ["array", []],
    ["unknown field", { stateKeys: ["a"], artifacts: [] }],
    ["missing stateKeys", {}],
    ["non-array stateKeys", { stateKeys: "a" }],
    ["empty stateKeys", { stateKeys: [] }],
    ["non-string entry", { stateKeys: ["a", 1] }],
    ["duplicate keys", { stateKeys: ["a", "a"] }],
    ["unsafe key", { stateKeys: ["__proto__"] }],
    ["constructor key", { stateKeys: ["constructor"] }],
    ["prototype key", { stateKeys: ["prototype"] }],
    [
      "too many keys",
      { stateKeys: Array.from({ length: 129 }, (_, i) => `k${i}`) },
    ],
  ])("rejects %s", (_name, input) => {
    expect(() => validateContextProjection(input)).toThrow();
  });

  it("rejects a key longer than 128 Unicode code points", () => {
    expect(() =>
      validateContextProjection({ stateKeys: ["x".repeat(129)] }),
    ).toThrow(/code points/);
  });

  it("accepts a key of exactly 128 code points and 128 keys", () => {
    const projection = validateContextProjection({
      stateKeys: Array.from({ length: 128 }, (_, i) => `k${i}`),
    });
    expect(projection.stateKeys).toHaveLength(128);
  });

  it("accepts astral-plane key characters measured in code points", () => {
    const key = "😀".repeat(128);
    const projection = validateContextProjection({ stateKeys: [key] });
    expect(projection.stateKeys).toEqual([key]);
  });

  it("returns a defensive copy", () => {
    const input = { stateKeys: ["a"] };
    const projection = validateContextProjection(input);
    projection.stateKeys.push("b");
    expect(input.stateKeys).toEqual(["a"]);
  });
});

describe("validateArtifactSelectors (M2D)", () => {
  it("accepts valid selectors with all optional combinations", () => {
    const selectors = validateArtifactSelectors([
      { fromStep: "research" },
      { fromStep: "sources", name: "a.json", includeMetadata: true },
      { fromStep: "sources", ordinal: 0 },
    ]);
    expect(selectors).toHaveLength(3);
    expect(selectors[0].includeMetadata).toBeUndefined();
  });

  it.each([
    ["not an array", "x"],
    ["empty array", []],
    ["entry not an object", [{ fromStep: "research" }, 7]],
    ["unknown field", [{ fromStep: "research", glob: "*" }]],
    ["missing fromStep", [{ name: "x" }]],
    ["empty fromStep", [{ fromStep: "" }]],
    ["non-string name", [{ fromStep: "research", name: 3 }]],
    ["non-integer ordinal", [{ fromStep: "research", ordinal: 1.5 }]],
    ["negative ordinal", [{ fromStep: "research", ordinal: -1 }]],
    [
      "non-boolean includeMetadata",
      [{ fromStep: "research", includeMetadata: 1 }],
    ],
    [
      "name and ordinal together",
      [{ fromStep: "research", name: "x", ordinal: 0 }],
    ],
  ])("rejects %s", (_name, input) => {
    expect(() => validateArtifactSelectors(input as never)).toThrow();
  });

  it("rejects more than 128 selectors", () => {
    expect(() =>
      validateArtifactSelectors(
        Array.from({ length: 129 }, (_, i) => ({ fromStep: `s${i}` })),
      ),
    ).toThrow(/exceeds/);
  });

  it("rejects duplicate selectors deterministically", () => {
    expect(() =>
      validateArtifactSelectors([
        { fromStep: "research", name: "a.json", includeMetadata: true },
        { fromStep: "research", includeMetadata: true, name: "a.json" },
      ]),
    ).toThrow(/duplicate/);
  });
});

describe("validateContextProjection with artifacts (M2D)", () => {
  it("accepts empty stateKeys when artifact selectors give meaning", () => {
    const projection = validateContextProjection({
      stateKeys: [],
      artifacts: [{ fromStep: "research" }],
    });
    expect(projection).toEqual({
      stateKeys: [],
      artifacts: [{ fromStep: "research" }],
    });
  });

  it("rejects an explicit empty artifacts array", () => {
    expect(() =>
      validateContextProjection({ stateKeys: [], artifacts: [] }),
    ).toThrow(/must not be empty/);
  });

  it("rejects a projection with neither state keys nor artifacts", () => {
    expect(() => validateContextProjection({ stateKeys: [] })).toThrow(
      /state keys or artifact references/,
    );
  });

  it("keeps the M2C canonical form when artifacts are absent", () => {
    const projection = validateContextProjection({ stateKeys: ["a"] });
    expect(projection).toEqual({ stateKeys: ["a"] });
    expect(projection).not.toHaveProperty("artifacts");
  });
});

describe("materializeContextSnapshot", () => {
  const state = {
    approvedBrief: { artifactId: "abc" },
    review: { status: "ok" },
    "dotted.key": 1,
    nil: null,
    nested: { deep: ["x", { y: 2 }] },
  };

  it("selects exact top-level keys with canonical ordering", () => {
    const envelope = materializeContextSnapshot(
      { stateKeys: ["review", "approvedBrief", "dotted.key", "nil"] },
      state,
      7,
    );
    expect(envelope.tenvyr.schemaVersion).toBe(1);
    expect(envelope.tenvyr.executionState.version).toBe(7);
    expect(Object.keys(envelope.tenvyr.executionState.values)).toEqual([
      "approvedBrief",
      "dotted.key",
      "nil",
      "review",
    ]);
    expect(envelope.tenvyr.executionState.values.nil).toBeNull();
    expect(envelope.tenvyr.artifacts).toEqual([]);
  });

  it("is deterministic regardless of selector input order", () => {
    const first = materializeContextSnapshot(
      { stateKeys: ["b", "a"] },
      { a: 1, b: 2 },
      1,
    );
    const second = materializeContextSnapshot(
      { stateKeys: ["a", "b"] },
      { a: 1, b: 2 },
      1,
    );
    expect(first).toEqual(second);
  });

  it("fails deterministically with a stable code for a missing key", () => {
    expect.assertions(2);
    try {
      materializeContextSnapshot({ stateKeys: ["absent"] }, state, 1);
    } catch (error) {
      expect(error).toBeInstanceOf(ContextProjectionError);
      expect((error as ContextProjectionError).code).toBe(
        "TENVYR_CTX_MISSING_STATE_KEY",
      );
    }
  });

  it("fails with TENVYR_CTX_INVALID_PROJECTION for malformed projection", () => {
    expect.assertions(2);
    try {
      materializeContextSnapshot({ stateKeys: "not-an-array" }, state, 1);
    } catch (error) {
      expect(error).toBeInstanceOf(ContextProjectionError);
      expect((error as ContextProjectionError).code).toBe(
        "TENVYR_CTX_INVALID_PROJECTION",
      );
    }
  });

  it("isolates output from later mutation of the input objects", () => {
    const mutable = { list: [1, 2], nested: { a: 1 } };
    const envelope = materializeContextSnapshot(
      { stateKeys: ["mutable"] },
      { mutable },
      1,
    );
    (mutable.list as number[]).push(3);
    (mutable.nested as Record<string, number>).a = 99;
    expect(envelope.tenvyr.executionState.values.mutable).toEqual({
      list: [1, 2],
      nested: { a: 1 },
    });
  });

  it("accepts an envelope at exactly the 65,536-byte boundary", () => {
    // Each ASCII byte adds exactly one canonical UTF-8 byte, so the pad
    // length is computable in O(1) from the empty-pad envelope size.
    const target = CONTEXT_SNAPSHOT_BOUNDS.maxEnvelopeBytes;
    const empty: TenvyrContextEnvelope = {
      tenvyr: {
        schemaVersion: 1,
        executionState: { version: 1, values: { pad: "" } },
        artifacts: [],
      },
    };
    const padding = target - jsonValueUtf8Size(empty);
    const state = { pad: "a".repeat(padding) };
    const envelope = materializeContextSnapshot(
      { stateKeys: ["pad"] },
      state,
      1,
    );
    expect(jsonValueUtf8Size(envelope)).toBe(target);
  });

  it("rejects an envelope one UTF-8 byte over the bound", () => {
    expect.assertions(2);
    const target = CONTEXT_SNAPSHOT_BOUNDS.maxEnvelopeBytes;
    const empty: TenvyrContextEnvelope = {
      tenvyr: {
        schemaVersion: 1,
        executionState: { version: 1, values: { pad: "" } },
        artifacts: [],
      },
    };
    const pad = "a".repeat(target - jsonValueUtf8Size(empty) + 1);
    try {
      materializeContextSnapshot({ stateKeys: ["pad"] }, { pad }, 1);
    } catch (error) {
      expect(error).toBeInstanceOf(ContextProjectionError);
      expect((error as ContextProjectionError).code).toBe(
        "TENVYR_CTX_ENVELOPE_TOO_LARGE",
      );
    }
  });

  it("rejects nested non-JSON values before returning an envelope", () => {
    const bad = { nested: { v: NaN } } as unknown as Record<string, unknown>;
    expect.assertions(2);
    try {
      materializeContextSnapshot({ stateKeys: ["nested"] }, bad as never, 1);
    } catch (error) {
      expect(error).toBeInstanceOf(ContextProjectionError);
      expect((error as ContextProjectionError).code).toBe(
        "TENVYR_CTX_UNSAFE_VALUE",
      );
    }
  });

  it("never includes unselected state", () => {
    const envelope = materializeContextSnapshot(
      { stateKeys: ["approvedBrief"] },
      state,
      1,
    );
    expect(Object.keys(envelope.tenvyr.executionState.values)).toEqual([
      "approvedBrief",
    ]);
  });

  it("exposes only a bounded envelope: 128 selected keys each 128 code points", () => {
    const keys = Array.from({ length: 128 }, (_, i) => `key${i}`);
    const bigState: Record<string, JsonValue> = {};
    for (const key of keys) bigState[key] = "v";
    const envelope = materializeContextSnapshot(
      { stateKeys: keys },
      bigState,
      1,
    );
    expect(Object.keys(envelope.tenvyr.executionState.values)).toHaveLength(
      128,
    );
  });

  it("includes resolved artifact references and isolates them from caller mutation (M2D)", () => {
    const references = [
      {
        artifactId: "art-1",
        producerStepId: "research",
        producerAttemptId: "attempt-1",
        descriptorOrdinal: 0,
        name: "report.json",
        uri: "s3://opaque/producer-uri",
      },
    ];
    const envelope = materializeContextSnapshot(
      { stateKeys: [], artifacts: [{ fromStep: "research" }] },
      {},
      1,
      references as never,
    );
    expect(envelope.tenvyr.artifacts).toEqual(references);
    (references[0] as { name?: string }).name = "mutated";
    expect(envelope.tenvyr.artifacts[0].name).toBe("report.json");
    // Without references the list stays empty (M2C behavior).
    const plain = materializeContextSnapshot({ stateKeys: ["k"] }, { k: 1 }, 1);
    expect(plain.tenvyr.artifacts).toEqual([]);
  });

  it("counts artifact references toward the complete envelope bound (M2D)", () => {
    expect.assertions(2);
    const reference = {
      artifactId: "art-1",
      producerStepId: "producer",
      producerAttemptId: "attempt-1",
      descriptorOrdinal: 0,
      uri: "x",
    };
    const many = Array.from({ length: 2000 }, () => ({ ...reference }));
    try {
      materializeContextSnapshot(
        { stateKeys: [], artifacts: [{ fromStep: "producer" }] },
        {},
        1,
        many as never,
      );
    } catch (error) {
      expect(error).toBeInstanceOf(ContextProjectionError);
      expect((error as ContextProjectionError).code).toBe(
        "TENVYR_CTX_ENVELOPE_TOO_LARGE",
      );
    }
  });
});
