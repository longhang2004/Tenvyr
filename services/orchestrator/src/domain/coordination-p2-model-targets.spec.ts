import {
  compileIterationPlanPatch,
  CoordinationError,
  deterministicWorkerModel,
  parseCoordinationConfig,
  parseTaskBatchProposal,
  validateTaskBatchProposal,
  type CoordinationConfigV1,
} from "./coordination";

/**
 * P2: model selection authority — a Planner may choose ONLY Runtime
 * Targets frozen in `allowedTargets`; role targets are operator-frozen;
 * connection-only emission resolves deterministically only for exactly one
 * allowed model; Tenvyr never chooses arbitrarily and never falls back.
 */

const baseConfig = (): CoordinationConfigV1 => ({
  schemaVersion: 1,
  planner: { kind: "connection", name: "conn:claude", agent: "claude-planner" },
  verifier: { kind: "connection", name: "conn:verifier", agent: "verifier" },
  allowedWorkers: [
    { kind: "connection", name: "conn:claude" },
    { kind: "connection", name: "conn:opencode" },
    { kind: "connection", name: "conn:codex" },
  ],
  maxIterations: 3,
  maxWorkersPerIteration: 4,
  maxTotalWorkers: 20,
  loopDeadlineMs: 3_600_000,
  delegationDepthMax: 2,
  allowedExecutors: ["local-host"],
});

/** Runs a throwing fn and returns the caught error (predicate-free
 *  assertion for error CODES, which jest's toThrow types don't accept). */
const captureError = (fn: () => void): unknown => {
  try {
    fn();
    return undefined;
  } catch (error) {
    return error;
  }
};

const expectCode = (fn: () => void, code: string): void => {
  const error = captureError(fn);
  expect(error).toBeInstanceOf(CoordinationError);
  expect((error as CoordinationError).code).toBe(code);
};

const batch = (
  tasks: Array<Record<string, unknown>>,
): Record<string, unknown> => ({
  schemaVersion: 1,
  iterationNumber: 1,
  baseRevision: 3,
  tasks,
  reason: "test batch",
});

const task = (
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  taskId: "t1",
  agent: "worker",
  input: null,
  dependsOn: [],
  required: true,
  reason: "test",
  ...overrides,
});

describe("P2 model selection authorization", () => {
  test("config parses frozen role targets and allowedTargets", () => {
    const parsed = parseCoordinationConfig({
      ...baseConfig(),
      plannerTarget: {
        connectionId: "conn:claude",
        modelId: "claude-sonnet-5",
      },
      verifierTarget: { connectionId: "conn:verifier", modelId: "gpt-5.5" },
      allowedTargets: [
        {
          connectionId: "conn:opencode",
          modelId: "opencode-go/deepseek-v4-flash",
        },
        { connectionId: "conn:codex", modelId: "gpt-5.5" },
      ],
    });
    expect(parsed.plannerTarget).toEqual({
      connectionId: "conn:claude",
      modelId: "claude-sonnet-5",
    });
    expect(parsed.verifierTarget).toEqual({
      connectionId: "conn:verifier",
      modelId: "gpt-5.5",
    });
    expect(parsed.allowedTargets?.length).toBe(2);
    expect(parsed.allowedTargets?.[0].modelId).toBe(
      "opencode-go/deepseek-v4-flash",
    );
  });

  test("role target must be the role's OWN connection", () => {
    expect(() =>
      parseCoordinationConfig({
        ...baseConfig(),
        plannerTarget: { connectionId: "conn:codex", modelId: "gpt-5.5" },
      }),
    ).toThrow(/plannerTarget/);
    // Agent-kind roles cannot carry targets.
    expect(() =>
      parseCoordinationConfig({
        ...baseConfig(),
        planner: { kind: "agent", name: "planner" },
        plannerTarget: {
          connectionId: "conn:claude",
          modelId: "claude-sonnet-5",
        },
      }),
    ).toThrow(CoordinationError);
  });

  test("allowedTargets entries must be allowed connection workers", () => {
    expect(() =>
      parseCoordinationConfig({
        ...baseConfig(),
        allowedTargets: [{ connectionId: "conn:unknown", modelId: "gpt-5.5" }],
      }),
    ).toThrow(/not an allowed connection worker/);
  });

  test("malformed model ids are rejected as data", () => {
    expect(() =>
      parseCoordinationConfig({
        ...baseConfig(),
        allowedTargets: [{ connectionId: "conn:codex", modelId: "gpt 5.5" }],
      }),
    ).toThrow(CoordinationError);
    expect(() =>
      parseCoordinationConfig({
        ...baseConfig(),
        allowedTargets: [
          { connectionId: "conn:codex", modelId: `x${"a".repeat(300)}` },
        ],
      }),
    ).toThrow(CoordinationError);
    expect(() =>
      parseTaskBatchProposal({
        ...batch([]),
        tasks: [task({ modelId: "solo-model" })],
      }),
    ).toThrow(/modelId requires a connectionId/);
  });

  test("Planner selecting an unauthorized model is DENIED (MODEL_NOT_ALLOWED)", () => {
    const config: CoordinationConfigV1 = {
      ...baseConfig(),
      allowedTargets: [{ connectionId: "conn:codex", modelId: "gpt-5.5" }],
    };
    const proposal = parseTaskBatchProposal(
      batch([task({ connectionId: "conn:codex", modelId: "gpt-4o-mini" })]),
    );
    expectCode(
      () => validateTaskBatchProposal(config, proposal, 0),
      "MODEL_NOT_ALLOWED",
    );
  });

  test("Planner selecting an allowed target passes", () => {
    const config: CoordinationConfigV1 = {
      ...baseConfig(),
      allowedTargets: [
        {
          connectionId: "conn:opencode",
          modelId: "opencode-go/deepseek-v4-flash",
        },
        { connectionId: "conn:codex", modelId: "gpt-5.5" },
      ],
    };
    const proposal = parseTaskBatchProposal(
      batch([
        task({
          taskId: "w1",
          connectionId: "conn:opencode",
          modelId: "opencode-go/deepseek-v4-flash",
        }),
        task({ taskId: "w2", connectionId: "conn:codex", modelId: "gpt-5.5" }),
      ]),
    );
    validateTaskBatchProposal(config, proposal, 0);
  });

  test("connection-only emission with 2+ allowed models is DENIED (never arbitrary)", () => {
    const config: CoordinationConfigV1 = {
      ...baseConfig(),
      allowedTargets: [
        { connectionId: "conn:codex", modelId: "gpt-5.5" },
        { connectionId: "conn:codex", modelId: "gpt-5.6" },
      ],
    };
    const proposal = parseTaskBatchProposal(
      batch([task({ connectionId: "conn:codex" })]),
    );
    expectCode(
      () => validateTaskBatchProposal(config, proposal, 0),
      "MODEL_NOT_ALLOWED",
    );
  });

  test("connection-only emission with exactly one allowed model is deterministic", () => {
    const config: CoordinationConfigV1 = {
      ...baseConfig(),
      allowedTargets: [{ connectionId: "conn:codex", modelId: "gpt-5.5" }],
    };
    const proposal = parseTaskBatchProposal(
      batch([task({ connectionId: "conn:codex" })]),
    );
    validateTaskBatchProposal(config, proposal, 0);
    expect(deterministicWorkerModel(config, "conn:codex")).toBe("gpt-5.5");
    // The compiled step freezes the resolved model.
    const { patch } = compileIterationPlanPatch(config, proposal, 1);
    const workerStep = patch.operations[0].step as {
      metadata: Record<string, unknown>;
    };
    expect(workerStep.metadata.tenvyrConnectionId).toBe("conn:codex");
    expect(workerStep.metadata.tenvyrModelId).toBe("gpt-5.5");
  });

  test("revoked/unknown connection with a model is still DENIED (connection authority first)", () => {
    const config: CoordinationConfigV1 = {
      ...baseConfig(),
      allowedTargets: [{ connectionId: "conn:codex", modelId: "gpt-5.5" }],
    };
    const proposal = parseTaskBatchProposal(
      batch([
        task({
          taskId: "bad",
          connectionId: "conn:not-allowed",
          modelId: "gpt-5.5",
        }),
      ]),
    );
    expectCode(
      () => validateTaskBatchProposal(config, proposal, 0),
      "CONNECTION_NOT_ALLOWED",
    );
  });

  test("compileIterationPlanPatch freezes Planner task model + verifier role model", () => {
    const config: CoordinationConfigV1 = {
      ...baseConfig(),
      verifierTarget: { connectionId: "conn:verifier", modelId: "gpt-5.5" },
      allowedTargets: [
        {
          connectionId: "conn:opencode",
          modelId: "opencode-go/deepseek-v4-flash",
        },
      ],
    };
    const proposal = parseTaskBatchProposal(
      batch([
        task({
          taskId: "w1",
          connectionId: "conn:opencode",
          modelId: "opencode-go/deepseek-v4-flash",
        }),
      ]),
    );
    validateTaskBatchProposal(config, proposal, 0);
    const { patch, verifierStepId } = compileIterationPlanPatch(
      config,
      proposal,
      1,
    );
    const workerStep = patch.operations.find((op) => op.step.id === "w1")!
      .step as { metadata: Record<string, unknown> };
    expect(workerStep.metadata.tenvyrModelId).toBe(
      "opencode-go/deepseek-v4-flash",
    );
    const verifierStep = patch.operations.find(
      (op) => op.step.id === verifierStepId,
    )!.step as { metadata: Record<string, unknown> };
    expect(verifierStep.metadata.tenvyrConnectionId).toBe("conn:verifier");
    expect(verifierStep.metadata.tenvyrModelId).toBe("gpt-5.5");
  });

  test("no allowedTargets = legacy behavior (no model selection possible)", () => {
    const config = baseConfig();
    const proposal = parseTaskBatchProposal(
      batch([task({ connectionId: "conn:codex", modelId: "gpt-5.5" })]),
    );
    expectCode(
      () => validateTaskBatchProposal(config, proposal, 0),
      "MODEL_NOT_ALLOWED",
    );
    // Connection-only stays legacy-allowed.
    const legacy = parseTaskBatchProposal(
      batch([task({ connectionId: "conn:codex" })]),
    );
    validateTaskBatchProposal(config, legacy, 0);
    const { patch } = compileIterationPlanPatch(config, legacy, 1);
    const step = patch.operations[0].step as {
      metadata?: Record<string, unknown>;
    };
    expect(step.metadata?.tenvyrModelId).toBeUndefined();
  });
});
