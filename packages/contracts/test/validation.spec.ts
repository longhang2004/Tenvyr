import {
  ContractValidationError,
  parseAgentEvent,
  parseAgentInvocation,
  parseAgentResult,
} from "../src";

const invocation = {
  schemaVersion: "1",
  invocationId: "step-execution-1:1",
  executionId: "execution-1",
  stepExecutionId: "step-execution-1",
  stepId: "review",
  target: { agent: "code-reviewer" },
  input: { code: "const safe = true;" },
  attempt: 1,
  createdAt: "2026-07-26T00:00:00.000Z",
  trace: {
    traceId: "execution-1",
    correlationId: "step-execution-1:1",
  },
};

const succeededResult = {
  schemaVersion: "1",
  invocationId: "step-execution-1:1",
  executionId: "execution-1",
  stepExecutionId: "step-execution-1",
  status: "succeeded",
  output: { score: 100 },
  completedAt: "2026-07-26T00:00:01.000Z",
};

const event = {
  schemaVersion: "1",
  eventId: "event-1",
  invocationId: "step-execution-1:1",
  executionId: "execution-1",
  stepExecutionId: "step-execution-1",
  sequence: 0,
  type: "accepted",
  occurredAt: "2026-07-26T00:00:00.100Z",
  payload: {},
  trace: {
    traceId: "execution-1",
    correlationId: "step-execution-1:1",
  },
};

describe("contract validation", () => {
  it("parses a valid invocation v1", () => {
    expect(parseAgentInvocation(invocation)).toEqual(invocation);
  });

  it.each([
    ["missing invocationId", { invocationId: undefined }],
    ["attempt zero", { attempt: 0 }],
    ["invalid timestamp", { createdAt: "yesterday" }],
    ["unknown top-level property", { unexpected: true }],
  ])("rejects an invocation with %s", (_case, changes) => {
    const value = { ...invocation, ...changes };
    if ("invocationId" in changes && changes.invocationId === undefined)
      delete value.invocationId;
    expect(() => parseAgentInvocation(value)).toThrow(ContractValidationError);
  });

  it("rejects a succeeded result with an error", () => {
    expect(() =>
      parseAgentResult({
        ...succeededResult,
        error: { code: "NOPE", message: "should not exist", retryable: false },
      }),
    ).toThrow(ContractValidationError);
  });

  it("rejects a failed result without an error", () => {
    expect(() =>
      parseAgentResult({
        ...succeededResult,
        status: "failed",
        output: undefined,
      }),
    ).toThrow(ContractValidationError);
  });

  it("rejects negative token usage", () => {
    expect(() =>
      parseAgentResult({ ...succeededResult, usage: { inputTokens: -1 } }),
    ).toThrow(ContractValidationError);
  });

  it("rejects a negative event sequence", () => {
    expect(() => parseAgentEvent({ ...event, sequence: -1 })).toThrow(
      ContractValidationError,
    );
  });

  it("rejects a non-object event payload", () => {
    expect(() => parseAgentEvent({ ...event, payload: "working" })).toThrow(
      ContractValidationError,
    );
  });

  it("maps validator failures to a structured ContractValidationError", () => {
    try {
      parseAgentInvocation({ ...invocation, invocationId: "" });
      throw new Error("expected validation to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(ContractValidationError);
      expect(error).toMatchObject({
        contract: "AgentInvocationV1",
        issues: expect.any(Array),
      });
    }
  });

  it("returns a readable issue path", () => {
    try {
      parseAgentInvocation({ ...invocation, invocationId: "" });
      throw new Error("expected validation to fail");
    } catch (error) {
      expect((error as ContractValidationError).issues[0].path).toBe(
        "/invocationId",
      );
    }
  });
});
