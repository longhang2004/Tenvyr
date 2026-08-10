import { ConditionEvaluatorService } from "./condition-evaluator.service";
import { PipelineValidationService } from "./pipeline-validation.service";

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
});
