import { RuntimeRecoveryService } from "./runtime-recovery.service";

describe("RuntimeRecoveryService", () => {
  const buildService = (overrides: Record<string, any> = {}) => {
    const attempts = {
      find: jest.fn().mockResolvedValue([
        {
          id: "attempt-1",
          invocationId: "step-1:1",
          executionId: "execution-1",
          logicalStepId: "step-1",
          deadlineAt: new Date("2026-08-10T00:00:00.000Z"),
        },
      ]),
    };
    const executions = {
      createQueryBuilder: jest.fn(() => {
        const builder: any = {};
        for (const method of [
          "select",
          "addSelect",
          "where",
          "andWhere",
          "orderBy",
          "addOrderBy",
          "take",
        ]) {
          builder[method] = jest.fn(() => builder);
        }
        builder.getRawMany = jest.fn().mockResolvedValue([]);
        return builder;
      }),
    };
    const inbox = {
      apply: jest.fn().mockResolvedValue({
        disposition: "applied",
        executionId: "execution-1",
        stepId: "review",
      }),
    };
    const engine = {
      resumeAfterResult: jest.fn().mockResolvedValue(undefined),
      reconcileExecution: jest.fn().mockResolvedValue(undefined),
    };
    const outbox = {
      recover: jest
        .fn()
        .mockResolvedValue({ dispatched: 1, terminalFailures: [], retryableFailures: 0 }),
    };
    const supervision = {
      evaluate: jest.fn().mockResolvedValue(undefined),
    };
    const service = new RuntimeRecoveryService(
      (overrides.attempts ?? attempts) as any,
      (overrides.executions ?? executions) as any,
      (overrides.outbox ?? outbox) as any,
      (overrides.inbox ?? inbox) as any,
      (overrides.engine ?? engine) as any,
      (overrides.supervision ?? supervision) as any,
    );
    return {
      service,
      attempts,
      executions,
      inbox,
      engine,
      outbox,
      supervision,
    };
  };

  it("derives a deterministic timeout from the persisted deadline and reconciles durable retry work", async () => {
    const { service, inbox, engine, outbox } = buildService();
    const now = new Date("2026-08-10T00:00:05.000Z");
    const deadline = new Date("2026-08-10T00:00:00.000Z");

    await service.recover(now);

    expect(inbox.apply).toHaveBeenCalledWith(
      expect.objectContaining({
        invocationId: "step-1:1",
        status: "timed_out",
        // The persisted deadline, not the tick time, is the synthetic
        // completion time: replicas produce identical payload hashes.
        completedAt: deadline.toISOString(),
      }),
      expect.objectContaining({ adapter: "recovery" }),
    );
    expect(engine.reconcileExecution).toHaveBeenCalledWith("execution-1", {
      projectTerminal: true,
    });
    expect(outbox.recover).toHaveBeenCalledTimes(1);
  });

  it("reconciles every candidate execution through the engine", async () => {
    const { service, executions, engine } = buildService();
    executions.createQueryBuilder.mockImplementation(() => {
      const builder: any = {};
      for (const method of [
        "select",
        "addSelect",
        "where",
        "andWhere",
        "orderBy",
        "addOrderBy",
        "take",
      ]) {
        builder[method] = jest.fn(() => builder);
      }
      builder.getRawMany = jest
        .fn()
        .mockResolvedValue([
          { id: "execution-1", createdAt: "2026-08-10T00:00:00.000Z" },
          { id: "execution-2", createdAt: "2026-08-10T00:00:01.000Z" },
        ]);
      return builder;
    });

    await service.recover(new Date());

    expect(engine.reconcileExecution).toHaveBeenCalledWith("execution-1");
    expect(engine.reconcileExecution).toHaveBeenCalledWith("execution-2");
  });

  it("applies a keyset cursor so candidates beyond one batch are eventually visited", async () => {
    const { service, executions, engine } = buildService();
    // One full batch (100) plus a partial batch: candidates beyond the first
    // batch must be visited once the cursor advances, and a short batch
    // resets the cursor so the scan wraps around.
    const firstBatch = Array.from({ length: 100 }, (_, index) => ({
      id: `execution-${String(index + 1).padStart(3, "0")}`,
      createdAt: new Date(
        Date.parse("2026-08-10T00:00:00.000Z") + index * 1000,
      ).toISOString(),
    }));
    const secondBatch = [
      {
        id: "execution-101",
        createdAt: "2026-08-10T00:02:00.000Z",
      },
    ];
    const rowsByCall = [firstBatch, secondBatch, [], []];
    let call = 0;
    const builders: any[] = [];
    executions.createQueryBuilder.mockImplementation(() => {
      const builder: any = {};
      for (const method of [
        "select",
        "addSelect",
        "where",
        "andWhere",
        "orderBy",
        "addOrderBy",
        "take",
      ]) {
        builder[method] = jest.fn(() => builder);
      }
      builder.getRawMany = jest.fn().mockImplementation(() => {
        const rows = rowsByCall[Math.min(call, rowsByCall.length - 1)];
        call += 1;
        return Promise.resolve(rows);
      });
      builders.push(builder);
      return builder;
    });

    // Recover without any overdue attempts so only candidate scans run.
    (service as any).attempts.find = jest.fn().mockResolvedValue([]);
    (service as any).outbox.recover = jest
      .fn()
      .mockResolvedValue({ dispatched: 0, terminalFailures: [], retryableFailures: 0 });

    await service.recover(new Date("2026-08-10T00:01:00.000Z"));
    await service.recover(new Date("2026-08-10T00:01:01.000Z"));
    await service.recover(new Date("2026-08-10T00:01:02.000Z"));
    await service.recover(new Date("2026-08-10T00:01:03.000Z"));

    // Every candidate across both ticks was reconciled exactly once.
    expect(engine.reconcileExecution).toHaveBeenCalledWith("execution-001");
    expect(engine.reconcileExecution).toHaveBeenCalledWith("execution-100");
    expect(engine.reconcileExecution).toHaveBeenCalledWith("execution-101");
    expect(engine.reconcileExecution).toHaveBeenCalledTimes(101);
    // The second tick advanced the cursor past the first batch.
    expect(builders[1].andWhere).toHaveBeenCalledWith(
      expect.stringContaining('execution."id" > :cursorId'),
      expect.objectContaining({ cursorId: "execution-100" }),
    );
    // A short batch resets the cursor so the next scan wraps around.
    expect(builders[3].andWhere).not.toHaveBeenCalledWith(
      expect.stringContaining('execution."id" > :cursorId'),
      expect.anything(),
    );
  });

  it("only scans non-terminal executions, so terminal rows never consume recovery capacity", async () => {
    const { service, executions } = buildService();
    let whereArgs: any[] = [];
    executions.createQueryBuilder.mockImplementation(() => {
      const builder: any = {};
      for (const method of [
        "select",
        "addSelect",
        "where",
        "andWhere",
        "orderBy",
        "addOrderBy",
        "take",
      ]) {
        builder[method] = jest.fn((...args: any[]) => {
          if (method === "where") whereArgs = args;
          return builder;
        });
      }
      builder.getRawMany = jest.fn().mockResolvedValue([]);
      return builder;
    });

    (service as any).attempts.find = jest.fn().mockResolvedValue([]);
    (service as any).outbox.recover = jest
      .fn()
      .mockResolvedValue({ dispatched: 0, terminalFailures: [], retryableFailures: 0 });
    await service.recover(new Date());

    // Execution-level status filter: only PENDING/RUNNING executions are
    // scheduling candidates regardless of what their step rows look like.
    expect(whereArgs[0]).toContain('"status" IN');
    expect(whereArgs[1]).toEqual(
      expect.objectContaining({ active: ["PENDING", "RUNNING"] }),
    );
  });

  it("skips a recovery tick while the previous cycle is still running", async () => {
    const { service, inbox } = buildService();
    let release!: () => void;
    inbox.apply.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ disposition: "ignored" });
        }),
    );

    const first = service.recover(new Date("2026-08-10T00:00:00.000Z"));
    // Second tick lands while the first is still awaiting the inbox.
    await service.recover(new Date("2026-08-10T00:00:01.000Z"));
    expect(inbox.apply).toHaveBeenCalledTimes(1);

    release();
    await first;
    // After the cycle completes, a fresh tick runs again.
    await service.recover(new Date("2026-08-10T00:00:02.000Z"));
    expect(inbox.apply).toHaveBeenCalledTimes(2);
  });

  it("never turns an inner cycle failure into an unhandled rejection and still runs the next tick", async () => {
    const { service, outbox, engine } = buildService();
    (service as any).attempts.find = jest
      .fn()
      .mockRejectedValue(new Error("database outage"));

    // The scheduled-promise shape: `void recover()` must not reject.
    await expect(service.recover(new Date())).resolves.toBeUndefined();
    expect(outbox.recover).not.toHaveBeenCalled();

    // A later tick recovers once the outage clears.
    (service as any).attempts.find = jest.fn().mockResolvedValue([]);
    await service.recover(new Date());
    expect(outbox.recover).toHaveBeenCalled();
    expect(engine.reconcileExecution).toBeDefined();
  });

  it("isolates one failing candidate so later candidates in the same batch still run", async () => {
    const { service, executions, engine } = buildService();
    (service as any).attempts.find = jest.fn().mockResolvedValue([]);
    (service as any).outbox.recover = jest
      .fn()
      .mockResolvedValue({ dispatched: 0, terminalFailures: [], retryableFailures: 0 });
    executions.createQueryBuilder.mockImplementation(() => {
      const builder: any = {};
      for (const method of [
        "select",
        "addSelect",
        "where",
        "andWhere",
        "orderBy",
        "addOrderBy",
        "take",
      ]) {
        builder[method] = jest.fn(() => builder);
      }
      builder.getRawMany = jest
        .fn()
        .mockResolvedValue([
          { id: "execution-broken", createdAt: "2026-08-10T00:00:00.000Z" },
          { id: "execution-healthy", createdAt: "2026-08-10T00:00:01.000Z" },
        ]);
      return builder;
    });
    engine.reconcileExecution
      .mockRejectedValueOnce(new Error("broken execution"))
      .mockResolvedValueOnce(undefined);

    await expect(service.recover(new Date())).resolves.toBeUndefined();

    expect(engine.reconcileExecution).toHaveBeenCalledWith("execution-broken");
    expect(engine.reconcileExecution).toHaveBeenCalledWith("execution-healthy");
  });

  it("reconciles executions whose terminal dispatch failure was committed by the outbox", async () => {
    const { service, outbox, engine } = buildService();
    (service as any).attempts.find = jest.fn().mockResolvedValue([]);
    outbox.recover
      .mockResolvedValueOnce({
        dispatched: 0,
        terminalFailures: ["execution-1"],
        retryableFailures: 0,
      })
      .mockResolvedValue({ dispatched: 0, terminalFailures: [], retryableFailures: 0 });

    await service.recover(new Date());

    expect(engine.reconcileExecution).toHaveBeenCalledWith("execution-1", {
      projectTerminal: true,
    });
  });
});
