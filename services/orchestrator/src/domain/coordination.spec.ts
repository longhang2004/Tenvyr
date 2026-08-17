import {
  applyPhaseTransition,
  buildVerifierContext,
  canonicalDecisionHash,
  compileIterationPlanPatch,
  continueAllowed,
  COORDINATION_BOUNDS,
  CoordinationError,
  decisionsConflict,
  fanInReady,
  parseCoordinationConfig,
  parseRoleInvocationInput,
  parseTaskBatchProposal,
  parseVerifierDecision,
  TERMINAL_COORDINATION_PHASES,
  validateTaskBatchProposal,
  type CoordinationConfigV1,
  type TaskBatchProposalV1,
  type VerifierDecisionV1,
} from "./coordination";

const SEEDED_SECRET = "sk-coordination-secret";

const config = (): CoordinationConfigV1 => ({
  schemaVersion: 1,
  planner: { kind: "agent", name: "planner" },
  verifier: { kind: "agent", name: "verifier" },
  allowedWorkers: [
    { kind: "agent", name: "implementation" },
    { kind: "agent", name: "tests" },
    { kind: "connection", name: "conn:reviewer" },
  ],
  maxIterations: 10,
  maxWorkersPerIteration: 4,
  maxTotalWorkers: 20,
  loopDeadlineMs: 3_600_000,
  delegationDepthMax: 2,
  allowedExecutors: ["local-host"],
});

const batch = (overrides: Partial<TaskBatchProposalV1> = {}): TaskBatchProposalV1 => ({
  schemaVersion: 1,
  iterationNumber: 1,
  baseRevision: 3,
  tasks: [
    {
      taskId: "implement",
      agent: "implementation",
      input: { feature: "login" },
      dependsOn: [],
      required: true,
      reason: "core implementation",
    },
    {
      taskId: "review",
      agent: "conn__reviewer",
      connectionId: "conn:reviewer",
      input: { focus: "security" },
      dependsOn: ["implement"],
      required: false,
      reason: "optional review",
    },
  ],
  reason: "iteration 1 plan",
  ...overrides,
});

const decision = (
  overrides: Partial<VerifierDecisionV1> = {},
): VerifierDecisionV1 => ({
  schemaVersion: 1,
  iterationId: "iter-0001",
  iterationNumber: 1,
  action: "CONTINUE",
  reason: "progress is on track",
  evidenceRefs: ["policy:allow-1", "capsule:abc123"],
  ...overrides,
});

const expectRejected = (fail: () => unknown, code: string): void => {
  try {
    fail();
    throw new Error("expected rejection");
  } catch (error) {
    expect(error).toMatchObject({ code });
  }
};

describe("CoordinationConfig parsing and hard bounds", () => {
  it("round-trips a frozen config", () => {
    expect(parseCoordinationConfig(config())).toEqual(config());
  });

  it("rejects out-of-bounds limits and malformed selections", () => {
    expectRejected(
      () => parseCoordinationConfig({ ...config(), maxIterations: 0 }),
      "CONFIG_INVALID",
    );
    expectRejected(
      () =>
        parseCoordinationConfig({
          ...config(),
          maxIterations: COORDINATION_BOUNDS.maxIterations + 1,
        }),
      "CONFIG_INVALID",
    );
    expectRejected(
      () =>
        parseCoordinationConfig({
          ...config(),
          planner: { kind: "provider", name: "x" },
        }),
      "CONFIG_INVALID",
    );
    expectRejected(
      () =>
        parseCoordinationConfig({
          ...config(),
          allowedWorkers: [{ kind: "connection", name: "bad id" }],
        }),
      "CONFIG_INVALID",
    );
    expectRejected(
      () => parseCoordinationConfig({ ...config(), allowedWorkers: [] }),
      "CONFIG_INVALID",
    );
    expectRejected(
      () => parseCoordinationConfig({ ...config(), allowedExecutors: [] }),
      "CONFIG_INVALID",
    );
  });

  it("config carries only references, never secrets", () => {
    const rendered = JSON.stringify(parseCoordinationConfig(config()));
    expect(rendered).not.toContain(SEEDED_SECRET);
  });
});

describe("TaskBatchProposal parsing and validation", () => {
  it("round-trips a valid batch with dependency order", () => {
    const parsed = parseTaskBatchProposal(batch());
    expect(parsed.tasks).toHaveLength(2);
    expect(parsed.tasks[1].dependsOn).toEqual(["implement"]);
  });

  it("rejects unknown schema versions, empty/oversized batches, and duplicate ids", () => {
    expectRejected(
      () => parseTaskBatchProposal({ ...batch(), schemaVersion: 2 }),
      "BATCH_INVALID",
    );
    expectRejected(
      () => parseTaskBatchProposal({ ...batch(), tasks: [] }),
      "BATCH_INVALID",
    );
    expectRejected(
      () =>
        parseTaskBatchProposal({
          ...batch(),
          tasks: [
            { ...batch().tasks[0], dependsOn: [] },
            { ...batch().tasks[0], dependsOn: [] },
          ],
        }),
      "BATCH_INVALID",
    );
    expectRejected(
      () =>
        parseTaskBatchProposal({
          ...batch(),
          tasks: [
            batch().tasks[0],
            { ...batch().tasks[1], dependsOn: ["review"] },
          ],
        }),
      "TASK_INVALID",
    );
  });

  it("rejects cycles, unknown dependencies, and self-dependencies", () => {
    expectRejected(
      () =>
        parseTaskBatchProposal({
          ...batch(),
          tasks: [
            { ...batch().tasks[0], dependsOn: ["review"] },
            batch().tasks[1],
          ],
        }),
      "BATCH_INVALID",
    );
    expectRejected(
      () =>
        parseTaskBatchProposal({
          ...batch(),
          tasks: [
            { ...batch().tasks[0], dependsOn: ["missing"] },
            batch().tasks[1],
          ],
        }),
      "BATCH_INVALID",
    );
  });

  it("rejects hostile metadata: shell metacharacters, oversized input, bad selectors", () => {
    expectRejected(
      () =>
        parseTaskBatchProposal({
          ...batch(),
          tasks: [{ ...batch().tasks[0], taskId: "../../etc/passwd" }],
        }),
      "TASK_INVALID",
    );
    expectRejected(
      () =>
        parseTaskBatchProposal({
          ...batch(),
          tasks: [
            {
              ...batch().tasks[0],
              input: { payload: "x".repeat(COORDINATION_BOUNDS.maxTaskInputBytes + 1) },
            },
          ],
        }),
      "TASK_INVALID",
    );
    expectRejected(
      () =>
        parseTaskBatchProposal({
          ...batch(),
          tasks: [
            {
              ...batch().tasks[0],
              connectionId: "$(rm -rf /)",
            },
          ],
        }),
      "TASK_INVALID",
    );
    expectRejected(
      () =>
        parseTaskBatchProposal({
          ...batch(),
          tasks: [{ ...batch().tasks[0], timeoutMs: 0 }],
        }),
      "TASK_INVALID",
    );
  });

  it("enforces the allowlist and cumulative limits against the frozen config", () => {
    validateTaskBatchProposal(config(), batch(), 0);
    expectRejected(
      () =>
        validateTaskBatchProposal(config(), batch(), 19),
      "LIMIT_EXCEEDED",
    );
    expectRejected(
      () =>
        validateTaskBatchProposal(config(), batch({
          tasks: [
            {
              taskId: "sneaky",
              agent: "not-allowed-agent",
              input: {},
              dependsOn: [],
              required: true,
              reason: "bypass",
            },
          ],
        }), 0),
      "AGENT_NOT_ALLOWED",
    );
    expectRejected(
      () =>
        validateTaskBatchProposal(config(), batch({
          tasks: [
            {
              taskId: "sneaky",
              agent: "reviewer",
              connectionId: "conn:not-allowed",
              input: {},
              dependsOn: [],
              required: true,
              reason: "bypass",
            },
          ],
        }), 0),
      "CONNECTION_NOT_ALLOWED",
    );
    expectRejected(
      () =>
        validateTaskBatchProposal(
          config(),
          batch({ iterationNumber: 11 }),
          0,
        ),
      "LIMIT_EXCEEDED",
    );
  });

  it("rejects Planner recursion and Verifier smuggling in a batch (M9-S3)", () => {
    expectRejected(
      () =>
        validateTaskBatchProposal(config(), batch({
          tasks: [
            {
              taskId: "recursive",
              agent: "planner",
              input: {},
              dependsOn: [],
              required: true,
              reason: "planner recursion attempt",
            },
          ],
        }), 0),
      "AGENT_NOT_ALLOWED",
    );
    expectRejected(
      () =>
        validateTaskBatchProposal(config(), batch({
          tasks: [
            {
              taskId: "smuggled",
              agent: "verifier",
              input: {},
              dependsOn: [],
              required: true,
              reason: "verifier smuggling attempt",
            },
          ],
        }), 0),
      "AGENT_NOT_ALLOWED",
    );
  });

  it("compiles a batch plus one Coordinator-owned Verifier step into the restricted PlanPatch", () => {
    const { patch, verifierStepId } = compileIterationPlanPatch(
      config(),
      batch(),
      1,
    );
    expect(verifierStepId).toBe("verify-1");
    expect(patch.schemaVersion).toBe(1);
    expect(patch.operations).toHaveLength(3); // implement, review, verify-1
    const [implement, review, verifier] = patch.operations.map((op) => op.step);
    expect(implement).toMatchObject({
      id: "implement",
      agent: "implementation",
      dependsOn: [],
      onFailure: "stop", // required worker without retries
    });
    expect(review).toMatchObject({
      id: "review",
      agent: "conn__reviewer",
      dependsOn: ["implement"],
      onFailure: "continue", // optional worker: failure is evidence
      metadata: { tenvyrConnectionId: "conn:reviewer" },
    });
    expect(verifier).toMatchObject({
      id: "verify-1",
      agent: "verifier",
      dependsOn: ["implement", "review"],
      onFailure: "stop",
    });
    // No planner/coordinator/loop shapes in the compiled steps.
    for (const op of patch.operations) {
      expect(op.step.planner).toBeUndefined();
      expect(op.step).not.toHaveProperty("loop");
      expect(op.step).not.toHaveProperty("secret");
    }
  });

  it("compiles retry-aware required workers and records connection-kind verifier selections", () => {
    const retryBatch = batch({
      tasks: [{ ...batch().tasks[0], retry: 2 }],
    });
    const { patch } = compileIterationPlanPatch(config(), retryBatch, 1);
    expect(patch.operations[0].step).toMatchObject({
      onFailure: "retry",
      retries: 2,
    });

    // M8-S6: a connection-kind Verifier is a typed selection — the step
    // records the connection so the claim freezes exactly that revision.
    const connectionVerifier: CoordinationConfigV1 = {
      ...config(),
      verifier: { kind: "connection", name: "conn:verifier" },
    };
    const { patch: verifierPatch, verifierStepId } = compileIterationPlanPatch(
      connectionVerifier,
      batch(),
      1,
    );
    const verifierStep = verifierPatch.operations.find(
      (operation) => operation.step.id === verifierStepId,
    );
    expect(verifierStep?.step.metadata).toEqual({
      tenvyrConnectionId: "conn:verifier",
    });
  });

  it("batch proposals can never smuggle a verifier/coordinator/secret/command shape", () => {
    const rendered = JSON.stringify(batch());
    expect(rendered).not.toContain(SEEDED_SECRET);
    expect(rendered).not.toMatch(/verifier|coordinator|exec.*command/i);
    const parsed = parseTaskBatchProposal(batch());
    for (const task of parsed.tasks) {
      expect(task).not.toHaveProperty("command");
      expect(task).not.toHaveProperty("secret");
      expect(task).not.toHaveProperty("loop");
    }
  });
});

describe("VerifierDecision contract", () => {
  it("round-trips and canonical hashes are stable; conflicts are detected", () => {
    const parsed = parseVerifierDecision(decision());
    expect(parsed.action).toBe("CONTINUE");
    const hash = canonicalDecisionHash(parsed);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(canonicalDecisionHash(parseVerifierDecision(decision()))).toBe(hash);

    // Same identity, same payload: idempotent. Same identity, different
    // payload: conflict.
    expect(decisionsConflict(parsed, parsed)).toBe(false);
    expect(
      decisionsConflict(parsed, decision({ reason: "different reason" })),
    ).toBe(true);
    // Different identity: never a conflict.
    expect(
      decisionsConflict(parsed, decision({ iterationId: "iter-0002" })),
    ).toBe(false);
  });

  it("rejects unknown actions, oversized payloads, and executable content", () => {
    expectRejected(
      () => parseVerifierDecision(decision({ action: "RUN_CODE" as never })),
      "DECISION_INVALID",
    );
    expectRejected(
      () =>
        parseVerifierDecision(
          decision({ reason: "x".repeat(COORDINATION_BOUNDS.maxDecisionReasonLength + 1) }),
        ),
      "DECISION_INVALID",
    );
    expectRejected(
      () =>
        parseVerifierDecision(
          decision({
            recommendation: {
              reason: "next",
              focus: ["a", "a"],
            },
          }),
        ),
      "DECISION_INVALID",
    );
    const hostile = parseVerifierDecision(
      decision({
        recommendation: { reason: "next", focus: ["ok"] },
      }) as never,
    );
    expect(hostile).not.toHaveProperty("command");
    expect(hostile).not.toHaveProperty("limits");
    expect(JSON.stringify(hostile)).not.toContain(SEEDED_SECRET);
  });
});

describe("phase machine", () => {
  it("follows the SPEC lifecycle exactly", () => {
    let phase = applyPhaseTransition("PLANNING", "plannerProposed");
    expect(phase).toBe("BATCH_VALIDATION");
    phase = applyPhaseTransition(phase, "batchValidated");
    expect(phase).toBe("WORKING");
    phase = applyPhaseTransition(phase, "workersFinished");
    expect(phase).toBe("VERIFYING");
    phase = applyPhaseTransition(phase, "verifierProposed");
    expect(phase).toBe("DECIDING");
    phase = applyPhaseTransition(phase, "continue");
    expect(phase).toBe("PLANNING");
    phase = applyPhaseTransition(phase, "plannerProposed");
    phase = applyPhaseTransition(phase, "batchValidated");
    phase = applyPhaseTransition(phase, "workersFinished");
    phase = applyPhaseTransition(phase, "verifierProposed");
    phase = applyPhaseTransition(phase, "accept");
    expect(phase).toBe("ACCEPTED");
  });

  it("routes WAIT/approval/denial and terminal events", () => {
    expect(applyPhaseTransition("DECIDING", "wait")).toBe("WAITING_FOR_HUMAN");
    expect(applyPhaseTransition("WAITING_FOR_HUMAN", "approvalGranted")).toBe(
      "DECIDING",
    );
    expect(applyPhaseTransition("WAITING_FOR_HUMAN", "approvalDenied")).toBe(
      "FAILED",
    );
    expect(applyPhaseTransition("WORKING", "deadline")).toBe("LIMIT_REACHED");
    expect(applyPhaseTransition("WORKING", "cancel")).toBe("CANCELLED");
    expect(applyPhaseTransition("DECIDING", "fail")).toBe("FAILED");
  });

  it("rejects illegal transitions and absorbs everything once terminal", () => {
    expectRejected(
      () => applyPhaseTransition("WORKING", "plannerProposed"),
      "PHASE_TRANSITION_INVALID",
    );
    for (const terminal of TERMINAL_COORDINATION_PHASES) {
      expect(applyPhaseTransition(terminal, "continue")).toBe(terminal);
      expect(applyPhaseTransition(terminal, "cancel")).toBe(terminal);
      expect(applyPhaseTransition(terminal, "plannerProposed")).toBe(terminal);
    }
  });
});

describe("CONTINUE eligibility", () => {
  it("respects iteration and cumulative-worker hard limits", () => {
    const cfg = config();
    expect(continueAllowed(cfg, 1, 2, 2)).toBe(true);
    expect(continueAllowed(cfg, 10, 0, 1)).toBe(false); // maxIterations
    expect(continueAllowed(cfg, 1, 19, 2)).toBe(false); // maxTotalWorkers
  });
});

describe("fan-in readiness", () => {
  it("waits for every required worker; optional failure never blocks", () => {
    const terminal = new Map<string, "SUCCESS" | "FAILED">([
      ["implement", "SUCCESS"],
      ["tests", "FAILED"],
    ]);
    expect(fanInReady(terminal, ["implement"])).toBe(true);
    expect(fanInReady(terminal, ["implement", "tests"])).toBe(true); // terminal, any outcome
    expect(fanInReady(terminal, ["implement", "review"])).toBe(false);
    expect(fanInReady(new Map(), ["implement"])).toBe(false);
  });
});

describe("bounded aggregation", () => {
  it("builds a deterministic bounded context with explicit selection", () => {
    const context = buildVerifierContext({
      iterationId: "iter-0001",
      iterationNumber: 1,
      workers: [
        {
          taskId: "implement",
          status: "SUCCESS",
          summary: "implemented login",
          selectedFields: { diff: { files: 3 } },
          artifactRefs: ["artifact:one"],
        },
        {
          taskId: "review",
          status: "FAILED",
          failureCode: "review_failed",
          summary: "x".repeat(COORDINATION_BOUNDS.maxWorkerSummaryBytes + 100),
          artifactRefs: [],
        },
      ],
      executionStateKeys: { stateVersion: 4, secretKey: SEEDED_SECRET },
      priorDecision: { action: "CONTINUE", reason: "prior" },
      limits: {
        maxIterations: 10,
        maxTotalWorkers: 20,
        cumulativeWorkers: 2,
        remainingDeadlineMs: 3_000_000,
      },
      evidence: ["policy:allow-1"],
      selectedStateKeys: ["stateVersion"],
    });

    expect(context.workers).toHaveLength(2);
    expect(context.workers[0].summary).toBe("implemented login");
    expect(context.workers[0].artifactRefs).toEqual(["artifact:one"]);
    // Truncation is recorded, never silent.
    expect(context.workers[1].summary).toMatch(/…$/);
    expect(context.omitted).toContain("worker.review.summary");
    // Explicit state-key selection only: the secret key never enters.
    expect(context.executionStateKeys).toEqual({ stateVersion: 4 });
    expect(JSON.stringify(context)).not.toContain(SEEDED_SECRET);
    expect(context.limits.cumulativeWorkers).toBe(2);
    expect(context.evidence).toEqual(["policy:allow-1"]);
  });

  it("rejects oversized aggregates and caps refs/keys deterministically", () => {
    expectRejected(
      () =>
        buildVerifierContext({
          iterationId: "iter-0001",
          iterationNumber: 1,
          workers: Array.from({ length: COORDINATION_BOUNDS.maxAggregateWorkers + 1 }, (_, index) => ({
            taskId: `w${index}`,
            status: "SUCCESS" as const,
            artifactRefs: [],
          })),
          executionStateKeys: {},
          limits: {
            maxIterations: 10,
            maxTotalWorkers: 100,
            cumulativeWorkers: 0,
            remainingDeadlineMs: 1,
          },
          evidence: [],
          selectedStateKeys: [],
        }),
      "AGGREGATION_INVALID",
    );

    const context = buildVerifierContext({
      iterationId: "iter-0001",
      iterationNumber: 1,
      workers: [
        {
          taskId: "w1",
          status: "SUCCESS",
          artifactRefs: Array.from({ length: 200 }, (_, index) => `artifact:${index}`),
        },
      ],
      executionStateKeys: Object.fromEntries(
        Array.from({ length: 100 }, (_, index) => [`key${index}`, index]),
      ),
      limits: {
        maxIterations: 10,
        maxTotalWorkers: 20,
        cumulativeWorkers: 1,
        remainingDeadlineMs: 1,
      },
      evidence: [],
      selectedStateKeys: ["key0", "key1", "key2"],
    });
    expect(context.workers[0].artifactRefs).toHaveLength(
      COORDINATION_BOUNDS.maxArtifactRefs,
    );
    expect(Object.keys(context.executionStateKeys)).toHaveLength(3);
  });
});

describe("P0: Worker RuntimeConnection Routing Authority", () => {
  it("rejects proposal when task.agent mismatches the connection selection transport agent", () => {
    // config has conn:reviewer with expected transport agent conn__reviewer
    expectRejected(
      () =>
        validateTaskBatchProposal(
          config(),
          batch({
            tasks: [
              {
                taskId: "hack-route",
                agent: "evil-agent",
                connectionId: "conn:reviewer",
                input: {},
                dependsOn: [],
                required: true,
                reason: "attempt to divert connection execution",
              },
            ],
          }),
          0,
        ),
      "AGENT_NOT_ALLOWED",
    );
  });

  it("compiles step.agent from Tenvyr-derived connection authority even when bypassed by hostile preconstructed proposal", () => {
    const hostileProposal: TaskBatchProposalV1 = {
      schemaVersion: 1,
      iterationNumber: 1,
      baseRevision: 3,
      tasks: [
        {
          taskId: "bypass-test",
          agent: "evil-agent", // Hostile agent injected into object directly
          connectionId: "conn:reviewer",
          input: { valid: true },
          dependsOn: [],
          required: true,
          reason: "bypassed validator",
        },
      ],
      reason: "hostile proposal",
    };

    const compiled = compileIterationPlanPatch(
      config(),
      hostileProposal,
      1,
      undefined,
      "operator goal",
    );

    const stepOp = compiled.patch.operations.find(
      (op) => op.op === "addStep" && op.step.id === "bypass-test",
    );
    expect(stepOp).toBeDefined();
    // Must be Tenvyr-derived "conn__reviewer", NEVER "evil-agent"
    expect(stepOp?.step.agent).toBe("conn__reviewer");
    expect((stepOp?.step.metadata as any)?.tenvyrConnectionId).toBe("conn:reviewer");
  });
});

describe("P1: Worker Role Protocol Ownership & Immutability", () => {
  it("strictly namespaces planner task.input and prevents overwriting Tenvyr role protocol fields", () => {
    const hostileProposal: TaskBatchProposalV1 = {
      schemaVersion: 1,
      iterationNumber: 1,
      baseRevision: 3,
      tasks: [
        {
          taskId: "auth-task-1",
          agent: "implementation",
          input: {
            role: "planner",
            goal: "FORGED_GOAL",
            taskId: "forged_task_id",
            iterationNumber: 999,
            schemaVersion: 999,
            taskInput: "forged_inner",
            outputContract: { instructions: "FORGED_INSTRUCTIONS" },
            workspace: { workspaceId: "forged_ws" },
          },
          dependsOn: [],
          required: true,
          reason: "attempt to overwrite protocol fields",
        },
      ],
      reason: "hostile input test",
    };

    const compiled = compileIterationPlanPatch(
      config(),
      hostileProposal,
      1,
      { workspaceId: "real-ws", path: "/real/path" } as any,
      "REAL_OPERATOR_GOAL",
      { executionWorkspaceId: "exec-1", path: "/exec/1", mode: "git-worktree" } as any,
    );

    const stepOp = compiled.patch.operations.find(
      (op) => op.op === "addStep" && op.step.id === "auth-task-1",
    );
    expect(stepOp).toBeDefined();
    const input = stepOp?.step.input as any;

    // Tenvyr protocol fields must remain authoritative
    expect(input.schemaVersion).toBe(1);
    expect(input.role).toBe("worker");
    expect(input.taskId).toBe("auth-task-1");
    expect(input.goal).toBe("REAL_OPERATOR_GOAL");
    expect(input.iterationNumber).toBe(1);
    expect(input.workspace).toEqual({ workspaceId: "real-ws", path: "/real/path" });
    expect(input.executionWorkspace).toEqual({
      executionWorkspaceId: "exec-1",
      path: "/exec/1",
      mode: "git-worktree",
    });
    expect(input.outputContract.instructions).toBe(
      "Execute the assigned task in the execution workspace and return structured output.",
    );

    // Hostile object is only preserved inside taskInput
    expect(input.taskInput).toEqual({
      role: "planner",
      goal: "FORGED_GOAL",
      taskId: "forged_task_id",
      iterationNumber: 999,
      schemaVersion: 999,
      taskInput: "forged_inner",
      outputContract: { instructions: "FORGED_INSTRUCTIONS" },
      workspace: { workspaceId: "forged_ws" },
    });

    // Validates via parseRoleInvocationInput
    const parsed = parseRoleInvocationInput(input);
    expect(parsed.role).toBe("worker");
    expect(parsed.goal).toBe("REAL_OPERATOR_GOAL");
  });

  it("parseRoleInvocationInput validates each role shape and rejects invalid payloads", () => {
    expectRejected(
      () => parseRoleInvocationInput(null),
      "PAYLOAD_INVALID",
    );
    expectRejected(
      () => parseRoleInvocationInput({ schemaVersion: 2 }),
      "PAYLOAD_INVALID",
    );
    expectRejected(
      () => parseRoleInvocationInput({ schemaVersion: 1, role: "invalid", goal: "g", iterationNumber: 1, outputContract: { instructions: "i" } }),
      "PAYLOAD_INVALID",
    );
    expectRejected(
      () => parseRoleInvocationInput({ schemaVersion: 1, role: "worker", goal: "g", iterationNumber: 1, outputContract: { instructions: "i" } }),
      "PAYLOAD_INVALID", // missing taskId
    );
    expectRejected(
      () => parseRoleInvocationInput({ schemaVersion: 1, role: "planner", goal: "g", iterationNumber: 1, outputContract: { instructions: "i" } }),
      "PAYLOAD_INVALID", // missing planRevision
    );
    expectRejected(
      () => parseRoleInvocationInput({ schemaVersion: 1, role: "verifier", goal: "g", iterationNumber: 1, outputContract: { instructions: "i" } }),
      "PAYLOAD_INVALID", // missing context
    );
  });
});
