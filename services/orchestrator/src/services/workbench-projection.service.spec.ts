import { WorkbenchProjectionService, WORKBENCH_BOUNDS } from "./workbench-projection.service";

const makeDataSource = (overrides: Record<string, unknown> = {}) =>
  ({
    getRepository: () => ({
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(null),
      count: jest.fn().mockResolvedValue(0),
      createQueryBuilder: () => {
        const chain: Record<string, unknown> = {
          where: () => chain,
          orderBy: () => chain,
          take: () => chain,
          getMany: async () => [],
        };
        return chain;
      },
    }),
    ...overrides,
  }) as never;

describe("WorkbenchProjectionService", () => {
  it("bounds goal previews with truncation metadata and never exposes inputs raw", async () => {
    const huge = "x".repeat(WORKBENCH_BOUNDS.maxGoalChars + 100);
    const dataSource = makeDataSource();
    (dataSource as any).getRepository = () => ({
      findOne: jest.fn().mockImplementation(async ({ where }: any) => {
        if (where.id) {
          return {
            id: where.id,
            status: "RUNNING",
            createdAt: new Date(),
            updatedAt: new Date(),
            terminationReason: null,
            input: { goal: huge },
            activePlanRevisionId: null,
          };
        }
        return null;
      }),
      count: jest.fn().mockResolvedValue(0),
      find: jest.fn().mockResolvedValue([]),
      createQueryBuilder: () => {
        const chain: Record<string, unknown> = {
          where: () => chain,
          orderBy: () => chain,
          take: () => chain,
          getMany: async () => [],
        };
        return chain;
      },
    });
    const service = new WorkbenchProjectionService(dataSource as never);
    const projection = await service.executionProjection("execution-1");

    expect(projection.execution.goal.truncated).toBe(true);
    expect(projection.execution.goal.preview.length).toBe(
      WORKBENCH_BOUNDS.maxGoalChars,
    );
    expect(projection.execution.goal.preview.endsWith("xxxx")).toBe(true);
    expect(projection.coordination).toBeNull();
    expect(projection.schemaVersion).toBe(1);
    expect(projection.serverTime).toBeDefined();
    expect(projection.bounds.maxGoalChars).toBe(WORKBENCH_BOUNDS.maxGoalChars);
  });

  it("redacts raw attempt snapshots and results — summaries only", async () => {
    const dataSource = makeDataSource();
    (dataSource as any).getRepository = () => ({
      findOne: jest.fn().mockImplementation(async ({ where }: any) =>
        where.id
          ? {
              id: where.id,
              status: "RUNNING",
              createdAt: new Date(),
              updatedAt: new Date(),
              terminationReason: null,
              input: {},
              activePlanRevisionId: null,
            }
          : null,
      ),
      count: jest.fn().mockResolvedValue(0),
      find: jest.fn().mockResolvedValue([
        {
          id: "attempt-1",
          logicalStepId: "step-row-1",
          executionId: "execution-1",
          attemptNumber: 1,
          status: "SUCCESS",
          terminalAt: new Date(),
          error: null,
          inputSnapshot: { secret: "sk-raw-secret" },
          result: { chain_of_thought: "top secret reasoning" },
        },
      ]),
      createQueryBuilder: () => {
        const chain: Record<string, unknown> = {
          where: () => chain,
          orderBy: () => chain,
          take: () => chain,
          getMany: async () => [],
        };
        return chain;
      },
    });
    const service = new WorkbenchProjectionService(dataSource as never);
    const projection = await service.executionProjection("execution-1");

    expect(projection.attempts).toHaveLength(1);
    expect(projection.attempts[0]).toEqual({
      stepId: "step-row-1",
      attemptNumber: 1,
      status: "SUCCESS",
      terminalAt: expect.any(String),
      error: null,
    });
    // Raw snapshots/results never enter the projection.
    const rendered = JSON.stringify(projection);
    expect(rendered).not.toContain("sk-raw-secret");
    expect(rendered).not.toContain("chain_of_thought");
  });

  it("caps attempt lists with an explicit truncation flag", async () => {
    const dataSource = makeDataSource();
    const attempts = Array.from({ length: WORKBENCH_BOUNDS.maxAttemptsPerExecution }, (_, i) => ({
      id: `attempt-${i}`,
      logicalStepId: `step-row-${i}`,
      executionId: "execution-1",
      attemptNumber: i + 1,
      status: "SUCCESS",
      terminalAt: new Date(),
      error: null,
    }));
    (dataSource as any).getRepository = (entity: unknown) => {
      const attemptsOnly = (entity as { name?: string }).name === "StepAttemptEntity";
      const isExecution = (entity as { name?: string }).name === "ExecutionEntity";
      return {
        findOne: jest.fn().mockResolvedValue(
          isExecution
            ? {
                id: "execution-1",
                status: "COMPLETED",
                createdAt: new Date(),
                updatedAt: new Date(),
                terminationReason: null,
                input: {},
                activePlanRevisionId: null,
              }
            : null,
        ),
        count: jest.fn().mockResolvedValue(0),
        find: jest.fn().mockResolvedValue(attemptsOnly ? attempts : []),
        createQueryBuilder: () => {
          const chain: Record<string, unknown> = {
            where: () => chain,
            orderBy: () => chain,
            take: () => chain,
            getMany: async () => [],
          };
          return chain;
        },
      };
    };
    const service = new WorkbenchProjectionService(dataSource as never);
    const projection = await service.executionProjection("execution-1");

    expect(projection.attemptsTruncated).toBe(true);
    expect(projection.attempts).toHaveLength(
      WORKBENCH_BOUNDS.maxAttemptsPerExecution,
    );
  });

  it("projects the coordination loop with worker statuses and the decision", async () => {
    const dataSource = makeDataSource();
    const runRow = {
      id: "run-1",
      executionId: "execution-1",
      phase: "VERIFYING",
      currentIterationNumber: 1,
      cumulativeWorkers: 2,
      config: {
        maxIterations: 3,
        maxWorkersPerIteration: 4,
        maxTotalWorkers: 20,
        budgetAccountId: null,
      },
      loopDeadlineAt: new Date(Date.now() + 60_000),
      waitReason: null,
    };
    const iterationRow = {
      id: "iteration-1",
      coordinationRunId: "run-1",
      iterationNumber: 1,
      plannerStepId: "planner-1",
      workerManifest: [
        { taskId: "implement-1", logicalStepId: "step-row-a", required: true },
        { taskId: "tests-1", logicalStepId: "step-row-b", required: false },
      ],
      verifierStepId: "verify-1",
      decision: { action: "CONTINUE", reason: "keep going", iterationId: "iteration-1", iterationNumber: 1, evidenceRefs: [] },
      decisionHash: "ab".repeat(32),
      outcome: null,
    };
    const stepRows = [
      {
        id: "step-row-a",
        executionId: "execution-1",
        stepId: "implement-1",
        status: "COMPLETED",
      },
      {
        id: "step-row-b",
        executionId: "execution-1",
        stepId: "tests-1",
        status: "FAILED",
      },
    ];
     (dataSource as any).getRepository = (entity: unknown) => {
      const name = (entity as { name?: string }).name;
      const byName: Record<string, unknown[]> = {
        StepAttemptEntity: [
          {
            id: "attempt-1",
            logicalStepId: "step-row-a",
            executionId: "execution-1",
            attemptNumber: 1,
            status: "SUCCESS",
            terminalAt: new Date(),
            error: null,
          },
        ],
        CoordinationRunEntity: [runRow],
        CoordinationIterationEntity: [iterationRow],
        LogicalStepEntity: stepRows,
      };
      return {
        findOne: jest.fn().mockImplementation(async ({ where }: any) => {
          if (name === "CoordinationRunEntity" && where.executionId) return runRow;
          if (name === "ExecutionPlanRevisionEntity") return null;
          if (name === "ExecutionEntity") {
            return {
              id: "execution-1",
              status: "RUNNING",
              createdAt: new Date(),
              updatedAt: new Date(),
              terminationReason: null,
              input: { goal: "build the wedge" },
              activePlanRevisionId: "revision-1",
            };
          }
          return null;
        }),
        count: jest.fn().mockResolvedValue(1),
        find: jest.fn().mockResolvedValue(byName[name] ?? []),
        createQueryBuilder: () => {
          const chain: Record<string, unknown> = {
            where: () => chain,
            orderBy: () => chain,
            take: () => chain,
            getMany: async () => [],
          };
          return chain;
        },
      };
    };
    const service = new WorkbenchProjectionService(dataSource as never);
    const projection = await service.executionProjection("execution-1");

    expect(projection.coordination).not.toBeNull();
    expect(projection.coordination!.run.phase).toBe("VERIFYING");
    expect(projection.coordination!.run.remainingDeadlineMs).toBeGreaterThan(0);
    expect(projection.coordination!.iterations[0].workerManifest).toEqual([
      { taskId: "implement-1", logicalStepId: "step-row-a", required: true, status: "COMPLETED" },
      { taskId: "tests-1", logicalStepId: "step-row-b", required: false, status: "FAILED" },
    ]);
    expect(projection.coordination!.iterations[0].decisionAction).toBe("CONTINUE");
    expect(projection.coordination!.iterations[0].decisionHash).toMatch(
      /^[0-9a-f]{64}$/,
    );
    expect(projection.coordination!.truncated).toBe(false);
  });

  it("paginates execution summaries with a server timestamp", async () => {
    const dataSource = makeDataSource();
     (dataSource as any).getRepository = () => ({
      find: jest.fn().mockResolvedValue([
        {
          id: "execution-1",
          status: "RUNNING",
          createdAt: new Date(),
          updatedAt: new Date(),
          terminationReason: null,
        },
      ]),
      count: jest.fn().mockResolvedValue(0),
      findOne: jest.fn().mockResolvedValue(null),
    });
    const service = new WorkbenchProjectionService(dataSource as never);
    const summaries = await service.executionSummaries(1);

    expect(summaries.page).toBe(1);
    expect(summaries.items).toHaveLength(1);
    expect(summaries.items[0]).toMatchObject({
      id: "execution-1",
      status: "RUNNING",
      coordinationPhase: null,
      iterationNumber: null,
    });
    expect(summaries.serverTime).toBeDefined();
  });
});
