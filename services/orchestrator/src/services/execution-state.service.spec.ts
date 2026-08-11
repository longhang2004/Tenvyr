import { ExecutionEntity } from "../entities/execution.entity";
import { ExecutionStateService } from "./execution-state.service";
import {
  EXECUTION_STATE_BOUNDS,
  ExecutionStateValidationError,
  jsonValueUtf8Size,
} from "../domain/execution-state";

const chain = (one: unknown) => {
  const value: any = {};
  for (const method of [
    "setLock",
    "where",
    "andWhere",
    "insert",
    "into",
    "values",
  ]) {
    value[method] = jest.fn(() => value);
  }
  value.getOne = jest.fn().mockResolvedValue(one);
  value.getOneOrFail = jest.fn().mockResolvedValue(one);
  value.execute = jest.fn().mockResolvedValue({ affected: 1 });
  return value;
};

const executionRow = (overrides: Partial<ExecutionEntity> = {}) => ({
  id: "execution-1",
  pipelineId: "pipeline-1",
  status: "RUNNING",
  input: {},
  output: null,
  configurationSnapshot: null,
  executionState: {},
  executionStateVersion: 0,
  executionStateUpdatedAt: null,
  rowVersion: 1,
  ...overrides,
});

describe("ExecutionStateService", () => {
  const buildService = (row: unknown) => {
    const save = jest.fn().mockResolvedValue(row);
    const select = chain(row);
    const manager = {
      getRepository: jest.fn((entity) => {
        if (entity === ExecutionEntity)
          return { createQueryBuilder: jest.fn(() => select), save };
        throw new Error("unexpected repository");
      }),
    };
    const transaction = jest.fn((work: (m: unknown) => unknown) =>
      work(manager),
    );
    const dataSource = {
      transaction,
      getRepository: jest.fn(() => ({
        findOne: jest.fn().mockResolvedValue(row),
      })),
    };
    const service = new ExecutionStateService(dataSource as any);
    return { service, select, save, transaction, manager };
  };

  it("applies a mutation: increments the semantic version exactly once and saves atomically", async () => {
    const { service, save } = buildService(executionRow());
    const result = await service.mutate("execution-1", 0, { set: { a: 1 } });

    expect(result).toMatchObject({ disposition: "applied", version: 1 });
    expect(save).toHaveBeenCalledTimes(1);
    const saved = save.mock.calls[0][0] as ExecutionEntity;
    expect(saved.executionState).toEqual({ a: 1 });
    expect(saved.executionStateVersion).toBe(1);
    expect(saved.executionStateUpdatedAt).toEqual(expect.any(Date));
    // The returned state is an isolated copy, not the persisted object.
    expect((result as any).state).not.toBe(saved.executionState);
  });

  it("returns noop for an empty patch without saving or touching the row", async () => {
    const { service, save } = buildService(executionRow());
    const result = await service.mutate("execution-1", 0, {});

    expect(result).toEqual({ disposition: "noop", version: 0, state: {} });
    expect(save).not.toHaveBeenCalled();
  });

  it("returns noop when set replaces a key with an identical value", async () => {
    const { service, save } = buildService(
      executionRow({ executionState: { a: 1 } }),
    );
    const result = await service.mutate("execution-1", 0, { set: { a: 1 } });

    expect(result).toMatchObject({ disposition: "noop", version: 0 });
    expect(save).not.toHaveBeenCalled();
  });

  it("returns conflict with the current semantic version without mutation", async () => {
    const { service, save } = buildService(
      executionRow({ executionStateVersion: 3, executionState: { a: 1 } }),
    );
    const result = await service.mutate("execution-1", 0, { set: { b: 2 } });

    expect(result).toEqual({ disposition: "conflict", version: 3 });
    expect(save).not.toHaveBeenCalled();
  });

  it("returns missing for an unknown execution", async () => {
    const { service, save } = buildService(null);
    const result = await service.mutate("missing", 0, { set: { a: 1 } });

    expect(result).toEqual({ disposition: "missing" });
    expect(save).not.toHaveBeenCalled();
  });

  it.each(["COMPLETED", "FAILED", "CANCELLED"])(
    "rejects mutation of a %s terminal execution even with a matching version",
    async (status) => {
      const { service, save } = buildService(
        executionRow({ status: status as any }),
      );
      const result = await service.mutate("execution-1", 0, { set: { a: 1 } });

      expect(result).toEqual({ disposition: "terminal", status });
      expect(save).not.toHaveBeenCalled();
    },
  );

  it("validates patch input before any database work (bounded validation error)", async () => {
    const { service, transaction, save } = buildService(executionRow());
    await expect(
      service.mutate("execution-1", 0, { set: { ["__proto__"]: {} } }),
    ).rejects.toThrow(ExecutionStateValidationError);
    expect(transaction).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it("rejects a merged final state over 64 KiB before saving", async () => {
    // Four ~16 KiB values already persisted; the patch stays under the
    // 16 KiB patch cap while the merged state exceeds the 64 KiB state cap.
    const seed = Object.fromEntries(
      Array.from({ length: 4 }, (_, i) => [`k${i}`, "x".repeat(16366)]),
    );
    const patch = { set: { extra: "x".repeat(16364) } };
    expect(jsonValueUtf8Size(patch)).toBeLessThanOrEqual(
      EXECUTION_STATE_BOUNDS.maxPatchBytes,
    );
    expect(
      jsonValueUtf8Size({ ...seed, extra: patch.set.extra }),
    ).toBeGreaterThan(EXECUTION_STATE_BOUNDS.maxStateBytes);

    const { service, save } = buildService(
      executionRow({ executionState: seed }),
    );
    await expect(service.mutate("execution-1", 0, patch)).rejects.toThrow(
      /final state exceeds/,
    );
    expect(save).not.toHaveBeenCalled();
  });

  it("rejects a final state with more than 128 top-level keys before saving", async () => {
    const seeded = Object.fromEntries(
      Array.from({ length: 128 }, (_, i) => [`k${i}`, i]),
    );
    const { service, save } = buildService(
      executionRow({ executionState: seeded }),
    );
    await expect(
      service.mutate("execution-1", 0, { set: { extra: 1 } }),
    ).rejects.toThrow(/128 top-level keys/);
    expect(save).not.toHaveBeenCalled();
  });

  it("accepts boundary values: 128 keys and chained patches growing toward the state cap", async () => {
    const { service, save } = buildService(executionRow());
    const many = Object.fromEntries(
      Array.from({ length: 126 }, (_, i) => [`k${i}`, i]),
    );
    const applied = await service.mutate("execution-1", 0, { set: many });
    expect(applied.disposition).toBe("applied");
    // Each patch is bounded to 16 KiB; chained mutations grow the state.
    const chunk = "x".repeat(15 * 1024);
    const second = await service.mutate("execution-1", 1, {
      set: { a: chunk },
    });
    expect(second.disposition).toBe("applied");
    const third = await service.mutate("execution-1", 2, { set: { b: chunk } });
    expect(third.disposition).toBe("applied");
    expect(save).toHaveBeenCalledTimes(3);
  });

  it("read returns an isolated snapshot; mutating it never touches persisted state", async () => {
    const row = executionRow({ executionState: { a: { deep: [1, 2] } } });
    const { service } = buildService(row);

    const first = await service.read("execution-1");
    (first as any).state.a.deep.push(999);
    (first as any).state.b = "hacked";

    const second = await service.read("execution-1");
    expect(second?.state).toEqual({ a: { deep: [1, 2] } });
    expect(row.executionState).toEqual({ a: { deep: [1, 2] } });
  });

  it("read returns null for an unknown execution", async () => {
    const { service } = buildService(null);
    expect(await service.read("missing")).toBeNull();
  });

  it("the mutation result state is isolated from the persisted row", async () => {
    const { service } = buildService(executionRow());
    const applied = await service.mutate("execution-1", 0, {
      set: { a: { deep: [1] } },
    });
    if (applied.disposition !== "applied") throw new Error("expected applied");
    (applied.state.a as any).deep.push(2);

    const snapshot = await service.read("execution-1");
    expect(snapshot?.state).toEqual({ a: { deep: [1] } });
  });
});
