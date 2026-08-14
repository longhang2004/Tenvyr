import { RuntimeCoordinationService } from "./runtime-coordination.service";
import { CoordinationRunEntity } from "../entities/coordination-run.entity";
import { CoordinationIterationEntity } from "../entities/coordination-iteration.entity";
import {
  canonicalDecisionHash,
  parseVerifierDecision,
  type CoordinationConfigV1,
  type VerifierDecisionV1,
} from "../domain/coordination";

const config = (): CoordinationConfigV1 => ({
  schemaVersion: 1,
  planner: { kind: "agent", name: "planner" },
  verifier: { kind: "agent", name: "verifier" },
  allowedWorkers: [{ kind: "agent", name: "worker" }],
  maxIterations: 10,
  maxWorkersPerIteration: 4,
  maxTotalWorkers: 20,
  loopDeadlineMs: 3_600_000,
  delegationDepthMax: 2,
  allowedExecutors: ["local-host", "agent:planner", "agent:verifier", "agent:worker"],
});

type RunRow = {
  id: string;
  executionId: string;
  config: CoordinationConfigV1;
  phase: string;
  currentIterationNumber: number;
  cumulativeWorkers: number;
  loopDeadlineAt: Date;
  activeIterationId: string | null;
  waitReason: string | null;
  version: number;
};

type IterationRow = {
  id: string;
  coordinationRunId: string;
  iterationNumber: number;
  plannerAttemptId: string | null;
  plannerProposal: unknown;
  acceptedPlanRevisionId: string | null;
  workerManifest: unknown[];
  verifierStepId: string | null;
  verifierAttemptId: string | null;
  decision: unknown;
  decisionHash: string | null;
  outcome: string | null;
};

class MockManager {
  runs = new Map<string, RunRow>();
  iterations = new Map<string, IterationRow>();
  nextRunId = 1;
  nextIterationId = 1;
  /** Serialize consumeDecision exactly like the run-row FOR UPDATE lock. */
  private runLock: Promise<void> = Promise.resolve();

  constructor(runId: string) {
    this.nextRunId = 2;
    this.runs.set(runId, {
      id: runId,
      executionId: "execution-1",
      config: config(),
      phase: "PLANNING",
      currentIterationNumber: 0,
      cumulativeWorkers: 0,
      loopDeadlineAt: new Date(Date.now() + 3_600_000),
      activeIterationId: null,
      waitReason: null,
      version: 1,
    });
  }

  transaction = async <T>(
    callback: (manager: MockManager) => Promise<T>,
  ): Promise<T> => {
    const previous = this.runLock;
    let release!: () => void;
    this.runLock = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await callback(this);
    } finally {
      release();
    }
  };

  getRepository(entity: unknown) {
    const isRun = entity === CoordinationRunEntity;
    const isIteration = entity === CoordinationIterationEntity;
    return {
      create: (values: Record<string, unknown>) => values,
      findOne: async ({ where }: { where: Record<string, unknown> }) => {
        if (isRun) {
          const row = this.runs.get(String(where.id ?? where.executionId ?? ""));
          const byExecution = [...this.runs.values()].find(
            (candidate) => candidate.executionId === where.executionId,
          );
          const found = row ?? byExecution ?? null;
          return found ? { ...found } : null;
        }
        if (isIteration) {
          const found = [...this.iterations.values()].find(
            (candidate) =>
              candidate.coordinationRunId === where.coordinationRunId &&
              candidate.iterationNumber === where.iterationNumber,
          );
          return found ? { ...found } : null;
        }
        return null;
      },
      save: async (value: unknown) => {
        const row = value as RunRow | IterationRow;
        if (isRun && "executionId" in row) {
          this.runs.set(row.id, { ...row });
          return row;
        }
        if (isIteration && "iterationNumber" in row) {
          const iteration = row as IterationRow;
          if (!iteration.id) {
            iteration.id = `iteration-${this.nextIterationId++}`;
          }
          // Entity column defaults (real TypeORM sets these to null).
          iteration.decisionHash ??= null;
          iteration.decision ??= null;
          iteration.verifierAttemptId ??= null;
          iteration.plannerAttemptId ??= null;
          iteration.acceptedPlanRevisionId ??= null;
          iteration.plannerProposal ??= null;
          iteration.verifierStepId ??= null;
          iteration.outcome ??= null;
          this.iterations.set(iteration.id, { ...iteration });
          return iteration;
        }
        return row;
      },
      createQueryBuilder: () => {
        let builder: Record<string, unknown> = {};
        const chain = {
          setLock: () => chain,
          where: () => chain,
          getOne: () => {
            const row = [...this.runs.values()][0];
            return row ? { ...row } : null;
          },
          update: () => chain,
          set: (values: Record<string, unknown>) => {
            builder = values;
            return chain;
          },
          andWhere: () => chain,
          execute: async () => {
            const iteration = [...this.iterations.values()].find(
              (candidate) =>
                candidate.coordinationRunId === [...this.runs.keys()][0],
            );
            if (!iteration || iteration.decisionHash !== null) return { affected: 0 };
            iteration.decision = builder.decision as VerifierDecisionV1;
            iteration.decisionHash = builder.decisionHash as string;
            if (builder.verifierAttemptId) {
              iteration.verifierAttemptId = builder.verifierAttemptId as string;
            }
            return { affected: 1 };
          },
        };
        return chain;
      },
    };
  }
}

const expectRejected = (fail: () => Promise<unknown>, code: string): Promise<void> =>
  fail().then(
    () => {
      throw new Error("expected rejection");
    },
    (error) => {
      expect(error).toMatchObject({ code });
    },
  );

const decision = (overrides: Partial<VerifierDecisionV1> = {}): VerifierDecisionV1 => ({
  schemaVersion: 1,
  iterationId: "iteration-1",
  iterationNumber: 1,
  action: "CONTINUE",
  reason: "keep going",
  evidenceRefs: [],
  ...overrides,
});

describe("RuntimeCoordinationService", () => {
  it("startRun is idempotent and freezes the parsed config", async () => {
    const manager = new MockManager("run-1");
    const service = new RuntimeCoordinationService({ transaction: manager.transaction, getRepository: (e: unknown) => manager.getRepository(e) } as never);
    manager.runs.delete("run-1");
    manager.runs.set("run-1", {
      id: "run-1",
      executionId: "execution-1",
      config: config(),
      phase: "PLANNING",
      currentIterationNumber: 0,
      cumulativeWorkers: 0,
      loopDeadlineAt: new Date(),
      activeIterationId: null,
      waitReason: null,
      version: 1,
    });
    const first = await service.startRun("execution-1", config(), new Date());
    const second = await service.startRun("execution-1", config(), new Date());
    expect(first.id).toBe(second.id);
    expect(second.phase).toBe("PLANNING");
  });

  it("createNextIteration creates exactly one numbered iteration and sets the active one", async () => {
    const manager = new MockManager("run-1");
    const service = new RuntimeCoordinationService({ transaction: manager.transaction, getRepository: (e: unknown) => manager.getRepository(e) } as never);
    const iteration = await service.createNextIteration("run-1");
    expect(iteration.iterationNumber).toBe(1);
    expect(manager.runs.get("run-1")?.currentIterationNumber).toBe(1);
    expect(manager.runs.get("run-1")?.activeIterationId).toBe(iteration.id);
  });

  it("consumeDecision: CONTINUE consumes once, creates the next iteration, and later deliveries are idempotent", async () => {
    const manager = new MockManager("run-1");
    const service = new RuntimeCoordinationService({ transaction: manager.transaction, getRepository: (e: unknown) => manager.getRepository(e) } as never);
    await service.createNextIteration("run-1");
    const run = manager.runs.get("run-1")!;
    run.phase = "VERIFYING";

    const first = await service.consumeDecision("run-1", decision(), "attempt-v1");
    expect(first).toEqual({ outcome: "consumed", phase: "PLANNING" });
    expect(manager.runs.get("run-1")?.currentIterationNumber).toBe(2);

    const again = await service.consumeDecision("run-1", decision(), "attempt-v1");
    expect(again).toEqual({ outcome: "idempotent", phase: "PLANNING" });
    expect(manager.runs.get("run-1")?.currentIterationNumber).toBe(2);
  });

  it("consumeDecision: same iteration with a different payload is a conflict that changes nothing", async () => {
    const manager = new MockManager("run-1");
    const service = new RuntimeCoordinationService({ transaction: manager.transaction, getRepository: (e: unknown) => manager.getRepository(e) } as never);
    await service.createNextIteration("run-1");
    const run = manager.runs.get("run-1")!;
    run.phase = "VERIFYING";

    await service.consumeDecision("run-1", decision(), "attempt-v1");
    const conflicting = await service.consumeDecision(
      "run-1",
      decision({ reason: "different payload" }),
      "attempt-v1",
    );
    expect(conflicting.outcome).toBe("conflict");
    const stored = [...manager.iterations.values()][0];
    expect(stored.decisionHash).toBe(canonicalDecisionHash(parseVerifierDecision(decision())));
    expect(manager.runs.get("run-1")?.currentIterationNumber).toBe(2);
  });

  it("consumeDecision: stale iteration identity is rejected", async () => {
    const manager = new MockManager("run-1");
    const service = new RuntimeCoordinationService({ transaction: manager.transaction, getRepository: (e: unknown) => manager.getRepository(e) } as never);
    await service.createNextIteration("run-1");
    const run = manager.runs.get("run-1")!;
    run.phase = "VERIFYING";

    await expectRejected(
      () => service.consumeDecision("run-1", decision({ iterationId: "wrong-id" })),
      "DECISION_STALE",
    );
  });

  it("consumeDecision: ACCEPT terminalizes and FAIL/WAIT follow the machine", async () => {
    const manager = new MockManager("run-1");
    const service = new RuntimeCoordinationService({ transaction: manager.transaction, getRepository: (e: unknown) => manager.getRepository(e) } as never);
    await service.createNextIteration("run-1");
    manager.runs.get("run-1")!.phase = "VERIFYING";
    const accepted = await service.consumeDecision("run-1", decision({ action: "ACCEPT" }));
    expect(accepted).toEqual({ outcome: "consumed", phase: "ACCEPTED" });
    expect(await service.isCompletionHeld("execution-1")).toBe(false);

    const manager2 = new MockManager("run-2");
    const service2 = new RuntimeCoordinationService({ transaction: manager2.transaction, getRepository: (e: unknown) => manager2.getRepository(e) } as never);
    await service2.createNextIteration("run-2");
    manager2.runs.get("run-2")!.phase = "VERIFYING";
    const failed = await service2.consumeDecision("run-2", decision({ action: "FAIL" }));
    expect(failed).toEqual({ outcome: "consumed", phase: "FAILED" });

    const manager3 = new MockManager("run-3");
    const service3 = new RuntimeCoordinationService({ transaction: manager3.transaction, getRepository: (e: unknown) => manager3.getRepository(e) } as never);
    await service3.createNextIteration("run-3");
    manager3.runs.get("run-3")!.phase = "VERIFYING";
    const waited = await service3.consumeDecision("run-3", decision({ action: "WAIT_FOR_HUMAN" }));
    expect(waited).toEqual({ outcome: "consumed", phase: "WAITING_FOR_HUMAN" });
    expect(manager3.runs.get("run-3")?.waitReason).toBe("keep going");
  });

  it("completion hold: non-terminal run holds; terminal releases", async () => {
    const manager = new MockManager("run-1");
    const service = new RuntimeCoordinationService({ transaction: manager.transaction, getRepository: (e: unknown) => manager.getRepository(e) } as never);
    expect(await service.isCompletionHeld("execution-1")).toBe(true);
    manager.runs.get("run-1")!.phase = "CANCELLED";
    expect(await service.isCompletionHeld("execution-1")).toBe(false);
  });
});
