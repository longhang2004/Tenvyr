import type { AgentEventMessage } from "../agent-adapters/agent-adapter.types";
import type { AgentResultV1 } from "@tenvyr/contracts";
import { DataSource, In, type DataSourceOptions } from "typeorm";
import { AgentAdapterError } from "../agent-adapters/agent-adapter.errors";
import { DispatchOutboxEntity } from "../entities/dispatch-outbox.entity";
import { ExecutionEntity } from "../entities/execution.entity";
import { ExecutionPlanRevisionEntity } from "../entities/execution-plan-revision.entity";
import { PipelineEntity } from "../entities/pipeline.entity";
import { LogicalStepEntity } from "../entities/step-execution.entity";
import { StepAttemptEntity } from "../entities/step-attempt.entity";
import { ResultConflictEntity } from "../entities/result-conflict.entity";
import { ResultInboxEntity } from "../entities/result-inbox.entity";
import { AgentEventEntity } from "../entities/agent-event.entity";
import { AgentEventConflictEntity } from "../entities/agent-event-conflict.entity";
import { DispatchOutboxService } from "../services/dispatch-outbox.service";
import { AgentEventService } from "../services/agent-event.service";
import { SupervisionConfigService } from "../services/supervision-config.service";
import { SupervisionService } from "../services/supervision.service";
import { EngineService } from "../services/engine.service";
import { ExecutionService } from "../services/execution.service";
import { ResultInboxService } from "../services/result-inbox.service";
import { RuntimeRecoveryService } from "../services/runtime-recovery.service";
import { databaseOptions } from "./database.provider";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

/**
 * The suites below drop and recreate the target database/schema. Refuse to
 * run destructive DDL against the configured application database — the
 * TEST_DATABASE_URL contract is a disposable database.
 */
const assertDisposableTarget = (url: string | undefined): void => {
  // Safe only because both suites are describe.skip when TEST_DATABASE_URL is
  // unset; keep that coupling explicit so a future refactor cannot create an
  // unguarded destructive path.
  if (!url) return;
  // Never echo credentials from the URL into test output.
  const redacted = (value: string): string => {
    try {
      const parsed = new URL(value);
      parsed.username = "";
      parsed.password = "";
      // Query parameters and fragments can also carry credentials; the
      // database name is all the message needs.
      parsed.search = "";
      parsed.hash = "";
      return parsed.toString();
    } catch {
      return "<unparseable url>";
    }
  };
  let database: string;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
      throw new Error(`unsupported scheme ${parsed.protocol}`);
    }
    // pg-connection-string folds database/dbname query parameters into the
    // effective connection target, bypassing the pathname check.
    if (
      parsed.searchParams.has("database") ||
      parsed.searchParams.has("dbname")
    ) {
      throw new Error(
        "database/dbname query parameters are not allowed in TEST_DATABASE_URL",
      );
    }
    database = decodeURIComponent(
      parsed.pathname.replace(/^\/+/, "").replace(/\/+$/, ""),
    ).trim();
  } catch (error) {
    throw new Error(
      `Refusing destructive test DDL: TEST_DATABASE_URL "${redacted(url)}" is not a parseable postgres URL (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  if (!database) {
    throw new Error(
      `Refusing destructive test DDL: TEST_DATABASE_URL "${redacted(url)}" does not name a database`,
    );
  }
  const configured = process.env.POSTGRES_DB || "agentweave";
  if (database.toLowerCase() === configured.toLowerCase()) {
    throw new Error(
      `Refusing destructive test DDL on the configured database "${database}"; TEST_DATABASE_URL must name a disposable database`,
    );
  }
};

/**
 * Real-PostgreSQL durability and concurrency suite. Skipped unless
 * TEST_DATABASE_URL points at a disposable database; the schema is dropped
 * and migrated from scratch per run.
 */
const describeWithPostgres = TEST_DATABASE_URL ? describe : describe.skip;

// Supervision is exercised by its own dedicated tests; recovery-cycle
// construction here uses a no-op evaluator so candidate/deadline behavior
// stays isolated.
const noOpSupervision = () => ({
evaluate: jest.fn().mockResolvedValue(undefined),
});

describeWithPostgres("PostgreSQL integration", () => {
  jest.setTimeout(60_000);

  let dataSource: DataSource;
  let executionService: ExecutionService;
  let inbox: ResultInboxService;
  let outboxService: DispatchOutboxService;

  const pipeline = (name: string, steps: any[] = []) => ({
    name,
    version: "1.0",
    description: "integration fixture",
    steps:
      steps.length > 0
        ? steps
        : [
            { id: "extract", agent: "reader", timeout: "5s" },
            {
              id: "review",
              agent: "reviewer",
              dependsOn: ["extract"],
              timeout: "5s",
            },
          ],
  });

  beforeAll(async () => {
    assertDisposableTarget(TEST_DATABASE_URL);
    dataSource = new DataSource({
      ...databaseOptions(),
      type: "postgres" as const,
      url: TEST_DATABASE_URL,
      logging: process.env.DEBUG_SQL === "1" ? ["query"] : undefined,
    } as DataSourceOptions);
    await dataSource.initialize();
    await dataSource.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await dataSource.runMigrations();
    executionService = new ExecutionService(
      dataSource.getRepository(ExecutionEntity),
      dataSource.getRepository(LogicalStepEntity),
      dataSource.getRepository(StepAttemptEntity),
      dataSource.getRepository(ExecutionPlanRevisionEntity),
      dataSource,
    );
    inbox = new ResultInboxService(dataSource);
    outboxService = new DispatchOutboxService(
      dataSource as any,
      workingAdapter() as any,
    );
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await dataSource.query(
      `TRUNCATE "agent_event_conflicts", "agent_events", "result_conflicts", "result_inbox",
       "dispatch_outbox", "step_attempts",
       "step_executions", "execution_plan_revisions", "executions", "pipelines" CASCADE`,
    );
  });

  const createPipeline = async (name: string, steps?: any[]): Promise<PipelineEntity> => {
    const repository = dataSource.getRepository(PipelineEntity);
    return repository.save(
      repository.create(pipeline(name, steps)) as unknown as PipelineEntity,
    );
  };

  const workingAdapter = () => ({
    kind: "test",
    invoke: jest.fn().mockResolvedValue({
      adapter: "test",
      invocationId: "any",
      dispatchedAt: new Date().toISOString(),
    }),
  });

  const buildEngine = (adapter: any, pipelineId: string): EngineService => {
    const pipelineService = {
      findOne: jest.fn().mockResolvedValue({ id: pipelineId, name: "p" }),
    };
    return new EngineService(
      pipelineService as any,
      executionService as any,
      adapter,
      outboxService,
    );
  };

  const successfulResult = (
    claim: any,
    output: any,
  ): AgentResultV1 => ({
    schemaVersion: "1",
    invocationId: claim.attempt.invocationId,
    executionId: claim.attempt.executionId,
    stepExecutionId: claim.logicalStep.id,
    status: "succeeded",
    output,
    completedAt: new Date().toISOString(),
  });

  it("A: materializes unfrozen PENDING steps; the first claim freezes them", async () => {
    const stored = await createPipeline("materialize");
    const execution = await executionService.createExecution(stored, {
      run: 1,
    });

    const steps = await dataSource.getRepository(LogicalStepEntity).find({
      where: { executionId: execution.id },
      order: { stepId: "ASC" },
    });
    expect(steps.map((step) => step.stepId)).toEqual(["extract", "review"]);
    for (const step of steps) {
      expect(step.status).toBe("PENDING");
      // Materialization is not consumption: nothing is frozen yet.
      expect(step.frozenSpecHash).toBeNull();
      expect(step.frozenAt).toBeNull();
      expect(step.conditionResult).toBeNull();
      expect(step.attempt).toBe(0);
    }
    expect(execution.status).toBe("PENDING");

    // The first claim makes the scheduling decision authoritative.
    await executionService.reconcileExecution(execution.id);
    const claim = await executionService.claimRunnableStep(
      execution.id,
      { id: "extract", agent: "reader" } as any,
      { input: true },
      1,
    );
    expect(claim?.disposition).toBe("claimed");
    const frozen = await dataSource.getRepository(LogicalStepEntity).findOne({
      where: { id: (claim as any).logicalStep.id },
    });
    expect(frozen?.frozenSpecHash).toEqual(expect.any(String));
    expect(frozen?.frozenAt).toEqual(expect.any(Date));
    // The dependent step remains unfrozen until its own decision is made.
    const dependent = steps.find((step) => step.stepId === "review");
    const reloaded = await dataSource.getRepository(LogicalStepEntity).findOne({
      where: { id: dependent!.id },
    });
    expect(reloaded?.frozenSpecHash).toBeNull();
  });

  it("B: PostgreSQL rejects a second active attempt for one logical step", async () => {
    const stored = await createPipeline("partial-unique");
    const execution = await executionService.createExecution(stored, {});
    await executionService.reconcileExecution(execution.id);
    const claim = await executionService.claimRunnableStep(
      execution.id,
      { id: "extract", agent: "reader" } as any,
      { input: true },
      1,
    );
    expect(claim?.disposition).toBe("claimed");

    // Bypass every application pre-check: the partial unique index on
    // (logicalStepId) WHERE status IN (CREATED, DISPATCHED, RUNNING) is the
    // load-bearing guard.
    const attempts = dataSource.getRepository(StepAttemptEntity);
    await expect(
      attempts.save(
        attempts.create({
          executionId: execution.id,
          logicalStepId: (claim as any).logicalStep.id,
          planRevisionId: (claim as any).attempt.planRevisionId,
          attemptNumber: 99,
          invocationId: "forced-second-active",
          frozenSpecHash: "forced",
          executorSnapshot: { agent: "reader" },
          status: "CREATED",
        }),
      ),
    ).rejects.toMatchObject({ code: "23505" });

    const count = await attempts.count({
      where: { executionId: execution.id },
    });
    expect(count).toBe(1);
  });

  it("C: concurrent conflicting terminal results leave exactly one authoritative outcome and conflict evidence", async () => {
    const stored = await createPipeline("conflict-race");
    const execution = await executionService.createExecution(stored, {});
    await executionService.reconcileExecution(execution.id);
    const claim = await executionService.claimRunnableStep(
      execution.id,
      { id: "extract", agent: "reader" } as any,
      { input: true },
      1,
    );
    expect(claim?.disposition).toBe("claimed");

    // Same invocationId, two different valid terminal payloads, in flight at
    // the same time on separate transactions.
    const [first, second] = await Promise.all([
      inbox.apply(successfulResult(claim as any, { value: 1 }), {
        adapter: "http",
        receivedAt: new Date().toISOString(),
        deliveryId: "delivery-1",
        keyId: "key-1",
      }),
      inbox.apply(successfulResult(claim as any, { value: 2 }), {
        adapter: "http",
        receivedAt: new Date().toISOString(),
        deliveryId: "delivery-2",
        keyId: "key-1",
      }),
    ]);

    const dispositions = [first, second]
      .map((application) => application.disposition)
      .sort();
    expect(dispositions).toEqual(["applied", "conflict"]);

    const attempt = await dataSource
      .getRepository(StepAttemptEntity)
      .findOne({ where: { id: (claim as any).attempt.id } });
    expect(attempt?.status).toBe("SUCCESS");
    // The losing payload cannot alter the authoritative outcome.
    const winningHash = (await dataSource.getRepository(ResultInboxEntity).findOne({
      where: { invocationId: (claim as any).attempt.invocationId },
    }))!;
    const conflicts = await dataSource.getRepository(ResultConflictEntity).find({
      where: { invocationId: (claim as any).attempt.invocationId },
    });
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].payloadHash).not.toBe(winningHash.payloadHash);
    const reloaded = await dataSource
      .getRepository(ExecutionEntity)
      .findOne({ where: { id: execution.id } });
    expect(reloaded?.status).toBe("RUNNING");
  });

  it("D: concurrent result-versus-cancel race has exactly one authoritative terminal transition", async () => {
    const stored = await createPipeline("cancel-result-race");
    const execution = await executionService.createExecution(stored, {});
    await executionService.reconcileExecution(execution.id);
    const claim = await executionService.claimRunnableStep(
      execution.id,
      { id: "extract", agent: "reader" } as any,
      { input: true },
      1,
    );
    expect(claim?.disposition).toBe("claimed");

    const [application, cancellation] = await Promise.all([
      inbox.apply(successfulResult(claim as any, { value: 1 }), {
        adapter: "http",
        receivedAt: new Date().toISOString(),
        deliveryId: "delivery-1",
        keyId: "key-1",
      }),
      executionService.cancelExecution(execution.id),
    ]);

    // Both paths serialize on the attempt row. Exactly one of them owns the
    // attempt's terminal transition; the cancel request is authoritative for
    // the run-level transition (the two-step pipeline cannot COMPLETE on one
    // step result).
    const attempt = await dataSource
      .getRepository(StepAttemptEntity)
      .findOne({ where: { id: (claim as any).attempt.id } });
    const step = await dataSource
      .getRepository(LogicalStepEntity)
      .findOne({ where: { id: (claim as any).logicalStep.id } });
    const reloaded = await dataSource
      .getRepository(ExecutionEntity)
      .findOne({ where: { id: execution.id } });

    const resultWon = attempt?.status === "SUCCESS";
    if (resultWon) {
      expect(application.disposition).toBe("applied");
      expect(step?.status).toBe("COMPLETED");
      // The result is recorded; the run-level cancel still wins because the
      // second step was never executed.
      expect(reloaded?.status).toBe("CANCELLED");
    } else {
      expect(attempt?.status).toBe("CANCELLED");
      expect(step?.status).toBe("CANCELLED");
      expect(reloaded?.status).toBe("CANCELLED");
      // The losing result is recorded as rejected evidence, not applied.
      const inboxRow = await dataSource.getRepository(ResultInboxEntity).findOne({
        where: { invocationId: (claim as any).attempt.invocationId },
      });
      expect(inboxRow?.status).toBe("REJECTED");
    }
    expect(cancellation.status).toBe(reloaded?.status);

    // No later reconciliation can revive the run or create new attempts.
    const recovery = new RuntimeRecoveryService(
      dataSource.getRepository(StepAttemptEntity),
      dataSource.getRepository(ExecutionEntity),
      outboxService,
      inbox,
      buildEngine(workingAdapter(), stored.id),
      noOpSupervision() as any,
    );
    await recovery.recover(new Date());
    const attempts = await dataSource.getRepository(StepAttemptEntity).count({
      where: { executionId: execution.id },
    });
    expect(attempts).toBe(1);
    const stillTerminal = await dataSource
      .getRepository(ExecutionEntity)
      .findOne({ where: { id: execution.id } });
    expect(stillTerminal?.status).toBe(reloaded?.status);
    // The second step was cancelled alongside the run and stays cancelled.
    const review = await dataSource
      .getRepository(LogicalStepEntity)
      .findOne({ where: { executionId: execution.id, stepId: "review" } });
    expect(review?.status).toBe("CANCELLED");
  });

  it("E: crash after a durable result commit — a fresh engine reconciles and dispatches dependent work", async () => {
    const stored = await createPipeline("crash-after-result");
    const execution = await executionService.createExecution(stored, {});
    await executionService.reconcileExecution(execution.id);
    const claim = await executionService.claimRunnableStep(
      execution.id,
      { id: "extract", agent: "reader" } as any,
      { input: true },
      1,
    );
    expect(claim?.disposition).toBe("claimed");

    // Persist the terminal result WITHOUT calling resumeAfterResult, exactly
    // like a crash between the inbox commit and post-result continuation.
    const application = await inbox.apply(
      successfulResult(claim as any, { value: 1 }),
      { adapter: "http", receivedAt: new Date().toISOString(), deliveryId: "d-1", keyId: "k-1" },
    );
    expect(application.disposition).toBe("applied");

    // A fresh engine instance (post-restart) reconciles from durable state.
    const freshEngine = buildEngine(workingAdapter(), stored.id);
    await freshEngine.reconcileExecution(execution.id);

    const review = await dataSource.getRepository(LogicalStepEntity).findOne({
      where: { executionId: execution.id, stepId: "review" },
    });
    expect(review?.status).toBe("RUNNING");
    const reviewAttempt = await dataSource
      .getRepository(StepAttemptEntity)
      .findOne({ where: { logicalStepId: review?.id } });
    expect(reviewAttempt).not.toBeNull();
    const outboxRow = await dataSource
      .getRepository(DispatchOutboxEntity)
      .findOne({ where: { stepAttemptId: reviewAttempt?.id } });
    expect(outboxRow?.status).toBe("DISPATCHED");
  });

  it("F: retry recovery creates exactly one new attempt with a new invocationId", async () => {
    const stored = await createPipeline("retry-recovery", [
      { id: "extract", agent: "reader", retries: 1 },
    ]);
    const execution = await executionService.createExecution(stored, {});
    await executionService.reconcileExecution(execution.id);
    const claim = await executionService.claimRunnableStep(
      execution.id,
      { id: "extract", agent: "reader", retries: 1 } as any,
      { input: true },
      2,
    );
    expect(claim?.disposition).toBe("claimed");

    // Durable state left by a crash after a failed attempt: the previous
    // attempt is immutable FAILED, the step is RETRYING with a due
    // nextAttemptAt.
    const attemptRepo = dataSource.getRepository(StepAttemptEntity);
    const failedAttempt = (claim as any).attempt;
    failedAttempt.status = "FAILED";
    failedAttempt.terminalAt = new Date();
    failedAttempt.error = "worker reported failure";
    await attemptRepo.save(failedAttempt);
    const stepRepo = dataSource.getRepository(LogicalStepEntity);
    const step = (claim as any).logicalStep;
    step.status = "RETRYING";
    step.nextAttemptAt = new Date(Date.now() - 1_000);
    step.endTime = null;
    await stepRepo.save(step);

    // Fresh recovery: exactly ONE new attempt, with a NEW invocationId.
    const engine = buildEngine(workingAdapter(), stored.id);
    await engine.reconcileExecution(execution.id);

    const attempts = await attemptRepo.find({
      where: { executionId: execution.id },
      order: { attemptNumber: "ASC" },
    });
    expect(attempts).toHaveLength(2);
    expect(attempts[0].invocationId).toContain(":1");
    expect(attempts[1].invocationId).toContain(":2");
    expect(attempts[1].status).toBe("DISPATCHED");
    // The retry keeps the execution-defining specification of attempt 1.
    expect(attempts[1].frozenSpecHash).toBe(attempts[0].frozenSpecHash);
  });

  it("G: recovery fairness — candidates beyond one batch are visited and terminal rows cannot starve them", async () => {
    const adapter = workingAdapter();
    outboxService = new DispatchOutboxService(dataSource as any, adapter as any);
    const recovery = new RuntimeRecoveryService(
      dataSource.getRepository(StepAttemptEntity),
      dataSource.getRepository(ExecutionEntity),
      outboxService,
      inbox,
      buildEngine(adapter, "unused"),
      noOpSupervision() as any,
    );

    // Oldest of all: a terminal execution whose step row stays READY. Without
    // execution-level filtering it would consume every recovery batch.
    const terminalPipeline = await createPipeline("terminal-stale", [
      { id: "solo", agent: "reader" },
    ]);
    const terminalExecution = await executionService.createExecution(
      terminalPipeline,
      {},
    );
    await executionService.reconcileExecution(terminalExecution.id);
    await dataSource
      .getRepository(ExecutionEntity)
      .createQueryBuilder()
      .update(ExecutionEntity)
      .set({ status: "FAILED", endTime: new Date() })
      .where("id = :id", { id: terminalExecution.id })
      .execute();

    // 120 healthy candidates: more than one recovery batch of 100.
    const healthy = await createPipeline("fairness", [
      { id: "solo", agent: "reader" },
    ]);
    const executionIds: string[] = [];
    for (let index = 0; index < 120; index += 1) {
      const execution = await executionService.createExecution(healthy, {
        index,
      });
      await executionService.reconcileExecution(execution.id);
      executionIds.push(execution.id);
    }

    await recovery.recover(new Date());
    await recovery.recover(new Date());

    const attempts = await dataSource
      .getRepository(StepAttemptEntity)
      .find({ where: { executionId: In(executionIds) } });
    // Every healthy candidate was claimed (and dispatched via the outbox).
    expect(attempts).toHaveLength(120);
    // The terminal execution's stale READY row was never touched.
    const terminalStep = await dataSource
      .getRepository(LogicalStepEntity)
      .findOne({ where: { executionId: terminalExecution.id } });
    expect(terminalStep?.status).toBe("READY");
    const executions = await dataSource.getRepository(ExecutionEntity).find({
      where: { id: In(executionIds) },
    });
    for (const execution of executions) {
      expect(execution.status).toBe("RUNNING");
    }
  });

  it("H1: non-retryable dispatch with stop policy fails outbox, attempt, step, and execution", async () => {
    const stored = await createPipeline("dispatch-stop");
    const execution = await executionService.createExecution(stored, {});
    await executionService.reconcileExecution(execution.id);
    const claim = await executionService.claimRunnableStep(
      execution.id,
      { id: "extract", agent: "reader" } as any,
      { input: true },
      1,
    );
    expect(claim?.disposition).toBe("claimed");

    const adapter = {
      kind: "http",
      invoke: jest.fn().mockRejectedValue(
        new AgentAdapterError(
          "HTTP_REJECTED",
          "http",
          "agent rejected the invocation",
          {
            invocationId: (claim as any).attempt.invocationId,
            retryable: false,
            httpStatus: 400,
          },
        ),
      ),
    };
    const outbox = new DispatchOutboxService(dataSource as any, adapter as any);

    const disposition = await outbox.dispatchNext();

    expect(disposition).toEqual({
      outcome: "terminal_failure",
      executionId: execution.id,
    });
    const attempt = await dataSource
      .getRepository(StepAttemptEntity)
      .findOne({ where: { executionId: execution.id } });
    expect(attempt?.status).toBe("FAILED");
    const outboxRow = await dataSource
      .getRepository(DispatchOutboxEntity)
      .findOne({ where: { stepAttemptId: attempt?.id } });
    expect(outboxRow?.status).toBe("FAILED");
    const step = await dataSource
      .getRepository(LogicalStepEntity)
      .findOne({ where: { executionId: execution.id } });
    expect(step?.status).toBe("FAILED");
    const reloaded = await dataSource
      .getRepository(ExecutionEntity)
      .findOne({ where: { id: execution.id } });
    expect(reloaded?.status).toBe("FAILED");
  });

  it("H2: non-retryable dispatch with continue policy progresses downstream immediately", async () => {
    const adapter = {
      kind: "http",
      invoke: jest
        .fn()
        .mockRejectedValueOnce(
          new AgentAdapterError(
            "HTTP_REJECTED",
            "http",
            "agent rejected the invocation",
            {
              invocationId: "first",
              retryable: false,
              httpStatus: 400,
            },
          ),
        )
        .mockResolvedValue({
          adapter: "http",
          invocationId: "second",
          dispatchedAt: new Date().toISOString(),
        }),
    };
    outboxService = new DispatchOutboxService(dataSource as any, adapter as any);
    const stored = await createPipeline("dispatch-continue", [
      { id: "extract", agent: "reader", onFailure: "continue" },
      { id: "review", agent: "reviewer", dependsOn: ["extract"] },
    ]);
    const execution = await executionService.createExecution(stored, {});
    await executionService.reconcileExecution(execution.id);
    const claim = await executionService.claimRunnableStep(
      execution.id,
      { id: "extract", agent: "reader" } as any,
      { input: true },
      1,
    );
    expect(claim?.disposition).toBe("claimed");

    const disposition = await outboxService.dispatchNext();
    expect(disposition).toEqual({
      outcome: "terminal_failure",
      executionId: execution.id,
    });

    const extract = await dataSource
      .getRepository(LogicalStepEntity)
      .findOne({ where: { executionId: execution.id, stepId: "extract" } });
    expect(extract?.status).toBe("FAILED");
    const reloaded = await dataSource
      .getRepository(ExecutionEntity)
      .findOne({ where: { id: execution.id } });
    expect(reloaded?.status).toBe("RUNNING");

    // The caller reconciles: downstream work must NOT wait for the tick.
    await buildEngine(adapter as any, stored.id).reconcileExecution(execution.id);
    const review = await dataSource
      .getRepository(LogicalStepEntity)
      .findOne({ where: { executionId: execution.id, stepId: "review" } });
    expect(review?.status).toBe("RUNNING");
    const reviewAttempt = await dataSource
      .getRepository(StepAttemptEntity)
      .findOne({ where: { logicalStepId: review?.id } });
    expect(reviewAttempt?.status).toBe("DISPATCHED");
  });

  it("H3: non-retryable dispatch with retry policy schedules a NEW attempt with a NEW invocationId", async () => {
    const adapter = {
      kind: "http",
      invoke: jest
        .fn()
        .mockRejectedValueOnce(
          new AgentAdapterError(
            "HTTP_REJECTED",
            "http",
            "agent rejected the invocation",
            {
              invocationId: "first",
              retryable: false,
              httpStatus: 400,
            },
          ),
        )
        .mockResolvedValue({
          adapter: "http",
          invocationId: "second",
          dispatchedAt: new Date().toISOString(),
        }),
    };
    outboxService = new DispatchOutboxService(dataSource as any, adapter as any);
    const stored = await createPipeline("dispatch-retry", [
      { id: "extract", agent: "reader", retries: 2, onFailure: "retry" },
    ]);
    const execution = await executionService.createExecution(stored, {});
    await executionService.reconcileExecution(execution.id);
    const claim = await executionService.claimRunnableStep(
      execution.id,
      { id: "extract", agent: "reader", retries: 2 } as any,
      { input: true },
      3,
    );
    expect(claim?.disposition).toBe("claimed");

    const disposition = await outboxService.dispatchNext();
    expect(disposition).toEqual({
      outcome: "terminal_failure",
      executionId: execution.id,
    });

    // The workflow retry policy keeps the step RETRYING with a persisted
    // nextAttemptAt instead of redefining retry as stop.
    const step = await dataSource
      .getRepository(LogicalStepEntity)
      .findOne({ where: { executionId: execution.id } });
    expect(step?.status).toBe("RETRYING");
    expect(step?.nextAttemptAt).toEqual(expect.any(Date));
    const reloaded = await dataSource
      .getRepository(ExecutionEntity)
      .findOne({ where: { id: execution.id } });
    expect(reloaded?.status).toBe("RUNNING");

    // Reconciliation creates a NEW attempt with a NEW invocationId (no
    // transport redelivery of the rejected attempt) and dispatches it.
    await buildEngine(adapter as any, stored.id).reconcileExecution(execution.id);
    const attempts = await dataSource.getRepository(StepAttemptEntity).find({
      where: { executionId: execution.id },
      order: { attemptNumber: "ASC" },
    });
    expect(attempts).toHaveLength(2);
    expect(attempts[0].status).toBe("FAILED");
    expect(attempts[1].status).toBe("DISPATCHED");
    expect(attempts[1].invocationId).not.toBe(attempts[0].invocationId);
    // The new attempt retains the frozen specification of the first.
    expect(attempts[1].frozenSpecHash).toBe(attempts[0].frozenSpecHash);
  });

  it("H4: non-retryable dispatch with retry policy exhausted fails the execution", async () => {
    const adapter = {
      kind: "http",
      invoke: jest.fn().mockRejectedValue(
        new AgentAdapterError(
          "HTTP_REJECTED",
          "http",
          "agent rejected the invocation",
          { invocationId: "first", retryable: false, httpStatus: 400 },
        ),
      ),
    };
    outboxService = new DispatchOutboxService(dataSource as any, adapter as any);
    const stored = await createPipeline("dispatch-retry-exhausted", [
      { id: "extract", agent: "reader", retries: 1, onFailure: "retry" },
    ]);
    const execution = await executionService.createExecution(stored, {});
    await executionService.reconcileExecution(execution.id);
    const claim = await executionService.claimRunnableStep(
      execution.id,
      { id: "extract", agent: "reader", retries: 1 } as any,
      { input: true },
      2,
    );
    expect(claim?.disposition).toBe("claimed");

    // First failure -> RETRYING; reconciliation claims attempt 2; the second
    // failure exhausts maxAttempts -> FAILED execution.
    await outboxService.dispatchNext();
    await buildEngine(adapter as any, stored.id).reconcileExecution(execution.id);

    const attempts = await dataSource.getRepository(StepAttemptEntity).find({
      where: { executionId: execution.id },
      order: { attemptNumber: "ASC" },
    });
    expect(attempts).toHaveLength(2);
    expect(attempts.map((attempt) => attempt.status)).toEqual([
      "FAILED",
      "FAILED",
    ]);
    const step = await dataSource
      .getRepository(LogicalStepEntity)
      .findOne({ where: { executionId: execution.id } });
    expect(step?.status).toBe("FAILED");
    const reloaded = await dataSource
      .getRepository(ExecutionEntity)
      .findOne({ where: { id: execution.id } });
    expect(reloaded?.status).toBe("FAILED");
  });

  it("E2: crash after the final result commit — recovery completes a single-step execution", async () => {
    const stored = await createPipeline("crash-final-result", [
      { id: "solo", agent: "reader" },
    ]);
    const execution = await executionService.createExecution(stored, {});
    await executionService.reconcileExecution(execution.id);
    const claim = await executionService.claimRunnableStep(
      execution.id,
      { id: "solo", agent: "reader" } as any,
      { input: true },
      1,
    );
    expect(claim?.disposition).toBe("claimed");

    // The last step's terminal result commits; the process dies before any
    // post-result continuation. All steps are terminal but the execution row
    // is still RUNNING.
    const application = await inbox.apply(
      successfulResult(claim as any, { value: 1 }),
      { adapter: "http", receivedAt: new Date().toISOString(), deliveryId: "d-1", keyId: "k-1" },
    );
    expect(application.disposition).toBe("applied");
    const running = await dataSource
      .getRepository(ExecutionEntity)
      .findOne({ where: { id: execution.id } });
    expect(running?.status).toBe("RUNNING");

    // Fresh recovery must discover the run as a completion candidate and
    // finish it from durable state alone.
    const recovery = new RuntimeRecoveryService(
      dataSource.getRepository(StepAttemptEntity),
      dataSource.getRepository(ExecutionEntity),
      outboxService,
      inbox,
      buildEngine(workingAdapter(), stored.id),
      noOpSupervision() as any,
    );
    await recovery.recover(new Date());
    await recovery.recover(new Date());

    const completed = await dataSource
      .getRepository(ExecutionEntity)
      .findOne({ where: { id: execution.id } });
    expect(completed?.status).toBe("COMPLETED");
    expect(completed?.output).toEqual({ solo: { value: 1 } });
  });

  it("claim-to-dispatch affinity: A's reconcile dispatches A's own outbox, never B's older record", async () => {
    const stored = await createPipeline("dispatch-affinity", [
      { id: "solo", agent: "reader" },
    ]);

    // Execution B first: its claim leaves an OLDER PENDING outbox record.
    const b = await executionService.createExecution(stored, {});
    await executionService.reconcileExecution(b.id);
    const claimB = await executionService.claimRunnableStep(
      b.id,
      { id: "solo", agent: "reader" } as any,
      { input: true },
      1,
    );
    expect(claimB?.disposition).toBe("claimed");
    const bOutboxBefore = await dataSource
      .getRepository(DispatchOutboxEntity)
      .findOne({ where: { stepAttemptId: (claimB as any).attempt.id } });
    expect(bOutboxBefore?.status).toBe("PENDING");

    // Reconcile A: the immediate dispatch must target A's NEW attempt row.
    const a = await executionService.createExecution(stored, {});
    const adapter = workingAdapter();
    outboxService = new DispatchOutboxService(dataSource as any, adapter as any);
    await buildEngine(adapter as any, stored.id).reconcileExecution(a.id);

    expect(adapter.invoke).toHaveBeenCalledTimes(1);
    expect(adapter.invoke.mock.calls[0][0].executionId).toBe(a.id);
    const aAttempt = await dataSource
      .getRepository(StepAttemptEntity)
      .findOne({ where: { executionId: a.id } });
    expect(aAttempt?.status).toBe("DISPATCHED");
    // B's older record was NOT stolen by A's claim-specific dispatch.
    const bOutbox = await dataSource
      .getRepository(DispatchOutboxEntity)
      .findOne({ where: { stepAttemptId: (claimB as any).attempt.id } });
    expect(bOutbox?.status).toBe("PENDING");
    const bAttempt = await dataSource
      .getRepository(StepAttemptEntity)
      .findOne({ where: { id: (claimB as any).attempt.id } });
    expect(bAttempt?.status).toBe("CREATED");

    // Global recovery drains B's record with the SAME invocationId.
    const summary = await outboxService.recover();
    expect(summary.dispatched).toBe(1);
    const bAttemptAfter = await dataSource
      .getRepository(StepAttemptEntity)
      .findOne({ where: { id: (claimB as any).attempt.id } });
    expect(bAttemptAfter?.status).toBe("DISPATCHED");
    expect(bAttemptAfter?.invocationId).toBe((claimB as any).attempt.invocationId);
  });

  it("a non-retryable failure of B's older outbox is attributed to B, never to the execution being reconciled", async () => {
    const stored = await createPipeline("dispatch-attribution", [
      { id: "solo", agent: "reader" },
    ]);

    const b = await executionService.createExecution(stored, {});
    await executionService.reconcileExecution(b.id);
    const claimB = await executionService.claimRunnableStep(
      b.id,
      { id: "solo", agent: "reader" } as any,
      { input: true },
      1,
    );
    expect(claimB?.disposition).toBe("claimed");
    const bInvocationId = (claimB as any).attempt.invocationId;

    const a = await executionService.createExecution(stored, {});
    const adapter = {
      kind: "http",
      invoke: jest.fn().mockImplementation(async (invocation: any) => {
        if (invocation.invocationId === bInvocationId) {
          throw new AgentAdapterError(
            "HTTP_REJECTED",
            "http",
            "agent rejected the invocation",
            { invocationId: bInvocationId, retryable: false, httpStatus: 400 },
          );
        }
        return {
          adapter: "http",
          invocationId: invocation.invocationId,
          dispatchedAt: new Date().toISOString(),
        };
      }),
    };
    outboxService = new DispatchOutboxService(dataSource as any, adapter as any);
    await buildEngine(adapter as any, stored.id).reconcileExecution(a.id);

    // A's own outbox is independently correct.
    const aAttempt = await dataSource
      .getRepository(StepAttemptEntity)
      .findOne({ where: { executionId: a.id } });
    expect(aAttempt?.status).toBe("DISPATCHED");
    const aReloaded = await dataSource
      .getRepository(ExecutionEntity)
      .findOne({ where: { id: a.id } });
    expect(aReloaded?.status).toBe("RUNNING");

    // The global drain hits B's older record; the failure is B's.
    const summary = await outboxService.recover();
    expect(summary.terminalFailures).toEqual([b.id]);
    const bAttempt = await dataSource
      .getRepository(StepAttemptEntity)
      .findOne({ where: { id: (claimB as any).attempt.id } });
    expect(bAttempt?.status).toBe("FAILED");
    const bStep = await dataSource
      .getRepository(LogicalStepEntity)
      .findOne({ where: { executionId: b.id } });
    expect(bStep?.status).toBe("FAILED");
    const bReloaded = await dataSource
      .getRepository(ExecutionEntity)
      .findOne({ where: { id: b.id } });
    expect(bReloaded?.status).toBe("FAILED");
    // A was not reconciled as though the failure belonged to it.
    const aReloadedAfter = await dataSource
      .getRepository(ExecutionEntity)
      .findOne({ where: { id: a.id } });
    expect(aReloadedAfter?.status).toBe("RUNNING");
    const aStep = await dataSource
      .getRepository(LogicalStepEntity)
      .findOne({ where: { executionId: a.id } });
    expect(aStep?.status).toBe("RUNNING");
  });

  it("outbox fairness: one retryable poison record does not block healthy records behind it", async () => {
    const stored = await createPipeline("outbox-fairness", [
      { id: "solo", agent: "reader" },
    ]);
    const a = await executionService.createExecution(stored, {});
    await executionService.reconcileExecution(a.id);
    const claimA = await executionService.claimRunnableStep(
      a.id,
      { id: "solo", agent: "reader" } as any,
      { input: true },
      1,
    );
    const aInvocationId = (claimA as any).attempt.invocationId;
    const b = await executionService.createExecution(stored, {});
    await executionService.reconcileExecution(b.id);
    const claimB = await executionService.claimRunnableStep(
      b.id,
      { id: "solo", agent: "reader" } as any,
      { input: true },
      1,
    );
    const c = await executionService.createExecution(stored, {});
    await executionService.reconcileExecution(c.id);
    const claimC = await executionService.claimRunnableStep(
      c.id,
      { id: "solo", agent: "reader" } as any,
      { input: true },
      1,
    );

    // A is the OLDEST record and always fails retryably; B and C are healthy.
    const adapter = {
      kind: "http",
      invoke: jest.fn().mockImplementation(async (invocation: any) => {
        if (invocation.invocationId === aInvocationId) {
          throw new Error("producer unavailable");
        }
        return {
          adapter: "http",
          invocationId: invocation.invocationId,
          dispatchedAt: new Date().toISOString(),
        };
      }),
    };
    outboxService = new DispatchOutboxService(dataSource as any, adapter as any);

    const summary = await outboxService.recover();

    // A's retryable failure did not stop the drain: B and C dispatched.
    expect(summary).toEqual({
      dispatched: 2,
      terminalFailures: [],
      retryableFailures: 1,
    });
    const aOutbox = await dataSource
      .getRepository(DispatchOutboxEntity)
      .findOne({ where: { stepAttemptId: (claimA as any).attempt.id } });
    expect(aOutbox?.status).toBe("PENDING");
    expect(aOutbox?.nextDispatchAt.getTime()).toBeGreaterThan(Date.now());
    const bOutbox = await dataSource
      .getRepository(DispatchOutboxEntity)
      .findOne({ where: { stepAttemptId: (claimB as any).attempt.id } });
    expect(bOutbox?.status).toBe("DISPATCHED");
    const cOutbox = await dataSource
      .getRepository(DispatchOutboxEntity)
      .findOne({ where: { stepAttemptId: (claimC as any).attempt.id } });
    expect(cOutbox?.status).toBe("DISPATCHED");
    // No new StepAttempt was invented for A.
    const aAttempts = await dataSource.getRepository(StepAttemptEntity).find({
      where: { executionId: a.id },
    });
    expect(aAttempts).toHaveLength(1);

    // The next eligible retry of A reuses the SAME attempt and invocationId.
    await dataSource
      .getRepository(DispatchOutboxEntity)
      .createQueryBuilder()
      .update(DispatchOutboxEntity)
      .set({ nextDispatchAt: new Date(Date.now() - 1_000) })
      .where('"stepAttemptId" = :id', { id: (claimA as any).attempt.id })
      .execute();
    const retrySummary = await outboxService.recover();
    expect(retrySummary.retryableFailures).toBe(1);
    const aAttemptsAfter = await dataSource.getRepository(StepAttemptEntity).find({
      where: { executionId: a.id },
    });
    expect(aAttemptsAfter).toHaveLength(1);
    expect(aAttemptsAfter[0].invocationId).toBe(aInvocationId);
    const aOutboxAfter = await dataSource
      .getRepository(DispatchOutboxEntity)
      .findOne({ where: { stepAttemptId: (claimA as any).attempt.id } });
    expect(aOutboxAfter?.status).toBe("PENDING");
    expect(aOutboxAfter?.nextDispatchAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("claims only due dispatch records: expired leases are reclaimed, terminal-attempt records never are", async () => {    const adapter = workingAdapter();
    outboxService = new DispatchOutboxService(dataSource as any, adapter as any);
    const stored = await createPipeline("lease-reclaim", [
      { id: "solo", agent: "reader" },
    ]);

    // Execution A: live attempt whose outbox lease expired -> must be
    // reclaimed and dispatched.
    const a = await executionService.createExecution(stored, {});
    await executionService.reconcileExecution(a.id);
    const claimA = await executionService.claimRunnableStep(
      a.id,
      { id: "solo", agent: "reader" } as any,
      { input: true },
      1,
    );
    await dataSource
      .getRepository(DispatchOutboxEntity)
      .createQueryBuilder()
      .update(DispatchOutboxEntity)
      .set({ status: "LEASED", leaseExpiresAt: new Date(Date.now() - 1_000) })
      .where('"stepAttemptId" = :id', { id: (claimA as any).attempt.id })
      .execute();

    // Execution B: PENDING record with a future nextDispatchAt -> not due.
    const b = await executionService.createExecution(stored, {});
    await executionService.reconcileExecution(b.id);
    const claimB = await executionService.claimRunnableStep(
      b.id,
      { id: "solo", agent: "reader" } as any,
      { input: true },
      1,
    );
    await dataSource
      .getRepository(DispatchOutboxEntity)
      .createQueryBuilder()
      .update(DispatchOutboxEntity)
      .set({ nextDispatchAt: new Date(Date.now() + 60_000) })
      .where('"stepAttemptId" = :id', { id: (claimB as any).attempt.id })
      .execute();

    // Execution C: terminal attempt with a PENDING outbox row (crash window)
    // -> the terminal filter must exclude it even though the status predicate
    // matches.
    const c = await executionService.createExecution(stored, {});
    await executionService.reconcileExecution(c.id);
    const claimC = await executionService.claimRunnableStep(
      c.id,
      { id: "solo", agent: "reader" } as any,
      { input: true },
      1,
    );
    const cAttempt = (claimC as any).attempt;
    cAttempt.status = "FAILED";
    cAttempt.terminalAt = new Date();
    await dataSource.getRepository(StepAttemptEntity).save(cAttempt);

    const disposition = await outboxService.dispatchNext();

    // Only A's expired lease was claimed and dispatched; B is not due yet and
    // C's record belongs to a terminal attempt.
    expect(disposition).toEqual({ outcome: "dispatched" });
    expect(adapter.invoke).toHaveBeenCalledTimes(1);
    const aAttempt = await dataSource
      .getRepository(StepAttemptEntity)
      .findOne({ where: { id: (claimA as any).attempt.id } });
    expect(aAttempt?.status).toBe("DISPATCHED");
    const bOutbox = await dataSource.getRepository(DispatchOutboxEntity).findOne({
      where: { stepAttemptId: (claimB as any).attempt.id },
    });
    expect(bOutbox?.status).toBe("PENDING");
    const cOutbox = await dataSource.getRepository(DispatchOutboxEntity).findOne({
      where: { stepAttemptId: cAttempt.id },
    });
    expect(cOutbox?.status).toBe("PENDING");
    const cAttemptReloaded = await dataSource
      .getRepository(StepAttemptEntity)
      .findOne({ where: { id: cAttempt.id } });
    expect(cAttemptReloaded?.status).toBe("FAILED");
  });

  const eventService = () =>
    new AgentEventService(
      dataSource,
      dataSource.getRepository(AgentEventEntity),
    );

  const supervisionFor = (agent: string, expectation: Record<string, unknown>) =>
    new SupervisionService(
      dataSource.getRepository(StepAttemptEntity),
      new SupervisionConfigService({
        ...process.env,
        ORCHESTRATOR_SUPERVISION_CONFIG: JSON.stringify({
          [agent]: { heartbeat: expectation },
        }),
      }),
      inbox,
      buildEngine(workingAdapter(), "unused") as any,
    );

  const canonicalEvent = (
    attemptRow: StepAttemptEntity,
    overrides: Record<string, unknown> = {},
  ): AgentEventMessage => {
    return {
      event: {
        schemaVersion: "1",
        eventId: "event-1",
        invocationId: attemptRow.invocationId,
        executionId: attemptRow.executionId,
        stepExecutionId: attemptRow.logicalStepId,
        sequence: 1,
        type: "progress",
        occurredAt: new Date().toISOString(),
        payload: { stage: "indexing" },
        trace: { traceId: "execution-1", correlationId: attemptRow.invocationId },
        ...overrides,
      } as any,
      transport: {
        adapter: "http",
        receivedAt: new Date().toISOString(),
        // Each delivery is a distinct transport identity; the same deliveryId
        // for different events would collide on the transport unique index.
        deliveryId: `delivery-${(overrides.eventId as string) ?? "event-1"}`,
        keyId: "key-1",
      },
    };
  };

  const claimDispatchedAttempt = async (
    stored: PipelineEntity,
    agent: string,
  ) => {
    const execution = await executionService.createExecution(stored, {});
    await executionService.reconcileExecution(execution.id);
    const claim = await executionService.claimRunnableStep(
      execution.id,
      { id: "solo", agent } as any,
      { input: true },
      1,
    );
    expect(claim?.disposition).toBe("claimed");
    const adapter = workingAdapter();
    outboxService = new DispatchOutboxService(dataSource as any, adapter as any);
    await outboxService.dispatchAttempt((claim as any).attempt.id);
    const attempt = await dataSource
      .getRepository(StepAttemptEntity)
      .findOne({ where: { id: (claim as any).attempt.id } });
    expect(attempt?.status).toBe("DISPATCHED");
    return { execution, attempt: attempt! };
  };

  it("I1: two concurrent identical AgentEvents store one canonical row and one duplicate", async () => {
    const stored = await createPipeline("events-dedup", [
      { id: "solo", agent: "reader" },
    ]);
    const { attempt } = await claimDispatchedAttempt(stored, "reader");
    const message = canonicalEvent(attempt);
    const service = eventService();

    const [first, second] = await Promise.all([
      service.apply(message.event, message.transport),
      service.apply(message.event, message.transport),
    ]);

    expect([first.disposition, second.disposition].sort()).toEqual([
      "applied",
      "duplicate",
    ]);
    const rows = await dataSource
      .getRepository(AgentEventEntity)
      .find({ where: { stepAttemptId: attempt.id } });
    expect(rows).toHaveLength(1);
  });

  it("I2: same eventId with a different payload keeps the canonical event and retains conflict evidence", async () => {
    const stored = await createPipeline("events-conflict", [
      { id: "solo", agent: "reader" },
    ]);
    const { attempt } = await claimDispatchedAttempt(stored, "reader");
    const service = eventService();
    const message = canonicalEvent(attempt);
    await service.apply(message.event, message.transport);

    const conflicting = canonicalEvent(attempt, { payload: { stage: "done" } });
    const application = await service.apply(
      conflicting.event,
      conflicting.transport,
    );

    expect(application.disposition).toBe("conflict");
    const rows = await dataSource
      .getRepository(AgentEventEntity)
      .find({ where: { stepAttemptId: attempt.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0].payload).toEqual({ stage: "indexing" });
    const conflicts = await dataSource
      .getRepository(AgentEventConflictEntity)
      .find({ where: { stepAttemptId: attempt.id } });
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].conflictKind).toBe("event_id_payload");
  });

  it("I3: different eventIds claiming one sequence retain one owner and conflict evidence", async () => {
    const stored = await createPipeline("events-sequence", [
      { id: "solo", agent: "reader" },
    ]);
    const { attempt } = await claimDispatchedAttempt(stored, "reader");
    const service = eventService();
    const first = canonicalEvent(attempt);
    await service.apply(first.event, first.transport);

    const second = canonicalEvent(attempt, { eventId: "event-other" });
    const application = await service.apply(second.event, second.transport);

    expect(application.disposition).toBe("conflict");
    const rows = await dataSource
      .getRepository(AgentEventEntity)
      .find({ where: { stepAttemptId: attempt.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0].eventId).toBe("event-1");
    const conflicts = await dataSource
      .getRepository(AgentEventConflictEntity)
      .find({ where: { stepAttemptId: attempt.id } });
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].conflictKind).toBe("sequence_owner");
  });

  it("I4: out-of-order events are all stored — no contiguous-sequence gate", async () => {
    const stored = await createPipeline("events-out-of-order", [
      { id: "solo", agent: "reader" },
    ]);
    const { attempt } = await claimDispatchedAttempt(stored, "reader");
    const service = eventService();

    for (const sequence of [3, 1, 2]) {
      const message = canonicalEvent(attempt, {
        eventId: `event-${sequence}`,
        sequence,
      });
      const application = await service.apply(message.event, message.transport);
      expect(application.disposition).toBe("applied");
    }
    const rows = await dataSource
      .getRepository(AgentEventEntity)
      .find({ where: { stepAttemptId: attempt.id }, order: { sequence: "ASC" } });
    expect(rows.map((row) => row.sequence)).toEqual([1, 2, 3]);
  });

  it("I5: a late event after a terminal result is retained without changing the attempt or execution", async () => {
    const stored = await createPipeline("events-late", [
      { id: "solo", agent: "reader" },
    ]);
    const { execution, attempt } = await claimDispatchedAttempt(stored, "reader");
    const result: AgentResultV1 = {
      schemaVersion: "1",
      invocationId: attempt.invocationId,
      executionId: attempt.executionId,
      stepExecutionId: attempt.logicalStepId,
      status: "succeeded",
      output: { ok: true },
      completedAt: new Date().toISOString(),
    };
    await inbox.apply(result, {
      adapter: "http",
      receivedAt: new Date().toISOString(),
      deliveryId: "result-delivery",
      keyId: "key-1",
    });

    const service = eventService();
    const message = canonicalEvent(attempt, { type: "heartbeat" });
    const application = await service.apply(message.event, message.transport);

    expect(application.disposition).toBe("applied");
    const rows = await dataSource
      .getRepository(AgentEventEntity)
      .find({ where: { stepAttemptId: attempt.id } });
    expect(rows).toHaveLength(1);
    const reloaded = await dataSource
      .getRepository(StepAttemptEntity)
      .findOne({ where: { id: attempt.id } });
    expect(reloaded?.status).toBe("SUCCESS");
    expect(reloaded?.lastHeartbeatReceivedAt).toBeNull();
    const executionRow = await dataSource
      .getRepository(ExecutionEntity)
      .findOne({ where: { id: execution.id } });
    expect(executionRow?.status).toBe("RUNNING");
  });

  it("I6: a valid event transitions DISPATCHED -> RUNNING exactly once", async () => {
    const stored = await createPipeline("events-running", [
      { id: "solo", agent: "reader" },
    ]);
    const { attempt } = await claimDispatchedAttempt(stored, "reader");
    const service = eventService();
    const message = canonicalEvent(attempt, { type: "accepted" });

    const [first, second] = await Promise.all([
      service.apply(message.event, message.transport),
      service.apply(message.event, message.transport),
    ]);

    expect([first.disposition, second.disposition].sort()).toEqual([
      "applied",
      "duplicate",
    ]);
    const reloaded = await dataSource
      .getRepository(StepAttemptEntity)
      .findOne({ where: { id: attempt.id } });
    expect(reloaded?.status).toBe("RUNNING");
    expect(reloaded?.acceptedAt).toEqual(expect.any(Date));
    expect(reloaded?.lastEventReceivedAt).toEqual(expect.any(Date));
  });

  it("I7: the same Kafka offset on different partitions does not collide on transport dedup", async () => {
    const stored = await createPipeline("events-partitions", [
      { id: "solo", agent: "reader" },
    ]);
    const { attempt } = await claimDispatchedAttempt(stored, "reader");
    const service = eventService();
    const first = canonicalEvent(attempt, { eventId: "event-p0" });
    const second = canonicalEvent(attempt, { eventId: "event-p1", sequence: 2 });

    const a = await service.apply(first.event, {
      adapter: "kafka",
      receivedAt: new Date().toISOString(),
      topic: "agentweave.agent.reader.event",
      partition: 0,
      offset: "41",
    });
    const b = await service.apply(second.event, {
      adapter: "kafka",
      receivedAt: new Date().toISOString(),
      topic: "agentweave.agent.reader.event",
      partition: 1,
      offset: "41",
    });

    expect(a.disposition).toBe("applied");
    expect(b.disposition).toBe("applied");
    const rows = await dataSource
      .getRepository(AgentEventEntity)
      .find({ where: { stepAttemptId: attempt.id }, order: { sequence: "ASC" } });
    expect(rows.map((row) => row.eventId)).toEqual(["event-p0", "event-p1"]);
  });

  it("J1: acceptance timeout produces a deterministic synthetic result through the ResultInbox", async () => {
    const stored = await createPipeline("watchdog-acceptance", [
      { id: "solo", agent: "watchdog-agent" },
    ]);
    const { execution, attempt } = await claimDispatchedAttempt(stored, "watchdog-agent");
    const supervision = supervisionFor("watchdog-agent", {
      expected: true,
      startupGraceMs: 30_000,
      staleAfterMs: 30_000,
    });
    const dispatchTime = attempt.dispatchedAt as Date;

    // Before the grace window: untouched.
    await supervision.evaluate(new Date(dispatchTime.getTime() + 29_000));
    const notDue = await dataSource
      .getRepository(StepAttemptEntity)
      .findOne({ where: { id: attempt.id } });
    expect(notDue?.status).toBe("DISPATCHED");

    // After the grace window: deterministic synthetic terminal result.
    await supervision.evaluate(new Date(dispatchTime.getTime() + 31_000));
    const timedOut = await dataSource
      .getRepository(StepAttemptEntity)
      .findOne({ where: { id: attempt.id } });
    expect(timedOut?.status).toBe("TIMED_OUT");
    expect(timedOut?.error).toContain("AGENT_ACCEPTANCE_TIMEOUT");
    const executionRow = await dataSource
      .getRepository(ExecutionEntity)
      .findOne({ where: { id: execution.id } });
    expect(executionRow?.status).toBe("FAILED");
  });

  it("J2: stale heartbeat fails a RUNNING attempt at lastHeartbeat + staleAfter", async () => {
    const stored = await createPipeline("watchdog-stale", [
      { id: "solo", agent: "watchdog-agent" },
    ]);
    const { execution, attempt } = await claimDispatchedAttempt(stored, "watchdog-agent");
    const service = eventService();
    // Heartbeat at T.
    const heartbeat = canonicalEvent(attempt, {
      eventId: "hb-1",
      sequence: 1,
      type: "heartbeat",
    });
    await service.apply(heartbeat.event, heartbeat.transport);
    const heartbeatAt = new Date();
    const supervision = supervisionFor("watchdog-agent", {
      expected: true,
      startupGraceMs: 30_000,
      staleAfterMs: 10_000,
    });

    await supervision.evaluate(new Date(heartbeatAt.getTime() + 9_000));
    const stillRunning = await dataSource
      .getRepository(StepAttemptEntity)
      .findOne({ where: { id: attempt.id } });
    expect(stillRunning?.status).toBe("RUNNING");

    await supervision.evaluate(new Date(heartbeatAt.getTime() + 11_000));
    const timedOut = await dataSource
      .getRepository(StepAttemptEntity)
      .findOne({ where: { id: attempt.id } });
    expect(timedOut?.status).toBe("TIMED_OUT");
    expect(timedOut?.error).toContain("AGENT_HEARTBEAT_STALE");
    const executionRow = await dataSource
      .getRepository(ExecutionEntity)
      .findOne({ where: { id: execution.id } });
    expect(executionRow?.status).toBe("FAILED");
  });

  it("J3: two supervisor replicas evaluating the same stale attempt produce one canonical result", async () => {
    const stored = await createPipeline("watchdog-replicas", [
      { id: "solo", agent: "watchdog-agent" },
    ]);
    const { execution, attempt } = await claimDispatchedAttempt(stored, "watchdog-agent");
    const service = eventService();
    await service.apply(
      canonicalEvent(attempt, { eventId: "hb-1", sequence: 1, type: "heartbeat" }).event,
      canonicalEvent(attempt, { eventId: "hb-1", sequence: 1, type: "heartbeat" }).transport,
    );
    const heartbeatAt = new Date();
    const first = supervisionFor("watchdog-agent", {
      expected: true,
      startupGraceMs: 30_000,
      staleAfterMs: 10_000,
    });
    const second = supervisionFor("watchdog-agent", {
      expected: true,
      startupGraceMs: 30_000,
      staleAfterMs: 10_000,
    });

    await Promise.all([
      first.evaluate(new Date(heartbeatAt.getTime() + 11_000)),
      second.evaluate(new Date(heartbeatAt.getTime() + 11_000)),
    ]);

    const attempts = await dataSource.getRepository(StepAttemptEntity).find({
      where: { executionId: execution.id },
    });
    expect(attempts).toHaveLength(1);
    expect(attempts[0].status).toBe("TIMED_OUT");
    const conflicts = await dataSource
      .getRepository(ResultConflictEntity)
      .find({ where: { invocationId: attempt.invocationId } });
    expect(conflicts).toHaveLength(0);
    const inboxRows = await dataSource
      .getRepository(ResultInboxEntity)
      .find({ where: { invocationId: attempt.invocationId } });
    expect(inboxRows).toHaveLength(1);
    expect(inboxRows[0].status).toBe("APPLIED");
  });

  it("J4: a real AgentResult racing the watchdog result keeps the first authoritative transition and no revival", async () => {
    const stored = await createPipeline("watchdog-vs-result", [
      { id: "solo", agent: "watchdog-agent" },
    ]);
    const { execution, attempt } = await claimDispatchedAttempt(stored, "watchdog-agent");
    const service = eventService();
    await service.apply(
      canonicalEvent(attempt, { eventId: "hb-1", sequence: 1, type: "heartbeat" }).event,
      canonicalEvent(attempt, { eventId: "hb-1", sequence: 1, type: "heartbeat" }).transport,
    );
    const heartbeatAt = new Date();
    const supervision = supervisionFor("watchdog-agent", {
      expected: true,
      startupGraceMs: 30_000,
      staleAfterMs: 10_000,
    });
    const realResult: AgentResultV1 = {
      schemaVersion: "1",
      invocationId: attempt.invocationId,
      executionId: attempt.executionId,
      stepExecutionId: attempt.logicalStepId,
      status: "succeeded",
      output: { ok: true },
      completedAt: new Date().toISOString(),
    };

    const [watchdog, real] = await Promise.all([
      supervision.evaluate(new Date(heartbeatAt.getTime() + 11_000)),
      inbox.apply(realResult, {
        adapter: "http",
        receivedAt: new Date().toISOString(),
        deliveryId: "race-delivery",
        keyId: "key-1",
      }),
    ]);
    void watchdog;

    const reloaded = await dataSource
      .getRepository(StepAttemptEntity)
      .findOne({ where: { id: attempt.id } });
    // First authoritative terminal transition wins; both outcomes are
    // consistent (SUCCESS or TIMED_OUT) and the execution cannot be revived.
    expect(["SUCCESS", "TIMED_OUT"]).toContain(reloaded?.status);
    expect(real.disposition).not.toBe("ignored");
    // The result path does not complete executions itself; recovery-style
    // reconciliation settles the run from durable state, then no later
    // watchdog evaluation can revive it.
    await buildEngine(workingAdapter(), stored.id).reconcileExecution(execution.id);
    const executionRow = await dataSource
      .getRepository(ExecutionEntity)
      .findOne({ where: { id: execution.id } });
    expect(["COMPLETED", "FAILED"]).toContain(executionRow?.status);
    await supervision.evaluate(new Date(heartbeatAt.getTime() + 60_000));
    const attempts = await dataSource.getRepository(StepAttemptEntity).find({
      where: { executionId: execution.id },
    });
    expect(attempts).toHaveLength(1);
  });

  it("J5: cancellation racing the watchdog result keeps terminal truth consistent", async () => {
    const stored = await createPipeline("watchdog-vs-cancel", [
      { id: "solo", agent: "watchdog-agent" },
    ]);
    const { execution, attempt } = await claimDispatchedAttempt(stored, "watchdog-agent");
    const service = eventService();
    await service.apply(
      canonicalEvent(attempt, { eventId: "hb-1", sequence: 1, type: "heartbeat" }).event,
      canonicalEvent(attempt, { eventId: "hb-1", sequence: 1, type: "heartbeat" }).transport,
    );
    const heartbeatAt = new Date();
    const supervision = supervisionFor("watchdog-agent", {
      expected: true,
      startupGraceMs: 30_000,
      staleAfterMs: 10_000,
    });

    await Promise.all([
      supervision.evaluate(new Date(heartbeatAt.getTime() + 11_000)),
      executionService.cancelExecution(execution.id),
    ]);

    const reloaded = await dataSource
      .getRepository(StepAttemptEntity)
      .findOne({ where: { id: attempt.id } });
    expect(["TIMED_OUT", "CANCELLED"]).toContain(reloaded?.status);
    const executionRow = await dataSource
      .getRepository(ExecutionEntity)
      .findOne({ where: { id: execution.id } });
    expect(executionRow?.status).toBe("CANCELLED");
    const attempts = await dataSource.getRepository(StepAttemptEntity).count({
      where: { executionId: execution.id },
    });
    expect(attempts).toBe(1);
  });

  it("J7: a RUNNING attempt that never heartbeats is failed via the last-event baseline", async () => {
    const stored = await createPipeline("watchdog-no-heartbeat", [
      { id: "solo", agent: "watchdog-agent" },
    ]);
    const { execution, attempt } = await claimDispatchedAttempt(
      stored,
      "watchdog-agent",
    );
    const service = eventService();
    // The worker accepts and reports progress but never emits a heartbeat.
    const accepted = canonicalEvent(attempt, {
      eventId: "accepted-1",
      sequence: 0,
      type: "accepted",
    });
    await service.apply(accepted.event, accepted.transport);
    const progress = canonicalEvent(attempt, {
      eventId: "progress-1",
      sequence: 1,
      type: "progress",
    });
    await service.apply(progress.event, progress.transport);
    const lastEventAt = new Date();
    const supervision = supervisionFor("watchdog-agent", {
      expected: true,
      startupGraceMs: 30_000,
      staleAfterMs: 10_000,
    });

    // Still within staleAfter of the last event: untouched.
    await supervision.evaluate(new Date(lastEventAt.getTime() + 9_000));
    const alive = await dataSource
      .getRepository(StepAttemptEntity)
      .findOne({ where: { id: attempt.id } });
    expect(alive?.status).toBe("RUNNING");

    // No heartbeat ever arrived: the last-event baseline expires.
    await supervision.evaluate(new Date(lastEventAt.getTime() + 11_000));
    const timedOut = await dataSource
      .getRepository(StepAttemptEntity)
      .findOne({ where: { id: attempt.id } });
    expect(timedOut?.status).toBe("TIMED_OUT");
    expect(timedOut?.error).toContain("AGENT_HEARTBEAT_STALE");
    const executionRow = await dataSource
      .getRepository(ExecutionEntity)
      .findOne({ where: { id: execution.id } });
    expect(executionRow?.status).toBe("FAILED");
  });

  it("J6: agents without heartbeat expectations are never failed for emitting no events", async () => {
    const stored = await createPipeline("watchdog-compat", [
      { id: "solo", agent: "plain-agent" },
    ]);
    const { execution, attempt } = await claimDispatchedAttempt(stored, "plain-agent");
    const supervision = supervisionFor("watchdog-agent", {
      expected: true,
      startupGraceMs: 1,
      staleAfterMs: 1,
    });

    await supervision.evaluate(new Date(Date.now() + 60_000));
    await supervision.evaluate(new Date(Date.now() + 120_000));

    const reloaded = await dataSource
      .getRepository(StepAttemptEntity)
      .findOne({ where: { id: attempt.id } });
    expect(reloaded?.status).toBe("DISPATCHED");
    const executionRow = await dataSource
      .getRepository(ExecutionEntity)
      .findOne({ where: { id: execution.id } });
    expect(executionRow?.status).toBe("RUNNING");
  });

  it("reconcileExecution promotes a stuck PENDING execution and advances eligible steps", async () => {
    const stored = await createPipeline("reconcile-promote");
    const execution = await executionService.createExecution(stored, {
      run: 1,
    });

    // Simulates a crash between creation and the first scheduling pass.
    const result = await executionService.reconcileExecution(execution.id);

    expect(result).toEqual({
      promoted: true,
      backfilled: 0,
      advanced: 1,
    });
    const reloaded = await dataSource
      .getRepository(ExecutionEntity)
      .findOne({ where: { id: execution.id } });
    expect(reloaded?.status).toBe("RUNNING");
    const steps = await dataSource.getRepository(LogicalStepEntity).find({
      where: { executionId: execution.id },
    });
    expect(
      steps.find((step) => step.stepId === "extract")?.status,
    ).toBe("READY");
    // The dependent step stays PENDING until "extract" is terminal.
    expect(steps.find((step) => step.stepId === "review")?.status).toBe(
      "PENDING",
    );
  });

  it("scheduling updates the materialized row and never inserts a second one", async () => {
    const stored = await createPipeline("claim-existing");
    const execution = await executionService.createExecution(stored, {});
    await executionService.reconcileExecution(execution.id);

    const claim = await executionService.claimRunnableStep(
      execution.id,
      { id: "extract", agent: "reader", timeout: "5s" } as any,
      { input: true },
      1,
      new Date(Date.now() + 5_000),
    );

    expect(claim?.disposition).toBe("claimed");
    const stepRows = await dataSource.getRepository(LogicalStepEntity).count({
      where: { executionId: execution.id },
    });
    expect(stepRows).toBe(2);
    const attempts = await dataSource.getRepository(StepAttemptEntity).find({
      where: { executionId: execution.id },
    });
    expect(attempts).toHaveLength(1);
    expect(attempts[0].invocationId).toBe(`${claim!.logicalStep.id}:1`);
    const outboxRows = await dataSource
      .getRepository(DispatchOutboxEntity)
      .count({ where: { stepAttemptId: attempts[0].id } });
    expect(outboxRows).toBe(1);
  });

  it("concurrent claims on the same step yield exactly one winner", async () => {
    const stored = await createPipeline("concurrent-claim");
    const execution = await executionService.createExecution(stored, {});
    await executionService.reconcileExecution(execution.id);

    const [first, second] = await Promise.all([
      executionService.claimRunnableStep(
        execution.id,
        { id: "extract", agent: "reader" } as any,
        { a: 1 },
        1,
      ),
      executionService.claimRunnableStep(
        execution.id,
        { id: "extract", agent: "reader" } as any,
        { a: 1 },
        1,
      ),
    ]);

    const winners = [first, second].filter(
      (claim) => claim?.disposition === "claimed",
    );
    expect(winners).toHaveLength(1);
    const attempts = await dataSource.getRepository(StepAttemptEntity).count({
      where: { executionId: execution.id },
    });
    expect(attempts).toBe(1);
  });

  it("deduplicates identical synthetic timeout results from concurrent replicas", async () => {
    const stored = await createPipeline("timeout-dedupe");
    const execution = await executionService.createExecution(stored, {});
    await executionService.reconcileExecution(execution.id);
    const deadline = new Date(Date.now() - 1_000);
    const claim = await executionService.claimRunnableStep(
      execution.id,
      { id: "extract", agent: "reader" } as any,
      { input: true },
      1,
      deadline,
    );
    expect(claim?.disposition).toBe("claimed");

    // Two replicas time out the same attempt in the same tick; the payload is
    // deterministic (completedAt = persisted deadline) so the second delivery
    // deduplicates instead of recording a conflict.
    const timeoutResult: AgentResultV1 = {
      schemaVersion: "1",
      invocationId: (claim as any).attempt.invocationId,
      executionId: execution.id,
      stepExecutionId: (claim as any).logicalStep.id,
      status: "timed_out",
      error: {
        code: "DEADLINE_EXCEEDED",
        message: "Persisted attempt deadline exceeded",
        retryable: true,
      },
      completedAt: deadline.toISOString(),
    };
    const [first, second] = await Promise.all([
      inbox.apply(timeoutResult, {
        adapter: "recovery",
        receivedAt: new Date().toISOString(),
      }),
      inbox.apply(timeoutResult, {
        adapter: "recovery",
        receivedAt: new Date().toISOString(),
      }),
    ]);

    const dispositions = [first, second]
      .map((application) => application.disposition)
      .sort();
    expect(dispositions).toEqual(["applied", "duplicate"]);
    const attempt = await dataSource
      .getRepository(StepAttemptEntity)
      .findOne({ where: { executionId: execution.id } });
    expect(attempt?.status).toBe("TIMED_OUT");
    const reloaded = await dataSource
      .getRepository(ExecutionEntity)
      .findOne({ where: { id: execution.id } });
    expect(reloaded?.status).toBe("FAILED");
  });
});

const LEGACY_DATABASE = "tenvyr_m0_legacy";
const describeWithPostgresLegacy = TEST_DATABASE_URL ? describe : describe.skip;

/**
 * Legacy adoption suite: builds a REAL pre-Milestone-0 synchronized schema in
 * a disposable database, seeds representative rows, runs the MilestoneZero
 * migration against it, and proves the backfill never fabricates attempts and
 * never writes invalid StepAttempt statuses.
 */
describeWithPostgresLegacy("PostgreSQL legacy schema adoption", () => {
  jest.setTimeout(60_000);

  let legacy: DataSource;
  const legacyUrl = TEST_DATABASE_URL
    ? (() => {
        const url = new URL(TEST_DATABASE_URL);
        url.pathname = `/${LEGACY_DATABASE}`;
        return url.toString();
      })()
    : "";

  beforeAll(async () => {
    assertDisposableTarget(TEST_DATABASE_URL);
    if (
      (process.env.POSTGRES_DB || "agentweave").toLowerCase() ===
      LEGACY_DATABASE
    ) {
      throw new Error(
        `Refusing to drop "${LEGACY_DATABASE}": it is the configured application database`,
      );
    }
    const admin = new DataSource({
      ...databaseOptions(),
      type: "postgres" as const,
      url: TEST_DATABASE_URL,
    } as DataSourceOptions);
    await admin.initialize();
    await admin.query(`DROP DATABASE IF EXISTS ${LEGACY_DATABASE} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${LEGACY_DATABASE}`);
    await admin.destroy();

    legacy = new DataSource({
      ...databaseOptions(),
      type: "postgres" as const,
      url: legacyUrl,
      // The legacy schema must be created FIRST; migrations run explicitly
      // after seeding, not on initialize.
      migrationsRun: false,
    } as DataSourceOptions);
    await legacy.initialize();

    // The fresh legacy database is a genuine pre-Milestone-0 TypeORM-
    // synchronized database, whose uuid primary keys default to
    // uuid_generate_v4() — so the uuid-ossp extension must exist BEFORE the
    // legacy tables are created. The MilestoneZero migration (which also
    // creates the extension) runs only later, after seeding, and must not be
    // moved earlier: this fixture has to prove adoption from a genuinely
    // legacy table/column shape, not from partially-migrated state.
    await legacy.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);

    // The pre-Milestone-0 synchronized schema: exactly the columns the old
    // entities wrote (TypeORM synchronize output). No M0 columns exist.
    await legacy.query(`
      CREATE TABLE "pipelines" (
        "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "name" varchar(255) NOT NULL,
        "version" varchar(50) NOT NULL,
        "description" text,
        "steps" jsonb NOT NULL,
        "createdAt" timestamp NOT NULL DEFAULT now(),
        "updatedAt" timestamp NOT NULL DEFAULT now()
      )
    `);
    await legacy.query(`
      CREATE TABLE "executions" (
        "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "pipelineId" uuid NOT NULL,
        "status" varchar(50) NOT NULL DEFAULT 'PENDING',
        "input" jsonb NOT NULL,
        "output" jsonb,
        "startTime" timestamp,
        "endTime" timestamp,
        "createdAt" timestamp NOT NULL DEFAULT now(),
        "updatedAt" timestamp NOT NULL DEFAULT now()
      )
    `);
    await legacy.query(`
      CREATE TABLE "step_executions" (
        "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "executionId" uuid NOT NULL,
        "stepId" varchar(100) NOT NULL,
        "agent" varchar(100) NOT NULL,
        "status" varchar(50) NOT NULL DEFAULT 'PENDING',
        "input" jsonb,
        "output" jsonb,
        "error" text,
        "attempt" integer NOT NULL DEFAULT 0,
        "maxAttempts" integer NOT NULL DEFAULT 0,
        "startTime" timestamp,
        "endTime" timestamp,
        "createdAt" timestamp NOT NULL DEFAULT now(),
        "updatedAt" timestamp NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_step_executions_execution_step" UNIQUE ("executionId", "stepId")
      )
    `);

    // Seed: one RUNNING execution covering every legacy shape, plus a second
    // RUNNING execution with never-attempted work only.
    const pipelineId = "00000000-0000-0000-0000-000000000001";
    // Legacy pipelines.steps was a bare array (PipelineEntity.steps), not a
    // {schemaVersion, steps} wrapper.
    await legacy.query(
      `INSERT INTO "pipelines" ("id", "name", "version", "steps")
       VALUES ($1, 'legacy', '1.0', $2)`,
      [
        pipelineId,
        JSON.stringify([
          { id: "pending0", agent: "alpha" },
          { id: "running", agent: "alpha" },
          { id: "completed", agent: "alpha" },
          { id: "failed", agent: "alpha" },
          { id: "skipped", agent: "alpha" },
          { id: "cancelled", agent: "alpha" },
          { id: "pending3", agent: "alpha" },
        ]),
      ],
    );
    const ex1 = "00000000-0000-0000-0000-000000000101";
    const ex2 = "00000000-0000-0000-0000-000000000102";
    const ex3 = "00000000-0000-0000-0000-000000000103";
    // ex2 gets its own single-step pipeline so reconciliation has exactly one
    // real first attempt to create (the plan-revision backfill materializes
    // every plan step by design). ex3 isolates ambiguous scheduling rows from
    // the stop-policy semantics of ex1's FAILED legacy step.
    const pipeline2Id = "00000000-0000-0000-0000-000000000002";
    const pipeline3Id = "00000000-0000-0000-0000-000000000003";
    await legacy.query(
      `INSERT INTO "pipelines" ("id", "name", "version", "steps")
       VALUES ($1, 'legacy-single', '1.0', $2), ($3, 'legacy-ambiguous', '1.0', $4)`,
      [
        pipeline2Id,
        JSON.stringify([{ id: "pending0", agent: "alpha" }]),
        pipeline3Id,
        JSON.stringify([
          { id: "pending0", agent: "alpha" },
          { id: "pending3", agent: "alpha" },
        ]),
      ],
    );
    await legacy.query(
      `INSERT INTO "executions" ("id", "pipelineId", "status", "input", "startTime")
       VALUES ($1, $2, 'RUNNING', '{}', now()), ($3, $4, 'RUNNING', '{}', now()),
              ($5, $6, 'RUNNING', '{}', now())`,
      [ex1, pipelineId, ex2, pipeline2Id, ex3, pipeline3Id],
    );
    const seedStep = async (
      id: string,
      stepId: string,
      status: string,
      attempt: number,
      startTime?: string,
    ) => {
      await legacy.query(
        `INSERT INTO "step_executions"
           ("id", "executionId", "stepId", "agent", "status", "input", "attempt", "maxAttempts", "startTime", "endTime")
         VALUES ($1, $2, $3, 'alpha', $4, '{}', $5, 3, $6, NULL)`,
        [
          id,
          ex1,
          stepId,
          status,
          attempt,
          startTime ?? null,
        ],
      );
    };
    await seedStep("00000000-0000-0000-0000-000000000201", "pending0", "PENDING", 0);
    await seedStep("00000000-0000-0000-0000-000000000202", "running", "RUNNING", 1, "2026-08-01T00:00:00.000Z");
    await seedStep("00000000-0000-0000-0000-000000000203", "completed", "COMPLETED", 1, "2026-08-01T00:00:00.000Z");
    await seedStep("00000000-0000-0000-0000-000000000204", "failed", "FAILED", 2, "2026-08-01T00:00:00.000Z");
    await seedStep("00000000-0000-0000-0000-000000000205", "skipped", "SKIPPED", 0);
    await seedStep("00000000-0000-0000-0000-000000000206", "cancelled", "CANCELLED", 1, "2026-08-01T00:00:00.000Z");
    await seedStep("00000000-0000-0000-0000-000000000207", "pending3", "PENDING", 3);
    await legacy.query(
      `INSERT INTO "step_executions"
         ("id", "executionId", "stepId", "agent", "status", "input", "attempt", "maxAttempts")
       VALUES ($1, $2, 'pending0', 'alpha', 'PENDING', '{}', 0, 3)`,
      ["00000000-0000-0000-0000-000000000301", ex2],
    );
    await legacy.query(
      `INSERT INTO "step_executions"
         ("id", "executionId", "stepId", "agent", "status", "input", "attempt", "maxAttempts")
       VALUES ($1, $2, 'pending0', 'alpha', 'PENDING', '{}', 0, 3),
              ($3, $2, 'pending3', 'alpha', 'PENDING', '{}', 3, 3)`,
      ["00000000-0000-0000-0000-000000000401", ex3, "00000000-0000-0000-0000-000000000402"],
    );

    // Run the actual MilestoneZeroFoundation migration against this schema.
    await legacy.runMigrations();
  });

  afterAll(async () => {
    await legacy?.destroy();
  });

  it("backfills only evidence-backed attempts with valid statuses", async () => {
    const attempts = await legacy.query(
      `SELECT s."stepId", a."status", a."attemptNumber"
       FROM "step_attempts" a
       JOIN "step_executions" s ON s."id" = a."logicalStepId"
       ORDER BY s."stepId"`,
    );
    // COMPLETED->SUCCESS, FAILED->FAILED, CANCELLED->CANCELLED, RUNNING->RUNNING.
    expect(attempts).toEqual([
      { stepId: "cancelled", status: "CANCELLED", attemptNumber: 1 },
      { stepId: "completed", status: "SUCCESS", attemptNumber: 1 },
      { stepId: "failed", status: "FAILED", attemptNumber: 2 },
      { stepId: "running", status: "RUNNING", attemptNumber: 1 },
    ]);
    // No fabricated attempt for never-attempted or ambiguous scheduling rows.
    const fabricated = await legacy.query(
      `SELECT COUNT(*)::int AS n
       FROM "step_attempts" a
       JOIN "step_executions" s ON s."id" = a."logicalStepId"
       WHERE s."stepId" IN ('pending0', 'skipped', 'pending3')`,
    );
    expect(fabricated[0].n).toBe(0);
    // Every migrated status is a valid StepAttempt status.
    const invalid = await legacy.query(
      `SELECT COUNT(*)::int AS n FROM "step_attempts"
       WHERE "status" NOT IN
         ('CREATED', 'DISPATCHED', 'RUNNING', 'SUCCESS', 'FAILED', 'TIMED_OUT', 'CANCELLED')`,
    );
    expect(invalid[0].n).toBe(0);
    // Invocation ids follow the current convention logicalStepId:attemptNumber.
    const invocation = await legacy.query(
      `SELECT "invocationId" FROM "step_attempts" ORDER BY "createdAt"`,
    );
    for (const row of invocation) {
      expect(row.invocationId).toMatch(/^[0-9a-f-]+:[0-9]+$/);
    }
    // The migrated in-flight attempt carries a grace deadline so recovery can
    // settle it instead of pinning the step forever.
    const running = await legacy.query(
      `SELECT "deadlineAt", "terminalAt" FROM "step_attempts"
       WHERE "status" = 'RUNNING'`,
    );
    expect(running).toHaveLength(1);
    expect(running[0].deadlineAt).toEqual(expect.any(Date));
    expect(running[0].terminalAt).toBeNull();
    // Terminal backfills always carry a terminalAt, even for legacy CANCELLED
    // rows that never persisted endTime.
    const terminals = await legacy.query(
      `SELECT COUNT(*)::int AS n FROM "step_attempts"
       WHERE "status" IN ('SUCCESS', 'FAILED', 'CANCELLED') AND "terminalAt" IS NULL`,
    );
    expect(terminals[0].n).toBe(0);
  });

  it("backfills valid plan revisions and current entity reads succeed", async () => {
    const revisions = await legacy.query(
      `SELECT "source", "plan" FROM "execution_plan_revisions"`,
    );
    // One revision per legacy execution.
    expect(revisions).toHaveLength(3);
    const stepCounts = revisions
      .map((revision: any) => (revision.plan as any).steps.length)
      .sort();
    expect(stepCounts).toEqual([1, 2, 7]);
    for (const revision of revisions) {
      expect(revision.source).toBe("legacy_backfill");
    }
    const executions = await legacy.query(
      `SELECT "activePlanRevisionId" FROM "executions"`,
    );
    expect(executions.every((row: any) => row.activePlanRevisionId)).toBe(true);
    // The partial unique active-attempt index exists and is valid.
    const index = await legacy.query(
      `SELECT COUNT(*)::int AS n FROM pg_indexes WHERE indexname = 'UQ_step_attempt_active'`,
    );
    expect(index[0].n).toBe(1);

    const service = new ExecutionService(
      legacy.getRepository(ExecutionEntity),
      legacy.getRepository(LogicalStepEntity),
      legacy.getRepository(StepAttemptEntity),
      legacy.getRepository(ExecutionPlanRevisionEntity),
      legacy,
    );
    const steps = await service.getStepExecutions(
      "00000000-0000-0000-0000-000000000101",
    );
    expect(steps).toHaveLength(7);
    const planSteps = await service.getExecutionPlanSteps(
      "00000000-0000-0000-0000-000000000101",
    );
    expect(planSteps).toHaveLength(7);
  });

  it("never-attempted legacy work stays attempt-free and current reconciliation creates its real first attempt", async () => {
    const executionId = "00000000-0000-0000-0000-000000000102";
    const before = await legacy
      .getRepository(StepAttemptEntity)
      .count({ where: { executionId } });
    expect(before).toBe(0);

    const adapter = {
      kind: "test",
      invoke: jest.fn().mockResolvedValue({
        adapter: "test",
        invocationId: "any",
        dispatchedAt: new Date().toISOString(),
      }),
    };
    const service = new ExecutionService(
      legacy.getRepository(ExecutionEntity),
      legacy.getRepository(LogicalStepEntity),
      legacy.getRepository(StepAttemptEntity),
      legacy.getRepository(ExecutionPlanRevisionEntity),
      legacy,
    );
    const outbox = new DispatchOutboxService(legacy as any, adapter as any);
    const engine = new EngineService(
      { findOne: jest.fn().mockResolvedValue({ id: "legacy-pipeline" }) } as any,
      service as any,
      adapter as any,
      outbox,
    );

    await engine.reconcileExecution(executionId);

    // Exactly one real attempt #1, dispatched through the outbox.
    const attempts = await legacy.getRepository(StepAttemptEntity).find({
      where: { executionId },
      order: { attemptNumber: "ASC" },
    });
    expect(attempts).toHaveLength(1);
    expect(attempts[0].attemptNumber).toBe(1);
    expect(attempts[0].invocationId).toContain(":1");
    expect(attempts[0].status).toBe("DISPATCHED");
    const step = await legacy
      .getRepository(LogicalStepEntity)
      .findOne({ where: { executionId } });
    expect(step?.status).toBe("RUNNING");
    // The claim froze the spec — materialization rules apply to legacy rows too.
    expect(step?.frozenSpecHash).toEqual(expect.any(String));
  });

  it("a migrated legacy in-flight attempt is settled by deadline recovery, never stuck forever", async () => {
    const executionId = "00000000-0000-0000-0000-000000000101";
    const service = new ExecutionService(
      legacy.getRepository(ExecutionEntity),
      legacy.getRepository(LogicalStepEntity),
      legacy.getRepository(StepAttemptEntity),
      legacy.getRepository(ExecutionPlanRevisionEntity),
      legacy,
    );
    const adapter = {
      kind: "test",
      invoke: jest.fn().mockResolvedValue({
        adapter: "test",
        invocationId: "any",
        dispatchedAt: new Date().toISOString(),
      }),
    };
    const outbox = new DispatchOutboxService(legacy as any, adapter as any);
    const inbox = new ResultInboxService(legacy);
    const recovery = new RuntimeRecoveryService(
      legacy.getRepository(StepAttemptEntity),
      legacy.getRepository(ExecutionEntity),
      outbox,
      inbox,
      new EngineService({ findOne: jest.fn() } as any, service as any, adapter as any, outbox),
      noOpSupervision() as any,
    );

    // Past the grace window: recovery expires the migrated RUNNING attempt
    // deterministically (deadline-based synthetic timeout, same invocationId).
    // The candidate scan is stubbed so this focused test cannot disturb the
    // sibling legacy tests' scheduling state.
    (recovery as any).reconcileCandidateExecutions = jest
      .fn()
      .mockResolvedValue(undefined);
    await recovery.recover(new Date(Date.now() + 3_600_000));

    const running = await service.getStepExecution(executionId, "running");
    const runningAttempts = await service.getStepAttempts(running!.id);
    expect(runningAttempts).toHaveLength(1);
    expect(runningAttempts[0].status).toBe("TIMED_OUT");
    // No onFailure: retry semantics default to stop, so the run reaches a
    // terminal policy outcome instead of hanging.
    expect(running?.status).toBe("FAILED");
    const reloaded = await legacy
      .getRepository(ExecutionEntity)
      .findOne({ where: { id: executionId } });
    expect(reloaded?.status).toBe("FAILED");
  });

  it("ambiguous legacy scheduling rows do not block a later real attempt", async () => {
    const executionId = "00000000-0000-0000-0000-000000000103";
    const service = new ExecutionService(
      legacy.getRepository(ExecutionEntity),
      legacy.getRepository(LogicalStepEntity),
      legacy.getRepository(StepAttemptEntity),
      legacy.getRepository(ExecutionPlanRevisionEntity),
      legacy,
    );
    const adapter = {
      kind: "test",
      invoke: jest.fn().mockResolvedValue({
        adapter: "test",
        invocationId: "any",
        dispatchedAt: new Date().toISOString(),
      }),
    };
    const outbox = new DispatchOutboxService(legacy as any, adapter as any);
    const engine = new EngineService(
      { findOne: jest.fn() } as any,
      service as any,
      adapter as any,
      outbox,
    );

    // Reconcile the legacy RUNNING execution: the never-attempted row claims
    // attempt #1 and the ambiguous counter row claims attempt #4 (counter+1).
    await engine.reconcileExecution(executionId);

    const pending0 = await service.getStepExecution(executionId, "pending0");
    const pending0Attempts = await service.getStepAttempts(pending0!.id);
    expect(pending0Attempts).toHaveLength(1);
    expect(pending0Attempts[0].attemptNumber).toBe(1);

    const pending3 = await service.getStepExecution(executionId, "pending3");
    const pending3Attempts = await service.getStepAttempts(pending3!.id);
    expect(pending3Attempts).toHaveLength(1);
    expect(pending3Attempts[0].attemptNumber).toBe(4);
  });
});
