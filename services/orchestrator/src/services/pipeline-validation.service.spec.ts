import { ConditionEvaluatorService } from "./condition-evaluator.service";
import { PipelineValidationService } from "./pipeline-validation.service";
import { sha256Json } from "../domain/canonical-json";

describe("PipelineValidationService", () => {
  const conditions = new ConditionEvaluatorService();
  const service = new PipelineValidationService(conditions);

  it("normalizes the showcase legacy condition into a safe AST", () => {
    const definition = service.validate({
      name: "review",
      version: "1",
      steps: [
        { id: "review", agent: "reviewer" },
        {
          id: "observe",
          agent: "observer",
          dependsOn: ["review"],
          condition: "{{ steps.review.result.score < 90 }}",
        },
      ],
    });

    expect(definition.steps[1].condition).toEqual({
      op: "lt",
      left: { ref: "steps.review.result.score" },
      right: 90,
    });
    expect(
      conditions.evaluate(definition.steps[1].condition!, {
        pipeline: { input: {} },
        steps: { review: { result: { score: 80 } } },
      }),
    ).toBe(true);
  });

  it.each([
    [
      "duplicate ids",
      [
        { id: "a", agent: "x" },
        { id: "a", agent: "y" },
      ],
    ],
    ["missing dependency", [{ id: "a", agent: "x", dependsOn: ["missing"] }]],
    [
      "cycle",
      [
        { id: "a", agent: "x", dependsOn: ["b"] },
        { id: "b", agent: "x", dependsOn: ["a"] },
      ],
    ],
  ])("rejects %s", (_label, steps) => {
    expect(() =>
      service.validate({ name: "invalid", version: "1", steps }),
    ).toThrow();
  });

  it("rejects executable legacy conditions", () => {
    expect(() =>
      service.validate({
        name: "unsafe",
        version: "1",
        steps: [{ id: "a", agent: "x", condition: "global.process.exit()" }],
      }),
    ).toThrow(/comparison/);
  });

  it("rejects excessively nested declarative conditions", () => {
    let condition: any = { op: "eq", left: 1, right: 1 };
    for (let index = 0; index < 20; index += 1)
      condition = { op: "not", condition };
    expect(() =>
      service.validate({
        name: "nested",
        version: "1",
        steps: [{ id: "a", agent: "x", condition }],
      }),
    ).toThrow(/depth 20/);
  });

  it("rejects graphs deeper than the configured limit", () => {
    const steps = Array.from({ length: 21 }, (_, index) => ({
      id: `step-${index}`,
      agent: "x",
      ...(index === 0 ? {} : { dependsOn: [`step-${index - 1}`] }),
    }));
    expect(() =>
      service.validate({ name: "deep", version: "1", steps }),
    ).toThrow(/depth 20/);
  });

  describe("contextProjection (M2C)", () => {
    const pipelineWith = (contextProjection: unknown) => ({
      name: "ctx",
      version: "1",
      steps: [{ id: "a", agent: "x", contextProjection }],
    });

    it("retains a valid projection and a defensive copy", () => {
      const projection = { stateKeys: ["brief", "review.status"] };
      const definition = service.validate(pipelineWith(projection));
      expect(definition.steps[0].contextProjection).toEqual(projection);
      definition.steps[0].contextProjection!.stateKeys.push("smuggled");
      expect(projection.stateKeys).toEqual(["brief", "review.status"]);
    });

    it("preserves the legacy canonical form when the field is absent", () => {
      const definition = service.validate({
        name: "legacy",
        version: "1",
        steps: [{ id: "a", agent: "x" }],
      });
      expect(definition.steps[0]).toEqual({ id: "a", agent: "x" });
    });

    it.each([
      ["not an object", 42, /object/],
      ["null", null, /object/],
      ["unknown field", { stateKeys: ["a"], extra: 1 }, /unknown field/],
      ["missing stateKeys", {}, /stateKeys/],
      ["non-array", { stateKeys: "a" }, /array/],
      ["empty", { stateKeys: [] }, /state keys or artifact/],
      ["duplicate", { stateKeys: ["a", "a"] }, /duplicate/],
      ["unsafe key", { stateKeys: ["__proto__"] }, /not allowed/],
      ["non-string", { stateKeys: [1] }, /strings/],
      [
        "too many",
        { stateKeys: Array.from({ length: 129 }, (_, i) => `k${i}`) },
        /exceeds/,
      ],
      ["too long", { stateKeys: ["x".repeat(129)] }, /code points/],
    ])(
      "rejects %s at pipeline ingress",
      (_name, contextProjection, pattern) => {
        expect(() => service.validate(pipelineWith(contextProjection))).toThrow(
          pattern,
        );
      },
    );

    it("distinguishes selector changes in the frozen step specification hash", () => {
      const without = service.validate(pipelineWith(undefined)).steps[0];
      const one = service.validate(pipelineWith({ stateKeys: ["a"] })).steps[0];
      const two = service.validate(pipelineWith({ stateKeys: ["b"] })).steps[0];
      expect(sha256Json(one)).not.toBe(sha256Json(without));
      expect(sha256Json(one)).not.toBe(sha256Json(two));
    });
  });

  describe("artifact selectors (M2D)", () => {
    const pipeline = (
      consumer: Record<string, unknown>,
      others: Record<string, unknown>[] = [],
    ) => ({
      name: "artifacts",
      version: "1",
      steps: [...others, { id: "consumer", agent: "x", ...consumer }],
    });

    it("accepts a selector naming a direct dependency", () => {
      const definition = service.validate(
        pipeline(
          {
            dependsOn: ["research"],
            contextProjection: {
              stateKeys: [],
              artifacts: [{ fromStep: "research", name: "report.json" }],
            },
          },
          [{ id: "research", agent: "r" }],
        ),
      );
      expect(definition.steps[1].contextProjection?.artifacts).toEqual([
        { fromStep: "research", name: "report.json" },
      ]);
    });

    it("accepts a selector naming a transitive (grandparent) dependency", () => {
      const definition = service.validate(
        pipeline(
          {
            dependsOn: ["middle"],
            contextProjection: {
              stateKeys: [],
              artifacts: [{ fromStep: "root" }],
            },
          },
          [
            { id: "root", agent: "r" },
            { id: "middle", agent: "m", dependsOn: ["root"] },
          ],
        ),
      );
      expect(definition.steps[2].contextProjection?.artifacts).toBeDefined();
    });

    it.each([
      [
        "self",
        {
          contextProjection: {
            stateKeys: [],
            artifacts: [{ fromStep: "consumer" }],
          },
        },
        /itself/,
      ],
      [
        "unrelated step",
        {
          contextProjection: {
            stateKeys: [],
            artifacts: [{ fromStep: "unrelated" }],
          },
        },
        /not a transitive dependency/,
      ],
      [
        "future step",
        {
          dependsOn: ["research"],
          contextProjection: {
            stateKeys: [],
            artifacts: [{ fromStep: "later" }],
          },
        },
        /not a transitive dependency/,
      ],
      [
        "missing step",
        {
          contextProjection: {
            stateKeys: [],
            artifacts: [{ fromStep: "ghost" }],
          },
        },
        /not a transitive dependency/,
      ],
    ])(
      "rejects a %s producer at pipeline ingress",
      (_name, consumer, pattern) => {
        expect(() =>
          service.validate(
            pipeline(consumer, [{ id: "research", agent: "r" }]),
          ),
        ).toThrow(pattern);
      },
    );
  });

  describe("stateWrites (M2E)", () => {
    it("retains valid mappings and preserves the canonical form when absent", () => {
      const definition = service.validate({
        name: "writes",
        version: "1",
        steps: [
          {
            id: "a",
            agent: "x",
            stateWrites: [
              { key: "approvedBrief", fromOutput: "/brief" },
              { key: "review.status", fromOutput: "/decision/status" },
            ],
          },
        ],
      });
      expect(definition.steps[0].stateWrites).toEqual([
        { key: "approvedBrief", fromOutput: "/brief" },
        { key: "review.status", fromOutput: "/decision/status" },
      ]);
      const legacy = service.validate({
        name: "writes-legacy",
        version: "1",
        steps: [{ id: "a", agent: "x" }],
      });
      expect(legacy.steps[0]).toEqual({ id: "a", agent: "x" });
    });

    it("allows two ordered writers of the same key", () => {
      const definition = service.validate({
        name: "ordered-writers",
        version: "1",
        steps: [
          {
            id: "first",
            agent: "x",
            stateWrites: [{ key: "k", fromOutput: "/a" }],
          },
          {
            id: "second",
            agent: "x",
            dependsOn: ["first"],
            stateWrites: [{ key: "k", fromOutput: "/b" }],
          },
        ],
      });
      expect(definition.steps).toHaveLength(2);
    });

    it("allows disjoint parallel writers of different keys", () => {
      const definition = service.validate({
        name: "disjoint-writers",
        version: "1",
        steps: [
          {
            id: "a",
            agent: "x",
            stateWrites: [{ key: "ka", fromOutput: "/a" }],
          },
          {
            id: "b",
            agent: "x",
            stateWrites: [{ key: "kb", fromOutput: "/b" }],
          },
        ],
      });
      expect(definition.steps).toHaveLength(2);
    });

    it("rejects two unordered writers of the same key", () => {
      expect(() =>
        service.validate({
          name: "conflicting-writers",
          version: "1",
          steps: [
            {
              id: "a",
              agent: "x",
              stateWrites: [{ key: "k", fromOutput: "/a" }],
            },
            {
              id: "b",
              agent: "x",
              stateWrites: [{ key: "k", fromOutput: "/b" }],
            },
          ],
        }),
      ).toThrow(/both write state key "k" without proven ordering/);
    });

    it("rejects a chain of three unordered writers pairwise", () => {
      expect(() =>
        service.validate({
          name: "triple-conflict",
          version: "1",
          steps: [
            {
              id: "a",
              agent: "x",
              stateWrites: [{ key: "k", fromOutput: "/a" }],
            },
            {
              id: "b",
              agent: "x",
              stateWrites: [{ key: "k", fromOutput: "/b" }],
            },
            {
              id: "c",
              agent: "x",
              stateWrites: [{ key: "k", fromOutput: "/c" }],
            },
          ],
        }),
      ).toThrow(/without proven ordering/);
    });
  });
});
