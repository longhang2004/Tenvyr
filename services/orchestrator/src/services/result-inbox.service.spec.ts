import type { AgentResultV1 } from "@tenvyr/contracts";
import { sha256Json } from "../domain/canonical-json";
import { ArtifactEntity } from "../entities/artifact.entity";
import { DispatchOutboxEntity } from "../entities/dispatch-outbox.entity";
import { ExecutionEntity } from "../entities/execution.entity";
import { ExecutionPlanRevisionEntity } from "../entities/execution-plan-revision.entity";
import { ResultConflictEntity } from "../entities/result-conflict.entity";
import { ResultInboxEntity } from "../entities/result-inbox.entity";
import { LogicalStepEntity } from "../entities/step-execution.entity";
import { StepAttemptEntity } from "../entities/step-attempt.entity";
import { ResultInboxService } from "./result-inbox.service";

const result: AgentResultV1 = {
  schemaVersion: "1",
  invocationId: "logical-1:1",
  executionId: "execution-1",
  stepExecutionId: "logical-1",
  status: "succeeded",
  output: { value: 1 },
  completedAt: "2026-08-10T00:00:00.000Z",
};

const chain = (one?: unknown, affected = 1) => {
  const value: any = {};
  for (const method of [
    "setLock",
    "where",
    "andWhere",
    "insert",
    "into",
    "values",
    "orIgnore",
    "update",
    "set",
  ]) {
    value[method] = jest.fn(() => value);
  }
  value.getOne = jest.fn().mockResolvedValue(one);
  value.getOneOrFail = jest.fn().mockResolvedValue(one);
  value.execute = jest.fn().mockResolvedValue({ affected });
  return value;
};

describe("ResultInboxService", () => {
  const attempt = {
    id: "attempt-1",
    invocationId: result.invocationId,
    executionId: result.executionId,
    logicalStepId: result.stepExecutionId,
    planRevisionId: "revision-1",
    attemptNumber: 1,
    status: "DISPATCHED",
  };
  const logical = {
    id: "logical-1",
    stepId: "review",
    maxAttempts: 1,
  };

  it("makes an identical applied delivery a no-op", async () => {
    const attemptSelect = chain(attempt);
    const inboxInsert = chain();
    const inboxSelect = chain({
      id: "inbox-1",
      payloadHash: sha256Json(result),
      status: "APPLIED",
    });
    const logicalSelect = chain(logical);
    const manager = {
      getRepository: jest.fn((entity) => {
        if (entity === StepAttemptEntity)
          return { createQueryBuilder: jest.fn(() => attemptSelect) };
        if (entity === ResultInboxEntity)
          return {
            createQueryBuilder: jest
              .fn()
              .mockReturnValueOnce(inboxInsert)
              .mockReturnValueOnce(inboxSelect),
          };
        if (entity === LogicalStepEntity)
          return { createQueryBuilder: jest.fn(() => logicalSelect) };
        throw new Error("unexpected repository");
      }),
    };
    const service = new ResultInboxService({
      transaction: jest.fn((work) => work(manager)),
    } as any);

    await expect(
      service.apply(result, { adapter: "kafka", receivedAt: "now" }),
    ).resolves.toEqual({
      disposition: "duplicate",
      executionId: "execution-1",
      stepId: "review",
    });
  });

  it("records a conflicting payload without changing the canonical inbox row", async () => {
    const attemptSelect = chain(attempt);
    const inboxInsert = chain();
    const inboxSelect = chain({
      id: "inbox-1",
      payloadHash: "a".repeat(64),
      status: "APPLIED",
    });
    const conflictInsert = chain();
    const manager = {
      getRepository: jest.fn((entity) => {
        if (entity === StepAttemptEntity)
          return { createQueryBuilder: jest.fn(() => attemptSelect) };
        if (entity === ResultInboxEntity)
          return {
            createQueryBuilder: jest
              .fn()
              .mockReturnValueOnce(inboxInsert)
              .mockReturnValueOnce(inboxSelect),
          };
        if (entity === ResultConflictEntity)
          return { createQueryBuilder: jest.fn(() => conflictInsert) };
        throw new Error("unexpected repository");
      }),
    };
    const service = new ResultInboxService({
      transaction: jest.fn((work) => work(manager)),
    } as any);

    await expect(
      service.apply(result, { adapter: "kafka", receivedAt: "now" }),
    ).resolves.toEqual({ disposition: "conflict" });
    expect(conflictInsert.values).toHaveBeenCalledWith(
      expect.objectContaining({ invocationId: result.invocationId }),
    );
  });

  it("records a reused transport receipt as conflict evidence", async () => {
    const alternate = {
      ...result,
      invocationId: "logical-2:1",
      stepExecutionId: "logical-2",
    };
    const attemptSelect = chain({
      ...attempt,
      invocationId: alternate.invocationId,
      logicalStepId: alternate.stepExecutionId,
    });
    const inboxInsert = chain();
    const invocationLookup = chain(undefined);
    const transportLookup = chain({ id: "inbox-existing" });
    const conflictInsert = chain();
    const manager = {
      getRepository: jest.fn((entity) => {
        if (entity === StepAttemptEntity)
          return { createQueryBuilder: jest.fn(() => attemptSelect) };
        if (entity === ResultInboxEntity)
          return {
            createQueryBuilder: jest
              .fn()
              .mockReturnValueOnce(inboxInsert)
              .mockReturnValueOnce(invocationLookup)
              .mockReturnValueOnce(transportLookup),
          };
        if (entity === ResultConflictEntity)
          return { createQueryBuilder: jest.fn(() => conflictInsert) };
        throw new Error("unexpected repository");
      }),
    };
    const service = new ResultInboxService({
      transaction: jest.fn((work) => work(manager)),
    } as any);

    await expect(
      service.apply(alternate, {
        adapter: "kafka",
        receivedAt: "now",
        topic: "agent.result",
        partition: 1,
        offset: "42",
      }),
    ).resolves.toEqual({ disposition: "conflict" });
    expect(conflictInsert.values).toHaveBeenCalledWith(
      expect.objectContaining({ resultInboxId: "inbox-existing" }),
    );
  });

  it("retires the durable outbox in the terminal-result transaction", async () => {
    const attemptSelect = chain(attempt);
    const attemptTransition = chain(undefined, 1);
    const inboxInsert = chain();
    const inboxSelect = chain({
      id: "inbox-1",
      payloadHash: sha256Json(result),
      status: "RECEIVED",
    });
    const logicalSelect = chain({ ...logical });
    const outboxTransition = chain(undefined, 1);
    const executionSelect = chain({
      id: result.executionId,
      status: "RUNNING",
    });
    const inboxRepository = {
      createQueryBuilder: jest
        .fn()
        .mockReturnValueOnce(inboxInsert)
        .mockReturnValueOnce(inboxSelect),
      save: jest.fn(),
    };
    const logicalRepository = {
      createQueryBuilder: jest.fn(() => logicalSelect),
      save: jest.fn(),
    };
    const manager = {
      getRepository: jest.fn((entity) => {
        if (entity === StepAttemptEntity)
          return {
            createQueryBuilder: jest
              .fn()
              .mockReturnValueOnce(attemptSelect)
              .mockReturnValueOnce(attemptTransition),
          };
        if (entity === ResultInboxEntity) return inboxRepository;
        if (entity === LogicalStepEntity) return logicalRepository;
        if (entity === DispatchOutboxEntity)
          return { createQueryBuilder: jest.fn(() => outboxTransition) };
        if (entity === ExecutionPlanRevisionEntity)
          return {
            findOne: jest.fn().mockResolvedValue({
              id: "revision-1",
              plan: { steps: [{ id: "review", onFailure: "stop" }] },
            }),
          };
        if (entity === ExecutionEntity)
          return {
            createQueryBuilder: jest.fn(() => executionSelect),
            save: jest.fn(),
          };
        throw new Error("unexpected repository");
      }),
    };
    const service = new ResultInboxService({
      transaction: jest.fn((work) => work(manager)),
    } as any);

    await expect(
      service.apply(result, { adapter: "kafka", receivedAt: "now" }),
    ).resolves.toEqual({
      disposition: "applied",
      executionId: "execution-1",
      stepId: "review",
    });
    expect(outboxTransition.set).toHaveBeenCalledWith(
      expect.objectContaining({ status: "COMPLETED", leaseToken: null }),
    );
  });

  it("turns a worker-cancelled outcome into a CANCELLED execution, never COMPLETED", async () => {
    const cancelled: AgentResultV1 = {
      ...result,
      status: "cancelled",
      output: undefined,
      error: {
        code: "CANCELLED",
        message: "worker stopped",
        retryable: false,
      },
    };
    const attemptSelect = chain(attempt);
    const attemptTransition = chain(undefined, 1);
    const inboxInsert = chain();
    const inboxSelect = chain({
      id: "inbox-1",
      payloadHash: sha256Json(cancelled),
      status: "RECEIVED",
    });
    const logicalSelect = chain({ ...logical, status: "RUNNING" });
    const outboxTransition = chain(undefined, 1);
    const executionSelect = chain({
      id: result.executionId,
      status: "RUNNING",
    });
    const inboxSave = jest.fn();
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
        if (entity === ResultInboxEntity)
          return {
            createQueryBuilder: jest
              .fn()
              .mockReturnValueOnce(inboxInsert)
              .mockReturnValueOnce(inboxSelect),
            save: inboxSave,
          };
        if (entity === LogicalStepEntity)
          return {
            createQueryBuilder: jest.fn(() => logicalSelect),
            save: logicalSave,
          };
        if (entity === DispatchOutboxEntity)
          return { createQueryBuilder: jest.fn(() => outboxTransition) };
        if (entity === ExecutionPlanRevisionEntity)
          return {
            findOne: jest.fn().mockResolvedValue({
              id: "revision-1",
              plan: { steps: [{ id: "review", onFailure: "stop" }] },
            }),
          };
        if (entity === ExecutionEntity)
          return {
            createQueryBuilder: jest.fn(() => executionSelect),
            save: executionSave,
          };
        throw new Error("unexpected repository");
      }),
    };
    const service = new ResultInboxService({
      transaction: jest.fn((work) => work(manager)),
    } as any);

    await expect(
      service.apply(cancelled, { adapter: "kafka", receivedAt: "now" }),
    ).resolves.toEqual({
      disposition: "applied",
      executionId: "execution-1",
      stepId: "review",
    });
    expect(logicalSave).toHaveBeenCalledWith(
      expect.objectContaining({ status: "CANCELLED", nextAttemptAt: null }),
    );
    expect(executionSave).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "CANCELLED",
        terminationReason: "Worker cancelled the attempt",
      }),
    );
    expect(inboxSave).toHaveBeenCalledWith(
      expect.objectContaining({ status: "APPLIED" }),
    );
  });

  it("rejects a terminal result that arrives after cancellation won the race", async () => {
    const attemptSelect = chain(attempt);
    const inboxInsert = chain();
    const inboxSelect = chain({
      id: "inbox-1",
      payloadHash: sha256Json(result),
      status: "RECEIVED",
    });
    const logicalSelect = chain({ ...logical });
    const executionSelect = chain({
      id: result.executionId,
      status: "CANCELLED",
    });
    const inboxSave = jest.fn();
    const logicalSave = jest.fn();
    const executionSave = jest.fn();
    const manager = {
      getRepository: jest.fn((entity) => {
        if (entity === StepAttemptEntity)
          return { createQueryBuilder: jest.fn(() => attemptSelect) };
        if (entity === ResultInboxEntity)
          return {
            createQueryBuilder: jest
              .fn()
              .mockReturnValueOnce(inboxInsert)
              .mockReturnValueOnce(inboxSelect),
            save: inboxSave,
          };
        if (entity === LogicalStepEntity)
          return {
            createQueryBuilder: jest.fn(() => logicalSelect),
            save: logicalSave,
          };
        if (entity === ExecutionEntity)
          return {
            createQueryBuilder: jest.fn(() => executionSelect),
            save: executionSave,
          };
        throw new Error("unexpected repository");
      }),
    };
    const service = new ResultInboxService({
      transaction: jest.fn((work) => work(manager)),
    } as any);

    await expect(
      service.apply(result, { adapter: "kafka", receivedAt: "now" }),
    ).resolves.toEqual({ disposition: "conflict" });
    expect(attemptSelect.execute).not.toHaveBeenCalled();
    expect(logicalSave).not.toHaveBeenCalled();
    expect(executionSave).not.toHaveBeenCalled();
    expect(inboxSave).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "REJECTED",
        lastApplicationError: expect.stringContaining("cancellation"),
      }),
    );
  });

  it("never rewrites an already-terminal execution from a late result", async () => {
    // Step A failed the run (execution FAILED); a late `cancelled` outcome
    // from step B must record its own attempt/step facts but cannot turn the
    // run CANCELLED.
    const cancelled: AgentResultV1 = {
      ...result,
      status: "cancelled",
      error: { code: "CANCELLED", message: "worker stopped", retryable: false },
    };
    const attemptSelect = chain(attempt);
    const attemptTransition = chain(undefined, 1);
    const inboxInsert = chain();
    const inboxSelect = chain({
      id: "inbox-1",
      payloadHash: sha256Json(cancelled),
      status: "RECEIVED",
    });
    const logicalSelect = chain({ ...logical, status: "RUNNING" });
    const outboxTransition = chain(undefined, 1);
    const executionSelect = chain({ id: result.executionId, status: "FAILED" });
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
        if (entity === ResultInboxEntity)
          return {
            createQueryBuilder: jest
              .fn()
              .mockReturnValueOnce(inboxInsert)
              .mockReturnValueOnce(inboxSelect),
            save: jest.fn(),
          };
        if (entity === LogicalStepEntity)
          return {
            createQueryBuilder: jest.fn(() => logicalSelect),
            save: logicalSave,
          };
        if (entity === DispatchOutboxEntity)
          return { createQueryBuilder: jest.fn(() => outboxTransition) };
        if (entity === ExecutionPlanRevisionEntity)
          return {
            findOne: jest.fn().mockResolvedValue({
              id: "revision-1",
              plan: { steps: [{ id: "review", onFailure: "stop" }] },
            }),
          };
        if (entity === ExecutionEntity)
          return {
            createQueryBuilder: jest.fn(() => executionSelect),
            save: executionSave,
          };
        throw new Error("unexpected repository");
      }),
    };
    const service = new ResultInboxService({
      transaction: jest.fn((work) => work(manager)),
    } as any);

    const application = await service.apply(cancelled, {
      adapter: "kafka",
      receivedAt: "now",
    });

    expect(application.disposition).toBe("applied");
    expect(logicalSave).toHaveBeenCalledWith(
      expect.objectContaining({ status: "CANCELLED" }),
    );
    // The FAILED execution truth is preserved; no save rewrites it.
    expect(executionSave).not.toHaveBeenCalled();
  });

  it("never schedules a retry for a late sibling outcome under a terminal execution", async () => {
    // Step A failed the run (execution FAILED, retry policy configured); a
    // late TIMED_OUT from step B must record B as FAILED, not RETRYING with a
    // past nextAttemptAt that recovery would re-pick every tick.
    const lateTimeout: AgentResultV1 = {
      ...result,
      status: "timed_out",
      error: { code: "DEADLINE_EXCEEDED", message: "late", retryable: true },
    };
    const attemptSelect = chain(attempt);
    const attemptTransition = chain(undefined, 1);
    const inboxInsert = chain();
    const inboxSelect = chain({
      id: "inbox-1",
      payloadHash: sha256Json(lateTimeout),
      status: "RECEIVED",
    });
    const logicalSelect = chain({
      ...logical,
      status: "RUNNING",
      maxAttempts: 3,
    });
    const outboxTransition = chain(undefined, 1);
    const executionSelect = chain({ id: result.executionId, status: "FAILED" });
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
        if (entity === ResultInboxEntity)
          return {
            createQueryBuilder: jest
              .fn()
              .mockReturnValueOnce(inboxInsert)
              .mockReturnValueOnce(inboxSelect),
            save: jest.fn(),
          };
        if (entity === LogicalStepEntity)
          return {
            createQueryBuilder: jest.fn(() => logicalSelect),
            save: logicalSave,
          };
        if (entity === DispatchOutboxEntity)
          return { createQueryBuilder: jest.fn(() => outboxTransition) };
        if (entity === ExecutionPlanRevisionEntity)
          return {
            findOne: jest.fn().mockResolvedValue({
              id: "revision-1",
              plan: { steps: [{ id: "review", onFailure: "retry" }] },
            }),
          };
        if (entity === ExecutionEntity)
          return {
            createQueryBuilder: jest.fn(() => executionSelect),
            save: executionSave,
          };
        throw new Error("unexpected repository");
      }),
    };
    const service = new ResultInboxService({
      transaction: jest.fn((work) => work(manager)),
    } as any);

    const application = await service.apply(lateTimeout, {
      adapter: "recovery",
      receivedAt: "now",
    });

    expect(application.disposition).toBe("applied");
    expect(logicalSave).toHaveBeenCalledWith(
      expect.objectContaining({ status: "FAILED", nextAttemptAt: null }),
    );
    expect(executionSave).not.toHaveBeenCalled();
  });

  // A full first-application manager mock: attempt transition, inbox insert +
  // select (RECEIVED), step projection, outbox retirement, execution, and the
  // artifact registration repository.
  const appliedManager = (payload: AgentResultV1) => {
    const attemptSelect = chain(attempt);
    const attemptTransition = chain(undefined, 1);
    const inboxInsert = chain();
    const inboxSelect = chain({
      id: "inbox-1",
      payloadHash: sha256Json(payload),
      status: "RECEIVED",
    });
    const logicalSelect = chain({ ...logical, status: "RUNNING" });
    const outboxTransition = chain(undefined, 1);
    const executionSelect = chain({
      id: payload.executionId,
      status: "RUNNING",
    });
    const artifactInsert = chain();
    const inboxSave = jest.fn();
    const manager = {
      getRepository: jest.fn((entity: any) => {
        if (entity === StepAttemptEntity)
          return {
            createQueryBuilder: jest
              .fn()
              .mockReturnValueOnce(attemptSelect)
              .mockReturnValueOnce(attemptTransition),
          };
        if (entity === ResultInboxEntity)
          return {
            createQueryBuilder: jest
              .fn()
              .mockReturnValueOnce(inboxInsert)
              .mockReturnValueOnce(inboxSelect),
            save: inboxSave,
          };
        if (entity === LogicalStepEntity)
          return {
            createQueryBuilder: jest.fn(() => logicalSelect),
            save: jest.fn(),
          };
        if (entity === DispatchOutboxEntity)
          return { createQueryBuilder: jest.fn(() => outboxTransition) };
        if (entity === ExecutionPlanRevisionEntity)
          return {
            findOne: jest.fn().mockResolvedValue({
              id: "revision-1",
              plan: { steps: [{ id: "review", onFailure: "stop" }] },
            }),
          };
        if (entity === ExecutionEntity)
          return {
            createQueryBuilder: jest.fn(() => executionSelect),
            save: jest.fn(),
          };
        if (entity === ArtifactEntity)
          return { createQueryBuilder: jest.fn(() => artifactInsert) };
        throw new Error("unexpected repository");
      }),
    };
    return { manager, artifactInsert, inboxSave };
  };

  const artifactA = { id: "worker-art-1", name: "report.pdf" };
  const artifactB = {
    id: "worker-art-1", // duplicate worker id: opaque producer data
    name: "data.json",
    mediaType: "application/json",
  };

  it.each([
    ["succeeded", { status: "succeeded", output: { done: true } }] as const,
    [
      "failed",
      {
        status: "failed",
        error: { code: "AGENT_ERROR", message: "boom", retryable: false },
      },
    ] as const,
    [
      "cancelled",
      {
        status: "cancelled",
        error: { code: "CANCELLED", message: "stopped", retryable: false },
      },
    ] as const,
    [
      "timed_out",
      {
        status: "timed_out",
        error: { code: "DEADLINE_EXCEEDED", message: "late", retryable: true },
      },
    ] as const,
  ])(
    "registers one immutable Artifact per descriptor when the canonical outcome is %s",
    async (_, outcome) => {
      const payload: AgentResultV1 = {
        ...result,
        ...outcome,
        artifacts: [artifactA, artifactB],
      };
      const { manager, artifactInsert } = appliedManager(payload);
      const service = new ResultInboxService({
        transaction: jest.fn((work) => work(manager)),
      } as any);

      await expect(
        service.apply(payload, { adapter: "kafka", receivedAt: "now" }),
      ).resolves.toEqual({
        disposition: "applied",
        executionId: "execution-1",
        stepId: "review",
      });
      // Tenvyr identity is (inbox row, ordinal); the worker id stays opaque.
      expect(artifactInsert.values).toHaveBeenCalledWith([
        {
          resultInboxId: "inbox-1",
          descriptorOrdinal: 0,
          descriptorHash: sha256Json(artifactA),
        },
        {
          resultInboxId: "inbox-1",
          descriptorOrdinal: 1,
          descriptorHash: sha256Json(artifactB),
        },
      ]);
      // Defense in depth: duplicate registration is swallowed, never thrown.
      expect(artifactInsert.orIgnore).toHaveBeenCalled();
    },
  );

  it("registers no additional Artifact records for an identical duplicate delivery", async () => {
    const payload: AgentResultV1 = {
      ...result,
      artifacts: [artifactA],
    };
    const attemptSelect = chain(attempt);
    const inboxInsert = chain();
    const inboxSelect = chain({
      id: "inbox-1",
      payloadHash: sha256Json(payload),
      status: "APPLIED",
    });
    const logicalSelect = chain(logical);
    const manager = {
      getRepository: jest.fn((entity: any) => {
        if (entity === StepAttemptEntity)
          return { createQueryBuilder: jest.fn(() => attemptSelect) };
        if (entity === ResultInboxEntity)
          return {
            createQueryBuilder: jest
              .fn()
              .mockReturnValueOnce(inboxInsert)
              .mockReturnValueOnce(inboxSelect),
          };
        if (entity === LogicalStepEntity)
          return { createQueryBuilder: jest.fn(() => logicalSelect) };
        throw new Error("unexpected repository");
      }),
    };
    const service = new ResultInboxService({
      transaction: jest.fn((work) => work(manager)),
    } as any);

    await expect(
      service.apply(payload, { adapter: "kafka", receivedAt: "now" }),
    ).resolves.toEqual({
      disposition: "duplicate",
      executionId: "execution-1",
      stepId: "review",
    });
    expect(manager.getRepository).not.toHaveBeenCalledWith(ArtifactEntity);
  });

  it("conflicting, ignored, and post-cancellation results register no Artifact records", async () => {
    const payload: AgentResultV1 = {
      ...result,
      artifacts: [artifactA],
    };
    const conflicting: AgentResultV1 = {
      ...payload,
      output: { value: 2 }, // same invocationId, different payload
    };
    const ignored: AgentResultV1 = {
      ...payload,
      invocationId: "logical-unknown:1",
    };
    const attemptSelect = chain(attempt);
    const inboxInsert = chain();
    const inboxSelect = chain({
      id: "inbox-1",
      payloadHash: "a".repeat(64),
      status: "APPLIED",
    });
    const conflictInsert = chain();
    const logicalSelect = chain(logical);
    const manager = {
      getRepository: jest.fn((entity: any) => {
        if (entity === StepAttemptEntity)
          return { createQueryBuilder: jest.fn(() => attemptSelect) };
        if (entity === ResultInboxEntity)
          return {
            createQueryBuilder: jest
              .fn()
              .mockReturnValueOnce(inboxInsert)
              .mockReturnValueOnce(inboxSelect),
          };
        if (entity === ResultConflictEntity)
          return { createQueryBuilder: jest.fn(() => conflictInsert) };
        if (entity === LogicalStepEntity)
          return { createQueryBuilder: jest.fn(() => logicalSelect) };
        throw new Error("unexpected repository");
      }),
    };
    const service = new ResultInboxService({
      transaction: jest.fn((work) => work(manager)),
    } as any);

    await expect(
      service.apply(conflicting, { adapter: "kafka", receivedAt: "now" }),
    ).resolves.toEqual({ disposition: "conflict" });

    const ignoredManager = {
      getRepository: jest.fn((entity: any) => {
        if (entity === StepAttemptEntity)
          return { createQueryBuilder: jest.fn(() => chain(undefined)) };
        throw new Error("unexpected repository");
      }),
    };
    const ignoredService = new ResultInboxService({
      transaction: jest.fn((work) => work(ignoredManager)),
    } as any);
    await expect(
      ignoredService.apply(ignored, { adapter: "kafka", receivedAt: "now" }),
    ).resolves.toEqual({ disposition: "ignored" });

    const cancelledExecutionSelect = chain({
      id: payload.executionId,
      status: "CANCELLED",
    });
    // Matching payload hash so the flow reaches the execution-CANCELLED
    // guard (a mismatched hash would short-circuit into the conflict path).
    const cancelledInboxInsert = chain();
    const cancelledInboxSelect = chain({
      id: "inbox-1",
      payloadHash: sha256Json(payload),
      status: "RECEIVED",
    });
    const cancelledInboxSave = jest.fn();
    const cancelledManager = {
      getRepository: jest.fn((entity: any) => {
        if (entity === StepAttemptEntity)
          return { createQueryBuilder: jest.fn(() => attemptSelect) };
        if (entity === ResultInboxEntity)
          return {
            createQueryBuilder: jest
              .fn()
              .mockReturnValueOnce(cancelledInboxInsert)
              .mockReturnValueOnce(cancelledInboxSelect),
            save: cancelledInboxSave,
          };
        if (entity === LogicalStepEntity)
          return {
            createQueryBuilder: jest.fn(() => logicalSelect),
            save: jest.fn(),
          };
        if (entity === ExecutionEntity)
          return {
            createQueryBuilder: jest.fn(() => cancelledExecutionSelect),
            save: jest.fn(),
          };
        throw new Error("unexpected repository");
      }),
    };
    const cancelledService = new ResultInboxService({
      transaction: jest.fn((work) => work(cancelledManager)),
    } as any);
    await expect(
      cancelledService.apply(payload, { adapter: "kafka", receivedAt: "now" }),
    ).resolves.toEqual({ disposition: "conflict" });
    // Proof the CANCELLED guard ran: the canonical row is REJECTED, never
    // APPLIED, and no conflict-evidence row was written.
    expect(cancelledInboxSave).toHaveBeenCalledWith(
      expect.objectContaining({ status: "REJECTED" }),
    );

    expect(manager.getRepository).not.toHaveBeenCalledWith(ArtifactEntity);
    expect(ignoredManager.getRepository).not.toHaveBeenCalledWith(
      ArtifactEntity,
    );
    expect(cancelledManager.getRepository).not.toHaveBeenCalledWith(
      ArtifactEntity,
    );
  });

  it("registers nothing for a result without artifacts (zero-artifact compatibility)", async () => {
    const { manager } = appliedManager(result);
    const service = new ResultInboxService({
      transaction: jest.fn((work) => work(manager)),
    } as any);

    await expect(
      service.apply(result, { adapter: "kafka", receivedAt: "now" }),
    ).resolves.toEqual({
      disposition: "applied",
      executionId: "execution-1",
      stepId: "review",
    });
    expect(manager.getRepository).not.toHaveBeenCalledWith(ArtifactEntity);
  });

  it("an artifact registration failure aborts the whole application", async () => {
    const payload: AgentResultV1 = {
      ...result,
      artifacts: [artifactA],
    };
    const { manager, artifactInsert, inboxSave } = appliedManager(payload);
    artifactInsert.execute.mockRejectedValueOnce(
      new Error("artifact insert failed"),
    );
    const service = new ResultInboxService({
      transaction: jest.fn((work) => work(manager)),
    } as any);

    await expect(
      service.apply(payload, { adapter: "kafka", receivedAt: "now" }),
    ).rejects.toThrow("artifact insert failed");
    // The APPLIED inbox save must never run; the real rollback proof lives in
    // the PostgreSQL integration suite.
    expect(inboxSave).not.toHaveBeenCalled();
  });
});
