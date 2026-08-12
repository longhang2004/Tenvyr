import {
  buildDispatchProposal,
  evaluateProposal,
  parsePolicySnapshot,
  PolicyError,
  proposalHash,
} from "./policy";

const expectCode = (fail: () => unknown, code: string): void => {
  try {
    fail();
    throw new Error("expected rejection");
  } catch (error) {
    expect(error).toMatchObject({ code });
  }
};

const snapshot = (overrides: Record<string, unknown> = {}) =>
  parsePolicySnapshot({
    version: 1,
    rules: [
      { id: "deny-banned", actionType: "dispatch", effect: "DENY", agents: ["banned-agent"] },
      { id: "approve-http", actionType: "dispatch", effect: "REQUIRE_APPROVAL", executors: ["http"] },
      { id: "allow-rest", actionType: "dispatch", effect: "ALLOW" },
    ],
    ...overrides,
  });

const proposal = (facts: Partial<{ agent: string; executor: string }> = {}) =>
  buildDispatchProposal("attempt-1", {
    executionId: "execution-1",
    logicalStepId: "step-1",
    attemptNumber: 1,
    agent: facts.agent ?? "reader",
    executor: facts.executor ?? "kafka",
  });

describe("policy snapshot parsing and hashing", () => {
  it("parses bounded rule data deterministically", () => {
    const first = snapshot();
    const second = snapshot();
    expect(first.hash).toBe(second.hash);
    expect(first.version).toBe(1);
    expect(first.rules).toHaveLength(3);
  });

  it("rejects invalid configuration (unknown effects, unknown action types, empty rules)", () => {
    expect(() =>
      parsePolicySnapshot({ version: 1, rules: [{ id: "x", actionType: "dispatch", effect: "maybe" }] }),
    ).toThrow(PolicyError);
    expect(() =>
      parsePolicySnapshot({ version: 1, rules: [{ id: "x", actionType: "run_shell", effect: "ALLOW" }] }),
    ).toThrow(/actionType/);
    expect(() => parsePolicySnapshot({ version: 1, rules: [] })).toThrow(
      /at least one rule/,
    );
    expect(() => parsePolicySnapshot({ version: 0, rules: [{ id: "x", actionType: "dispatch", effect: "ALLOW" }] })).toThrow(
      /positive integer/,
    );
    expect(() => parsePolicySnapshot("not-an-object")).toThrow(PolicyError);
  });

  it("bounds proposal fields and hashes canonically", () => {
    expectCode(
      () =>
        buildDispatchProposal("a".repeat(65), {
          executionId: "e",
          logicalStepId: "s",
          attemptNumber: 1,
          agent: "a",
          executor: "kafka",
        }),
      "PROPOSAL_INVALID",
    );
    expectCode(
      () =>
        buildDispatchProposal("p", {
          executionId: "e",
          logicalStepId: "s",
          attemptNumber: 1,
          agent: "a".repeat(256),
          executor: "kafka",
        }),
      "PROPOSAL_INVALID",
    );

    const first = proposal();
    const second = proposal();
    expect(first.hash).toBe(second.hash);
    expect(proposalHash(first)).toBe(first.hash);
    expect(proposal({ agent: "other" }).hash).not.toBe(first.hash);
  });
});

describe("deterministic evaluation", () => {
  it("first matching rule wins: agent constraint, executor constraint, default", () => {
    const frozen = snapshot();
    expect(evaluateProposal(proposal({ agent: "banned-agent" }), frozen).effect).toBe(
      "DENY",
    );
    expect(evaluateProposal(proposal({ executor: "http" }), frozen).effect).toBe(
      "REQUIRE_APPROVAL",
    );
    expect(evaluateProposal(proposal(), frozen).effect).toBe("ALLOW");
  });

  it("untrusted proposal facts can only match EXACT trusted constraints", () => {
    const frozen = snapshot();
    // A look-alike agent is NOT the banned one — no permissive downgrade.
    expect(evaluateProposal(proposal({ agent: "banned-agent.evil" }), frozen).effect).toBe(
      "ALLOW",
    );
    expect(evaluateProposal(proposal({ agent: "BANNED-AGENT" }), frozen).effect).toBe(
      "ALLOW",
    );
  });

  it("no matching rule defaults to ALLOW with an explicit reason", () => {
    const frozen = parsePolicySnapshot({
      version: 1,
      rules: [{ id: "only-delegate", actionType: "delegate", effect: "DENY" }],
    });
    const decision = evaluateProposal(proposal(), frozen);
    expect(decision.effect).toBe("ALLOW");
    expect(decision.reasons).toContain("no matching rule; default allow");
  });

  it("decisions carry the frozen snapshot identity and proposal hash", () => {
    const frozen = snapshot();
    const decision = evaluateProposal(proposal(), frozen);
    expect(decision).toMatchObject({
      proposalHash: proposal().hash,
      policyVersion: 1,
      policyHash: frozen.hash,
      effect: "ALLOW",
    });
    expect(decision.decisionId).toBe("attempt-1");
    expect(decision.reasons.length).toBeGreaterThan(0);
  });
});
