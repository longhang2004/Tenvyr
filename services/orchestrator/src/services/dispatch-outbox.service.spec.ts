import { AgentAdapterError } from "../agent-adapters/agent-adapter.errors";
import { DispatchOutboxEntity } from "../entities/dispatch-outbox.entity";
import { ExecutionEntity } from "../entities/execution.entity";
import { ExecutionPlanRevisionEntity } from "../entities/execution-plan-revision.entity";
import { LogicalStepEntity } from "../entities/step-execution.entity";
import { StepAttemptEntity } from "../entities/step-attempt.entity";
import { DispatchOutboxService } from "./dispatch-outbox.service";

const chain = (one?: unknown, affected = 1) => {
  const value: any = {};
  for (const method of ["update", "set", "where", "andWhere", "setLock"]) {
    value[method] = jest.fn(() => value);
  }
  value.getOne = jest.fn().mockResolvedValue(one);
  value.execute = jest.fn().mockResolvedValue({ affected });
  return value;
};

const claimed = {
  id: "outbox-1",
  stepAttemptId: "attempt-1",
  leaseToken: "lease-1",
  invocation: {
    schemaVersion: "1",
    invocationId: "logical-1:1",
    executionId: "execution-1",
    stepExecutionId: "logical-1",
    stepId: "review",
    target: { agent: "reviewer" },
    input: {},
    attempt: 1,
    createdAt: "2026-08-10T00:00:00.000Z",
    trace: { traceId: "execution-1", correlationId: "logical-1:1" },
  },
} as any;

/**
 * Builds a dispatchNext harness whose failNonRetryable transaction serves the
 * given repositories. `overrides.onFailure` picks the pipeline failure policy
 * and `overrides.attempt`/`overrides.maxAttempts` shape the retry decision.
 */
const nonRetryableHarness = (
  overrides: {
    onFailure?: string;
    attemptNumber?: number;
    maxAttempts?: number;
    logicalStatus?: string;
    outboxAffected?: number;
  } = {},
) => {
  const attemptSelect = chain({
    id: "attempt-1",
    executionId: "execution-1",
    logicalStepId: "logical-1",
    planRevisionId: "revision-1",
    attemptNumber: overrides.attemptNumber ?? 1,
    status: "CREATED",
  });
  const attemptTransition = chain(undefined, 1);
  const logicalSelect = chain({
    id: "logical-1",
    stepId: "review",
    status: overrides.logicalStatus ?? "RUNNING",
    attempt: overrides.attemptNumber ?? 1,
    maxAttempts: overrides.maxAttempts ?? 3,
    error: null,
    endTime: null,
    nextAttemptAt: null,
  });
  const executionSelect = chain({ id: "execution-1", status: "RUNNING" });
  const outboxTransition = chain(undefined, overrides.outboxAffected ?? 1);
  const logicalSave = jest.fn(async (value: any) => value);
  const executionSave = jest.fn(async (value: any) => value);
  const manager = {
    getRepository: jest.fn((entity) => {
      if (entity === StepAttemptEntity)
        return {
          createQueryBuilder: jest
            .fn()
            .mockReturnValueOnce(attemptSelect)
            .mockReturnValueOnce(attemptTransition),
        };
      if (entity === LogicalStepEntity)
        return {
          createQueryBuilder: jest.fn(() => logicalSelect),
          save: logicalSave,
        };
      if (entity === ExecutionPlanRevisionEntity)
        return {
          findOne: jest.fn().mockResolvedValue({
            id: "revision-1",
            plan: {
              steps: [
                { id: "review", onFailure: overrides.onFailure ?? "stop" },
              ],
            },
          }),
        };
      if (entity === ExecutionEntity)
        return {
          createQueryBuilder: jest.fn(() => executionSelect),
          save: executionSave,
        };
      if (entity === DispatchOutboxEntity)
        return { createQueryBuilder: jest.fn(() => outboxTransition) };
      throw new Error("unexpected repository");
    }),
  };
  const dataSource = {
    transaction: jest.fn((work: any) => work(manager)),
    getRepository: jest.fn(),
  };
  const adapter = {
    invoke: jest.fn().mockRejectedValue(
      new AgentAdapterError(
        "HTTP_REJECTED",
        "http",
        "agent rejected the invocation",
        { invocationId: "logical-1:1", retryable: false, httpStatus: 400 },
      ),
    ),
  };
  const service = new DispatchOutboxService(dataSource as any, adapter as any);
  (service as any).claimNext = jest.fn().mockResolvedValue(claimed);
  return { service, attemptTransition, outboxTransition, logicalSave, executionSave };
};

describe("DispatchOutboxService", () => {
  it("does not let a stale receipt mutate an attempt after its lease changed", async () => {
    const attemptSelect = chain({ id: "attempt-1", status: "CREATED" });
    const receiptUpdate = chain(undefined, 0);
    const attemptRepository = {
      createQueryBuilder: jest.fn(() => attemptSelect),
      save: jest.fn(),
    };
    const outboxRepository = {
      createQueryBuilder: jest.fn(() => receiptUpdate),
    };
    const manager = {
      getRepository: jest.fn((entity) =>
        entity === StepAttemptEntity ? attemptRepository : outboxRepository,
      ),
    };
    const service = new DispatchOutboxService(
      { transaction: jest.fn((work) => work(manager)) } as any,
      {} as any,
    );

    await (service as any).markDispatched(claimed, { adapter: "kafka" });

    expect(receiptUpdate.andWhere).toHaveBeenCalledWith(
      '"leaseToken" = :leaseToken',
      { leaseToken: "lease-1" },
    );
    expect(attemptRepository.save).not.toHaveBeenCalled();
  });

  it("uses the claimed lease token when a delivery error returns work to pending", async () => {
    const reset = chain();
    const dataSource = {
      getRepository: jest.fn(() => ({ createQueryBuilder: jest.fn(() => reset) })),
    };
    const adapter = { invoke: jest.fn().mockRejectedValue(new Error("broker unavailable")) };
    const service = new DispatchOutboxService(dataSource as any, adapter as any);
    (service as any).claimNext = jest.fn().mockResolvedValue(claimed);

    await expect(service.dispatchNext()).rejects.toThrow("broker unavailable");

    expect(reset.andWhere).toHaveBeenCalledWith(
      '"leaseToken" = :leaseToken',
      { leaseToken: "lease-1" },
    );
  });

  it("reports a committed terminal failure with the affected execution for stop policy", async () => {
    const {
      service,
      outboxTransition,
      attemptTransition,
      logicalSave,
      executionSave,
    } = nonRetryableHarness({ onFailure: "stop", maxAttempts: 3 });

    const disposition = await service.dispatchNext();

    expect(disposition).toEqual({
      outcome: "terminal_failure",
      executionId: "execution-1",
    });
    // The outbox record is terminal FAILED, the attempt is FAILED, and the
    // execution follows the stop policy — nothing is scheduled for retry.
    expect(outboxTransition.set).toHaveBeenCalledWith(
      expect.objectContaining({ status: "FAILED", leaseToken: null }),
    );
    expect(attemptTransition.set).toHaveBeenCalledWith(
      expect.objectContaining({ status: "FAILED" }),
    );
    expect(logicalSave).toHaveBeenCalledWith(
      expect.objectContaining({ status: "FAILED", nextAttemptAt: null }),
    );
    expect(executionSave).toHaveBeenCalledWith(
      expect.objectContaining({ status: "FAILED" }),
    );
  });

  it("applies the continue policy: step FAILED, execution keeps running", async () => {
    const { service, logicalSave, executionSave } = nonRetryableHarness({
      onFailure: "continue",
    });

    const disposition = await service.dispatchNext();

    expect(disposition).toEqual({
      outcome: "terminal_failure",
      executionId: "execution-1",
    });
    expect(logicalSave).toHaveBeenCalledWith(
      expect.objectContaining({ status: "FAILED" }),
    );
    expect(executionSave).not.toHaveBeenCalled();
  });

  it("applies the retry policy with attempts remaining: step RETRYING with a persisted nextAttemptAt, execution untouched", async () => {
    const { service, logicalSave, executionSave } = nonRetryableHarness({
      onFailure: "retry",
      attemptNumber: 1,
      maxAttempts: 3,
    });

    const disposition = await service.dispatchNext();

    expect(disposition).toEqual({
      outcome: "terminal_failure",
      executionId: "execution-1",
    });
    // A non-retryable transport rejection ends THIS invocation, but the
    // workflow retry policy schedules a NEW attempt with a new invocationId.
    expect(logicalSave).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "RETRYING",
        nextAttemptAt: expect.any(Date),
        endTime: null,
      }),
    );
    expect(executionSave).not.toHaveBeenCalled();
  });

  it("applies the retry policy with attempts exhausted: step FAILED and execution FAILED", async () => {
    const { service, logicalSave, executionSave } = nonRetryableHarness({
      onFailure: "retry",
      attemptNumber: 3,
      maxAttempts: 3,
    });

    await service.dispatchNext();

    expect(logicalSave).toHaveBeenCalledWith(
      expect.objectContaining({ status: "FAILED", nextAttemptAt: null }),
    );
    expect(executionSave).toHaveBeenCalledWith(
      expect.objectContaining({ status: "FAILED" }),
    );
  });

  it("does not fail an attempt when a stale worker reports non-retryable after the lease changed", async () => {
    const attemptSelect = chain({ id: "attempt-1", status: "DISPATCHED" });
    const attemptTransition = chain(undefined, 1);
    const outboxTransition = chain(undefined, 0); // lease guard rejects: a newer claim owns the record
    const manager = {
      getRepository: jest.fn((entity) => {
        if (entity === StepAttemptEntity)
          return {
            createQueryBuilder: jest
              .fn()
              .mockReturnValueOnce(attemptSelect)
              .mockReturnValueOnce(attemptTransition),
          };
        if (entity === DispatchOutboxEntity)
          return { createQueryBuilder: jest.fn(() => outboxTransition) };
        if (entity === LogicalStepEntity || entity === ExecutionEntity)
          throw new Error("must not be reached");
        throw new Error("unexpected repository");
      }),
    };
    const dataSource = {
      transaction: jest.fn((work: any) => work(manager)),
    };
    const adapter = {
      invoke: jest.fn().mockRejectedValue(
        new AgentAdapterError(
          "HTTP_REJECTED",
          "http",
          "stale 400",
          { invocationId: "logical-1:1", retryable: false, httpStatus: 400 },
        ),
      ),
    };
    const service = new DispatchOutboxService(dataSource as any, adapter as any);
    (service as any).claimNext = jest.fn().mockResolvedValue(claimed);

    const disposition = await service.dispatchNext();

    // The lease guard bailed before any attempt/step/execution mutation; the
    // caller still reconciles the execution, which is a harmless no-op.
    expect(disposition).toEqual({
      outcome: "terminal_failure",
      executionId: "execution-1",
    });
    expect(attemptTransition.execute).not.toHaveBeenCalled();
  });

  it("reports dispatched and idle outcomes and collects terminal failures in recover()", async () => {
    const service = new DispatchOutboxService({} as any, {} as any);
    const claimedRows = [
      { id: "outbox-1" },
      { id: "outbox-2" },
      null,
    ];
    const dispositions = [
      { outcome: "dispatched" },
      { outcome: "terminal_failure", executionId: "execution-1" },
    ];
    (service as any).claimNext = jest
      .fn()
      .mockResolvedValueOnce(claimedRows[0])
      .mockResolvedValueOnce(claimedRows[1])
      .mockResolvedValueOnce(claimedRows[2]);
    (service as any).dispatchClaimed = jest
      .fn()
      .mockResolvedValueOnce(dispositions[0])
      .mockResolvedValueOnce(dispositions[1]);

    await expect(service.recover()).resolves.toEqual({
      dispatched: 1,
      terminalFailures: ["execution-1"],
      retryableFailures: 0,
    });
  });

  it("isolates one retryable delivery failure so later records still dispatch", async () => {
    const service = new DispatchOutboxService({} as any, {} as any);
    (service as any).claimNext = jest
      .fn()
      .mockResolvedValueOnce({ id: "outbox-poison" })
      .mockResolvedValueOnce({ id: "outbox-healthy" })
      .mockResolvedValueOnce(null);
    (service as any).dispatchClaimed = jest
      .fn()
      .mockRejectedValueOnce(new Error("producer unavailable"))
      .mockResolvedValueOnce({ outcome: "dispatched" });

    const summary = await service.recover();

    // A: retryable failure counted but the drain continued; B dispatched.
    expect(summary).toEqual({
      dispatched: 1,
      terminalFailures: [],
      retryableFailures: 1,
    });
    expect((service as any).dispatchClaimed).toHaveBeenCalledTimes(2);
  });

  it("aborts the drain on a claim-phase (database) failure so outages surface", async () => {
    const service = new DispatchOutboxService({} as any, {} as any);
    (service as any).claimNext = jest
      .fn()
      .mockRejectedValueOnce(new Error("database outage"));
    (service as any).dispatchClaimed = jest.fn();

    await expect(service.recover()).rejects.toThrow("database outage");
    expect((service as any).dispatchClaimed).not.toHaveBeenCalled();
  });

  it("dispatchAttempt leases only the outbox row of the given attempt", async () => {
    const builder: any = {};
    for (const method of ["innerJoin", "where", "andWhere", "setLock", "setOnLocked"]) {
      builder[method] = jest.fn(() => builder);
    }
    builder.getOne = jest.fn().mockResolvedValue({ id: "outbox-1" });
    const save = jest.fn(async (value: any) => value);
    const manager = {
      getRepository: jest.fn((entity) => {
        if (entity === DispatchOutboxEntity)
          return { createQueryBuilder: jest.fn(() => builder), save };
        if (entity === StepAttemptEntity)
          return { createQueryBuilder: jest.fn(() => chain()) };
        throw new Error("unexpected repository");
      }),
    };
    const dataSource = {
      transaction: jest.fn((work: any) => work(manager)),
    };
    const service = new DispatchOutboxService(dataSource as any, {} as any);
    (service as any).dispatchClaimed = jest
      .fn()
      .mockResolvedValue({ outcome: "dispatched" });

    const disposition = await service.dispatchAttempt("attempt-42");

    expect(disposition).toEqual({ outcome: "dispatched" });
    expect(builder.where).toHaveBeenCalledWith(
      'outbox."stepAttemptId" = :stepAttemptId',
      { stepAttemptId: "attempt-42" },
    );
    // The lease eligibility predicate and terminal filters still apply.
    expect(builder.andWhere).toHaveBeenCalledWith(
      expect.stringContaining('outbox."status" = :pending'),
      expect.anything(),
    );
    expect((service as any).dispatchClaimed).toHaveBeenCalledWith(
      expect.objectContaining({ id: "outbox-1" }),
    );
  });

  it("dispatchAttempt reports idle when the attempt's row is not eligible", async () => {
    const service = new DispatchOutboxService({} as any, {} as any);
    (service as any).claimAttempt = jest.fn().mockResolvedValue(null);
    (service as any).dispatchClaimed = jest.fn();

    await expect(service.dispatchAttempt("attempt-1")).resolves.toEqual({
      outcome: "idle",
    });
    expect((service as any).dispatchClaimed).not.toHaveBeenCalled();
  });
});
