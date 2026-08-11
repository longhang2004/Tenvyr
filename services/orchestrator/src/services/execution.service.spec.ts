import { ExecutionEntity } from "../entities/execution.entity";
import { ExecutionPlanRevisionEntity } from "../entities/execution-plan-revision.entity";
import { LogicalStepEntity } from "../entities/step-execution.entity";
import { StepAttemptEntity } from "../entities/step-attempt.entity";
import { DispatchOutboxEntity } from "../entities/dispatch-outbox.entity";
import { sha256Json } from "../domain/canonical-json";
import { ExecutionService } from "./execution.service";

describe("ExecutionService attempt history", () => {
  it("creates a new immutable attempt without replacing the logical step", async () => {
    const logicalSteps: any[] = [];
    const attempts: any[] = [];
    const logicalRepository = {
      createQueryBuilder: jest.fn(() => ({
        setLock: jest.fn().mockReturnThis(),
        setOnLocked: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getOne: jest.fn(async () => logicalSteps[0] ?? null),
      })),
      findOne: jest.fn(
        async ({ where }: any) =>
          logicalSteps.find(
            (item) =>
              item.executionId === where.executionId &&
              item.stepId === where.stepId,
          ) ?? null,
      ),
      create: jest.fn((value) => ({ ...value })),
      save: jest.fn(async (value) => {
        if (!value.id) value.id = "logical-1";
        const index = logicalSteps.findIndex((item) => item.id === value.id);
        if (index === -1) logicalSteps.push(value);
        else logicalSteps[index] = value;
        return value;
      }),
    };
    const attemptRepository = {
      create: jest.fn((value) => ({ ...value })),
      save: jest.fn(async (value) => {
        value.id = `attempt-${attempts.length + 1}`;
        attempts.push({ ...value });
        return value;
      }),
    };
    const executionRepository = {
      createQueryBuilder: jest.fn(() => ({
        setLock: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue({
          id: "execution-1",
          status: "RUNNING",
          activePlanRevisionId: "plan-1",
        }),
      })),
      findOne: jest.fn().mockResolvedValue({
        id: "execution-1",
        activePlanRevisionId: "plan-1",
      }),
    };
    const outboxRepository = {
      create: jest.fn((value) => ({ ...value })),
      save: jest.fn(async (value) => value),
    };
    const manager = {
      getRepository: jest.fn((entity) => {
        if (entity === LogicalStepEntity) return logicalRepository;
        if (entity === StepAttemptEntity) return attemptRepository;
        if (entity === DispatchOutboxEntity) return outboxRepository;
        if (entity === ExecutionEntity) return executionRepository;
        throw new Error("unexpected repository");
      }),
    };
    const dataSource = { transaction: jest.fn(async (work) => work(manager)) };
    const service = new ExecutionService(
      {} as any,
      logicalRepository as any,
      attemptRepository as any,
      {} as any,
      dataSource as any,
    );
    const step = { id: "review", agent: "reviewer", retries: 1 } as const;

    await service.createStepExecution(
      "execution-1",
      "review",
      "reviewer",
      { run: 1 },
      2,
      step,
    );
    logicalSteps[0].status = "FAILED";
    await service.createStepExecution(
      "execution-1",
      "review",
      "reviewer",
      { run: 2 },
      2,
      step,
    );

    expect(logicalSteps).toHaveLength(1);
    expect(attempts.map((attempt) => attempt.attemptNumber)).toEqual([1, 2]);
    expect(attempts.map((attempt) => attempt.invocationId)).toEqual([
      "logical-1:1",
      "logical-1:2",
    ]);
    expect(attempts[0].inputSnapshot).toEqual({ run: 1 });
    expect(attempts[1].inputSnapshot).toEqual({ run: 2 });

    await expect(
      service.createStepExecution(
        "execution-1",
        "review",
        "different-agent",
        { run: 3 },
        2,
        { ...step, agent: "different-agent" },
      ),
    ).rejects.toThrow(/specification is frozen/);
    expect(attempts).toHaveLength(2);
  });

  it("claims one eligible logical step under SKIP LOCKED and commits its outbox", async () => {
    const candidate = {
      id: "logical-1",
      executionId: "execution-1",
      stepId: "review",
      agent: "reviewer",
      status: "READY",
      attempt: 0,
      maxAttempts: 1,
    } as any;
    const candidateLock = {
      setLock: jest.fn().mockReturnThis(),
      setOnLocked: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getOne: jest.fn().mockResolvedValue(candidate),
    };
    const logicalRepository = {
      createQueryBuilder: jest.fn(() => candidateLock),
      find: jest.fn().mockResolvedValue([candidate]),
      save: jest.fn().mockImplementation(async (value) => value),
    };
    const executionRepository = {
      createQueryBuilder: jest.fn(() => ({
        setLock: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue({
          id: "execution-1",
          input: { repository: "tenvyr" },
          status: "RUNNING",
          activePlanRevisionId: "revision-1",
        }),
      })),
    };
    const attemptRepository = {
      createQueryBuilder: jest.fn(() => ({
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue(null),
      })),
      create: jest.fn((value) => value),
      save: jest.fn().mockResolvedValue({
        id: "attempt-1",
        invocationId: "logical-1:1",
      }),
    };
    const revisionRepository = {
      findOne: jest.fn().mockResolvedValue({
        id: "revision-1",
        plan: {
          steps: [{ id: "review", agent: "reviewer", input: { safe: true } }],
        },
      }),
    };
    const outboxRepository = {
      create: jest.fn((value) => value),
      save: jest.fn().mockResolvedValue(undefined),
    };
    const manager = {
      getRepository: jest.fn((entity) => {
        if (entity === LogicalStepEntity) return logicalRepository;
        if (entity === ExecutionEntity) return executionRepository;
        if (entity === ExecutionPlanRevisionEntity) return revisionRepository;
        if (entity === StepAttemptEntity) return attemptRepository;
        if (entity === DispatchOutboxEntity) return outboxRepository;
        throw new Error("unexpected repository");
      }),
    };
    const dataSource = { transaction: jest.fn(async (work) => work(manager)) };
    const service = new ExecutionService(
      {} as any,
      logicalRepository as any,
      attemptRepository as any,
      revisionRepository as any,
      dataSource as any,
    );

    const claim = await service.claimRunnableStep(
      "execution-1",
      { id: "review", agent: "reviewer", input: { safe: true } },
      { safe: true },
      1,
    );

    expect(candidateLock.setOnLocked).toHaveBeenCalledWith("skip_locked");
    expect(candidateLock.setLock).toHaveBeenCalledWith("pessimistic_write");
    expect(claim).toEqual(
      expect.objectContaining({
        disposition: "claimed",
        logicalStep: candidate,
      }),
    );
    expect(candidate.status).toBe("RUNNING");
    // Claiming the first attempt makes the scheduling decision authoritative:
    // the step freezes exactly here, not at materialization.
    expect(candidate.frozenSpecHash).toEqual(expect.any(String));
    expect(candidate.frozenAt).toEqual(expect.any(Date));
    expect(attemptRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({
        attemptNumber: 1,
        invocationId: "logical-1:1",
        status: "CREATED",
      }),
    );
    expect(outboxRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({
        stepAttemptId: "attempt-1",
      }),
    );
  });

  it("materializes the Tenvyr context envelope on the attempt and in the outbox invocation atomically (M2C)", async () => {
    const candidate = {
      id: "logical-1",
      executionId: "execution-1",
      stepId: "review",
      agent: "reviewer",
      status: "READY",
      attempt: 0,
      maxAttempts: 1,
    } as any;
    const candidateLock = {
      setLock: jest.fn().mockReturnThis(),
      setOnLocked: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getOne: jest.fn().mockResolvedValue(candidate),
    };
    const logicalRepository = {
      createQueryBuilder: jest.fn(() => candidateLock),
      find: jest.fn().mockResolvedValue([candidate]),
      save: jest.fn().mockImplementation(async (value) => value),
    };
    const executionRepository = {
      createQueryBuilder: jest.fn(() => ({
        setLock: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue({
          id: "execution-1",
          input: { repository: "tenvyr" },
          status: "RUNNING",
          activePlanRevisionId: "revision-1",
          executionState: { brief: { ok: true }, "other.key": 2 },
          executionStateVersion: 3,
        }),
      })),
    };
    const attemptRepository = {
      createQueryBuilder: jest.fn(() => ({
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue(null),
      })),
      create: jest.fn((value) => value),
      save: jest.fn().mockResolvedValue({
        id: "attempt-1",
        invocationId: "logical-1:1",
      }),
    };
    const revisionRepository = {
      findOne: jest.fn().mockResolvedValue({
        id: "revision-1",
        plan: {
          steps: [
            {
              id: "review",
              agent: "reviewer",
              input: { safe: true },
              contextProjection: { stateKeys: ["other.key", "brief"] },
            },
          ],
        },
      }),
    };
    const outboxRepository = {
      create: jest.fn((value) => value),
      save: jest.fn().mockResolvedValue(undefined),
    };
    const manager = {
      getRepository: jest.fn((entity) => {
        if (entity === LogicalStepEntity) return logicalRepository;
        if (entity === ExecutionEntity) return executionRepository;
        if (entity === ExecutionPlanRevisionEntity) return revisionRepository;
        if (entity === StepAttemptEntity) return attemptRepository;
        if (entity === DispatchOutboxEntity) return outboxRepository;
        throw new Error("unexpected repository");
      }),
    };
    const dataSource = { transaction: jest.fn(async (work) => work(manager)) };
    const service = new ExecutionService(
      {} as any,
      logicalRepository as any,
      attemptRepository as any,
      revisionRepository as any,
      dataSource as any,
    );

    const claim = await service.claimRunnableStep(
      "execution-1",
      {
        id: "review",
        agent: "reviewer",
        input: { safe: true },
        contextProjection: { stateKeys: ["other.key", "brief"] },
      },
      { safe: true },
      1,
    );
    expect(claim?.disposition).toBe("claimed");

    const expectedEnvelope = {
      tenvyr: {
        schemaVersion: 1,
        executionState: {
          version: 3,
          values: { brief: { ok: true }, "other.key": 2 },
        },
        artifacts: [],
      },
    };
    // Canonical lexicographic values order, independent of selector order.
    expect(Object.keys(expectedEnvelope.tenvyr.executionState.values)).toEqual([
      "brief",
      "other.key",
    ]);
    expect(attemptRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({
        contextSnapshot: expectedEnvelope,
        status: "CREATED",
      }),
    );
    expect(outboxRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({
        invocation: expect.objectContaining({
          context: expectedEnvelope,
        }),
      }),
    );
  });

  it("freezes the gate decision when a condition evaluates false and skips the step", async () => {
    const candidate = {
      id: "logical-1",
      executionId: "execution-1",
      stepId: "review",
      agent: "reviewer",
      status: "READY",
      attempt: 0,
      maxAttempts: 1,
      frozenSpecHash: null,
      frozenAt: null,
    } as any;
    const candidateLock = {
      setLock: jest.fn().mockReturnThis(),
      setOnLocked: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getOne: jest.fn().mockResolvedValue(candidate),
    };
    const logicalRepository = {
      createQueryBuilder: jest.fn(() => candidateLock),
      find: jest.fn().mockResolvedValue([candidate]),
      save: jest.fn().mockImplementation(async (value) => value),
    };
    const executionRepository = {
      createQueryBuilder: jest.fn(() => ({
        setLock: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue({
          id: "execution-1",
          input: { run: 2 },
          status: "RUNNING",
          activePlanRevisionId: "revision-1",
        }),
      })),
    };
    const attemptRepository = {
      createQueryBuilder: jest.fn(() => ({
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue(null),
      })),
      create: jest.fn((value) => value),
      save: jest.fn(),
    };
    const revisionRepository = {
      findOne: jest.fn().mockResolvedValue({
        id: "revision-1",
        plan: {
          steps: [
            {
              id: "review",
              agent: "reviewer",
              condition: {
                op: "eq",
                left: { ref: "pipeline.input.run" },
                right: { value: 1 },
              },
            },
          ],
        },
      }),
    };
    const outboxRepository = { create: jest.fn(), save: jest.fn() };
    const manager = {
      getRepository: jest.fn((entity) => {
        if (entity === LogicalStepEntity) return logicalRepository;
        if (entity === ExecutionEntity) return executionRepository;
        if (entity === ExecutionPlanRevisionEntity) return revisionRepository;
        if (entity === StepAttemptEntity) return attemptRepository;
        if (entity === DispatchOutboxEntity) return outboxRepository;
        throw new Error("unexpected repository");
      }),
    };
    const dataSource = { transaction: jest.fn(async (work) => work(manager)) };
    const service = new ExecutionService(
      {} as any,
      logicalRepository as any,
      attemptRepository as any,
      revisionRepository as any,
      dataSource as any,
    );

    const claim = await service.claimRunnableStep(
      "execution-1",
      { id: "review", agent: "reviewer" },
      { run: 1 },
      1,
    );

    expect(claim?.disposition).toBe("skipped");
    expect(candidate.status).toBe("SKIPPED");
    // The gate decision is execution-defining and therefore frozen.
    expect(candidate.frozenSpecHash).toEqual(expect.any(String));
    expect(candidate.frozenAt).toEqual(expect.any(Date));
    expect(candidate.conditionResult).toBe(false);
    expect(attemptRepository.save).not.toHaveBeenCalled();
  });

  it("retains the original frozen specification across a retry claim", async () => {
    const frozen = sha256Json({ id: "review", agent: "reviewer" });
    const candidate = {
      id: "logical-1",
      executionId: "execution-1",
      stepId: "review",
      agent: "reviewer",
      status: "RETRYING",
      attempt: 1,
      maxAttempts: 3,
      frozenSpecHash: frozen,
      frozenAt: new Date("2026-08-10T00:00:00.000Z"),
      nextAttemptAt: new Date("2026-08-09T00:00:00.000Z"),
    } as any;
    const candidateLock = {
      setLock: jest.fn().mockReturnThis(),
      setOnLocked: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getOne: jest.fn().mockResolvedValue(candidate),
    };
    const logicalRepository = {
      createQueryBuilder: jest.fn(() => candidateLock),
      find: jest.fn().mockResolvedValue([candidate]),
      save: jest.fn().mockImplementation(async (value) => value),
    };
    const executionRepository = {
      createQueryBuilder: jest.fn(() => ({
        setLock: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue({
          id: "execution-1",
          input: {},
          status: "RUNNING",
          activePlanRevisionId: "revision-1",
        }),
      })),
    };
    const attemptRepository = {
      createQueryBuilder: jest.fn(() => ({
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue(null),
      })),
      create: jest.fn((value) => value),
      save: jest.fn().mockResolvedValue({ id: "attempt-2" }),
    };
    const revisionRepository = {
      findOne: jest.fn().mockResolvedValue({
        id: "revision-1",
        plan: { steps: [{ id: "review", agent: "reviewer" }] },
      }),
    };
    const outboxRepository = {
      create: jest.fn((value) => value),
      save: jest.fn().mockResolvedValue(undefined),
    };
    const manager = {
      getRepository: jest.fn((entity) => {
        if (entity === LogicalStepEntity) return logicalRepository;
        if (entity === ExecutionEntity) return executionRepository;
        if (entity === ExecutionPlanRevisionEntity) return revisionRepository;
        if (entity === StepAttemptEntity) return attemptRepository;
        if (entity === DispatchOutboxEntity) return outboxRepository;
        throw new Error("unexpected repository");
      }),
    };
    const dataSource = { transaction: jest.fn(async (work) => work(manager)) };
    const service = new ExecutionService(
      {} as any,
      logicalRepository as any,
      attemptRepository as any,
      revisionRepository as any,
      dataSource as any,
    );

    const claim = await service.claimRunnableStep(
      "execution-1",
      { id: "review", agent: "reviewer" },
      { run: 2 },
      3,
    );

    expect(claim?.disposition).toBe("claimed");
    expect(candidate.attempt).toBe(2);
    // The retry keeps the execution-defining spec that the first claim froze.
    expect(candidate.frozenSpecHash).toBe(frozen);
    expect(candidate.frozenAt?.toISOString()).toBe("2026-08-10T00:00:00.000Z");
    expect(attemptRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({
        attemptNumber: 2,
        invocationId: "logical-1:2",
      }),
    );
  });

  it("rejects a claim whose active revision differs from the frozen specification", async () => {
    const frozen = sha256Json({ id: "review", agent: "reviewer" });
    const candidate = {
      id: "logical-1",
      executionId: "execution-1",
      stepId: "review",
      agent: "reviewer",
      status: "READY",
      attempt: 0,
      maxAttempts: 1,
      frozenSpecHash: frozen,
      frozenAt: new Date(),
    } as any;
    const candidateLock = {
      setLock: jest.fn().mockReturnThis(),
      setOnLocked: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getOne: jest.fn().mockResolvedValue(candidate),
    };
    const logicalRepository = {
      createQueryBuilder: jest.fn(() => candidateLock),
      find: jest.fn().mockResolvedValue([candidate]),
      save: jest.fn().mockImplementation(async (value) => value),
    };
    const executionRepository = {
      createQueryBuilder: jest.fn(() => ({
        setLock: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue({
          id: "execution-1",
          input: {},
          status: "RUNNING",
          activePlanRevisionId: "revision-1",
        }),
      })),
    };
    const attemptRepository = {
      createQueryBuilder: jest.fn(() => ({
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue(null),
      })),
      create: jest.fn((value) => value),
      save: jest.fn(),
    };
    const revisionRepository = {
      findOne: jest.fn().mockResolvedValue({
        id: "revision-1",
        // A future PlanPatch-style revision changed the step's executor.
        plan: { steps: [{ id: "review", agent: "different-agent" }] },
      }),
    };
    const outboxRepository = { create: jest.fn(), save: jest.fn() };
    const manager = {
      getRepository: jest.fn((entity) => {
        if (entity === LogicalStepEntity) return logicalRepository;
        if (entity === ExecutionEntity) return executionRepository;
        if (entity === ExecutionPlanRevisionEntity) return revisionRepository;
        if (entity === StepAttemptEntity) return attemptRepository;
        if (entity === DispatchOutboxEntity) return outboxRepository;
        throw new Error("unexpected repository");
      }),
    };
    const dataSource = { transaction: jest.fn(async (work) => work(manager)) };
    const service = new ExecutionService(
      {} as any,
      logicalRepository as any,
      attemptRepository as any,
      revisionRepository as any,
      dataSource as any,
    );

    await expect(
      service.claimRunnableStep(
        "execution-1",
        { id: "review", agent: "different-agent" },
        {},
        1,
      ),
    ).rejects.toThrow(/execution specification is frozen/);
    expect(attemptRepository.save).not.toHaveBeenCalled();
    expect(outboxRepository.save).not.toHaveBeenCalled();
  });
});

describe("ExecutionService cancellation and state machine", () => {
  const cancelHarness = (execution: any, steps: any[], attempts: any[]) => {
    const attemptRepository = {
      createQueryBuilder: jest.fn(() => ({
        setLock: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue(attempts),
      })),
      save: jest.fn(),
    };
    const logicalRepository = {
      createQueryBuilder: jest.fn(() => ({
        setLock: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue(steps),
      })),
      save: jest.fn(),
    };
    const executionRepository = {
      createQueryBuilder: jest.fn(() => ({
        setLock: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue(execution),
      })),
      save: jest.fn(async (value: any) => value),
    };
    const outboxRepository = {
      createQueryBuilder: jest.fn(() => ({
        update: jest.fn().mockReturnThis(),
        set: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        execute: jest.fn().mockResolvedValue({ affected: 1 }),
      })),
    };
    const manager = {
      getRepository: jest.fn((entity) => {
        if (entity === StepAttemptEntity) return attemptRepository;
        if (entity === LogicalStepEntity) return logicalRepository;
        if (entity === ExecutionEntity) return executionRepository;
        if (entity === DispatchOutboxEntity) return outboxRepository;
        throw new Error("unexpected repository");
      }),
    };
    const dataSource = { transaction: jest.fn(async (work) => work(manager)) };
    const service = new ExecutionService(
      {} as any,
      logicalRepository as any,
      attemptRepository as any,
      {} as any,
      dataSource as any,
    );
    return {
      service,
      attemptRepository,
      logicalRepository,
      executionRepository,
    };
  };

  it("makes repeated cancellation idempotent", async () => {
    const execution: any = {
      id: "execution-1",
      status: "RUNNING",
      endTime: null,
      terminationReason: null,
    };
    const attempts: any[] = [
      {
        id: "attempt-1",
        executionId: "execution-1",
        status: "DISPATCHED",
        result: "pending",
        error: null,
        terminalAt: null,
        terminationReason: null,
      },
    ];
    const steps: any[] = [
      {
        id: "logical-1",
        executionId: "execution-1",
        stepId: "review",
        status: "RUNNING",
        error: null,
        endTime: null,
        nextAttemptAt: null,
        eligibleAt: null,
      },
    ];
    const {
      service,
      attemptRepository,
      logicalRepository,
      executionRepository,
    } = cancelHarness(execution, steps, attempts);

    const first = await service.cancelExecution("execution-1");
    expect(first.status).toBe("CANCELLED");
    expect(execution.status).toBe("CANCELLED");
    expect(attempts[0].status).toBe("CANCELLED");
    expect(steps[0].status).toBe("CANCELLED");

    const savesAfterFirst = {
      attempts: (attemptRepository.save as jest.Mock).mock.calls.length,
      steps: (logicalRepository.save as jest.Mock).mock.calls.length,
      executions: (executionRepository.save as jest.Mock).mock.calls.length,
    };
    expect(savesAfterFirst.attempts).toBeGreaterThan(0);

    const second = await service.cancelExecution("execution-1");
    expect(second.status).toBe("CANCELLED");
    expect((attemptRepository.save as jest.Mock).mock.calls.length).toBe(
      savesAfterFirst.attempts,
    );
    expect((logicalRepository.save as jest.Mock).mock.calls.length).toBe(
      savesAfterFirst.steps,
    );
    expect((executionRepository.save as jest.Mock).mock.calls.length).toBe(
      savesAfterFirst.executions,
    );
  });

  it("reserves WAITING for an external authority: no autonomous claim, cancellation can still end it", async () => {
    const waitingExecution: any = {
      id: "execution-1",
      status: "WAITING",
      input: {},
    };
    const candidate: any = {
      id: "logical-1",
      executionId: "execution-1",
      stepId: "review",
      agent: "reviewer",
      status: "READY",
      attempt: 0,
      maxAttempts: 1,
    };
    const candidateLock = {
      setLock: jest.fn().mockReturnThis(),
      setOnLocked: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getOne: jest.fn().mockResolvedValue(candidate),
    };
    const logicalRepository = {
      createQueryBuilder: jest.fn(),
      find: jest.fn(),
      save: jest.fn(),
    };
    logicalRepository.createQueryBuilder.mockReturnValueOnce(candidateLock);
    const executionRepository = {
      createQueryBuilder: jest.fn(() => ({
        setLock: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue(waitingExecution),
      })),
    };
    const manager = {
      getRepository: jest.fn((entity) => {
        if (entity === LogicalStepEntity) return logicalRepository;
        if (entity === ExecutionEntity) return executionRepository;
        if (entity === StepAttemptEntity || entity === DispatchOutboxEntity)
          return { createQueryBuilder: jest.fn() };
        throw new Error("unexpected repository");
      }),
    };
    const dataSource = { transaction: jest.fn(async (work) => work(manager)) };
    const service = new ExecutionService(
      {} as any,
      logicalRepository as any,
      {} as any,
      {} as any,
      dataSource as any,
    );

    const claim = await service.claimRunnableStep(
      "execution-1",
      { id: "review", agent: "reviewer" },
      { run: 1 },
      1,
    );
    expect(claim).toBeNull();
    expect(candidate.status).toBe("READY");

    const waitingSteps: any[] = [
      {
        id: "logical-1",
        executionId: "execution-1",
        stepId: "review",
        status: "WAITING",
      },
    ];
    const cancel = cancelHarness(waitingExecution, waitingSteps, []);
    const cancelled = await cancel.service.cancelExecution("execution-1");
    expect(cancelled.status).toBe("CANCELLED");
    expect(waitingSteps[0].status).toBe("CANCELLED");
  });
});

describe("ExecutionService materialization and reconciliation", () => {
  it("materializes every plan step row inside the execution-creation transaction", async () => {
    const savedSteps: any[] = [];
    const stepRepository = {
      create: jest.fn((value) => ({ ...value })),
      save: jest.fn(async (value) => {
        value.id = `logical-${savedSteps.length + 1}`;
        savedSteps.push(value);
        return value;
      }),
    };
    const executionRepository = {
      create: jest.fn((value) => ({ ...value })),
      save: jest.fn(async (value) => {
        if (!value.id) value.id = "execution-1";
        return value;
      }),
    };
    const planRepository = {
      create: jest.fn((value) => ({ ...value })),
      save: jest.fn(async (value) => {
        value.id = "revision-1";
        return value;
      }),
    };
    const manager = {
      getRepository: jest.fn((entity) => {
        if (entity === ExecutionEntity) return executionRepository;
        if (entity === ExecutionPlanRevisionEntity) return planRepository;
        if (entity === LogicalStepEntity) return stepRepository;
        throw new Error("unexpected repository");
      }),
    };
    const dataSource = { transaction: jest.fn(async (work) => work(manager)) };
    const service = new ExecutionService(
      {} as any,
      stepRepository as any,
      {} as any,
      planRepository as any,
      dataSource as any,
    );

    await service.createExecution(
      {
        id: "pipeline-1",
        name: "p",
        version: "1.0",
        steps: [
          { id: "a", agent: "alpha" },
          { id: "b", agent: "beta", dependsOn: ["a"] },
        ],
      } as any,
      { run: 1 },
    );

    expect(savedSteps.map((step) => step.stepId)).toEqual(["a", "b"]);
    for (const step of savedSteps) {
      expect(step).toEqual(
        expect.objectContaining({
          executionId: "execution-1",
          status: "PENDING",
          attempt: 0,
          // Materialization is not consumption: a step is frozen only when
          // its scheduling/gate decision becomes authoritative.
          frozenSpecHash: null,
          frozenAt: null,
        }),
      );
    }
  });

  it("reconcileExecution promotes a stuck PENDING execution and advances eligible steps", async () => {
    const execution: any = {
      id: "execution-1",
      status: "PENDING",
      activePlanRevisionId: "revision-1",
    };
    const steps: any[] = [
      {
        id: "logical-1",
        executionId: "execution-1",
        stepId: "a",
        status: "PENDING",
      },
      {
        id: "logical-2",
        executionId: "execution-1",
        stepId: "b",
        status: "PENDING",
      },
    ];
    const executionQuery = {
      setLock: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getOne: jest.fn().mockResolvedValue(execution),
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      execute: jest.fn().mockImplementation(async () => {
        // Mirror the committed UPDATE so the step-advancement transaction
        // observes the execution as RUNNING.
        execution.status = "RUNNING";
        return { affected: 1 };
      }),
    };
    const executionRepository = {
      createQueryBuilder: jest.fn(() => executionQuery),
      findOne: jest.fn().mockResolvedValue(execution),
    };
    const stepRepository = {
      findOne: jest.fn(
        async ({ where }: any) =>
          steps.find((step) => step.stepId === where.stepId) ?? null,
      ),
      create: jest.fn((value) => ({ ...value })),
      save: jest.fn(async (value) => value),
      find: jest.fn().mockResolvedValue(steps),
      createQueryBuilder: jest.fn(() => ({
        setLock: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue(steps[0]),
      })),
    };
    const revisionRepository = {
      findOne: jest.fn().mockResolvedValue({
        id: "revision-1",
        plan: {
          steps: [
            { id: "a", agent: "alpha" },
            { id: "b", agent: "beta", dependsOn: ["a"] },
          ],
        },
      }),
    };
    const attemptRepository = {
      createQueryBuilder: jest.fn(() => ({
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue(null),
      })),
    };
    const manager = {
      getRepository: jest.fn((entity) => {
        if (entity === ExecutionEntity) return executionRepository;
        if (entity === ExecutionPlanRevisionEntity) return revisionRepository;
        if (entity === LogicalStepEntity) return stepRepository;
        if (entity === StepAttemptEntity) return attemptRepository;
        throw new Error("unexpected repository");
      }),
    };
    const dataSource = { transaction: jest.fn(async (work) => work(manager)) };
    const service = new ExecutionService(
      {} as any,
      stepRepository as any,
      attemptRepository as any,
      revisionRepository as any,
      dataSource as any,
    );

    const result = await service.reconcileExecution("execution-1");

    expect(result.promoted).toBe(true);
    expect(result.advanced).toBe(1);
    // Step "a" has no dependencies and becomes READY; step "b" depends on "a"
    // and stays PENDING.
    expect(steps[0].status).toBe("READY");
    expect(steps[1].status).toBe("PENDING");
  });

  it("reconcileExecution backfills missing rows and leaves terminal executions untouched", async () => {
    const terminal: any = {
      id: "execution-1",
      status: "CANCELLED",
      activePlanRevisionId: "revision-1",
    };
    const executionRepository = {
      createQueryBuilder: jest.fn(() => ({
        setLock: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue(terminal),
      })),
      findOne: jest.fn().mockResolvedValue(terminal),
      update: jest.fn(),
    };
    const manager = {
      getRepository: jest.fn((entity) => {
        if (entity === ExecutionEntity) return executionRepository;
        throw new Error("unexpected repository");
      }),
    };
    const dataSource = { transaction: jest.fn(async (work) => work(manager)) };
    const service = new ExecutionService(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      dataSource as any,
    );

    const result = await service.reconcileExecution("execution-1");

    expect(result).toEqual({ promoted: false, backfilled: 0, advanced: 0 });
    expect(executionRepository.update).not.toHaveBeenCalled();
  });
});
