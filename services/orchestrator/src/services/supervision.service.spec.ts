import { SUPERVISION_BATCH, SupervisionService } from "./supervision.service";
import { SupervisionConfigService } from "./supervision-config.service";

const config = (agent: string, expectation: Record<string, unknown>) =>
  new SupervisionConfigService({
    ORCHESTRATOR_SUPERVISION_CONFIG: JSON.stringify({
      [agent]: { heartbeat: expectation },
    }),
  } as NodeJS.ProcessEnv);

const attempt = (overrides: Record<string, unknown> = {}) => ({
  id: "attempt-1",
  invocationId: "logical-1:1",
  executionId: "execution-1",
  logicalStepId: "logical-1",
  status: "DISPATCHED",
  dispatchedAt: new Date("2026-08-10T00:00:00.000Z"),
  lastEventReceivedAt: null,
  lastHeartbeatReceivedAt: null,
  executorSnapshot: { agent: "reviewer" },
  ...overrides,
});

describe("SupervisionService", () => {
  const build = (rows: any[], inbox?: any) => {
    const attempts = {
      createQueryBuilder: jest.fn(() => {
        const builder: any = {};
        for (const method of [
          "where",
          "andWhere",
          "orderBy",
          "addOrderBy",
          "take",
        ]) {
          builder[method] = jest.fn(() => builder);
        }
        builder.getMany = jest.fn().mockResolvedValue(rows);
        return builder;
      }),
    };
    const engine = {
      reconcileExecution: jest.fn().mockResolvedValue(undefined),
    };
    const inboxMock = inbox ?? {
      apply: jest.fn().mockResolvedValue({
        disposition: "applied",
        executionId: "execution-1",
        stepId: "logical-1",
      }),
    };
    const service = new SupervisionService(
      attempts as any,
      config("reviewer", {
        expected: true,
        startupGraceMs: 30_000,
        staleAfterMs: 30_000,
      }),
      inboxMock as any,
      engine as any,
    );
    return { service, attempts, engine, inbox: inboxMock };
  };

  it("is a no-op when no agent expects events (Milestone-0 compatibility)", async () => {
    const attempts = {
      createQueryBuilder: jest.fn(),
    };
    const service = new SupervisionService(
      attempts as any,
      new SupervisionConfigService({} as NodeJS.ProcessEnv),
      {} as any,
      {} as any,
    );
    await service.evaluate(new Date());
    expect(attempts.createQueryBuilder).not.toHaveBeenCalled();
  });

  it("terminates a DISPATCHED attempt with no events once the acceptance grace elapsed", async () => {
    const { service, inbox, engine } = build([
      attempt({ status: "DISPATCHED" }),
    ]);
    const now = new Date("2026-08-10T00:00:31.000Z"); // 31s after dispatch

    await service.evaluate(now);

    expect(inbox.apply).toHaveBeenCalledWith(
      expect.objectContaining({
        invocationId: "logical-1:1",
        status: "timed_out",
        // Deterministic completion time: persisted dispatch + grace, never now.
        completedAt: "2026-08-10T00:00:30.000Z",
        error: expect.objectContaining({
          code: "AGENT_ACCEPTANCE_TIMEOUT",
          retryable: true,
        }),
      }),
      expect.objectContaining({ adapter: "supervision" }),
    );
    expect(engine.reconcileExecution).toHaveBeenCalledWith("execution-1", {
      projectTerminal: true,
    });
  });

  it("terminates a RUNNING attempt whose heartbeat is stale using persisted heartbeat + staleAfter", async () => {
    const { service, inbox } = build([
      attempt({
        status: "RUNNING",
        dispatchedAt: new Date("2026-08-10T00:00:00.000Z"),
        lastHeartbeatReceivedAt: new Date("2026-08-10T00:01:00.000Z"),
      }),
    ]);
    const now = new Date("2026-08-10T00:01:31.000Z");

    await service.evaluate(now);

    expect(inbox.apply).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "timed_out",
        completedAt: "2026-08-10T00:01:30.000Z",
        error: expect.objectContaining({
          code: "AGENT_HEARTBEAT_STALE",
        }),
      }),
      expect.anything(),
    );
  });

  it("fails a RUNNING attempt that never heartbeated from its persisted startTime", async () => {
    const { service, inbox } = build([
      attempt({
        status: "RUNNING",
        dispatchedAt: new Date("2026-08-10T00:00:00.000Z"),
        startTime: new Date("2026-08-10T00:00:05.000Z"),
        lastEventReceivedAt: new Date("2026-08-10T00:02:00.000Z"),
        lastHeartbeatReceivedAt: null,
      }),
    ]);
    const now = new Date("2026-08-10T00:00:36.000Z");

    await service.evaluate(now);

    // Progress events do not substitute for the heartbeat contract: the
    // deadline is startTime + staleAfter (persisted, deterministic), even
    // though lastEventReceivedAt is recent.
    expect(inbox.apply).toHaveBeenCalledWith(
      expect.objectContaining({
        completedAt: "2026-08-10T00:00:35.000Z",
        error: expect.objectContaining({
          code: "AGENT_HEARTBEAT_STALE",
          message: expect.stringContaining("never heartbeated"),
        }),
      }),
      expect.anything(),
    );
  });

  it("does not time out a RUNNING attempt within staleAfter of its startTime", async () => {
    const { service, inbox } = build([
      attempt({
        status: "RUNNING",
        dispatchedAt: new Date("2026-08-10T00:00:00.000Z"),
        startTime: new Date("2026-08-10T00:00:05.000Z"),
        lastHeartbeatReceivedAt: null,
      }),
    ]);
    await service.evaluate(new Date("2026-08-10T00:00:34.000Z"));
    expect(inbox.apply).not.toHaveBeenCalled();
  });

  it("does not fail an attempt that is not yet due", async () => {
    const { service, inbox } = build([attempt({ status: "DISPATCHED" })]);
    await service.evaluate(new Date("2026-08-10T00:00:20.000Z"));
    expect(inbox.apply).not.toHaveBeenCalled();
  });

  it("isolates one failing candidate from the rest of the batch", async () => {
    const inbox = {
      apply: jest
        .fn()
        .mockRejectedValueOnce(new Error("db blip"))
        .mockResolvedValueOnce({
          disposition: "applied",
          executionId: "execution-1",
          stepId: "logical-1",
        }),
    };
    const { service, engine } = build(
      [attempt({ id: "attempt-1" }), attempt({ id: "attempt-2" })],
      inbox,
    );
    await expect(
      service.evaluate(new Date("2026-08-10T00:00:31.000Z")),
    ).resolves.toBeUndefined();
    expect(inbox.apply).toHaveBeenCalledTimes(2);
    expect(engine.reconcileExecution).toHaveBeenCalledTimes(1);
  });

  it("uses a keyset cursor so a healthy batch cannot starve a later stale candidate", async () => {
    // One full supervision batch of old, continuously-healthy attempts ...
    const healthy = Array.from({ length: SUPERVISION_BATCH }, (_, i) =>
      attempt({
        id: `healthy-${i}`,
        status: "RUNNING",
        dispatchedAt: new Date("2026-08-10T00:00:00.000Z"),
        startTime: new Date("2026-08-10T00:00:00.000Z"),
        lastHeartbeatReceivedAt: new Date("2026-08-10T00:03:20.000Z"),
      }),
    );
    // ... and one later stale attempt that must eventually be visited.
    const stale = attempt({
      id: "stale-101",
      dispatchedAt: new Date("2026-08-10T00:03:00.000Z"),
    });
    const getMany = jest
      .fn()
      .mockResolvedValueOnce(healthy)
      .mockResolvedValueOnce([stale])
      .mockResolvedValue([]);
    const cursorCalls: Array<Record<string, unknown>> = [];
    const builder: any = {};
    for (const method of [
      "where",
      "andWhere",
      "orderBy",
      "addOrderBy",
      "take",
    ]) {
      builder[method] = jest.fn((...args: unknown[]) => {
        const params = args[1] as Record<string, unknown>;
        if (method === "andWhere" && params?.cursorId !== undefined) {
          cursorCalls.push(params);
        }
        return builder;
      });
    }
    builder.getMany = getMany;
    const attempts = { createQueryBuilder: jest.fn(() => builder) };
    const inbox = {
      apply: jest.fn().mockResolvedValue({
        disposition: "applied",
        executionId: "execution-1",
        stepId: "logical-1",
      }),
    };
    const engine = {
      reconcileExecution: jest.fn().mockResolvedValue(undefined),
    };
    const service = new SupervisionService(
      attempts as any,
      config("reviewer", {
        expected: true,
        startupGraceMs: 30_000,
        staleAfterMs: 30_000,
      }),
      inbox as any,
      engine as any,
    );
    const now = new Date("2026-08-10T00:03:31.000Z");

    // Pass 1: only the healthy batch is loaded; nothing is due.
    await service.evaluate(now);
    expect(cursorCalls).toHaveLength(0);
    expect(inbox.apply).not.toHaveBeenCalled();

    // Pass 2: the cursor resumes after the healthy batch and reaches the
    // stale row, which is terminalized.
    await service.evaluate(now);
    expect(cursorCalls).toHaveLength(1);
    expect(cursorCalls[0]).toEqual({ cursorId: "healthy-99" });
    expect(inbox.apply).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "timed_out",
        error: expect.objectContaining({ code: "AGENT_ACCEPTANCE_TIMEOUT" }),
      }),
      expect.anything(),
    );

    // Pass 3: fewer than a batch remained, so the cursor wrapped and the
    // scan restarts from the beginning (idempotent).
    await service.evaluate(now);
    expect(cursorCalls).toHaveLength(1);
  });
});
