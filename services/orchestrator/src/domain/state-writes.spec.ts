import {
  buildStateWritesPatch,
  parseJsonPointer,
  resolveJsonPointer,
  StateWriteResolutionError,
  validateStateWrites,
} from "./state-writes";

describe("parseJsonPointer", () => {
  it.each([
    ["/a/b/c", ["a", "b", "c"]],
    ["/", [""]],
    ["/a~1b", ["a/b"]],
    ["/m~0n", ["m~n"]],
    ["/a~01b", ["a~1b"]],
    ["/0", ["0"]],
    ["/10", ["10"]],
  ])("parses %s", (pointer, tokens) => {
    expect(parseJsonPointer(pointer)).toEqual(tokens);
  });

  it.each([
    ["empty pointer", ""],
    ["URI fragment", "#/a"],
    ["no leading slash", "a/b"],
    ["invalid escape", "/a~2b"],
    ["trailing tilde", "/a~"],
    ["array append token", "/items/-"],
  ])("rejects %s", (_name, pointer) => {
    expect(() => parseJsonPointer(pointer)).toThrow();
  });
});

describe("resolveJsonPointer", () => {
  const output = {
    brief: { title: "hello" },
    list: ["zero", "one", { nested: true }],
    "dotted.key": 1,
    nil: null,
  };

  it("resolves object keys, dotted literal keys, arrays, and null", () => {
    expect(resolveJsonPointer(output, ["brief", "title"])).toEqual({
      found: true,
      value: "hello",
    });
    expect(resolveJsonPointer(output, ["dotted.key"])).toEqual({
      found: true,
      value: 1,
    });
    expect(resolveJsonPointer(output, ["list", "0"])).toEqual({
      found: true,
      value: "zero",
    });
    expect(resolveJsonPointer(output, ["nil"])).toEqual({
      found: true,
      value: null,
    });
  });

  it("returns not found for missing keys, indices, and primitives", () => {
    expect(resolveJsonPointer(output, ["absent"])).toEqual({ found: false });
    expect(resolveJsonPointer(output, ["list", "9"])).toEqual({
      found: false,
    });
    expect(resolveJsonPointer(output, ["brief", "title", "deep"])).toEqual({
      found: false,
    });
  });

  it("rejects non-canonical array index tokens", () => {
    expect(resolveJsonPointer(output, ["list", "01"])).toEqual({
      found: false,
    });
    expect(resolveJsonPointer(output, ["list", "1.0"])).toEqual({
      found: false,
    });
    expect(resolveJsonPointer(output, ["list", "-"])).toEqual({
      found: false,
    });
  });

  it("treats leading-zero tokens as ordinary object keys", () => {
    expect(resolveJsonPointer({ "01": "key" }, ["01"])).toEqual({
      found: true,
      value: "key",
    });
  });

  it("escaped tokens resolve after decoding", () => {
    expect(resolveJsonPointer({ "a/b": 1 }, ["a/b"])).toEqual({
      found: true,
      value: 1,
    });
    expect(parseJsonPointer("/a~1b")).toEqual(["a/b"]);
  });
});

describe("validateStateWrites", () => {
  const valid = [{ key: "brief", fromOutput: "/brief" }];

  it("accepts valid mappings and returns a defensive copy", () => {
    const mappings = validateStateWrites(valid);
    expect(mappings).toEqual(valid);
    mappings[0].key = "mutated";
    expect(valid[0].key).toBe("brief");
  });

  it.each([
    ["not an array", "x"],
    ["empty array", []],
    ["entry not an object", [{ key: "a", fromOutput: "/a" }, 5]],
    ["unknown field", [{ key: "a", fromOutput: "/a", transform: "x" }]],
    ["missing key", [{ fromOutput: "/a" }]],
    ["empty key", [{ key: "", fromOutput: "/a" }]],
    ["unsafe key", [{ key: "__proto__", fromOutput: "/a" }]],
    [
      "duplicate target key",
      [
        { key: "a", fromOutput: "/a" },
        { key: "a", fromOutput: "/b" },
      ],
    ],
    ["missing fromOutput", [{ key: "a" }]],
    ["malformed pointer", [{ key: "a", fromOutput: "a/b" }]],
    [
      "duplicate mapping",
      [
        { key: "a", fromOutput: "/a" },
        { key: "b", fromOutput: "/a" },
        { key: "a", fromOutput: "/a" },
      ],
    ],
  ])("rejects %s", (_name, input) => {
    expect(() => validateStateWrites(input as never)).toThrow();
  });

  it("rejects more than 128 mappings", () => {
    expect(() =>
      validateStateWrites(
        Array.from({ length: 129 }, (_, i) => ({
          key: `k${i}`,
          fromOutput: `/v${i}`,
        })),
      ),
    ).toThrow(/exceeds/);
  });
});

describe("buildStateWritesPatch", () => {
  it("builds a bounded set patch from resolved pointers with isolation", () => {
    const output = { brief: { title: "x" }, list: ["a", "b"] };
    const patch = buildStateWritesPatch(output, [
      { key: "approvedBrief", fromOutput: "/brief" },
      { key: "second", fromOutput: "/list/1" },
    ]);
    expect(patch.set).toEqual({
      approvedBrief: { title: "x" },
      second: "b",
    });
    (output.list as string[]).push("c");
    expect(patch.set.second as string[]).toBe("b");
  });

  it("fails deterministically on the first missing pointer, applying no keys", () => {
    expect.assertions(2);
    try {
      buildStateWritesPatch({ present: 1 }, [
        { key: "a", fromOutput: "/present" },
        { key: "b", fromOutput: "/missing" },
      ]);
    } catch (error) {
      expect(error).toBeInstanceOf(StateWriteResolutionError);
      expect((error as StateWriteResolutionError).code).toBe(
        "TENVYR_STATE_WRITE_POINTER_MISSING",
      );
    }
  });

  it("selects an explicit JSON null value", () => {
    const patch = buildStateWritesPatch({ nil: null }, [
      { key: "nil", fromOutput: "/nil" },
    ]);
    expect(patch.set).toEqual({ nil: null });
  });
});
