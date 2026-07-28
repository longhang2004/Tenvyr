import {
  ContractValidationError,
  LegacyInvocationDefaults,
  LegacyResultDefaults,
  normalizeLegacyInvocation,
  normalizeLegacyResult,
} from "../src";

const invocationDefaults: LegacyInvocationDefaults = {
  invocationId: "step-execution-1:1",
  executionId: "execution-1",
  stepExecutionId: "step-execution-1",
  stepId: "review",
  agent: "code-reviewer",
  attempt: 1,
  traceId: "execution-1",
  correlationId: "step-execution-1:1",
  createdAt: "2026-07-26T00:00:00.000Z",
};

const resultDefaults: LegacyResultDefaults = {
  invocationId: "step-execution-1:1",
  executionId: "execution-1",
  stepExecutionId: "step-execution-1",
  completedAt: "2026-07-26T00:00:01.000Z",
};

const invocationV1 = {
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
} as const;

describe("legacy normalization", () => {
  it("keeps an invocation v1 unchanged", () => {
    expect(normalizeLegacyInvocation(invocationV1, invocationDefaults)).toEqual(
      invocationV1,
    );
  });

  it("maps a valid legacy invocation to v1", () => {
    expect(
      normalizeLegacyInvocation(
        {
          executionId: "execution-1",
          stepId: "review",
          agent: "code-reviewer",
          input: { code: "const safe = true;" },
          attempt: 1,
          maxAttempts: 3,
          timeout: "30s",
          timestamp: "2026-07-26T00:00:00.000Z",
        },
        invocationDefaults,
      ),
    ).toMatchObject({
      ...invocationV1,
      deadlineAt: "2026-07-26T00:00:30.000Z",
      metadata: {
        legacy: {
          maxAttempts: 3,
          timeout: "30s",
        },
      },
    });
  });

  it("maps a successful legacy result to v1", () => {
    expect(
      normalizeLegacyResult(
        {
          executionId: "execution-1",
          stepId: "review",
          status: "COMPLETED",
          output: { score: 100 },
          attempt: 1,
          timestamp: "2026-07-26T00:00:01.000Z",
        },
        resultDefaults,
      ),
    ).toEqual({
      schemaVersion: "1",
      invocationId: "step-execution-1:1",
      executionId: "execution-1",
      stepExecutionId: "step-execution-1",
      status: "succeeded",
      output: { score: 100 },
      completedAt: "2026-07-26T00:00:01.000Z",
      metadata: { legacy: { stepId: "review", attempt: 1 } },
    });
  });

  it("maps a failed legacy result to v1", () => {
    expect(
      normalizeLegacyResult(
        {
          executionId: "execution-1",
          stepId: "review",
          status: "FAILED",
          error: "runner unavailable",
          attempt: 1,
          timestamp: "2026-07-26T00:00:01.000Z",
        },
        resultDefaults,
      ),
    ).toMatchObject({
      status: "failed",
      error: {
        code: "LEGACY_AGENT_FAILURE",
        message: "runner unavailable",
        retryable: false,
      },
    });
  });

  it("fails when an important orchestration default is missing", () => {
    expect(() =>
      normalizeLegacyInvocation(
        { input: {}, timestamp: "2026-07-26T00:00:00.000Z" },
        { ...invocationDefaults, stepExecutionId: "" },
      ),
    ).toThrow(ContractValidationError);
  });

  it("produces the same output for the same payload and defaults", () => {
    const legacy = {
      executionId: "execution-1",
      stepId: "review",
      agent: "code-reviewer",
      input: {},
      attempt: 1,
      timestamp: "2026-07-26T00:00:00.000Z",
    };
    expect(normalizeLegacyInvocation(legacy, invocationDefaults)).toEqual(
      normalizeLegacyInvocation(legacy, invocationDefaults),
    );
  });

  it("never creates random identifiers", () => {
    const normalized = normalizeLegacyResult(
      {
        executionId: "execution-1",
        stepId: "review",
        status: "COMPLETED",
        timestamp: "2026-07-26T00:00:01.000Z",
      },
      resultDefaults,
    );
    expect(normalized.invocationId).toBe(resultDefaults.invocationId);
    expect(normalized.stepExecutionId).toBe(resultDefaults.stepExecutionId);
  });
});
