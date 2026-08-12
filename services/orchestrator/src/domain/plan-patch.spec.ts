import {
  PLAN_PATCH_BOUNDS,
  PlanPatchError,
  applyPlanPatch,
  parsePlanPatch,
} from "./plan-patch";
import { PipelineValidationService } from "../services/pipeline-validation.service";
import { ConditionEvaluatorService } from "../services/condition-evaluator.service";
import { sha256Json } from "./canonical-json";

describe("plan-patch (M5-S1)", () => {
  const baseSteps = [
    { id: "extract", agent: "reader", timeout: "5s" },
    {
      id: "review",
      agent: "reviewer",
      dependsOn: ["extract"],
      timeout: "5s",
    },
  ];

  const patch = (operations: unknown[], baseRevision = 1) => ({
    schemaVersion: 1,
    baseRevision,
    operations,
  });

  describe("parsePlanPatch bounds", () => {
    it("parses a valid addStep/replaceUnfrozenStep patch", () => {
      const parsed = parsePlanPatch(
        patch([
          { op: "addStep", step: { id: "load", agent: "writer" } },
          {
            op: "replaceUnfrozenStep",
            stepId: "review",
            step: { id: "review", agent: "reviewer", timeout: "10s" },
          },
        ]),
      );
      expect(parsed.baseRevision).toBe(1);
      expect(parsed.operations).toHaveLength(2);
    });

    it("rejects non-object, wrong schemaVersion, and missing baseRevision", () => {
      expect(() => parsePlanPatch(null)).toThrow(PlanPatchError);
      expect(() => parsePlanPatch({ schemaVersion: 2 })).toThrow(/schemaVersion/);
      expect(() => parsePlanPatch({ schemaVersion: 1 })).toThrow(
        /baseRevision/,
      );
    });

    it("rejects empty and oversized operation lists", () => {
      expect(() => parsePlanPatch(patch([]))).toThrow(/at least one operation/);
      const exactlyMax = patch(
        Array.from({ length: PLAN_PATCH_BOUNDS.maxOperations }, () => ({
          op: "addStep",
          step: { id: "x", agent: "a" },
        })),
      );
      expect(() => parsePlanPatch(exactlyMax)).not.toThrow();
      const tooMany = patch(
        Array.from({ length: PLAN_PATCH_BOUNDS.maxOperations + 1 }, () => ({
          op: "addStep",
          step: { id: "x", agent: "a" },
        })),
      );
      expect(() => parsePlanPatch(tooMany)).toThrow(/exceeds .* operations/);
    });

    it("rejects serialized payloads above the bound", () => {
      const huge = patch([
        {
          op: "addStep",
          step: { id: "big", agent: "a", input: { blob: "x".repeat(PLAN_PATCH_BOUNDS.maxSerializedBytes) } },
        },
      ]);
      expect(() => parsePlanPatch(huge)).toThrow(/serialized bytes/);
    });

    it("rejects unknown operations and malformed replace targets", () => {
      expect(() =>
        parsePlanPatch(patch([{ op: "removeStep", stepId: "extract" }])),
      ).toThrow(/must be addStep or replaceUnfrozenStep/);
      expect(() =>
        parsePlanPatch(
          patch([
            {
              op: "replaceUnfrozenStep",
              stepId: "review",
              step: { id: "renamed", agent: "reviewer" },
            },
          ]),
        ),
      ).toThrow(/step.id must equal stepId/);
      expect(() =>
        parsePlanPatch(patch([{ op: "replaceUnfrozenStep", step: {} }])),
      ).toThrow(/stepId/);
      expect(() =>
        parsePlanPatch(
          patch([{ op: "replaceUnfrozenStep", stepId: "e", step: "nope" }]),
        ),
      ).toThrow(/step must be an object/);
      expect(() =>
        parsePlanPatch(patch([{ op: "addStep", step: "nope" }])),
      ).toThrow(/step must be an object/);
    });
  });

  describe("applyPlanPatch", () => {
    it("appends addStep operations in order and swaps replacements in place", () => {
      const candidate = applyPlanPatch(
        baseSteps,
        new Set(),
        parsePlanPatch(
          patch([
            { op: "addStep", step: { id: "load", agent: "writer" } },
            {
              op: "replaceUnfrozenStep",
              stepId: "review",
              step: { id: "review", agent: "reviewer", timeout: "10s" },
            },
            { op: "addStep", step: { id: "publish", agent: "writer" } },
          ]),
        ),
      );
      expect(candidate.map((s) => (s as { id: string }).id)).toEqual([
        "extract",
        "review",
        "load",
        "publish",
      ]);
      expect((candidate[1] as { timeout?: string }).timeout).toBe("10s");
    });

    it("rejects replacement of a frozen step", () => {
      expect(() =>
        applyPlanPatch(
          baseSteps,
          new Set(["review"]),
          parsePlanPatch(
            patch([
              {
                op: "replaceUnfrozenStep",
                stepId: "review",
                step: { id: "review", agent: "other" },
              },
            ]),
          ),
        ),
      ).toThrow(expect.objectContaining({ code: "TARGET_FROZEN" }));
    });

    it("rejects replacement of a missing target", () => {
      expect(() =>
        applyPlanPatch(
          baseSteps,
          new Set(),
          parsePlanPatch(
            patch([
              {
                op: "replaceUnfrozenStep",
                stepId: "ghost",
                step: { id: "ghost", agent: "x" },
              },
            ]),
          ),
        ),
      ).toThrow(expect.objectContaining({ code: "TARGET_NOT_FOUND" }));
    });

    it("applies sequentially: a later op may target a step added earlier", () => {
      const candidate = applyPlanPatch(
        baseSteps,
        new Set(),
        parsePlanPatch(
          patch([
            { op: "addStep", step: { id: "load", agent: "writer" } },
            {
              op: "replaceUnfrozenStep",
              stepId: "load",
              step: { id: "load", agent: "writer", timeout: "30s" },
            },
          ]),
        ),
      );
      expect((candidate[2] as { timeout?: string }).timeout).toBe("30s");
    });

    it("is deterministic: identical inputs produce identical candidates and hashes", () => {
      const p = parsePlanPatch(
        patch([{ op: "addStep", step: { id: "load", agent: "writer" } }]),
      );
      const a = sha256Json(applyPlanPatch(baseSteps, new Set(), p));
      const b = sha256Json(applyPlanPatch(baseSteps, new Set(), p));
      expect(a).toBe(b);
    });
  });

  describe("candidate validation through the real safe validation", () => {
    const validation = new PipelineValidationService(
      new ConditionEvaluatorService(),
    );

    it("accepts a valid candidate and returns the validated steps", () => {
      const candidate = applyPlanPatch(
        baseSteps,
        new Set(),
        parsePlanPatch(
          patch([
            { op: "addStep", step: { id: "load", agent: "writer", budget: { tokens: 5 } } },
          ]),
        ),
      );
      const validated = validation.validateSteps(candidate);
      expect(validated.map((s) => s.id)).toEqual([
        "extract",
        "review",
        "load",
      ]);
      expect(validated[2].budget).toEqual({ tokens: 5 });
    });

    it("rejects duplicate ids created by add operations", () => {
      const candidate = applyPlanPatch(
        baseSteps,
        new Set(),
        parsePlanPatch(
          patch([{ op: "addStep", step: { id: "extract", agent: "other" } }]),
        ),
      );
      expect(() => validation.validateSteps(candidate)).toThrow(/Duplicate/);
    });

    it("rejects cycles introduced by added steps", () => {
      const candidate = applyPlanPatch(
        baseSteps,
        new Set(),
        parsePlanPatch(
          patch([
            {
              op: "addStep",
              step: { id: "loop", agent: "writer", dependsOn: ["extract"] },
            },
            {
              op: "replaceUnfrozenStep",
              stepId: "extract",
              step: {
                id: "extract",
                agent: "reader",
                dependsOn: ["loop"],
              },
            },
          ]),
        ),
      );
      expect(() => validation.validateSteps(candidate)).toThrow(/cycle|depend/i);
    });

    it("rejects fanout growth beyond the bound", () => {
      const wide = Array.from({ length: 20 }, (_, i) => ({
        id: `fan-${i + 1}`,
        agent: "writer",
        dependsOn: ["root"],
      }));
      const candidate = applyPlanPatch(
        [
          { id: "root", agent: "reader" },
          { id: "fan-0", agent: "writer", dependsOn: ["root"] },
        ],
        new Set(),
        parsePlanPatch(patch(wide.map((step) => ({ op: "addStep", step })))),
      );
      expect(() => validation.validateSteps(candidate)).toThrow(
        /exceeds fanout/,
      );
    });

    it("rejects step count growth beyond the bound", () => {
      const many = Array.from({ length: 100 }, (_, i) => ({
        id: `s-${i}`,
        agent: "writer",
      }));
      const candidate = applyPlanPatch(
        many,
        new Set(),
        parsePlanPatch(
          patch([{ op: "addStep", step: { id: "s-100", agent: "writer" } }]),
        ),
      );
      expect(() => validation.validateSteps(candidate)).toThrow(/exceeds 100/);
    });

    it("rejects an added step with an invalid step config (bad identifier)", () => {
      const candidate = applyPlanPatch(
        baseSteps,
        new Set(),
        parsePlanPatch(
          patch([
            { op: "addStep", step: { id: "not valid!", agent: "writer" } },
          ]),
        ),
      );
      expect(() => validation.validateSteps(candidate)).toThrow(/identifier/);
    });
  });
});
