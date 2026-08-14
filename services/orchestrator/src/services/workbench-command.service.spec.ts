import { WorkbenchCommandService } from "./workbench-command.service";
import { OperatorActionEntity } from "../entities/operator-action.entity";
import type { CoordinationConfigV1 } from "../domain/coordination";

const teamConfig = (): CoordinationConfigV1 => ({
  schemaVersion: 1,
  planner: { kind: "agent", name: "planner" },
  verifier: { kind: "agent", name: "verifier" },
  allowedWorkers: [{ kind: "agent", name: "implementation" }],
  maxIterations: 3,
  maxWorkersPerIteration: 4,
  maxTotalWorkers: 20,
  loopDeadlineMs: 3_600_000,
  delegationDepthMax: 2,
  allowedExecutors: ["local-host"],
});

class MockDataStore {
  rows = new Map<string, Record<string, unknown>>();
  nextId = 1;
  executeResults = new Map<string, Record<string, unknown>>();

  transaction = async <T>(callback: (manager: MockDataStore) => Promise<T>): Promise<T> =>
    callback(this);

  getRepository(entity?: unknown) {
    const name = (entity as { name?: string } | undefined)?.name;
    if (name === "PipelineEntity") {
      return {
        create: (v: unknown) => v,
        save: async (v: unknown) => v,
      };
    }
    return {
      create: (v: unknown) => v,
      findOne: async ({ where }: { where: Record<string, unknown> }) => {
        const row = [...this.rows.values()].find(
          (candidate) =>
            candidate.action === where.action &&
            candidate.idempotencyKey === where.idempotencyKey,
        );
        return row ? { ...row } : null;
      },
      // P1/M10: the audit insert is INSERT ... ON CONFLICT DO NOTHING —
      // the mock returns identifiers only for the winning insert.
      createQueryBuilder: () => ({
        insert: () => ({
          into: () => ({
            values: (value: Record<string, unknown>) => ({
              orIgnore: () => ({
                execute: async () => {
                  const existing = [...this.rows.values()].find(
                    (candidate) =>
                      candidate.action === value.action &&
                      candidate.idempotencyKey === value.idempotencyKey,
                  );
                  if (existing) return { identifiers: [] };
                  const id = `action-${this.nextId++}`;
                  this.rows.set(id, { id, ...value });
                  return { identifiers: [{ id }] };
                },
              }),
            }),
          }),
        }),
      }),
      update: async (
        { id }: { id: string },
        patch: Record<string, unknown>,
      ) => {
        const existing = this.rows.get(String(id));
        if (existing) this.rows.set(String(id), { ...existing, ...patch });
        return { affected: existing ? 1 : 0 };
      },
      save: async (value: Record<string, unknown>) => {
        const existing = [...this.rows.values()].find(
          (candidate) =>
            candidate.action === value.action &&
            candidate.idempotencyKey === value.idempotencyKey,
        );
        if (existing) {
          if (value.id) {
            // Outcome update on the same row.
            const merged = { ...existing, ...value };
            this.rows.set(String(existing.id), merged);
            return merged;
          }
          // Simulate the real unique index: a second INSERT throws 23505.
          const violation = new Error(
            "duplicate key value violates unique constraint",
          );
          (violation as { code?: string }).code = "23505";
          (violation as { constraint?: string }).constraint =
            "UQ_operator_action_idempotency";
          throw violation;
        }
        const id = `action-${this.nextId++}`;
        const row = { id, ...value };
        this.rows.set(id, row);
        return row;
      },
      find: async ({ order, take }: { order: unknown; take?: number }) => {
        const items = [...this.rows.values()].sort((a, b) =>
          String(a.createdAt) < String(b.createdAt) ? 1 : -1,
        );
        return take ? items.slice(0, take) : items;
      },
    };
  }
}

const makeService = (store: MockDataStore) =>
  new WorkbenchCommandService(
    store as never,
    undefined,
    undefined,
    undefined,
  );

describe("WorkbenchCommandService", () => {
  it("startTeamRun records audit evidence and is exactly-once per idempotency key", async () => {
    const store = new MockDataStore();
    const service = makeService(store);
    // Stub the authority calls inside the transaction.
    (service as any).executionService = {
      materializeExecutionWithManager: jest
        .fn()
        .mockResolvedValue({ id: "execution-1" }),
      cancelExecutionWithManager: jest.fn().mockResolvedValue({}),
    };
    (service as any).coordination = {
      startRunWithManager: jest.fn().mockResolvedValue({ id: "run-1" }),
      createNextIterationWithManager: jest
        .fn()
        .mockResolvedValue({ iterationNumber: 1 }),
      resolveWaitWithManager: jest.fn().mockResolvedValue("PLANNING"),
    };

    const first = await service.startTeamRun({
      idempotencyKey: "launch-1",
      name: "wedge",
      goal: "build the wedge",
      config: teamConfig(),
    });
    expect(first.outcome).toBe("executed");
    expect(first.result).toMatchObject({
      executionId: "execution-1",
      runId: "run-1",
      iterationNumber: 1,
    });
    expect(store.rows.size).toBe(1);
    const stored = [...store.rows.values()][0];
    expect(stored.action).toBe("start-team-run");
    expect(stored.actor).toBe("local-operator");
    expect(JSON.stringify(stored.payload)).not.toContain("credential");

    const duplicate = await service.startTeamRun({
      idempotencyKey: "launch-1",
      name: "wedge",
      goal: "build the wedge",
      config: teamConfig(),
    });
    expect(duplicate.outcome).toBe("duplicate");
    expect((service as any).coordination.startRunWithManager).toHaveBeenCalledTimes(1);
  });

  it("rejects oversized goals and invalid idempotency keys deterministically", async () => {
    const store = new MockDataStore();
    const service = makeService(store);
    await expect(
      service.startTeamRun({
        idempotencyKey: "launch-2",
        name: "wedge",
        goal: "x".repeat(5000),
        config: teamConfig(),
      }),
    ).rejects.toMatchObject({ code: "GOAL_TOO_LARGE" });
    await expect(
      service.startTeamRun({
        idempotencyKey: "bad key!",
        name: "wedge",
        goal: "ok",
        config: teamConfig(),
      }),
    ).rejects.toMatchObject({ code: "INVALID_IDEMPOTENCY_KEY" });
  });

  it("resolveWait and cancelExecution route through existing authority", async () => {
    const store = new MockDataStore();
    const service = makeService(store);
    (service as any).coordination = {
      resolveWaitWithManager: jest.fn().mockResolvedValue("FAILED"),
    };
    (service as any).executionService = {
      cancelExecutionWithManager: jest.fn().mockResolvedValue({}),
    };

    const waited = await service.resolveWait({
      idempotencyKey: "wait-1",
      runId: "run-1",
      approve: false,
    });
    expect(waited.result).toEqual({ runId: "run-1", phase: "FAILED" });

    const cancelled = await service.cancelExecution({
      idempotencyKey: "cancel-1",
      executionId: "execution-1",
    });
    expect(cancelled.result).toMatchObject({ status: "CANCELLED" });
    expect(store.rows.size).toBe(2);
  });

  it("audit trail is bounded and newest first", async () => {
    const store = new MockDataStore();
    const service = makeService(store);
    (service as any).coordination = {
      resolveWaitWithManager: jest.fn().mockResolvedValue("PLANNING"),
    };
    for (let index = 0; index < 5; index++) {
      await service.resolveWait({
        idempotencyKey: `wait-${index}`,
        runId: "run-1",
        approve: true,
      });
    }
    const trail = await service.auditTrail(undefined, 3);
    expect(trail.items).toHaveLength(3);
    expect(trail.truncated).toBe(true);
    expect(trail.items[0].action).toBe("resolve-wait");
  });
});
