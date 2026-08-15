import {
  configFromTeamTemplate,
  TEAM_TEMPLATES,
} from "./team-templates";
import { parseAcceptanceEvidence } from "./workspace";

/**
 * Product Phase 1: bounded team templates + acceptance-evidence parsing.
 * Templates define roles/bounds/goal framing ONLY — the Planner still
 * proposes the actual TaskBatch and Tenvyr still authorizes it.
 */

describe("team templates", () => {
  it("offers exactly the two bounded templates", () => {
    expect(TEAM_TEMPLATES.map((t) => t.templateId).sort()).toEqual([
      "code-review",
      "software-engineering",
    ]);
    for (const template of TEAM_TEMPLATES) {
      expect(template.defaultBounds.maxIterations).toBeGreaterThan(0);
      expect(template.defaultBounds.maxIterations).toBeLessThanOrEqual(100);
      expect(template.defaultBounds.maxTotalWorkers).toBeLessThanOrEqual(1024);
      expect(template.roleSuggestions.planner.kind).toBe("connection");
      expect(template.roleSuggestions.verifier.kind).toBe("connection");
    }
  });

  it("builds a valid CoordinationConfigV1 skeleton with template defaults", () => {
    const config = configFromTeamTemplate("software-engineering");
    expect(config.schemaVersion).toBe(1);
    expect(config.maxIterations).toBe(3);
    expect(config.allowedExecutors).toEqual(["local-host"]);
    expect(config.allowedWorkers).toEqual([]);
    expect(() => configFromTeamTemplate("unknown" as never)).toThrow(/unknown/);
  });

  it("allows tightening bounds but never raises them beyond template defaults", () => {
    const config = configFromTeamTemplate("software-engineering", {
      maxIterations: 2,
      loopDeadlineMs: 60000,
    });
    expect(config.maxIterations).toBe(2);
    expect(config.loopDeadlineMs).toBe(60000);
  });
});

describe("acceptance evidence parsing", () => {
  it("parses a bounded acceptance-evidence block", () => {
    const parsed = parseAcceptanceEvidence({
      testCommand: "pnpm test",
      buildCommand: "pnpm build",
      requiredArtifacts: ["dist/index.js"],
    });
    expect(parsed).toEqual({
      testCommand: "pnpm test",
      buildCommand: "pnpm build",
      requiredArtifacts: ["dist/index.js"],
    });
  });

  it("returns null for absent/empty blocks", () => {
    expect(parseAcceptanceEvidence(undefined)).toBeNull();
    expect(parseAcceptanceEvidence(null)).toBeNull();
    expect(parseAcceptanceEvidence({})).toBeNull();
  });

  it("rejects non-objects, oversized commands, and oversized artifact lists", () => {
    expect(() => parseAcceptanceEvidence("nope")).toThrow(/must be an object/);
    expect(() =>
      parseAcceptanceEvidence({ testCommand: "x".repeat(5000) }),
    ).toThrow(/exceeds the bound/);
    expect(() =>
      parseAcceptanceEvidence({ requiredArtifacts: Array(50).fill("a") }),
    ).toThrow(/bounded string array/);
  });
});
