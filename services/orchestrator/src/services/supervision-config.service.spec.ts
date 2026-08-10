import { SupervisionConfigService } from "./supervision-config.service";

describe("SupervisionConfigService", () => {
  it("defaults to no expectations (Milestone-0 compatible)", () => {
    const service = new SupervisionConfigService({} as NodeJS.ProcessEnv);
    expect(service.forAgent("any-agent")).toEqual({
      expected: false,
      startupGraceMs: 30_000,
      staleAfterMs: 30_000,
    });
    expect(service.expectedAgents()).toEqual({});
  });

  it("parses a valid per-agent configuration", () => {
    const service = new SupervisionConfigService({
      ORCHESTRATOR_SUPERVISION_CONFIG: JSON.stringify({
        "code-reviewer": {
          heartbeat: { expected: true, startupGraceMs: 5000, staleAfterMs: 7000 },
        },
      }),
    } as NodeJS.ProcessEnv);
    expect(service.forAgent("code-reviewer")).toEqual({
      expected: true,
      startupGraceMs: 5000,
      staleAfterMs: 7000,
    });
    expect(service.forAgent("other")).toEqual(
      expect.objectContaining({ expected: false }),
    );
    expect(service.expectedAgents()).toEqual({
      "code-reviewer": expect.objectContaining({ expected: true }),
    });
  });

  it("rejects invalid JSON", () => {
    expect(
      () =>
        new SupervisionConfigService({
          ORCHESTRATOR_SUPERVISION_CONFIG: "not json",
        } as NodeJS.ProcessEnv),
    ).toThrow(/must be valid JSON/);
  });

  it("rejects non-boolean expected", () => {
    expect(
      () =>
        new SupervisionConfigService({
          ORCHESTRATOR_SUPERVISION_CONFIG: JSON.stringify({
            a: { heartbeat: { expected: "yes" } },
          }),
        } as NodeJS.ProcessEnv),
    ).toThrow(/heartbeat\.expected must be a boolean/);
  });

  it("rejects non-integer or unbounded durations", () => {
    for (const value of [1.5, -1, 0, 87_000_000]) {
      expect(
        () =>
          new SupervisionConfigService({
            ORCHESTRATOR_SUPERVISION_CONFIG: JSON.stringify({
              a: { heartbeat: { expected: true, startupGraceMs: value, staleAfterMs: 1000 } },
            }),
          } as NodeJS.ProcessEnv),
      ).toThrow(/startupGraceMs/);
    }
  });
});
