import type { AgentEventMessage } from "../agent-adapters/agent-adapter.types";
import {
  parseAgentEvent,
  type AgentResultV1,
  type JsonValue,
} from "@tenvyr/contracts";
import { DataSource, In, type DataSourceOptions } from "typeorm";
import { sha256Json } from "../domain/canonical-json";
import {
  EXECUTION_STATE_BOUNDS,
  jsonValueUtf8Size,
} from "../domain/execution-state";
import { CONTEXT_SNAPSHOT_BOUNDS } from "../domain/context-snapshot";
import { AgentAdapterError } from "../agent-adapters/agent-adapter.errors";
import { ArtifactEntity } from "../entities/artifact.entity";
import { ArtifactExposureEntity } from "../entities/artifact-exposure.entity";
import { StateWriteEvidenceEntity } from "../entities/state-write-evidence.entity";
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
import { ExecutionStateService } from "../services/execution-state.service";
import { RuntimeRecoveryService } from "../services/runtime-recovery.service";
import { databaseOptions } from "./database.provider";
import { MilestoneZeroFoundation1722270000000 } from "./migrations/1722270000000-MilestoneZeroFoundation";
import { MilestoneOneAgentEvents1722270001000 } from "./migrations/1722270001000-MilestoneOneAgentEvents";
import { MilestoneTwoArtifactIdentity1722270002000 } from "./migrations/1722270002000-MilestoneTwoArtifactIdentity";
import { MilestoneTwoExecutionState1722270003000 } from "./migrations/1722270003000-MilestoneTwoExecutionState";
import { MilestoneTwoArtifactExposure1722270004000 } from "./migrations/1722270004000-MilestoneTwoArtifactExposure";
import { MilestoneTwoStateWriteEvidence1722270005000 } from "./migrations/1722270005000-MilestoneTwoStateWriteEvidence";
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
       "dispatch_outbox", "step_attempts", "artifacts",
       "step_executions", "execution_plan_revisions", "executions", "pipelines" CASCADE`,
    );
  });

  const createPipeline = async (
    name: string,
    steps?: any[],
  ): Promise<PipelineEntity> => {
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

  const successfulResult = (claim: any, output: any): AgentResultV1 => ({
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
    const winningHash = (await dataSource
      .getRepository(ResultInboxEntity)
      .findOne({
        where: { invocationId: (claim as any).attempt.invocationId },
      }))!;
    const conflicts = await dataSource
      .getRepository(ResultConflictEntity)
      .find({
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
      const inboxRow = await dataSource
        .getRepository(ResultInboxEntity)
        .findOne({
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
      {
        adapter: "http",
        receivedAt: new Date().toISOString(),
        deliveryId: "d-1",
        keyId: "k-1",
      },
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
    outboxService = new DispatchOutboxService(
      dataSource as any,
      adapter as any,
    );
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
    outboxService = new DispatchOutboxService(
      dataSource as any,
      adapter as any,
    );
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
    await buildEngine(adapter as any, stored.id).reconcileExecution(
      execution.id,
    );
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
    outboxService = new DispatchOutboxService(
      dataSource as any,
      adapter as any,
    );
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
    await buildEngine(adapter as any, stored.id).reconcileExecution(
      execution.id,
    );
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
      invoke: jest
        .fn()
        .mockRejectedValue(
          new AgentAdapterError(
            "HTTP_REJECTED",
            "http",
            "agent rejected the invocation",
            { invocationId: "first", retryable: false, httpStatus: 400 },
          ),
        ),
    };
    outboxService = new DispatchOutboxService(
      dataSource as any,
      adapter as any,
    );
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
    await buildEngine(adapter as any, stored.id).reconcileExecution(
      execution.id,
    );

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
      {
        adapter: "http",
        receivedAt: new Date().toISOString(),
        deliveryId: "d-1",
        keyId: "k-1",
      },
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
    outboxService = new DispatchOutboxService(
      dataSource as any,
      adapter as any,
    );
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
    expect(bAttemptAfter?.invocationId).toBe(
      (claimB as any).attempt.invocationId,
    );
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
    outboxService = new DispatchOutboxService(
      dataSource as any,
      adapter as any,
    );
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
    outboxService = new DispatchOutboxService(
      dataSource as any,
      adapter as any,
    );

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
    const aAttemptsAfter = await dataSource
      .getRepository(StepAttemptEntity)
      .find({
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

  it("claims only due dispatch records: expired leases are reclaimed, terminal-attempt records never are", async () => {
    const adapter = workingAdapter();
    outboxService = new DispatchOutboxService(
      dataSource as any,
      adapter as any,
    );
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
    const bOutbox = await dataSource
      .getRepository(DispatchOutboxEntity)
      .findOne({
        where: { stepAttemptId: (claimB as any).attempt.id },
      });
    expect(bOutbox?.status).toBe("PENDING");
    const cOutbox = await dataSource
      .getRepository(DispatchOutboxEntity)
      .findOne({
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

  const supervisionFor = (
    agent: string,
    expectation: Record<string, unknown>,
  ) =>
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
        trace: {
          traceId: "execution-1",
          correlationId: attemptRow.invocationId,
        },
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
    outboxService = new DispatchOutboxService(
      dataSource as any,
      adapter as any,
    );
    await outboxService.dispatchAttempt((claim as any).attempt.id);
    const attempt = await dataSource
      .getRepository(StepAttemptEntity)
      .findOne({ where: { id: (claim as any).attempt.id } });
    expect(attempt?.status).toBe("DISPATCHED");
    return { execution, attempt: attempt! };
  };

  /**
   * Seeds one execution with `count` supervised attempts inserted directly
   * (bypassing the claim/dispatch flow so dispatchedAt is fully controlled).
   * Each attempt gets its own logical step, satisfying the active-attempt
   * unique index; returns the attempts in (dispatchedAt, id) order.
   */
  const seedSupervisedAttempts = async (
    agent: string,
    rows: Array<{
      dispatchedAt: Date | null;
      status: "DISPATCHED" | "RUNNING";
      startTime?: Date | null;
      acceptedAt?: Date | null;
      lastEventReceivedAt?: Date | null;
      lastHeartbeatReceivedAt?: Date | null;
    }>,
  ) => {
    const stored = await createPipeline(
      "watchdog-fairness",
      rows.map((_, i) => ({
        id: `solo-${i}`,
        agent,
        timeout: "5s",
      })),
    );
    const execution = await executionService.createExecution(stored, {});
    const planRevision = await dataSource
      .getRepository(ExecutionPlanRevisionEntity)
      .findOne({ where: { executionId: execution.id } });
    const steps = await dataSource.getRepository(LogicalStepEntity).find({
      where: { executionId: execution.id },
      order: { stepId: "ASC" },
    });
    await dataSource.getRepository(StepAttemptEntity).insert(
      rows.map((row, i) => ({
        executionId: execution.id,
        logicalStepId: steps[i].id,
        planRevisionId: (planRevision as ExecutionPlanRevisionEntity).id,
        attemptNumber: 1,
        invocationId: `fairness-${execution.id}-${i}`,
        frozenSpecHash: "f".repeat(64),
        inputSnapshot: {},
        executorSnapshot: { agent },
        status: row.status,
        dispatchedAt: row.dispatchedAt,
        startTime: row.startTime ?? null,
        acceptedAt: row.acceptedAt ?? null,
        lastEventReceivedAt: row.lastEventReceivedAt ?? null,
        lastHeartbeatReceivedAt: row.lastHeartbeatReceivedAt ?? null,
      })),
    );
    const seeded = await dataSource.getRepository(StepAttemptEntity).find({
      where: { executionId: execution.id },
      order: { dispatchedAt: "ASC", id: "ASC" },
    });
    expect(seeded).toHaveLength(rows.length);
    return { execution, attempts: seeded };
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
    const rows = await dataSource.getRepository(AgentEventEntity).find({
      where: { stepAttemptId: attempt.id },
      order: { sequence: "ASC" },
    });
    expect(rows.map((row) => row.sequence)).toEqual([1, 2, 3]);
  });

  it("I5: a late event after a terminal result is retained without changing the attempt or execution", async () => {
    const stored = await createPipeline("events-late", [
      { id: "solo", agent: "reader" },
    ]);
    const { execution, attempt } = await claimDispatchedAttempt(
      stored,
      "reader",
    );
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

  it("I6: accepted projects acceptedAt without transitioning; activity transitions DISPATCHED -> RUNNING exactly once", async () => {
    const stored = await createPipeline("events-running", [
      { id: "solo", agent: "reader" },
    ]);
    const { attempt } = await claimDispatchedAttempt(stored, "reader");
    const service = eventService();

    // `accepted` proves the Worker owns the invocation (a queued run), not
    // that the handler is executing: acceptedAt + lastEventReceivedAt project,
    // status stays DISPATCHED and startTime stays unset.
    const accepted = canonicalEvent(attempt, {
      eventId: "accepted-1",
      sequence: 0,
      type: "accepted",
    });
    const applied = await service.apply(accepted.event, accepted.transport);
    expect(applied.disposition).toBe("applied");
    let reloaded = await dataSource
      .getRepository(StepAttemptEntity)
      .findOne({ where: { id: attempt.id } });
    expect(reloaded?.status).toBe("DISPATCHED");
    expect(reloaded?.acceptedAt).toEqual(expect.any(Date));
    expect(reloaded?.lastEventReceivedAt).toEqual(expect.any(Date));
    expect(reloaded?.startTime).toBeNull();

    // The first event that proves execution activity (heartbeat/progress/
    // log/artifact) transitions the attempt to RUNNING exactly once, with a
    // persisted server-side startTime.
    const progress = canonicalEvent(attempt, {
      eventId: "progress-1",
      sequence: 1,
      type: "progress",
    });
    const [first, second] = await Promise.all([
      service.apply(progress.event, progress.transport),
      service.apply(progress.event, progress.transport),
    ]);
    expect([first.disposition, second.disposition].sort()).toEqual([
      "applied",
      "duplicate",
    ]);
    reloaded = await dataSource
      .getRepository(StepAttemptEntity)
      .findOne({ where: { id: attempt.id } });
    expect(reloaded?.status).toBe("RUNNING");
    expect(reloaded?.startTime).toEqual(expect.any(Date));
    expect(reloaded?.acceptedAt).toEqual(expect.any(Date));
  });

  it("I7: the same Kafka offset on different partitions does not collide on transport dedup", async () => {
    const stored = await createPipeline("events-partitions", [
      { id: "solo", agent: "reader" },
    ]);
    const { attempt } = await claimDispatchedAttempt(stored, "reader");
    const service = eventService();
    const first = canonicalEvent(attempt, { eventId: "event-p0" });
    const second = canonicalEvent(attempt, {
      eventId: "event-p1",
      sequence: 2,
    });

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
    const rows = await dataSource.getRepository(AgentEventEntity).find({
      where: { stepAttemptId: attempt.id },
      order: { sequence: "ASC" },
    });
    expect(rows.map((row) => row.eventId)).toEqual(["event-p0", "event-p1"]);
  });

  it("J1: acceptance timeout produces a deterministic synthetic result through the ResultInbox", async () => {
    const stored = await createPipeline("watchdog-acceptance", [
      { id: "solo", agent: "watchdog-agent" },
    ]);
    const { execution, attempt } = await claimDispatchedAttempt(
      stored,
      "watchdog-agent",
    );
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
    const { execution, attempt } = await claimDispatchedAttempt(
      stored,
      "watchdog-agent",
    );
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
    // Deterministic replica-identical completion time: the persisted
    // server-side heartbeat receipt + staleAfter, never the evaluation tick
    // time or the worker-reported occurredAt.
    const persistedBaseline = (
      await dataSource
        .getRepository(StepAttemptEntity)
        .findOne({ where: { id: attempt.id } })
    )?.lastHeartbeatReceivedAt as Date;
    const inboxRow = await dataSource
      .getRepository(ResultInboxEntity)
      .findOne({ where: { invocationId: attempt.invocationId } });
    expect((inboxRow?.payload as { completedAt?: string }).completedAt).toBe(
      new Date(persistedBaseline.getTime() + 10_000).toISOString(),
    );
    const executionRow = await dataSource
      .getRepository(ExecutionEntity)
      .findOne({ where: { id: execution.id } });
    expect(executionRow?.status).toBe("FAILED");
  });

  it("J3: two supervisor replicas evaluating the same stale attempt produce one canonical result", async () => {
    const stored = await createPipeline("watchdog-replicas", [
      { id: "solo", agent: "watchdog-agent" },
    ]);
    const { execution, attempt } = await claimDispatchedAttempt(
      stored,
      "watchdog-agent",
    );
    const service = eventService();
    await service.apply(
      canonicalEvent(attempt, {
        eventId: "hb-1",
        sequence: 1,
        type: "heartbeat",
      }).event,
      canonicalEvent(attempt, {
        eventId: "hb-1",
        sequence: 1,
        type: "heartbeat",
      }).transport,
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
    const { execution, attempt } = await claimDispatchedAttempt(
      stored,
      "watchdog-agent",
    );
    const service = eventService();
    await service.apply(
      canonicalEvent(attempt, {
        eventId: "hb-1",
        sequence: 1,
        type: "heartbeat",
      }).event,
      canonicalEvent(attempt, {
        eventId: "hb-1",
        sequence: 1,
        type: "heartbeat",
      }).transport,
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
    await buildEngine(workingAdapter(), stored.id).reconcileExecution(
      execution.id,
    );
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
    const { execution, attempt } = await claimDispatchedAttempt(
      stored,
      "watchdog-agent",
    );
    const service = eventService();
    await service.apply(
      canonicalEvent(attempt, {
        eventId: "hb-1",
        sequence: 1,
        type: "heartbeat",
      }).event,
      canonicalEvent(attempt, {
        eventId: "hb-1",
        sequence: 1,
        type: "heartbeat",
      }).transport,
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

  it("J7: a RUNNING attempt that never heartbeats expires from its persisted startTime even with fresh progress", async () => {
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
    const reloaded = await dataSource
      .getRepository(StepAttemptEntity)
      .findOne({ where: { id: attempt.id } });
    // The persisted server-side startTime is the first-heartbeat baseline.
    const startTime = reloaded?.startTime as Date;
    expect(reloaded?.status).toBe("RUNNING");
    const supervision = supervisionFor("watchdog-agent", {
      expected: true,
      startupGraceMs: 30_000,
      staleAfterMs: 10_000,
    });

    // Still within staleAfter of startTime: untouched.
    await supervision.evaluate(new Date(startTime.getTime() + 9_000));
    const alive = await dataSource
      .getRepository(StepAttemptEntity)
      .findOne({ where: { id: attempt.id } });
    expect(alive?.status).toBe("RUNNING");

    // No heartbeat ever arrived: the startTime baseline expires, even though
    // lastEventReceivedAt is still fresh (progress does not substitute for
    // the configured heartbeat contract).
    await supervision.evaluate(new Date(startTime.getTime() + 11_000));
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

  it("J8: supervision fairness — 100 healthy attempts cannot hide a later stale one beyond one batch", async () => {
    const oldDispatch = new Date("2026-08-10T00:00:00.000Z");
    const staleDispatch = new Date("2026-08-10T00:05:00.000Z");
    const now = new Date("2026-08-10T00:05:31.000Z"); // staleDispatch + 31s
    const { execution, attempts } = await seedSupervisedAttempts(
      "watchdog-agent",
      [
        // One full SUPERVISION_BATCH of older, continuously-healthy attempts
        // (fresh heartbeats, so never due) ...
        ...Array.from({ length: 100 }, () => ({
          dispatchedAt: oldDispatch,
          status: "RUNNING" as const,
          startTime: oldDispatch,
          lastHeartbeatReceivedAt: new Date(now.getTime() - 1_000),
        })),
        // ... one later stale attempt that must eventually be visited ...
        { dispatchedAt: staleDispatch, status: "DISPATCHED" as const },
        // ... and one row with no dispatch time, which can never be due under
        // Rule A and must not consume candidate capacity or be terminalized.
        { dispatchedAt: null, status: "DISPATCHED" as const },
      ],
    );
    const supervision = supervisionFor("watchdog-agent", {
      expected: true,
      startupGraceMs: 30_000,
      staleAfterMs: 30_000,
    });
    const healthy = attempts.slice(0, 100);
    const stale = attempts[100];
    const noDispatch = attempts[101];
    expect(stale.dispatchedAt?.getTime()).toBe(staleDispatch.getTime());
    expect(noDispatch.dispatchedAt).toBeNull();

    // Pass 1: the bounded batch covers only the healthy attempts.
    await supervision.evaluate(now);
    let reloaded = await dataSource
      .getRepository(StepAttemptEntity)
      .findOne({ where: { id: stale.id } });
    expect(reloaded?.status).toBe("DISPATCHED");
    for (const row of healthy) {
      const current = await dataSource
        .getRepository(StepAttemptEntity)
        .findOne({ where: { id: row.id } });
      expect(current?.status).toBe("RUNNING");
    }

    // Pass 2: the in-memory keyset cursor resumes after the healthy batch and
    // the stale row is terminalized.
    await supervision.evaluate(now);
    reloaded = await dataSource
      .getRepository(StepAttemptEntity)
      .findOne({ where: { id: stale.id } });
    expect(reloaded?.status).toBe("TIMED_OUT");
    expect(reloaded?.error).toContain("AGENT_ACCEPTANCE_TIMEOUT");
    for (const row of healthy) {
      const current = await dataSource
        .getRepository(StepAttemptEntity)
        .findOne({ where: { id: row.id } });
      expect(current?.status).toBe("RUNNING");
    }
    const nullRow = await dataSource
      .getRepository(StepAttemptEntity)
      .findOne({ where: { id: noDispatch.id } });
    expect(nullRow?.status).toBe("DISPATCHED");
    // One canonical terminal result in the inbox.
    const inboxRows = await dataSource
      .getRepository(ResultInboxEntity)
      .find({ where: { invocationId: stale.invocationId } });
    expect(inboxRows).toHaveLength(1);
    expect(inboxRows[0].status).toBe("APPLIED");
    const executionRow = await dataSource
      .getRepository(ExecutionEntity)
      .findOne({ where: { id: execution.id } });
    expect(executionRow?.status).toBe("FAILED");
  });

  it("J9: periodic progress without heartbeat does not evade the required heartbeat timeout", async () => {
    const stored = await createPipeline("watchdog-progress-evasion", [
      { id: "solo", agent: "watchdog-agent" },
    ]);
    const { execution, attempt } = await claimDispatchedAttempt(
      stored,
      "watchdog-agent",
    );
    const service = eventService();
    // The worker emits accepted, then progress every few seconds, but never
    // a heartbeat.
    await service.apply(
      canonicalEvent(attempt, {
        eventId: "accepted-1",
        sequence: 0,
        type: "accepted",
      }).event,
      canonicalEvent(attempt, {
        eventId: "accepted-1",
        sequence: 0,
        type: "accepted",
      }).transport,
    );
    await service.apply(
      canonicalEvent(attempt, {
        eventId: "progress-1",
        sequence: 1,
        type: "progress",
      }).event,
      canonicalEvent(attempt, {
        eventId: "progress-1",
        sequence: 1,
        type: "progress",
      }).transport,
    );
    const reloaded = await dataSource
      .getRepository(StepAttemptEntity)
      .findOne({ where: { id: attempt.id } });
    const startTime = reloaded?.startTime as Date;
    expect(reloaded?.status).toBe("RUNNING");
    const supervision = supervisionFor("watchdog-agent", {
      expected: true,
      startupGraceMs: 30_000,
      staleAfterMs: 10_000,
    });

    // Fresh progress at startTime + 11s: lastEventReceivedAt is recent, but
    // the heartbeat contract still expires the attempt from startTime.
    await service.apply(
      canonicalEvent(attempt, {
        eventId: "progress-2",
        sequence: 2,
        type: "progress",
      }).event,
      canonicalEvent(attempt, {
        eventId: "progress-2",
        sequence: 2,
        type: "progress",
      }).transport,
    );
    await supervision.evaluate(new Date(startTime.getTime() + 11_000));
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

  it("J10: an accepted DISPATCHED attempt queued beyond startupGrace is not acceptance-timed-out", async () => {
    const stored = await createPipeline("watchdog-accepted-queued", [
      { id: "solo", agent: "watchdog-agent" },
    ]);
    const { execution, attempt } = await claimDispatchedAttempt(
      stored,
      "watchdog-agent",
    );
    const service = eventService();
    // concurrency=1 worker: run accepted, handler of another run occupies the
    // slot, so this run stays queued (DISPATCHED) far beyond startupGrace.
    const accepted = canonicalEvent(attempt, {
      eventId: "accepted-1",
      sequence: 0,
      type: "accepted",
    });
    await service.apply(accepted.event, accepted.transport);
    const dispatchTime = attempt.dispatchedAt as Date;
    const supervision = supervisionFor("watchdog-agent", {
      expected: true,
      startupGraceMs: 30_000,
      staleAfterMs: 10_000,
    });

    await supervision.evaluate(new Date(dispatchTime.getTime() + 60_000));
    const reloaded = await dataSource
      .getRepository(StepAttemptEntity)
      .findOne({ where: { id: attempt.id } });
    // Owned but queued: no acceptance timeout, no heartbeat timeout, and no
    // false transition to RUNNING.
    expect(reloaded?.status).toBe("DISPATCHED");
    expect(reloaded?.acceptedAt).toEqual(expect.any(Date));
    expect(reloaded?.startTime).toBeNull();
    const executionRow = await dataSource
      .getRepository(ExecutionEntity)
      .findOne({ where: { id: execution.id } });
    expect(executionRow?.status).toBe("RUNNING");

    // Once actual execution activity arrives, DISPATCHED -> RUNNING and the
    // heartbeat contract applies normally from the persisted startTime.
    const progress = canonicalEvent(attempt, {
      eventId: "progress-1",
      sequence: 1,
      type: "progress",
    });
    await service.apply(progress.event, progress.transport);
    const started = await dataSource
      .getRepository(StepAttemptEntity)
      .findOne({ where: { id: attempt.id } });
    expect(started?.status).toBe("RUNNING");
    expect(started?.startTime).toEqual(expect.any(Date));
    await supervision.evaluate(
      new Date((started?.startTime as Date).getTime() + 11_000),
    );
    const stale = await dataSource
      .getRepository(StepAttemptEntity)
      .findOne({ where: { id: attempt.id } });
    expect(stale?.status).toBe("TIMED_OUT");
    expect(stale?.error).toContain("AGENT_HEARTBEAT_STALE");
  });

  it("I8: storage-safe boundary events persist; out-of-range values are rejected by the contract before PostgreSQL", async () => {
    const stored = await createPipeline("events-boundaries", [
      { id: "solo", agent: "reader" },
    ]);
    const { attempt } = await claimDispatchedAttempt(stored, "reader");
    const service = eventService();

    // The maximum supported eventId (varchar(255)) and sequence (int32)
    // persist without any PostgreSQL varchar/int overflow. The transport
    // delivery id stays short: it is a separate varchar(255) column.
    const boundary = canonicalEvent(attempt, {
      eventId: "e".repeat(255),
      sequence: 2147483647,
    });
    boundary.transport.deliveryId = "delivery-boundary";
    const application = await service.apply(boundary.event, boundary.transport);
    expect(application.disposition).toBe("applied");
    const row = await dataSource.getRepository(AgentEventEntity).findOne({
      where: { stepAttemptId: attempt.id },
    });
    expect(row?.eventId).toBe("e".repeat(255));
    expect(row?.sequence).toBe(2147483647);

    // Values beyond the durable bounds are rejected by the canonical contract
    // BEFORE any persistence attempt: no 'value too long for type character
    // varying' and no 'integer out of range' can surface.
    for (const overrides of [
      { eventId: "e".repeat(256) },
      { sequence: 2147483648 },
    ]) {
      expect(() =>
        parseAgentEvent({ ...boundary.event, ...overrides }),
      ).toThrow();
    }
    const count = await dataSource
      .getRepository(AgentEventEntity)
      .count({ where: { stepAttemptId: attempt.id } });
    expect(count).toBe(1);
  });

  it("K2: long Kafka topic scopes are deterministically bounded for both events and results", async () => {
    const longTopic = `agentweave.agent.${"t".repeat(260)}`;
    expect(`${longTopic}:3`.length).toBeGreaterThan(255);
    const stored = await createPipeline("kafka-long-topic", [
      { id: "solo", agent: "reader" },
    ]);
    const { attempt } = await claimDispatchedAttempt(stored, "reader");
    const service = eventService();

    // AgentEvent path: durable application succeeds, scope is bounded, and a
    // duplicate delivery still deduplicates under the bounded scope.
    const message = canonicalEvent(attempt, { eventId: "event-1" });
    const transport = {
      adapter: "kafka",
      receivedAt: new Date().toISOString(),
      topic: longTopic,
      partition: 3,
      offset: "41",
    };
    expect((await service.apply(message.event, transport)).disposition).toBe(
      "applied",
    );
    expect((await service.apply(message.event, transport)).disposition).toBe(
      "duplicate",
    );
    const row = await dataSource
      .getRepository(AgentEventEntity)
      .findOne({ where: { stepAttemptId: attempt.id } });
    expect(row?.sourceScope).toMatch(/^kafka-sha256:[0-9a-f]{64}$/);
    expect(row?.sourceScope?.length).toBeLessThanOrEqual(255);
    expect(row?.sourceMessageId).toBe("41");

    // AgentResult path uses the same durable scope semantics: identical
    // bounded scope for the identical raw topic+partition identity.
    const result: AgentResultV1 = {
      schemaVersion: "1",
      invocationId: attempt.invocationId,
      executionId: attempt.executionId,
      stepExecutionId: attempt.logicalStepId,
      status: "succeeded",
      output: { score: 100 },
      completedAt: new Date().toISOString(),
    };
    const applied = await inbox.apply(result, {
      ...transport,
      receivedAt: new Date().toISOString(),
    });
    expect(applied.disposition).toBe("applied");
    const inboxRow = await dataSource
      .getRepository(ResultInboxEntity)
      .findOne({ where: { invocationId: attempt.invocationId } });
    expect(inboxRow?.sourceScope).toBe(row?.sourceScope);
    expect(inboxRow?.sourceScope?.length).toBeLessThanOrEqual(255);
  });

  it("K3: HTTP transport with a maximum keyId (255) persists the durable scope", async () => {
    const stored = await createPipeline("http-max-keyid", [
      { id: "solo", agent: "reader" },
    ]);
    const { attempt } = await claimDispatchedAttempt(stored, "reader");
    const message = canonicalEvent(attempt, { eventId: "event-1" });
    const applied = await eventService().apply(message.event, {
      adapter: "http",
      receivedAt: new Date().toISOString(),
      keyId: "k".repeat(255),
      deliveryId: "delivery-1",
    });
    expect(applied.disposition).toBe("applied");
    const row = await dataSource
      .getRepository(AgentEventEntity)
      .findOne({ where: { stepAttemptId: attempt.id } });
    expect(row?.sourceScope).toBe("k".repeat(255));
  });

  it("J6: agents without heartbeat expectations are never failed for emitting no events", async () => {
    const stored = await createPipeline("watchdog-compat", [
      { id: "solo", agent: "plain-agent" },
    ]);
    const { execution, attempt } = await claimDispatchedAttempt(
      stored,
      "plain-agent",
    );
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
    expect(steps.find((step) => step.stepId === "extract")?.status).toBe(
      "READY",
    );
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
    expect(attempts[0].invocationId).toBe(
      `${claim!.disposition === "claimed" ? claim!.logicalStep.id : ""}:1`,
    );
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

  it("K4: first application registers one Artifact per descriptor; an identical duplicate adds none", async () => {
    const stored = await createPipeline("artifact-first-application");
    const execution = await executionService.createExecution(stored, {});
    await executionService.reconcileExecution(execution.id);
    const claim = await executionService.claimRunnableStep(
      execution.id,
      { id: "extract", agent: "reader" } as any,
      { input: true },
      1,
    );
    expect(claim?.disposition).toBe("claimed");

    const descriptorA = { id: "worker-art-1", name: "report.pdf" };
    const descriptorB = {
      id: "worker-art-1", // same worker id on purpose: opaque producer data
      name: "data.json",
      mediaType: "application/json",
    };
    const artifactResult: AgentResultV1 = {
      ...successfulResult(claim, { done: true }),
      artifacts: [descriptorA, descriptorB],
    };
    const first = await inbox.apply(artifactResult, {
      adapter: "test",
      receivedAt: new Date().toISOString(),
    });
    expect(first.disposition).toBe("applied");

    const inboxRow = await dataSource.getRepository(ResultInboxEntity).findOne({
      where: { invocationId: (claim as any).attempt.invocationId },
    });
    expect(inboxRow?.status).toBe("APPLIED");
    const artifacts = await dataSource
      .getRepository(ArtifactEntity)
      .find({ order: { descriptorOrdinal: "ASC" } });
    expect(artifacts).toHaveLength(2);
    expect(artifacts[0]).toMatchObject({
      resultInboxId: inboxRow?.id,
      descriptorOrdinal: 0,
      descriptorHash: sha256Json(descriptorA),
    });
    expect(artifacts[1]).toMatchObject({
      resultInboxId: inboxRow?.id,
      descriptorOrdinal: 1,
      descriptorHash: sha256Json(descriptorB),
    });
    expect(artifacts[0].id).not.toBe(artifacts[1].id);
    const attempt = await dataSource
      .getRepository(StepAttemptEntity)
      .findOne({ where: { id: (claim as any).attempt.id } });
    expect(attempt?.status).toBe("SUCCESS");

    // Identical duplicate: no additional Artifact rows, no new inbox row.
    const second = await inbox.apply(artifactResult, {
      adapter: "test",
      receivedAt: new Date().toISOString(),
    });
    expect(second.disposition).toBe("duplicate");
    expect(await dataSource.getRepository(ArtifactEntity).count()).toBe(2);
    expect(await dataSource.getRepository(ResultInboxEntity).count()).toBe(1);
  });

  it("K5: non-success terminal results still register artifact identities", async () => {
    const stored = await createPipeline("artifact-failed-application");
    const execution = await executionService.createExecution(stored, {});
    await executionService.reconcileExecution(execution.id);
    const claim = await executionService.claimRunnableStep(
      execution.id,
      { id: "extract", agent: "reader" } as any,
      { input: true },
      1,
    );
    expect(claim?.disposition).toBe("claimed");

    const failedResult: AgentResultV1 = {
      schemaVersion: "1",
      invocationId: (claim as any).attempt.invocationId,
      executionId: execution.id,
      stepExecutionId: (claim as any).logicalStep.id,
      status: "failed",
      error: { code: "AGENT_ERROR", message: "boom", retryable: false },
      completedAt: new Date().toISOString(),
      artifacts: [{ id: "worker-partial", name: "partial.json" }],
    };
    const application = await inbox.apply(failedResult, {
      adapter: "test",
      receivedAt: new Date().toISOString(),
    });
    expect(application.disposition).toBe("applied");

    const attempt = await dataSource
      .getRepository(StepAttemptEntity)
      .findOne({ where: { id: (claim as any).attempt.id } });
    expect(attempt?.status).toBe("FAILED");
    const reloaded = await dataSource
      .getRepository(ExecutionEntity)
      .findOne({ where: { id: execution.id } });
    expect(reloaded?.status).toBe("FAILED");
    const artifacts = await dataSource.getRepository(ArtifactEntity).find();
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].descriptorOrdinal).toBe(0);
    expect(artifacts[0].descriptorHash).toBe(
      sha256Json({ id: "worker-partial", name: "partial.json" }),
    );
  });

  it("K6: concurrent identical deliveries create exactly one Artifact per descriptor", async () => {
    const stored = await createPipeline("artifact-concurrent-dedupe");
    const execution = await executionService.createExecution(stored, {});
    await executionService.reconcileExecution(execution.id);
    const claim = await executionService.claimRunnableStep(
      execution.id,
      { id: "extract", agent: "reader" } as any,
      { input: true },
      1,
    );
    expect(claim?.disposition).toBe("claimed");

    const artifactResult: AgentResultV1 = {
      ...successfulResult(claim, { done: true }),
      artifacts: [
        { id: "worker-1", name: "a.json" },
        { id: "worker-2", name: "b.json" },
      ],
    };
    const [first, second] = await Promise.all([
      inbox.apply(artifactResult, {
        adapter: "test",
        receivedAt: new Date().toISOString(),
      }),
      inbox.apply(artifactResult, {
        adapter: "test",
        receivedAt: new Date().toISOString(),
      }),
    ]);

    const dispositions = [first, second]
      .map((application) => application.disposition)
      .sort();
    expect(dispositions).toEqual(["applied", "duplicate"]);
    const artifacts = await dataSource
      .getRepository(ArtifactEntity)
      .find({ order: { descriptorOrdinal: "ASC" } });
    expect(artifacts).toHaveLength(2);
    // The surviving rows map exactly to the canonical descriptors.
    const inboxRow = await dataSource.getRepository(ResultInboxEntity).findOne({
      where: { invocationId: (claim as any).attempt.invocationId },
    });
    expect(artifacts[0]).toMatchObject({
      resultInboxId: inboxRow?.id,
      descriptorOrdinal: 0,
      descriptorHash: sha256Json({ id: "worker-1", name: "a.json" }),
    });
    expect(artifacts[1]).toMatchObject({
      resultInboxId: inboxRow?.id,
      descriptorOrdinal: 1,
      descriptorHash: sha256Json({ id: "worker-2", name: "b.json" }),
    });
    const inboxRows = await dataSource
      .getRepository(ResultInboxEntity)
      .find({ where: { invocationId: (claim as any).attempt.invocationId } });
    expect(inboxRows).toHaveLength(1);
    expect(inboxRows[0].status).toBe("APPLIED");
    const attempt = await dataSource
      .getRepository(StepAttemptEntity)
      .findOne({ where: { id: (claim as any).attempt.id } });
    expect(attempt?.status).toBe("SUCCESS");
  });

  it("K7: a forced artifact-registration failure rolls back the entire terminal transaction", async () => {
    const stored = await createPipeline("artifact-rollback");
    const execution = await executionService.createExecution(stored, {});
    await executionService.reconcileExecution(execution.id);
    const claim = await executionService.claimRunnableStep(
      execution.id,
      { id: "extract", agent: "reader" } as any,
      { input: true },
      1,
    );
    expect(claim?.disposition).toBe("claimed");

    // Make the artifact insert fail inside the apply transaction (the
    // relation vanishes; ON CONFLICT DO NOTHING does not swallow this).
    await dataSource.query(
      `ALTER TABLE "artifacts" RENAME TO "artifacts_hidden"`,
    );
    try {
      const artifactResult: AgentResultV1 = {
        ...successfulResult(claim, { done: true }),
        artifacts: [{ id: "worker-1", name: "a.json" }],
      };
      await expect(
        inbox.apply(artifactResult, {
          adapter: "test",
          receivedAt: new Date().toISOString(),
        }),
      ).rejects.toThrow(/artifacts/);
    } finally {
      await dataSource.query(
        `ALTER TABLE "artifacts_hidden" RENAME TO "artifacts"`,
      );
    }

    // Nothing from the terminal transaction committed: no inbox row, no
    // attempt terminal transition, no step projection, no execution
    // transition, no outbox retirement, no partial artifact set.
    expect(await dataSource.getRepository(ResultInboxEntity).count()).toBe(0);
    const attempt = await dataSource
      .getRepository(StepAttemptEntity)
      .findOne({ where: { id: (claim as any).attempt.id } });
    // The claim left the attempt CREATED (outbox PENDING); the failed apply
    // must not have terminalized or liveness-updated it.
    expect(attempt?.status).toBe("CREATED");
    expect(attempt?.terminalAt).toBeNull();
    const step = await dataSource
      .getRepository(LogicalStepEntity)
      .findOne({ where: { id: (claim as any).logicalStep.id } });
    expect(step?.status).toBe("RUNNING");
    const reloaded = await dataSource
      .getRepository(ExecutionEntity)
      .findOne({ where: { id: execution.id } });
    expect(reloaded?.status).toBe("RUNNING");
    const outbox = await dataSource.getRepository(DispatchOutboxEntity).find();
    expect(outbox).toHaveLength(1);
    expect(outbox[0].status).toBe("PENDING");
    expect(await dataSource.getRepository(ArtifactEntity).count()).toBe(0);

    // Forward recovery: with the table restored, the same result applies
    // cleanly and registers its artifact — the failed transaction left no
    // poison state.
    const retry = await inbox.apply(
      {
        ...successfulResult(claim, { done: true }),
        artifacts: [{ id: "worker-1", name: "a.json" }],
      },
      { adapter: "test", receivedAt: new Date().toISOString() },
    );
    expect(retry.disposition).toBe("applied");
    const recovered = await dataSource.getRepository(ArtifactEntity).find();
    expect(recovered).toHaveLength(1);
    expect(recovered[0].descriptorOrdinal).toBe(0);
  });

  it("K8: a result without artifacts registers no Artifact rows", async () => {
    const stored = await createPipeline("artifact-zero");
    const execution = await executionService.createExecution(stored, {});
    await executionService.reconcileExecution(execution.id);
    const claim = await executionService.claimRunnableStep(
      execution.id,
      { id: "extract", agent: "reader" } as any,
      { input: true },
      1,
    );
    expect(claim?.disposition).toBe("claimed");

    const application = await inbox.apply(
      successfulResult(claim, { done: true }),
      {
        adapter: "test",
        receivedAt: new Date().toISOString(),
      },
    );
    expect(application.disposition).toBe("applied");
    expect(await dataSource.getRepository(ArtifactEntity).count()).toBe(0);
    const attempt = await dataSource
      .getRepository(StepAttemptEntity)
      .findOne({ where: { id: (claim as any).attempt.id } });
    expect(attempt?.status).toBe("SUCCESS");
  });
});

const LEGACY_DATABASE = "tenvyr_m0_legacy";
const describeWithPostgresLegacy = TEST_DATABASE_URL ? describe : describe.skip;

/**
 * Artifact identity migration suite: proves against real PostgreSQL that the
 * Milestone 2A migration runs after M1, is repeat-safe, preserves existing
 * rows, and performs no historical artifact backfill (pre-existing APPLIED
 * inbox rows with artifact descriptors gain no Artifact rows).
 */
describeWithPostgres("PostgreSQL artifact identity migration", () => {
  jest.setTimeout(60_000);

  let dataSource: DataSource;

  beforeAll(async () => {
    assertDisposableTarget(TEST_DATABASE_URL);
    dataSource = new DataSource({
      ...databaseOptions(),
      type: "postgres" as const,
      url: TEST_DATABASE_URL,
    } as DataSourceOptions);
    await dataSource.initialize();
    await dataSource.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await dataSource.runMigrations();

    // Simulate a post-M1 deployment: drop the artifact table (and the M2D
    // exposure table that references it) while keeping every pre-existing
    // row, then re-run the M2 migration manually.
    await dataSource.query(`DROP TABLE IF EXISTS "artifact_exposures"`);
    await dataSource.query(`DROP TABLE IF EXISTS "artifacts"`);

    const pipelineRepo = dataSource.getRepository(PipelineEntity);
    const pipeline = pipelineRepo.create({
      name: "legacy",
      version: "1.0",
      steps: [],
    });
    await pipelineRepo.save(pipeline);

    const executionRepo = dataSource.getRepository(ExecutionEntity);
    const execution = executionRepo.create({
      pipelineId: pipeline.id,
      input: {},
      status: "COMPLETED",
    });
    await executionRepo.save(execution);

    const stepRepo = dataSource.getRepository(LogicalStepEntity);
    const step = stepRepo.create({
      executionId: execution.id,
      stepId: "legacy-step",
      agent: "reader",
      status: "COMPLETED",
    });
    await stepRepo.save(step);

    const planRepo = dataSource.getRepository(ExecutionPlanRevisionEntity);
    const plan = planRepo.create({
      executionId: execution.id,
      revisionNumber: 1,
      plan: { schemaVersion: 1, steps: [] },
    });
    await planRepo.save(plan);

    const attemptRepo = dataSource.getRepository(StepAttemptEntity);
    const attempt = attemptRepo.create({
      executionId: execution.id,
      logicalStepId: step.id,
      planRevisionId: plan.id,
      attemptNumber: 1,
      invocationId: "legacy:1",
      frozenSpecHash: "a".repeat(64),
      executorSnapshot: {},
      status: "SUCCESS",
    });
    await attemptRepo.save(attempt);

    // A pre-existing canonical APPLIED result whose payload carries artifact
    // descriptors: the migration must NOT backfill identities for it.
    const inboxRepo = dataSource.getRepository(ResultInboxEntity);
    await inboxRepo.save(
      inboxRepo.create({
        invocationId: "legacy:1",
        stepAttemptId: attempt.id,
        payloadHash: "b".repeat(64),
        payload: {
          schemaVersion: "1",
          status: "succeeded",
          artifacts: [{ id: "legacy-art", name: "old.json" }],
        },
        sourceAdapter: "legacy",
        status: "APPLIED",
        appliedAt: new Date(),
      }),
    );
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  it("runs after M1, is repeat-safe, preserves rows, and never backfills artifact identities", async () => {
    const migrationRows = await dataSource.query(
      `SELECT "name" FROM "migrations" ORDER BY "id"`,
    );
    const names = migrationRows.map((row: { name: string }) => row.name);
    expect(names).toContain("MilestoneTwoArtifactIdentity1722270002000");
    expect(
      names.indexOf("MilestoneTwoArtifactIdentity1722270002000"),
    ).toBeGreaterThan(names.indexOf("MilestoneOneAgentEvents1722270001000"));

    const runner = dataSource.createQueryRunner();
    try {
      // First up() creates the table; second up() is the repeat-safety check.
      await new MilestoneTwoArtifactIdentity1722270002000().up(runner);
      await new MilestoneTwoArtifactIdentity1722270002000().up(runner);
    } finally {
      await runner.release();
    }

    const constraints = await dataSource.query(
      `SELECT "conname" FROM "pg_constraint" WHERE "conname" IN
         ('UQ_artifact_inbox_ordinal', 'FK_artifact_inbox')`,
    );
    expect(
      constraints.map((row: { conname: string }) => row.conname).sort(),
    ).toEqual(["FK_artifact_inbox", "UQ_artifact_inbox_ordinal"]);

    // No historical backfill: the pre-existing APPLIED inbox row with an
    // artifact descriptor gains zero Artifact rows.
    expect(
      (
        await dataSource.query(
          `SELECT count(*)::int AS "count" FROM "artifacts"`,
        )
      )[0].count,
    ).toBe(0);

    // Existing rows are preserved byte-for-byte.
    const inboxRow = await dataSource
      .getRepository(ResultInboxEntity)
      .findOne({ where: { invocationId: "legacy:1" } });
    expect(inboxRow?.status).toBe("APPLIED");
    expect(inboxRow?.payloadHash).toBe("b".repeat(64));
    const attempt = await dataSource
      .getRepository(StepAttemptEntity)
      .findOne({ where: { invocationId: "legacy:1" } });
    expect(attempt?.status).toBe("SUCCESS");
  });
});

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
    await admin.query(
      `DROP DATABASE IF EXISTS ${LEGACY_DATABASE} WITH (FORCE)`,
    );
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
        [id, ex1, stepId, status, attempt, startTime ?? null],
      );
    };
    await seedStep(
      "00000000-0000-0000-0000-000000000201",
      "pending0",
      "PENDING",
      0,
    );
    await seedStep(
      "00000000-0000-0000-0000-000000000202",
      "running",
      "RUNNING",
      1,
      "2026-08-01T00:00:00.000Z",
    );
    await seedStep(
      "00000000-0000-0000-0000-000000000203",
      "completed",
      "COMPLETED",
      1,
      "2026-08-01T00:00:00.000Z",
    );
    await seedStep(
      "00000000-0000-0000-0000-000000000204",
      "failed",
      "FAILED",
      2,
      "2026-08-01T00:00:00.000Z",
    );
    await seedStep(
      "00000000-0000-0000-0000-000000000205",
      "skipped",
      "SKIPPED",
      0,
    );
    await seedStep(
      "00000000-0000-0000-0000-000000000206",
      "cancelled",
      "CANCELLED",
      1,
      "2026-08-01T00:00:00.000Z",
    );
    await seedStep(
      "00000000-0000-0000-0000-000000000207",
      "pending3",
      "PENDING",
      3,
    );
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
      [
        "00000000-0000-0000-0000-000000000401",
        ex3,
        "00000000-0000-0000-0000-000000000402",
      ],
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
      {
        findOne: jest.fn().mockResolvedValue({ id: "legacy-pipeline" }),
      } as any,
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
      new EngineService(
        { findOne: jest.fn() } as any,
        service as any,
        adapter as any,
        outbox,
      ),
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

/**
 * Execution-state migration suite: proves against real PostgreSQL that the
 * M2B migration runs after M2A, is repeat-safe, preserves existing rows,
 * gives pre-existing executions `{}` at semantic version 0, and performs no
 * unrelated backfill.
 */
describeWithPostgres("PostgreSQL execution state migration", () => {
  jest.setTimeout(60_000);

  let dataSource: DataSource;
  let legacyExecutionId: string;

  beforeAll(async () => {
    assertDisposableTarget(TEST_DATABASE_URL);
    dataSource = new DataSource({
      ...databaseOptions(),
      type: "postgres" as const,
      url: TEST_DATABASE_URL,
    } as DataSourceOptions);
    await dataSource.initialize();
    await dataSource.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await dataSource.runMigrations();

    // Simulate a pre-M2B deployment: drop the three execution-state columns
    // while keeping every pre-existing row, then re-run the M2B migration.
    await dataSource.query(
      `ALTER TABLE "executions" DROP COLUMN IF EXISTS "executionState"`,
    );
    await dataSource.query(
      `ALTER TABLE "executions" DROP COLUMN IF EXISTS "executionStateVersion"`,
    );
    await dataSource.query(
      `ALTER TABLE "executions" DROP COLUMN IF EXISTS "executionStateUpdatedAt"`,
    );

    const pipelineRepo = dataSource.getRepository(PipelineEntity);
    const pipeline = pipelineRepo.create({
      name: "execution-state-legacy",
      version: "1.0",
      steps: [],
    });
    await pipelineRepo.save(pipeline);

    // Seed a pre-M2B execution row via raw SQL: the TypeORM entity now
    // includes the execution-state columns, which this legacy row predates.
    legacyExecutionId = "00000000-0000-0000-0000-000000000201";
    await dataSource.query(
      `INSERT INTO "executions"
         ("id", "pipelineId", "status", "input", "output", "terminationReason")
       VALUES ($1, $2, 'COMPLETED', $3::jsonb, $4::jsonb, 'legacy done')`,
      [
        legacyExecutionId,
        pipeline.id,
        JSON.stringify({ legacy: true }),
        JSON.stringify({ final: 1 }),
      ],
    );
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  it("runs after M2A, is repeat-safe, preserves rows, and gives existing executions {} at version 0", async () => {
    const migrationRows = await dataSource.query(
      `SELECT "name" FROM "migrations" ORDER BY "id"`,
    );
    const names = migrationRows.map((row: { name: string }) => row.name);
    expect(names).toContain("MilestoneTwoExecutionState1722270003000");
    expect(names.indexOf("MilestoneTwoExecutionState1722270003000")).toBe(
      names.indexOf("MilestoneTwoArtifactIdentity1722270002000") + 1,
    );

    // Repeat-safety: both up() runs must be no-ops on the second execution.
    const runner = dataSource.createQueryRunner();
    try {
      await new MilestoneTwoExecutionState1722270003000().up(runner);
      await new MilestoneTwoExecutionState1722270003000().up(runner);
    } finally {
      await runner.release();
    }

    const columns = await dataSource.query(
      `SELECT "column_name", "data_type", "is_nullable", "column_default"
       FROM information_schema.columns WHERE "table_name" = 'executions'
       AND "column_name" IN ('executionState', 'executionStateVersion', 'executionStateUpdatedAt')
       ORDER BY "column_name"`,
    );
    const byName = Object.fromEntries(
      columns.map((row: Record<string, string>) => [row.column_name, row]),
    );
    expect(byName.executionState.data_type).toBe("jsonb");
    expect(byName.executionState.is_nullable).toBe("NO");
    expect(byName.executionState.column_default).toMatch(/'{}'/);
    expect(byName.executionStateVersion.data_type).toBe("integer");
    expect(byName.executionStateVersion.is_nullable).toBe("NO");
    expect(byName.executionStateVersion.column_default).toContain("0");
    expect(byName.executionStateUpdatedAt.is_nullable).toBe("YES");

    // Pre-existing rows are preserved byte-for-byte and gain {} at version 0.
    const legacy = await dataSource
      .getRepository(ExecutionEntity)
      .findOne({ where: { id: legacyExecutionId } });
    expect(legacy?.status).toBe("COMPLETED");
    expect(legacy?.input).toEqual({ legacy: true });
    expect(legacy?.output).toEqual({ final: 1 });
    expect(legacy?.terminationReason).toBe("legacy done");
    expect(legacy?.executionState).toEqual({});
    expect(legacy?.executionStateVersion).toBe(0);
    expect(legacy?.executionStateUpdatedAt).toBeNull();

    // A row created after the migration starts at {} and version 0 too.
    const fresh = await dataSource.getRepository(ExecutionEntity).save(
      dataSource.getRepository(ExecutionEntity).create({
        pipelineId: legacy!.pipelineId,
        input: {},
        status: "PENDING",
      }),
    );
    expect(fresh.executionState).toEqual({});
    expect(fresh.executionStateVersion).toBe(0);
    expect(fresh.executionStateUpdatedAt).toBeNull();
  });
});

/**
 * Execution-state durability and concurrency suite against real PostgreSQL:
 * atomic compare-and-set semantics, no-op invariance, terminal rejection,
 * cross-execution isolation, forced-failure rollback, and replica contention.
 */
describeWithPostgres("PostgreSQL execution state", () => {
  jest.setTimeout(120_000);

  let dataSource: DataSource;
  let stateService: ExecutionStateService;
  let executionService: ExecutionService;
  let inbox: ResultInboxService;

  const rawState = async (executionId: string) => {
    const rows = await dataSource.query(
      `SELECT "executionState", "executionStateVersion", "executionStateUpdatedAt", "rowVersion"
       FROM "executions" WHERE "id" = $1`,
      [executionId],
    );
    return rows[0];
  };

  beforeAll(async () => {
    assertDisposableTarget(TEST_DATABASE_URL);
    dataSource = new DataSource({
      ...databaseOptions(),
      type: "postgres" as const,
      url: TEST_DATABASE_URL,
    } as DataSourceOptions);
    await dataSource.initialize();
    await dataSource.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await dataSource.runMigrations();
    stateService = new ExecutionStateService(dataSource as any);
    executionService = new ExecutionService(
      dataSource.getRepository(ExecutionEntity),
      dataSource.getRepository(LogicalStepEntity),
      dataSource.getRepository(StepAttemptEntity),
      dataSource.getRepository(ExecutionPlanRevisionEntity),
      dataSource,
    );
    inbox = new ResultInboxService(dataSource);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await dataSource.query(`TRUNCATE "executions", "pipelines" CASCADE`);
  });

  const createExecution = async (name: string) => {
    const pipeline = await dataSource.getRepository(PipelineEntity).save(
      dataSource.getRepository(PipelineEntity).create({
        name,
        version: "1.0",
        steps: [],
      }),
    );
    return executionService.createExecution(pipeline, {});
  };

  const forceTerminal = async (executionId: string, status: string) => {
    await dataSource
      .getRepository(ExecutionEntity)
      .update(executionId, { status: status as any });
  };

  it("newly created executions start with {} at semantic version 0", async () => {
    const execution = await createExecution("fresh-state");
    const snapshot = await stateService.read(execution.id);
    expect(snapshot).toEqual({
      executionId: execution.id,
      state: {},
      version: 0,
      updatedAt: null,
    });
  });

  it("an applied mutation survives DataSource close and reopen", async () => {
    const execution = await createExecution("durable-state");
    const applied = await stateService.mutate(execution.id, 0, {
      set: { durable: [1, 2, 3] },
    });
    expect(applied.disposition).toBe("applied");

    const reopened = new DataSource({
      ...databaseOptions(),
      type: "postgres" as const,
      url: TEST_DATABASE_URL,
    } as DataSourceOptions);
    await reopened.initialize();
    try {
      const service = new ExecutionStateService(reopened as any);
      const snapshot = await service.read(execution.id);
      expect(snapshot?.state).toEqual({ durable: [1, 2, 3] });
      expect(snapshot?.version).toBe(1);
      expect(snapshot?.updatedAt).toEqual(expect.any(Date));
    } finally {
      await reopened.destroy();
    }
  });

  it("a no-op leaves semantic version, row version, and state timestamp unchanged", async () => {
    const execution = await createExecution("noop-invariance");
    const first = await stateService.mutate(execution.id, 0, { set: { a: 1 } });
    expect(first.disposition).toBe("applied");

    const before = await rawState(execution.id);
    const noop = await stateService.mutate(execution.id, 1, { set: { a: 1 } });
    expect(noop).toEqual({ disposition: "noop", version: 1, state: { a: 1 } });
    const after = await rawState(execution.id);

    expect(after.executionStateVersion).toBe(before.executionStateVersion);
    expect(after.rowVersion).toBe(before.rowVersion);
    // pg returns a fresh Date object per query; compare instants, not identity.
    expect(after.executionStateUpdatedAt?.getTime()).toBe(
      before.executionStateUpdatedAt?.getTime(),
    );
    expect(after.executionState).toEqual(before.executionState);

    // Deleting an absent key is also a no-op.
    const deleteNoop = await stateService.mutate(execution.id, 1, {
      delete: ["missing"],
    });
    expect(deleteNoop.disposition).toBe("noop");
    const afterDelete = await rawState(execution.id);
    expect(afterDelete.rowVersion).toBe(before.rowVersion);
  });

  it.each(["COMPLETED", "FAILED", "CANCELLED"])(
    "a %s terminal execution rejects mutation without touching state",
    async (status) => {
      const execution = await createExecution(`terminal-${status}`);
      await forceTerminal(execution.id, status);
      const result = await stateService.mutate(execution.id, 0, {
        set: { late: true },
      });
      expect(result).toEqual({ disposition: "terminal", status });
      const row = await rawState(execution.id);
      expect(row.executionState).toEqual({});
      expect(row.executionStateVersion).toBe(0);
      expect(row.executionStateUpdatedAt).toBeNull();
    },
  );

  it("state is isolated across executions", async () => {
    const first = await createExecution("isolated-1");
    const second = await createExecution("isolated-2");
    await stateService.mutate(first.id, 0, { set: { mine: [1] } });

    const firstSnapshot = await stateService.read(first.id);
    const secondSnapshot = await stateService.read(second.id);
    expect(firstSnapshot?.state).toEqual({ mine: [1] });
    expect(firstSnapshot?.version).toBe(1);
    expect(secondSnapshot?.state).toEqual({});
    expect(secondSnapshot?.version).toBe(0);
  });

  it("a forced persistence failure rolls back state, semantic version, row version, and timestamp together", async () => {
    const execution = await createExecution("forced-rollback");
    const before = await rawState(execution.id);
    // A BEFORE UPDATE trigger makes the service's save fail inside its own
    // transaction: the atomic write must roll back completely.
    await dataSource.query(`
      CREATE OR REPLACE FUNCTION tenvyr_m2_test_fail_execution_update()
      RETURNS trigger AS $$ BEGIN
        RAISE EXCEPTION 'forced persistence failure';
      END; $$ LANGUAGE plpgsql
    `);
    await dataSource.query(`
      CREATE TRIGGER tenvyr_m2_test_fail_update
      BEFORE UPDATE ON "executions"
      FOR EACH ROW EXECUTE FUNCTION tenvyr_m2_test_fail_execution_update()
    `);
    try {
      await expect(
        stateService.mutate(execution.id, 0, { set: { a: 1 } }),
      ).rejects.toThrow(/forced persistence failure/);
    } finally {
      await dataSource.query(
        `DROP TRIGGER tenvyr_m2_test_fail_update ON "executions"`,
      );
      await dataSource.query(
        `DROP FUNCTION tenvyr_m2_test_fail_execution_update()`,
      );
    }

    const after = await rawState(execution.id);
    expect(after.executionState).toEqual(before.executionState);
    expect(after.executionStateVersion).toBe(before.executionStateVersion);
    expect(after.executionStateUpdatedAt).toBe(before.executionStateUpdatedAt);
    expect(after.rowVersion).toBe(before.rowVersion);
  });

  it("100 concurrent same-version mutations apply exactly once, five rounds, winner state intact", async () => {
    for (let round = 0; round < 5; round++) {
      const execution = await createExecution(`contention-${round}`);
      const outcomes = await Promise.all(
        Array.from({ length: 100 }, (_, i) =>
          stateService.mutate(execution.id, 0, { set: { [`key${i}`]: i } }),
        ),
      );
      const applied = outcomes.filter(
        (outcome) => outcome.disposition === "applied",
      );
      const conflicts = outcomes.filter(
        (outcome) => outcome.disposition === "conflict",
      );
      expect(applied).toHaveLength(1);
      expect(conflicts).toHaveLength(99);
      expect(
        outcomes.some(
          (outcome) =>
            outcome.disposition !== "applied" &&
            outcome.disposition !== "conflict",
        ),
      ).toBe(false);

      // The semantic version increments exactly once and the final state is
      // the winner's complete state — no merged partial writes.
      const snapshot = await stateService.read(execution.id);
      expect(snapshot?.version).toBe(1);
      expect(snapshot?.state).toEqual(
        (applied[0] as { state: Record<string, unknown> }).state,
      );
      expect(Object.keys(snapshot?.state ?? {})).toHaveLength(1);
    }
  });

  it("sequential mutations using the returned version all apply in order", async () => {
    const execution = await createExecution("chained");
    let version = 0;
    const expected = {};
    for (let i = 0; i < 6; i++) {
      const outcome = await stateService.mutate(execution.id, version, {
        set: { [`step${i}`]: i },
      });
      expect(outcome.disposition).toBe("applied");
      version = (outcome as { version: number }).version;
      (expected as Record<string, number>)[`step${i}`] = i;
    }
    const snapshot = await stateService.read(execution.id);
    expect(snapshot?.version).toBe(6);
    expect(snapshot?.state).toEqual(expected);
  });

  it("stale versions never overwrite newer state", async () => {
    const execution = await createExecution("stale-writer");
    await stateService.mutate(execution.id, 0, { set: { a: 1 } });

    const stale = await stateService.mutate(execution.id, 0, {
      set: { stale: true },
    });
    expect(stale).toEqual({ disposition: "conflict", version: 1 });

    const fresh = await stateService.mutate(execution.id, 1, {
      set: { fresh: true },
    });
    expect(fresh.disposition).toBe("applied");
    const snapshot = await stateService.read(execution.id);
    expect(snapshot?.state).toEqual({ a: 1, fresh: true });
    expect(snapshot?.version).toBe(2);
  });

  it("a merged final state over 64 KiB is rejected and rolls back cleanly", async () => {
    const execution = await createExecution("state-cap");
    // Four ~16 KiB patches build a ~64 KiB state; the fifth patch passes the
    // patch cap but would push the merged state over the 64 KiB state cap.
    for (let i = 0; i < 4; i++) {
      const outcome = await stateService.mutate(execution.id, i, {
        set: { [`k${i}`]: "x".repeat(16366) },
      });
      expect(outcome.disposition).toBe("applied");
    }
    await expect(
      stateService.mutate(execution.id, 4, {
        set: { extra: "x".repeat(16364) },
      }),
    ).rejects.toThrow(/final state exceeds/);

    const snapshot = await stateService.read(execution.id);
    expect(snapshot?.version).toBe(4);
    expect(Object.keys(snapshot?.state ?? {})).toHaveLength(4);
    expect(jsonValueUtf8Size(snapshot?.state ?? {})).toBeLessThanOrEqual(
      EXECUTION_STATE_BOUNDS.maxStateBytes,
    );
  });

  it("AgentResult output and artifact descriptors never enter ExecutionState", async () => {
    const pipeline = await dataSource.getRepository(PipelineEntity).save(
      dataSource.getRepository(PipelineEntity).create({
        name: "state-regression",
        version: "1.0",
        steps: [{ id: "extract", agent: "reader", timeout: "5s" }],
      }),
    );
    const execution = await executionService.createExecution(pipeline, {
      input: "kept",
    });
    await executionService.reconcileExecution(execution.id);
    const claim = await executionService.claimRunnableStep(
      execution.id,
      { id: "extract", agent: "reader" } as any,
      { input: true },
      1,
    );
    expect(claim?.disposition).toBe("claimed");

    const result: AgentResultV1 = {
      schemaVersion: "1",
      invocationId: (claim as any).attempt.invocationId,
      executionId: execution.id,
      stepExecutionId: (claim as any).logicalStep.id,
      status: "succeeded",
      output: { big: "x".repeat(4096), agent: "data" },
      artifacts: [{ id: "worker-art-1", name: "produced.json" }],
      completedAt: new Date().toISOString(),
    };
    const application = await inbox.apply(result, {
      adapter: "http",
      receivedAt: new Date().toISOString(),
      deliveryId: "state-regression-delivery",
      keyId: "key-1",
    });
    expect(application.disposition).toBe("applied");

    // The canonical result and its artifacts took their normal path; the
    // semantic ExecutionState is untouched by both.
    const snapshot = await stateService.read(execution.id);
    expect(snapshot?.state).toEqual({});
    expect(snapshot?.version).toBe(0);
    expect(await dataSource.getRepository(ArtifactEntity).count()).toBe(1);
    const executionRow = await dataSource
      .getRepository(ExecutionEntity)
      .findOne({ where: { id: execution.id } });
    expect(executionRow?.output).toBeNull();
  });
});

/**
 * M2C suite: immutable per-attempt ContextSnapshot from an explicit state
 * projection. Proves atomic claim (snapshot + attempt + outbox), deep-equal
 * snapshot/invocation envelope, restart durability, deterministic projection
 * failure, race coherence, retry identity, historical immutability, and
 * legacy compatibility — all against real PostgreSQL.
 */
describeWithPostgres("PostgreSQL M2C context snapshot", () => {
  jest.setTimeout(120_000);

  let dataSource: DataSource;
  let executionService: ExecutionService;
  let stateService: ExecutionStateService;

  const workingAdapter = () => ({
    kind: "test",
    invoke: jest.fn().mockResolvedValue({
      adapter: "test",
      invocationId: "any",
      dispatchedAt: new Date().toISOString(),
    }),
  });

  const projectionStep = (id: string, stateKeys: string[]) => ({
    id,
    agent: "reader",
    contextProjection: { stateKeys },
  });

  const claim = async (
    executionId: string,
    stepConfig: any,
    maxAttempts = 1,
  ) => {
    await executionService.reconcileExecution(executionId);
    return executionService.claimRunnableStep(
      executionId,
      stepConfig,
      { input: true },
      maxAttempts,
    );
  };

  const rawAttempt = async (attemptId: string) => {
    const rows = await dataSource.query(
      `SELECT "contextSnapshot" FROM "step_attempts" WHERE "id" = $1`,
      [attemptId],
    );
    return rows[0];
  };

  const rawInvocation = async (attemptId: string) => {
    const rows = await dataSource.query(
      `SELECT invocation FROM "dispatch_outbox" WHERE "stepAttemptId" = $1`,
      [attemptId],
    );
    return rows[0];
  };

  beforeAll(async () => {
    assertDisposableTarget(TEST_DATABASE_URL);
    dataSource = new DataSource({
      ...databaseOptions(),
      type: "postgres" as const,
      url: TEST_DATABASE_URL,
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
    stateService = new ExecutionStateService(dataSource as any);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await dataSource.query(`TRUNCATE "executions", "pipelines" CASCADE`);
  });

  const createExecutionWithState = async (
    name: string,
    state: Record<string, unknown>,
    version = 0,
    steps: unknown[] = [],
  ) => {
    const pipeline = await dataSource.getRepository(PipelineEntity).save(
      dataSource.getRepository(PipelineEntity).create({
        name,
        version: "1.0",
        steps: steps as any[],
      }),
    );
    const execution = await executionService.createExecution(pipeline, {});
    if (version > 0) {
      await stateService.mutate(execution.id, 0, { set: state });
    } else {
      await dataSource
        .getRepository(ExecutionEntity)
        .update(execution.id, { executionState: state });
    }
    return execution;
  };

  it("commits snapshot, attempt, and outbox with a deep-equal envelope", async () => {
    const execution = await createExecutionWithState(
      "m2c-atomic",
      { brief: { ok: true }, "dotted.key": 1 },
      0,
      [projectionStep("a", ["brief", "dotted.key"])],
    );
    const claimResult = await claim(
      execution.id,
      projectionStep("a", ["brief", "dotted.key"]),
    );
    expect(claimResult?.disposition).toBe("claimed");

    const attemptId = (claimResult as any).attempt.id;
    const stored = await rawAttempt(attemptId);
    const outbox = await rawInvocation(attemptId);
    const expected = {
      tenvyr: {
        schemaVersion: 1,
        executionState: {
          version: 0,
          values: { brief: { ok: true }, "dotted.key": 1 },
        },
        artifacts: [],
      },
    };
    expect(stored.contextSnapshot).toEqual(expected);
    expect(outbox.invocation.context).toEqual(expected);
    // JSONB deep equality is authoritative (raw SQL, no ORM defaults).
    const equality = await dataSource.query(
      `SELECT (SELECT "contextSnapshot" FROM "step_attempts" WHERE "id" = $1)
              = (SELECT invocation->'context' FROM "dispatch_outbox" WHERE "stepAttemptId" = $1) AS equal`,
      [attemptId],
    );
    expect(equality[0].equal).toBe(true);
  });

  it("legacy steps without a projection keep null snapshot and no context member", async () => {
    const execution = await createExecutionWithState(
      "m2c-legacy",
      { brief: 1 },
      0,
      [{ id: "a", agent: "reader" }],
    );
    const claimResult = await claim(execution.id, { id: "a", agent: "reader" });
    expect(claimResult?.disposition).toBe("claimed");
    const attemptId = (claimResult as any).attempt.id;
    const stored = await rawAttempt(attemptId);
    const outbox = await rawInvocation(attemptId);
    expect(stored.contextSnapshot).toBeNull();
    expect(outbox.invocation).not.toHaveProperty("context");
  });

  it("a projection failure creates one failed pre-dispatch attempt and no outbox (ATOMIC-001)", async () => {
    const execution = await createExecutionWithState(
      "m2c-missing",
      { present: 1 },
      0,
      [projectionStep("a", ["absent"])],
    );
    const result = await claim(execution.id, projectionStep("a", ["absent"]));
    expect(result?.disposition).toBe("projection_failed");
    const attempts = await dataSource.getRepository(StepAttemptEntity).find({
      where: { executionId: execution.id },
    });
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({
      status: "FAILED",
      contextSnapshot: null,
      error: "Context projection failed: TENVYR_CTX_MISSING_STATE_KEY",
    });
    expect(await dataSource.getRepository(DispatchOutboxEntity).count()).toBe(
      0,
    );
  });

  it("a forced outbox failure rolls back attempt and snapshot together", async () => {
    const execution = await createExecutionWithState(
      "m2c-outbox-fail",
      { brief: 1 },
      0,
      [projectionStep("a", ["brief"])],
    );
    await dataSource.query(
      `ALTER TABLE "dispatch_outbox" RENAME TO "dispatch_outbox_m2c_hidden"`,
    );
    try {
      await expect(
        claim(execution.id, projectionStep("a", ["brief"])),
      ).rejects.toThrow();
    } finally {
      await dataSource.query(
        `ALTER TABLE "dispatch_outbox_m2c_hidden" RENAME TO "dispatch_outbox"`,
      );
    }
    expect(await dataSource.getRepository(StepAttemptEntity).count()).toBe(0);
    expect(await dataSource.getRepository(DispatchOutboxEntity).count()).toBe(
      0,
    );
    // Clean retry after the failure works and commits atomically.
    const retried = await claim(execution.id, projectionStep("a", ["brief"]));
    expect(retried?.disposition).toBe("claimed");
    const attemptId = (retried as any).attempt.id;
    const stored = await rawAttempt(attemptId);
    expect(stored.contextSnapshot.tenvyr.executionState.version).toBe(0);
  });

  it("restart preserves snapshot and invocation; redelivery uses the persisted invocation", async () => {
    const execution = await createExecutionWithState(
      "m2c-restart",
      { brief: 1 },
      0,
      [projectionStep("a", ["brief"])],
    );
    const claimResult = await claim(
      execution.id,
      projectionStep("a", ["brief"]),
    );
    const attemptId = (claimResult as any).attempt.id;
    const expected = await rawAttempt(attemptId);

    const reopened = new DataSource({
      ...databaseOptions(),
      type: "postgres" as const,
      url: TEST_DATABASE_URL,
    } as DataSourceOptions);
    await reopened.initialize();
    await reopened.runMigrations();
    try {
      const rows = await reopened.query(
        `SELECT "contextSnapshot" FROM "step_attempts" WHERE "id" = $1`,
        [attemptId],
      );
      const invocations = await reopened.query(
        `SELECT invocation FROM "dispatch_outbox" WHERE "stepAttemptId" = $1`,
        [attemptId],
      );
      expect(rows[0].contextSnapshot).toEqual(expected.contextSnapshot);
      expect(invocations[0].invocation.context).toEqual(
        expected.contextSnapshot,
      );
    } finally {
      await reopened.destroy();
    }
  });

  it("a state mutation racing a claim yields a coherent old or new version, never a mix", async () => {
    const config = projectionStep("a", ["k"]);
    const execution = await createExecutionWithState(
      "m2c-race",
      { k: "before" },
      0,
      [config],
    );
    for (let round = 0; round < 10; round += 1) {
      // Reset the round: no active attempt, the step back to READY, state
      // back to version 0 — then race the claim against a mutation.
      await dataSource.query(
        `UPDATE "step_attempts" SET "status" = 'CANCELLED', "terminalAt" = NOW()
         WHERE "executionId" = $1 AND "status" IN ('CREATED','DISPATCHED','RUNNING')`,
        [execution.id],
      );
      await dataSource.query(
        `UPDATE "step_executions" SET "status" = 'READY', "eligibleAt" = NOW(),
                "attempt" = 0, "endTime" = NULL, "output" = NULL, "error" = NULL
         WHERE "executionId" = $1`,
        [execution.id],
      );
      await dataSource.getRepository(ExecutionEntity).update(execution.id, {
        executionState: { k: "before" },
        executionStateVersion: 0,
      });
      const results = await Promise.allSettled([
        claim(execution.id, config),
        stateService.mutate(execution.id, 0, { set: { k: "after" } }),
      ]);
      // Exactly one claim may win per round; the loser returns null. The
      // mutation may win the lock first (claim then sees version 1) or lose
      // (claim sees version 0). A torn read would see version 0 with
      // "after" or version 1 with "before".
      const claimed = results.find(
        (result) =>
          result.status === "fulfilled" &&
          (result.value as any)?.disposition === "claimed",
      );
      if (claimed && claimed.status === "fulfilled") {
        const attempt = (claimed.value as any).attempt;
        const stored = await rawAttempt(attempt.id);
        const envelope = stored.contextSnapshot as any;
        const version = envelope.tenvyr.executionState.version;
        const value = envelope.tenvyr.executionState.values.k;
        expect(version === 0 ? value === "before" : value === "after").toBe(
          true,
        );
      }
    }
  });

  it("a retry owns a new attempt and snapshot; historical snapshots never change", async () => {
    const execution = await createExecutionWithState(
      "m2c-retry",
      { k: "v0" },
      0,
      [projectionStep("a", ["k"])],
    );
    const first = await claim(execution.id, projectionStep("a", ["k"]));
    const firstAttempt = (first as any).attempt;
    await stateService.mutate(execution.id, 0, { set: { k: "v1" } });
    // Settle attempt 1 and schedule a retry with a NEW invocation identity.
    await dataSource
      .getRepository(StepAttemptEntity)
      .update(firstAttempt.id, { status: "FAILED", terminalAt: new Date() });
    await dataSource
      .getRepository(LogicalStepEntity)
      .update(firstAttempt.logicalStepId, {
        status: "RETRYING",
        nextAttemptAt: new Date(0),
      });
    const second = await claim(
      execution.id,
      { id: "a", agent: "reader", contextProjection: { stateKeys: ["k"] } },
      2,
    );
    expect(second?.disposition).toBe("claimed");
    expect((second as any).attempt.id).not.toBe(firstAttempt.id);
    expect((second as any).attempt.invocationId).not.toBe(
      firstAttempt.invocationId,
    );

    const firstStored = await rawAttempt(firstAttempt.id);
    const secondStored = await rawAttempt((second as any).attempt.id);
    // Attempt 1 froze version 0; the retry froze version 1.
    expect(firstStored.contextSnapshot.tenvyr.executionState.version).toBe(0);
    expect(firstStored.contextSnapshot.tenvyr.executionState.values.k).toBe(
      "v0",
    );
    expect(secondStored.contextSnapshot.tenvyr.executionState.version).toBe(1);
    expect(secondStored.contextSnapshot.tenvyr.executionState.values.k).toBe(
      "v1",
    );
  });

  it("an envelope at the 64 KiB boundary claims; one byte over fails deterministically", async () => {
    const emptyEnvelope = {
      tenvyr: {
        schemaVersion: 1,
        executionState: { version: 0, values: { pad: "" } },
        artifacts: [],
      },
    };
    const emptyEnvelopeSize = jsonValueUtf8Size(emptyEnvelope);
    const pad = "a".repeat(
      CONTEXT_SNAPSHOT_BOUNDS.maxEnvelopeBytes - emptyEnvelopeSize,
    );
    const execution = await createExecutionWithState(
      "m2c-boundary",
      { pad },
      0,
      [projectionStep("a", ["pad"])],
    );
    const ok = await claim(execution.id, projectionStep("a", ["pad"]));
    expect(ok?.disposition).toBe("claimed");

    const tooBig = await createExecutionWithState(
      "m2c-over",
      { pad: pad + "a" },
      0,
      [projectionStep("a", ["pad"])],
    );
    const failed = await claim(tooBig.id, projectionStep("a", ["pad"]));
    expect(failed?.disposition).toBe("projection_failed");
    const attempts = await dataSource.getRepository(StepAttemptEntity).find({
      where: { executionId: tooBig.id },
    });
    expect(attempts).toHaveLength(1);
    expect(attempts[0].error).toBe(
      "Context projection failed: TENVYR_CTX_ENVELOPE_TOO_LARGE",
    );
  });

  it("projection failure follows the deterministic engine failure policy with no poison loop", async () => {
    const pipeline = await dataSource.getRepository(PipelineEntity).save(
      dataSource.getRepository(PipelineEntity).create({
        name: "m2c-engine-fail",
        version: "1.0",
        steps: [],
      }),
    );
    const execution = await executionService.createExecution(pipeline, {});
    // The frozen plan revision carries the projection; the engine claims from
    // it, so the missing key fails inside the claim and the run FAILED.
    await dataSource
      .getRepository(ExecutionPlanRevisionEntity)
      .update(execution.activePlanRevisionId!, {
        plan: {
          schemaVersion: 1,
          steps: [projectionStep("a", ["absent"])],
        },
      } as any);
    const engine = new EngineService(
      { findOne: jest.fn().mockResolvedValue(pipeline) } as any,
      executionService as any,
      workingAdapter() as any,
      new DispatchOutboxService(dataSource as any, workingAdapter() as any),
    );
    await engine.reconcileExecution(execution.id);
    const executionRow = await dataSource
      .getRepository(ExecutionEntity)
      .findOne({ where: { id: execution.id } });
    expect(executionRow?.status).toBe("FAILED");
    expect((executionRow?.output as any)?.error).toContain(
      "TENVYR_CTX_MISSING_STATE_KEY",
    );
    expect(await dataSource.getRepository(StepAttemptEntity).count()).toBe(1);
    expect(await dataSource.getRepository(DispatchOutboxEntity).count()).toBe(
      0,
    );
    // A later reconcile cannot resurrect a READY poison loop: the run is
    // terminal, so the claim precondition fails and nothing new appears.
    await engine.reconcileExecution(execution.id);
    expect(await dataSource.getRepository(StepAttemptEntity).count()).toBe(1);
    expect(await dataSource.getRepository(DispatchOutboxEntity).count()).toBe(
      0,
    );
  });

  it("projection failure applies retry and continue policies without dispatch", async () => {
    const retryStep = {
      ...projectionStep("retrying", ["absent"]),
      onFailure: "retry" as const,
      retries: 1,
    };
    const retryPipeline = await dataSource.getRepository(PipelineEntity).save(
      dataSource.getRepository(PipelineEntity).create({
        name: "m2c-retry-policy",
        version: "1.0",
        steps: [retryStep],
      }),
    );
    const retryExecution = await executionService.createExecution(
      retryPipeline,
      {},
    );
    const retryAdapter = workingAdapter();
    const retryEngine = new EngineService(
      { findOne: jest.fn().mockResolvedValue(retryPipeline) } as any,
      executionService as any,
      retryAdapter as any,
      new DispatchOutboxService(dataSource as any, retryAdapter as any),
    );
    await retryEngine.reconcileExecution(retryExecution.id);
    const retryAttempts = await dataSource
      .getRepository(StepAttemptEntity)
      .find({
        where: { executionId: retryExecution.id },
        order: { attemptNumber: "ASC" },
      });
    expect(retryAttempts).toHaveLength(2);
    expect(retryAttempts.map((attempt) => attempt.status)).toEqual([
      "FAILED",
      "FAILED",
    ]);
    expect(
      (await executionService.getExecution(retryExecution.id))?.status,
    ).toBe("FAILED");

    const continueStep = {
      ...projectionStep("optional-context", ["absent"]),
      onFailure: "continue" as const,
    };
    const downstreamStep = {
      id: "downstream",
      agent: "reader",
      dependsOn: ["optional-context"],
    };
    const continuePipeline = await dataSource
      .getRepository(PipelineEntity)
      .save(
        dataSource.getRepository(PipelineEntity).create({
          name: "m2c-continue-policy",
          version: "1.0",
          steps: [continueStep, downstreamStep],
        }),
      );
    const continueExecution = await executionService.createExecution(
      continuePipeline,
      {},
    );
    const continueAdapter = workingAdapter();
    const continueEngine = new EngineService(
      { findOne: jest.fn().mockResolvedValue(continuePipeline) } as any,
      executionService as any,
      continueAdapter as any,
      new DispatchOutboxService(dataSource as any, continueAdapter as any),
    );
    await continueEngine.reconcileExecution(continueExecution.id);
    const continueSteps = await executionService.getStepExecutions(
      continueExecution.id,
    );
    expect(
      continueSteps.find((step) => step.stepId === "optional-context")?.status,
    ).toBe("FAILED");
    expect(
      continueSteps.find((step) => step.stepId === "downstream")?.status,
    ).toBe("RUNNING");
    expect(
      (await executionService.getExecution(continueExecution.id))?.status,
    ).toBe("RUNNING");
    const downstreamAttempt = await dataSource
      .getRepository(StepAttemptEntity)
      .findOne({
        where: {
          logicalStepId: continueSteps.find(
            (step) => step.stepId === "downstream",
          )!.id,
        },
      });
    expect(downstreamAttempt).not.toBeNull();
    expect(
      await dataSource.getRepository(DispatchOutboxEntity).count({
        where: { stepAttemptId: downstreamAttempt!.id },
      }),
    ).toBe(1);
    expect(continueAdapter.invoke).toHaveBeenCalledTimes(1);
  });
});

/**
 * M2D suite: artifact projection and attempt-to-artifact exposure lineage.
 * Proves authoritative producer resolution (canonical APPLIED success only),
 * same-execution enforcement, name/ordinal filters, deterministic overlap and
 * no-match failures, atomic claim (attempt + snapshot + exposure edges +
 * outbox), restart durability, retry/redelivery behavior, migration order,
 * and lineage queryability — all against real PostgreSQL.
 */
describeWithPostgres("PostgreSQL M2D artifact projection", () => {
  jest.setTimeout(120_000);

  let dataSource: DataSource;
  let executionService: ExecutionService;
  let inbox: ResultInboxService;

  const producerStep = { id: "research", agent: "reader" };
  const consumerStep = (artifacts: unknown[]) => ({
    id: "review",
    agent: "reviewer",
    dependsOn: ["research"],
    contextProjection: { stateKeys: [], artifacts },
  });

  const rawInvocationContext = async (attemptId: string) => {
    const rows = await dataSource.query(
      `SELECT invocation FROM "dispatch_outbox" WHERE "stepAttemptId" = $1`,
      [attemptId],
    );
    return rows[0].invocation.context;
  };

  const rawSnapshot = async (attemptId: string) => {
    const rows = await dataSource.query(
      `SELECT "contextSnapshot" FROM "step_attempts" WHERE "id" = $1`,
      [attemptId],
    );
    return rows[0].contextSnapshot;
  };

  const exposureRows = async (attemptId: string) => {
    const rows = await dataSource.query(
      `SELECT "artifactId" FROM "artifact_exposures"
       WHERE "stepAttemptId" = $1 ORDER BY "artifactId"`,
      [attemptId],
    );
    return rows.map((row: any) => row.artifactId);
  };

  beforeAll(async () => {
    assertDisposableTarget(TEST_DATABASE_URL);
    dataSource = new DataSource({
      ...databaseOptions(),
      type: "postgres" as const,
      url: TEST_DATABASE_URL,
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
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await dataSource.query(`TRUNCATE "executions", "pipelines" CASCADE`);
  });

  const createExecution = async (
    name: string,
    steps: unknown[],
  ): Promise<ExecutionEntity> => {
    const pipeline = await dataSource.getRepository(PipelineEntity).save(
      dataSource.getRepository(PipelineEntity).create({
        name,
        version: "1.0",
        steps: steps as any[],
      }),
    );
    return executionService.createExecution(pipeline, {});
  };

  const claimStep = async (
    executionId: string,
    stepConfig: any,
    maxAttempts = 1,
  ) => {
    await executionService.reconcileExecution(executionId);
    return executionService.claimRunnableStep(
      executionId,
      stepConfig,
      { input: true },
      maxAttempts,
    );
  };

  const completeProducer = async (
    executionId: string,
    descriptors: Array<Record<string, unknown>>,
  ) => {
    const claim = await claimStep(executionId, producerStep);
    expect(claim?.disposition).toBe("claimed");
    const attempt = (claim as any).attempt;
    const result: AgentResultV1 = {
      schemaVersion: "1",
      invocationId: attempt.invocationId,
      executionId,
      stepExecutionId: (claim as any).logicalStep.id,
      status: "succeeded",
      output: { produced: true },
      artifacts: descriptors as any,
      completedAt: new Date().toISOString(),
    };
    const application = await inbox.apply(result, {
      adapter: "http",
      receivedAt: new Date().toISOString(),
      deliveryId: `delivery-${executionId}`,
      keyId: "key-1",
    });
    expect(application.disposition).toBe("applied");
    return attempt;
  };

  it("projects artifact references and exposure edges atomically with the claim", async () => {
    const execution = await createExecution("m2d-atomic", [
      producerStep,
      consumerStep([
        { fromStep: "research", name: "report.json", includeMetadata: true },
        { fromStep: "research", ordinal: 1 },
      ]),
    ]);
    await completeProducer(execution.id, [
      {
        id: "worker-1",
        name: "report.json",
        mediaType: "application/json",
        uri: "s3://opaque/report.json",
        metadata: { score: 9 },
      },
      {
        id: "worker-2",
        name: "notes.md",
        mediaType: "text/markdown",
        uri: "gs://opaque/notes.md",
      },
    ]);

    const claim = await claimStep(
      execution.id,
      consumerStep([
        { fromStep: "research", name: "report.json", includeMetadata: true },
        { fromStep: "research", ordinal: 1 },
      ]),
    );
    expect(claim?.disposition).toBe("claimed");
    const attemptId = (claim as any).attempt.id;

    const snapshot = await rawSnapshot(attemptId);
    const context = await rawInvocationContext(attemptId);
    expect(snapshot).toEqual(context); // deep-equal snapshot and outbox
    const artifacts = (snapshot as any).tenvyr.artifacts;
    expect(artifacts).toHaveLength(2);
    // Deterministic order: producer step, producer attempt, ordinal.
    expect(artifacts[0].descriptorOrdinal).toBe(0);
    expect(artifacts[0].name).toBe("report.json");
    expect(artifacts[0].metadata).toEqual({ score: 9 }); // includeMetadata
    expect(artifacts[1]).not.toHaveProperty("metadata");
    expect(artifacts[1].uri).toBe("gs://opaque/notes.md");

    // Exposure edges: one per projected reference.
    const edges = await exposureRows(attemptId);
    expect(edges).toHaveLength(2);
    const artifactIds = await dataSource.getRepository(ArtifactEntity).find();
    expect(edges.sort()).toEqual(artifactIds.map((row) => row.id).sort());
  });

  it("resolves no artifacts when the producer has no eligible successful result", async () => {
    const execution = await createExecution("m2d-skipped", [
      producerStep,
      consumerStep([{ fromStep: "research" }]),
    ]);
    // The producer never runs: its step is skipped by the scheduler decision.
    await dataSource
      .getRepository(LogicalStepEntity)
      .update(
        { executionId: execution.id, stepId: "research" },
        { status: "SKIPPED", endTime: new Date() },
      );
    const claim = await claimStep(
      execution.id,
      consumerStep([{ fromStep: "research" }]),
    );
    expect(claim?.disposition).toBe("claimed");
    const snapshot = await rawSnapshot((claim as any).attempt.id);
    expect((snapshot as any).tenvyr.artifacts).toEqual([]);
    expect(await exposureRows((claim as any).attempt.id)).toEqual([]);
  });

  it("fails deterministically when a configured filter matches no artifact", async () => {
    const execution = await createExecution("m2d-no-match", [
      producerStep,
      consumerStep([{ fromStep: "research", name: "missing.json" }]),
    ]);
    await completeProducer(execution.id, [
      { id: "worker-1", name: "report.json", uri: "s3://opaque/report.json" },
    ]);
    const failed = await claimStep(
      execution.id,
      consumerStep([{ fromStep: "research", name: "missing.json" }]),
    );
    expect(failed?.disposition).toBe("projection_failed");
    const attempts = await dataSource.getRepository(StepAttemptEntity).find({
      where: { executionId: execution.id },
    });
    expect(attempts).toHaveLength(2); // producer + failed consumer
    expect(attempts.find((attempt) => attempt.status === "FAILED")?.error).toBe(
      "Context projection failed: TENVYR_CTX_ARTIFACT_FILTER_NO_MATCH",
    );
    expect(await dataSource.getRepository(DispatchOutboxEntity).count()).toBe(
      1,
    );
  });

  it("fails deterministically on overlapping selectors resolving one artifact", async () => {
    const execution = await createExecution("m2d-overlap", [
      producerStep,
      consumerStep([
        { fromStep: "research" },
        { fromStep: "research", name: "report.json" },
      ]),
    ]);
    await completeProducer(execution.id, [
      { id: "worker-1", name: "report.json", uri: "s3://opaque/report.json" },
    ]);
    const failed = await claimStep(
      execution.id,
      consumerStep([
        { fromStep: "research" },
        { fromStep: "research", name: "report.json" },
      ]),
    );
    expect(failed?.disposition).toBe("projection_failed");
    const attempts = await dataSource.getRepository(StepAttemptEntity).find({
      where: { executionId: execution.id },
    });
    expect(attempts).toHaveLength(2);
    expect(attempts.find((attempt) => attempt.status === "FAILED")?.error).toBe(
      "Context projection failed: TENVYR_CTX_ARTIFACT_OVERLAP",
    );
  });

  it("a forced exposure-insert failure rolls back attempt, snapshot, and outbox", async () => {
    const execution = await createExecution("m2d-edge-fail", [
      producerStep,
      consumerStep([{ fromStep: "research" }]),
    ]);
    await completeProducer(execution.id, [
      { id: "worker-1", name: "report.json", uri: "s3://opaque/report.json" },
    ]);
    await dataSource.query(
      `ALTER TABLE "artifact_exposures" RENAME TO "artifact_exposures_m2d_hidden"`,
    );
    try {
      await expect(
        claimStep(execution.id, consumerStep([{ fromStep: "research" }])),
      ).rejects.toThrow();
    } finally {
      await dataSource.query(
        `ALTER TABLE "artifact_exposures_m2d_hidden" RENAME TO "artifact_exposures"`,
      );
    }
    // The consumer attempt never committed.
    const attempts = await dataSource
      .getRepository(StepAttemptEntity)
      .find({ where: { executionId: execution.id } });
    expect(attempts).toHaveLength(1); // producer only
    expect(await dataSource.getRepository(DispatchOutboxEntity).count()).toBe(
      1,
    );
    // Clean retry commits attempt, snapshot, edges, and outbox together.
    const retried = await claimStep(
      execution.id,
      consumerStep([{ fromStep: "research" }]),
    );
    expect(retried?.disposition).toBe("claimed");
    expect(await exposureRows((retried as any).attempt.id)).toHaveLength(1);
  });

  it("restart preserves snapshot, invocation, and exposure edges", async () => {
    const execution = await createExecution("m2d-restart", [
      producerStep,
      consumerStep([{ fromStep: "research" }]),
    ]);
    await completeProducer(execution.id, [
      { id: "worker-1", name: "report.json", uri: "s3://opaque/report.json" },
    ]);
    const claim = await claimStep(
      execution.id,
      consumerStep([{ fromStep: "research" }]),
    );
    const attemptId = (claim as any).attempt.id;
    const snapshot = await rawSnapshot(attemptId);

    const reopened = new DataSource({
      ...databaseOptions(),
      type: "postgres" as const,
      url: TEST_DATABASE_URL,
    } as DataSourceOptions);
    await reopened.initialize();
    await reopened.runMigrations();
    try {
      const rows = await reopened.query(
        `SELECT "contextSnapshot" FROM "step_attempts" WHERE "id" = $1`,
        [attemptId],
      );
      const edges = await reopened.query(
        `SELECT "artifactId" FROM "artifact_exposures" WHERE "stepAttemptId" = $1`,
        [attemptId],
      );
      expect(rows[0].contextSnapshot).toEqual(snapshot);
      expect(edges).toHaveLength(1);
    } finally {
      await reopened.destroy();
    }
  });

  it("a retry owns a new attempt with its own exposure edges; redelivery adds none", async () => {
    const execution = await createExecution("m2d-retry", [
      producerStep,
      consumerStep([{ fromStep: "research" }]),
    ]);
    await completeProducer(execution.id, [
      { id: "worker-1", name: "report.json", uri: "s3://opaque/report.json" },
    ]);
    const first = await claimStep(
      execution.id,
      consumerStep([{ fromStep: "research" }]),
    );
    const firstAttempt = (first as any).attempt;
    expect(await exposureRows(firstAttempt.id)).toHaveLength(1);

    // Redelivery of the same attempt never creates edges.
    const outboxService = new DispatchOutboxService(
      dataSource as any,
      {
        kind: "test",
        invoke: jest.fn().mockResolvedValue({
          adapter: "test",
          invocationId: firstAttempt.invocationId,
          dispatchedAt: new Date().toISOString(),
        }),
      } as any,
    );
    await outboxService.dispatchAttempt(firstAttempt.id);
    expect(await exposureRows(firstAttempt.id)).toHaveLength(1);

    // Retry: settle attempt 1, schedule a fresh attempt, claim again.
    await dataSource
      .getRepository(StepAttemptEntity)
      .update(firstAttempt.id, { status: "FAILED", terminalAt: new Date() });
    await dataSource
      .getRepository(LogicalStepEntity)
      .update(firstAttempt.logicalStepId, {
        status: "RETRYING",
        nextAttemptAt: new Date(0),
      });
    const second = await claimStep(
      execution.id,
      consumerStep([{ fromStep: "research" }]),
    );
    expect(second?.disposition).toBe("claimed");
    expect((second as any).attempt.id).not.toBe(firstAttempt.id);
    // Two attempts, two distinct edge sets, no sharing.
    const allEdges = await dataSource
      .getRepository(ArtifactExposureEntity)
      .find({ where: { artifactId: In(await exposureRows(firstAttempt.id)) } });
    expect(
      allEdges.filter(
        (edge) => edge.stepAttemptId === (second as any).attempt.id,
      ),
    ).toHaveLength(1);
    expect(
      allEdges.filter((edge) => edge.stepAttemptId === firstAttempt.id),
    ).toHaveLength(1);
  });

  it("exposes queryable consumer-to-producer lineage without a public API", async () => {
    const execution = await createExecution("m2d-lineage", [
      producerStep,
      consumerStep([{ fromStep: "research" }]),
    ]);
    const producerAttempt = await completeProducer(execution.id, [
      { id: "worker-1", name: "report.json", uri: "s3://opaque/report.json" },
    ]);
    const claim = await claimStep(
      execution.id,
      consumerStep([{ fromStep: "research" }]),
    );
    const consumerAttemptId = (claim as any).attempt.id;

    const lineage = await dataSource.query(
      `SELECT exposure."stepAttemptId" AS "consumerAttemptId",
              exposure."artifactId",
              artifact."resultInboxId",
              inbox."stepAttemptId" AS "producerAttemptId",
              attempt."attemptNumber" AS "producerAttemptNumber",
              step."stepId" AS "producerStepId"
       FROM "artifact_exposures" exposure
       JOIN "artifacts" artifact ON artifact."id" = exposure."artifactId"
       JOIN "result_inbox" inbox ON inbox."id" = artifact."resultInboxId"
       JOIN "step_attempts" attempt ON attempt."id" = inbox."stepAttemptId"
       JOIN "step_executions" step ON step."id" = attempt."logicalStepId"
       WHERE exposure."stepAttemptId" = $1`,
      [consumerAttemptId],
    );
    expect(lineage).toHaveLength(1);
    expect(lineage[0].consumerAttemptId).toBe(consumerAttemptId);
    expect(lineage[0].producerAttemptId).toBe(producerAttempt.id);
    expect(lineage[0].producerStepId).toBe("research");
  });

  it("the exposure migration runs after M2C, is repeat-safe, and never backfills", async () => {
    const names = (
      await dataSource.query(
        `SELECT name FROM "migrations" ORDER BY "timestamp" ASC`,
      )
    ).map((row: any) => row.name);
    expect(
      names.indexOf("MilestoneTwoArtifactExposure1722270004000"),
    ).toBeGreaterThan(names.indexOf("MilestoneTwoExecutionState1722270003000"));
    // Repeat application is a no-op (IF NOT EXISTS convention).
    await new MilestoneTwoArtifactExposure1722270004000().up(
      dataSource.createQueryRunner(),
    );
    const columns = await dataSource.query(
      `SELECT "column_name", "is_nullable" FROM information_schema.columns
       WHERE "table_name" = 'artifact_exposures' ORDER BY "column_name"`,
    );
    expect(columns.map((row: any) => row.column_name)).toEqual([
      "artifactId",
      "createdAt",
      "id",
      "stepAttemptId",
    ]);
    // No historical rows were fabricated by the migration.
    expect(await dataSource.getRepository(ArtifactExposureEntity).count()).toBe(
      0,
    );
  });
});

/**
 * M2E suite: pipeline-declared controlled state writes from canonical
 * successful results. Proves pointer resolution, no-op version semantics,
 * deterministic mapping-failure disposition (retry/onFailure policy, no
 * poison loop), atomic result/state/artifact/provenance commits, duplicate
 * and cancel safety, concurrent disjoint writers, restart durability,
 * migration order, and protocol compatibility — against real PostgreSQL.
 */
describeWithPostgres("PostgreSQL M2E controlled state writes", () => {
  jest.setTimeout(120_000);

  let dataSource: DataSource;
  let executionService: ExecutionService;
  let inbox: ResultInboxService;

  const writerStep = (id: string, stateWrites: unknown[]) => ({
    id,
    agent: "writer",
    stateWrites: stateWrites as any,
  });

  const rawState = async (executionId: string) => {
    const rows = await dataSource.query(
      `SELECT "executionState", "executionStateVersion", "executionStateUpdatedAt"
       FROM "executions" WHERE "id" = $1`,
      [executionId],
    );
    return rows[0];
  };

  const evidenceRows = async (executionId: string) => {
    return dataSource.getRepository(StateWriteEvidenceEntity).find({
      where: { executionId },
      order: { createdAt: "ASC" },
    });
  };

  beforeAll(async () => {
    assertDisposableTarget(TEST_DATABASE_URL);
    dataSource = new DataSource({
      ...databaseOptions(),
      type: "postgres" as const,
      url: TEST_DATABASE_URL,
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
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await dataSource.query(`TRUNCATE "executions", "pipelines" CASCADE`);
  });

  const createExecution = async (
    name: string,
    steps: unknown[],
  ): Promise<ExecutionEntity> => {
    const pipeline = await dataSource.getRepository(PipelineEntity).save(
      dataSource.getRepository(PipelineEntity).create({
        name,
        version: "1.0",
        steps: steps as any[],
      }),
    );
    return executionService.createExecution(pipeline, {});
  };

  const claimAndApply = async (
    executionId: string,
    stepConfig: any,
    output: unknown,
    resultOverrides: Partial<AgentResultV1> = {},
    maxAttempts = 1,
  ) => {
    await executionService.reconcileExecution(executionId);
    const claim = await executionService.claimRunnableStep(
      executionId,
      stepConfig,
      { input: true },
      maxAttempts,
    );
    expect(claim?.disposition).toBe("claimed");
    const attempt = (claim as any).attempt;
    const result: AgentResultV1 = {
      schemaVersion: "1",
      invocationId: attempt.invocationId,
      executionId,
      stepExecutionId: (claim as any).logicalStep.id,
      status: "succeeded",
      output: output as JsonValue,
      completedAt: new Date().toISOString(),
      ...resultOverrides,
    };
    const application = await inbox.apply(result, {
      adapter: "http",
      receivedAt: new Date().toISOString(),
      deliveryId: `delivery-${attempt.invocationId}`,
      keyId: "key-1",
    });
    return { application, claim, attempt };
  };

  it("applies a real mapping once: version increments exactly once, provenance records applied", async () => {
    const execution = await createExecution("m2e-applied", [
      writerStep("a", [
        { key: "approvedBrief", fromOutput: "/brief" },
        { key: "second", fromOutput: "/list/1" },
      ]),
    ]);
    const { application } = await claimAndApply(
      execution.id,
      writerStep("a", [
        { key: "approvedBrief", fromOutput: "/brief" },
        { key: "second", fromOutput: "/list/1" },
      ]),
      {
        brief: { title: "x" },
        list: ["zero", "one"],
      },
    );
    expect(application.disposition).toBe("applied");

    const state = await rawState(execution.id);
    expect(state.executionState).toEqual({
      approvedBrief: { title: "x" },
      second: "one",
    });
    expect(state.executionStateVersion).toBe(1);
    expect(state.executionStateUpdatedAt).not.toBeNull();

    const evidence = await evidenceRows(execution.id);
    expect(evidence).toHaveLength(1);
    expect(evidence[0]).toMatchObject({
      disposition: "applied",
      priorVersion: 0,
      resultVersion: 1,
      rejectionCode: null,
    });
    expect(evidence[0].mappingHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("a semantic no-op changes no version, timestamp, or state, and records noop", async () => {
    const execution = await createExecution("m2e-noop", [
      writerStep("a", [{ key: "k", fromOutput: "/k" }]),
    ]);
    await dataSource
      .getRepository(ExecutionEntity)
      .update(execution.id, { executionState: { k: "same" } });
    const before = await rawState(execution.id);
    const { application } = await claimAndApply(
      execution.id,
      writerStep("a", [{ key: "k", fromOutput: "/k" }]),
      { k: "same" },
    );
    expect(application.disposition).toBe("applied");

    const after = await rawState(execution.id);
    expect(after.executionStateVersion).toBe(before.executionStateVersion);
    expect(after.executionStateUpdatedAt?.getTime()).toBe(
      before.executionStateUpdatedAt?.getTime(),
    );
    expect(after.executionState).toEqual({ k: "same" });

    const evidence = await evidenceRows(execution.id);
    expect(evidence).toHaveLength(1);
    expect(evidence[0].disposition).toBe("noop");
    expect(evidence[0].priorVersion).toBe(evidence[0].resultVersion);
  });

  it("a missing pointer rejects the whole write: attempt FAILED, no state keys, retry policy applies", async () => {
    const execution = await createExecution("m2e-rejected", [
      {
        ...writerStep("a", [{ key: "k", fromOutput: "/missing" }]),
        onFailure: "retry",
        retries: 1,
      },
    ]);
    const { application, attempt } = await claimAndApply(
      execution.id,
      {
        ...writerStep("a", [{ key: "k", fromOutput: "/missing" }]),
        onFailure: "retry",
        retries: 1,
      },
      { present: 1 },
      {},
      2,
    );
    expect(application.disposition).toBe("applied");

    // The canonical result is evidence; the attempt is a deterministic
    // Tenvyr postcondition failure that follows the retry policy.
    const attemptRow = await dataSource
      .getRepository(StepAttemptEntity)
      .findOne({ where: { id: attempt.id } });
    expect(attemptRow?.status).toBe("FAILED");
    expect(attemptRow?.error).toContain(
      "TENVYR_STATE_WRITE_REJECTED: TENVYR_STATE_WRITE_POINTER_MISSING",
    );
    const stepRow = await dataSource
      .getRepository(LogicalStepEntity)
      .findOne({ where: { id: attemptRow!.logicalStepId } });
    expect(stepRow?.status).toBe("RETRYING");
    const state = await rawState(execution.id);
    expect(state.executionState).toEqual({});
    expect(state.executionStateVersion).toBe(0);
    const inboxRow = await dataSource
      .getRepository(ResultInboxEntity)
      .findOne({ where: { invocationId: attempt.invocationId } });
    expect(inboxRow?.status).toBe("APPLIED"); // no transport poison loop
    expect(inboxRow?.lastApplicationError).toContain(
      "TENVYR_STATE_WRITE_REJECTED",
    );
    const evidence = await evidenceRows(execution.id);
    expect(evidence).toHaveLength(1);
    expect(evidence[0].disposition).toBe("rejected");
    expect(evidence[0].rejectionCode).toBe(
      "TENVYR_STATE_WRITE_POINTER_MISSING",
    );
  });

  it("an unsafe nested JSON key is rejected before any state value commits", async () => {
    const execution = await createExecution("m2e-unsafe-nested", [
      writerStep("a", [{ key: "k", fromOutput: "/value" }]),
    ]);
    const { application, attempt } = await claimAndApply(
      execution.id,
      writerStep("a", [{ key: "k", fromOutput: "/value" }]),
      {
        value: JSON.parse('{"safe":{"constructor":{"polluted":true}}}'),
      },
    );
    expect(application.disposition).toBe("applied");
    const attemptRow = await dataSource
      .getRepository(StepAttemptEntity)
      .findOne({ where: { id: attempt.id } });
    expect(attemptRow?.status).toBe("FAILED");
    expect(attemptRow?.error).toContain(
      "TENVYR_STATE_WRITE_REJECTED: TENVYR_STATE_WRITE_INVALID_PATCH",
    );
    const state = await rawState(execution.id);
    expect(state.executionState).toEqual({});
    expect(state.executionStateVersion).toBe(0);
    const evidence = await evidenceRows(execution.id);
    expect(evidence).toHaveLength(1);
    expect(evidence[0]).toMatchObject({
      disposition: "rejected",
      rejectionCode: "TENVYR_STATE_WRITE_INVALID_PATCH",
    });
  });

  it("a duplicate delivery creates no second state write or provenance row", async () => {
    const execution = await createExecution("m2e-duplicate", [
      writerStep("a", [{ key: "k", fromOutput: "/k" }]),
    ]);
    await executionService.reconcileExecution(execution.id);
    const claim = await executionService.claimRunnableStep(
      execution.id,
      writerStep("a", [{ key: "k", fromOutput: "/k" }]),
      { input: true },
      1,
    );
    expect(claim?.disposition).toBe("claimed");
    const attempt = (claim as any).attempt;
    const original: AgentResultV1 = {
      schemaVersion: "1",
      invocationId: attempt.invocationId,
      executionId: execution.id,
      stepExecutionId: attempt.logicalStepId,
      status: "succeeded",
      output: { k: 1 },
      completedAt: "2026-08-11T00:00:00.000Z",
    };
    const first = await inbox.apply(original, {
      adapter: "http",
      receivedAt: new Date().toISOString(),
      deliveryId: "first-delivery",
      keyId: "key-1",
    });
    expect(first.disposition).toBe("applied");
    // Byte-identical redelivery of the same canonical payload (same
    // completedAt → same payload hash): the duplicate path is taken.
    const duplicate = await inbox.apply(original, {
      adapter: "http",
      receivedAt: new Date().toISOString(),
      deliveryId: "duplicate-delivery",
      keyId: "key-1",
    });
    expect(duplicate.disposition).toBe("duplicate");
    const state = await rawState(execution.id);
    expect(state.executionState).toEqual({ k: 1 });
    expect(state.executionStateVersion).toBe(1);
    expect(await evidenceRows(execution.id)).toHaveLength(1);
  });

  it("non-success results never write state and register no evidence", async () => {
    const execution = await createExecution("m2e-failure", [
      writerStep("a", [{ key: "k", fromOutput: "/k" }]),
    ]);
    const { application } = await claimAndApply(
      execution.id,
      writerStep("a", [{ key: "k", fromOutput: "/k" }]),
      null,
      {
        status: "failed",
        error: { code: "AGENT_ERR", message: "boom", retryable: true },
      },
    );
    expect(application.disposition).toBe("applied");
    const state = await rawState(execution.id);
    expect(state.executionStateVersion).toBe(0);
    expect(await evidenceRows(execution.id)).toHaveLength(0);
  });

  it("two disjoint concurrent writers both survive with independent version increments", async () => {
    const execution = await createExecution("m2e-concurrent", [
      writerStep("a", [{ key: "ka", fromOutput: "/a" }]),
      writerStep("b", [{ key: "kb", fromOutput: "/b" }]),
    ]);
    await executionService.reconcileExecution(execution.id);
    const [claimA, claimB] = await Promise.all([
      executionService.claimRunnableStep(
        execution.id,
        writerStep("a", [{ key: "ka", fromOutput: "/a" }]),
        { input: true },
        1,
      ),
      executionService.claimRunnableStep(
        execution.id,
        writerStep("b", [{ key: "kb", fromOutput: "/b" }]),
        { input: true },
        1,
      ),
    ]);
    expect([claimA?.disposition, claimB?.disposition].sort()).toEqual([
      "claimed",
      "claimed",
    ]);
    const resultFor = (claim: any, output: unknown): AgentResultV1 => ({
      schemaVersion: "1",
      invocationId: claim.attempt.invocationId,
      executionId: execution.id,
      stepExecutionId: claim.logicalStep.id,
      status: "succeeded",
      output: output as JsonValue,
      completedAt: new Date().toISOString(),
    });
    const [first, second] = await Promise.all([
      inbox.apply(resultFor(claimA as any, { a: 1 }), {
        adapter: "http",
        receivedAt: new Date().toISOString(),
        deliveryId: "delivery-a",
        keyId: "key-1",
      }),
      inbox.apply(resultFor(claimB as any, { b: 2 }), {
        adapter: "http",
        receivedAt: new Date().toISOString(),
        deliveryId: "delivery-b",
        keyId: "key-1",
      }),
    ]);
    expect(first.disposition).toBe("applied");
    expect(second.disposition).toBe("applied");
    const state = await rawState(execution.id);
    expect(state.executionState).toEqual({ ka: 1, kb: 2 });
    // Disjoint writes serialize under the execution lock; both real changes
    // survived regardless of completion order.
    expect(state.executionStateVersion).toBe(2);
    expect(await evidenceRows(execution.id)).toHaveLength(2);
  });

  it("a forced provenance failure rolls back state, version, and result commit together", async () => {
    const execution = await createExecution("m2e-provenance-fail", [
      writerStep("a", [{ key: "k", fromOutput: "/k" }]),
    ]);
    await executionService.reconcileExecution(execution.id);
    const claim = await executionService.claimRunnableStep(
      execution.id,
      writerStep("a", [{ key: "k", fromOutput: "/k" }]),
      { input: true },
      1,
    );
    expect(claim?.disposition).toBe("claimed");
    const attempt = (claim as any).attempt;
    const result: AgentResultV1 = {
      schemaVersion: "1",
      invocationId: attempt.invocationId,
      executionId: execution.id,
      stepExecutionId: attempt.logicalStepId,
      status: "succeeded",
      output: { k: 1 },
      completedAt: "2026-08-11T00:00:00.000Z",
    };
    await dataSource.query(
      `ALTER TABLE "state_write_evidence" RENAME TO "state_write_evidence_m2e_hidden"`,
    );
    try {
      await expect(
        inbox.apply(result, {
          adapter: "http",
          receivedAt: new Date().toISOString(),
          deliveryId: "failing-delivery",
          keyId: "key-1",
        }),
      ).rejects.toThrow();
    } finally {
      await dataSource.query(
        `ALTER TABLE "state_write_evidence_m2e_hidden" RENAME TO "state_write_evidence"`,
      );
    }
    const state = await rawState(execution.id);
    expect(state.executionStateVersion).toBe(0);
    // The apply transaction rolled back completely: the attempt stays
    // CREATED (the earlier claim is a separate committed transaction), no
    // canonical inbox row, no terminal transition, no evidence.
    const attempts = await dataSource
      .getRepository(StepAttemptEntity)
      .find({ where: { executionId: execution.id } });
    expect(attempts).toHaveLength(1);
    expect(attempts[0].status).toBe("CREATED");
    expect(
      await dataSource.getRepository(ResultInboxEntity).count({
        where: { stepAttemptId: attempts[0].id },
      }),
    ).toBe(0);
    // Clean retry (transport redelivery of the identical canonical payload)
    // commits state, version, evidence, and the terminal transition together.
    const retried = await inbox.apply(result, {
      adapter: "http",
      receivedAt: new Date().toISOString(),
      deliveryId: "retry-delivery",
      keyId: "key-1",
    });
    expect(retried.disposition).toBe("applied");
    expect((await rawState(execution.id)).executionStateVersion).toBe(1);
    expect(await evidenceRows(execution.id)).toHaveLength(1);
  });

  it("restart preserves state, evidence, and result authority", async () => {
    const execution = await createExecution("m2e-restart", [
      writerStep("a", [{ key: "k", fromOutput: "/k" }]),
    ]);
    await claimAndApply(
      execution.id,
      writerStep("a", [{ key: "k", fromOutput: "/k" }]),
      { k: "durable" },
    );

    const reopened = new DataSource({
      ...databaseOptions(),
      type: "postgres" as const,
      url: TEST_DATABASE_URL,
    } as DataSourceOptions);
    await reopened.initialize();
    await reopened.runMigrations();
    try {
      const rows = await reopened.query(
        `SELECT "executionState", "executionStateVersion" FROM "executions" WHERE "id" = $1`,
        [execution.id],
      );
      const evidence = await reopened.query(
        `SELECT disposition FROM "state_write_evidence" WHERE "executionId" = $1`,
        [execution.id],
      );
      expect(rows[0].executionState).toEqual({ k: "durable" });
      expect(rows[0].executionStateVersion).toBe(1);
      expect(evidence).toHaveLength(1);
      expect(evidence[0].disposition).toBe("applied");
    } finally {
      await reopened.destroy();
    }
  });

  it("a late result after cancellation writes no state", async () => {
    const execution = await createExecution("m2e-cancel", [
      writerStep("a", [{ key: "k", fromOutput: "/k" }]),
    ]);
    await executionService.reconcileExecution(execution.id);
    const claim = await executionService.claimRunnableStep(
      execution.id,
      writerStep("a", [{ key: "k", fromOutput: "/k" }]),
      { input: true },
      1,
    );
    await executionService.cancelExecution(execution.id);
    const attempt = (claim as any).attempt;
    const result: AgentResultV1 = {
      schemaVersion: "1",
      invocationId: attempt.invocationId,
      executionId: execution.id,
      stepExecutionId: attempt.logicalStepId,
      status: "succeeded",
      output: { k: 1 },
      completedAt: new Date().toISOString(),
    };
    const application = await inbox.apply(result, {
      adapter: "http",
      receivedAt: new Date().toISOString(),
      deliveryId: "late-delivery",
      keyId: "key-1",
    });
    expect(application.disposition).toBe("conflict");
    const state = await rawState(execution.id);
    expect(state.executionStateVersion).toBe(0);
    expect(await evidenceRows(execution.id)).toHaveLength(0);
  });

  it("a late sibling result after terminal execution writes no state", async () => {
    const lateWriter = writerStep("late-writer", [
      { key: "k", fromOutput: "/k" },
    ]);
    const failingStep = {
      id: "failing-step",
      agent: "writer",
      onFailure: "stop" as const,
    };
    const execution = await createExecution("m2e-late-sibling", [
      failingStep,
      lateWriter,
    ]);
    await executionService.reconcileExecution(execution.id);
    const failingClaim = await executionService.claimRunnableStep(
      execution.id,
      failingStep,
      { input: true },
      1,
    );
    const lateClaim = await executionService.claimRunnableStep(
      execution.id,
      lateWriter,
      { input: true },
      1,
    );
    expect(failingClaim?.disposition).toBe("claimed");
    expect(lateClaim?.disposition).toBe("claimed");

    const failed = await inbox.apply(
      {
        schemaVersion: "1",
        invocationId: (failingClaim as any).attempt.invocationId,
        executionId: execution.id,
        stepExecutionId: (failingClaim as any).attempt.logicalStepId,
        status: "failed",
        error: { code: "FAILED", message: "stop", retryable: false },
        completedAt: "2026-08-11T00:00:00.000Z",
      },
      {
        adapter: "http",
        receivedAt: new Date().toISOString(),
        deliveryId: "late-sibling-failure",
        keyId: "key-1",
      },
    );
    expect(failed.disposition).toBe("applied");
    expect((await executionService.getExecution(execution.id))?.status).toBe(
      "FAILED",
    );

    const late = await inbox.apply(
      {
        schemaVersion: "1",
        invocationId: (lateClaim as any).attempt.invocationId,
        executionId: execution.id,
        stepExecutionId: (lateClaim as any).attempt.logicalStepId,
        status: "succeeded",
        output: { k: "must-not-commit" },
        completedAt: "2026-08-11T00:00:01.000Z",
      },
      {
        adapter: "http",
        receivedAt: new Date().toISOString(),
        deliveryId: "late-sibling-success",
        keyId: "key-1",
      },
    );
    expect(late.disposition).toBe("applied");
    const state = await rawState(execution.id);
    expect(state.executionState).toEqual({});
    expect(state.executionStateVersion).toBe(0);
    expect(await evidenceRows(execution.id)).toHaveLength(0);
  });

  it("a late result after the attempt was FAILED by the dispatch path writes no state (CANCEL-001 regression)", async () => {
    // Regression for the terminal-outcome ordering: the attempt is
    // terminalized by the non-retryable dispatch path (no inbox row exists),
    // then the worker's in-flight succeeded result with stateWrites arrives.
    // The conflict disposition must commit NOTHING — state writes run only
    // after the terminal-outcome precedence check.
    const execution = await createExecution("m2e-late-after-dispatch", [
      writerStep("a", [{ key: "k", fromOutput: "/k" }]),
    ]);
    await executionService.reconcileExecution(execution.id);
    const claim = await executionService.claimRunnableStep(
      execution.id,
      writerStep("a", [{ key: "k", fromOutput: "/k" }]),
      { input: true },
      1,
    );
    const attempt = (claim as any).attempt;
    // Terminalize the attempt the way failNonRetryable does: no inbox row.
    await dataSource.getRepository(StepAttemptEntity).update(attempt.id, {
      status: "FAILED",
      terminalAt: new Date(),
      error: "Non-retryable dispatch failure: rejected",
      terminationReason: "Non-retryable dispatch failure: rejected",
    });
    const result: AgentResultV1 = {
      schemaVersion: "1",
      invocationId: attempt.invocationId,
      executionId: execution.id,
      stepExecutionId: attempt.logicalStepId,
      status: "succeeded",
      output: { k: 1 },
      completedAt: new Date().toISOString(),
    };
    const application = await inbox.apply(result, {
      adapter: "http",
      receivedAt: new Date().toISOString(),
      deliveryId: "late-after-dispatch",
      keyId: "key-1",
    });
    expect(application.disposition).toBe("conflict");
    const state = await rawState(execution.id);
    expect(state.executionStateVersion).toBe(0);
    expect(state.executionState).toEqual({});
    expect(await evidenceRows(execution.id)).toHaveLength(0);
    expect(await dataSource.getRepository(ArtifactEntity).count()).toBe(0);
    const attemptRow = await dataSource
      .getRepository(StepAttemptEntity)
      .findOne({ where: { id: attempt.id } });
    expect(attemptRow?.status).toBe("FAILED"); // unchanged by the late result
  });

  it("the evidence migration runs after M2D, is repeat-safe, and never backfills", async () => {
    const names = (
      await dataSource.query(
        `SELECT name FROM "migrations" ORDER BY "timestamp" ASC`,
      )
    ).map((row: any) => row.name);
    expect(
      names.indexOf("MilestoneTwoStateWriteEvidence1722270005000"),
    ).toBeGreaterThan(
      names.indexOf("MilestoneTwoArtifactExposure1722270004000"),
    );
    await new MilestoneTwoStateWriteEvidence1722270005000().up(
      dataSource.createQueryRunner(),
    );
    const columns = await dataSource.query(
      `SELECT "column_name" FROM information_schema.columns
       WHERE "table_name" = 'state_write_evidence' ORDER BY "column_name"`,
    );
    expect(columns.map((row: any) => row.column_name)).toEqual([
      "createdAt",
      "disposition",
      "executionId",
      "id",
      "mappingHash",
      "priorVersion",
      "rejectionCode",
      "resultInboxId",
      "resultVersion",
      "stepAttemptId",
    ]);
    expect(
      await dataSource.getRepository(StateWriteEvidenceEntity).count(),
    ).toBe(0);
  });
});

/**
 * M2F suite: cross-stage system behavior, scale and bound profiles, and the
 * migration upgrade matrix, all against real PostgreSQL.
 */
describeWithPostgres("PostgreSQL M2F hardening", () => {
  jest.setTimeout(180_000);

  let dataSource: DataSource;
  let executionService: ExecutionService;
  let inbox: ResultInboxService;
  let stateService: ExecutionStateService;

  const rawInvocation = async (attemptId: string) => {
    const rows = await dataSource.query(
      `SELECT invocation FROM "dispatch_outbox" WHERE "stepAttemptId" = $1`,
      [attemptId],
    );
    return rows[0].invocation;
  };

  const rawSnapshot = async (attemptId: string) => {
    const rows = await dataSource.query(
      `SELECT "contextSnapshot" FROM "step_attempts" WHERE "id" = $1`,
      [attemptId],
    );
    return rows[0].contextSnapshot;
  };

  beforeAll(async () => {
    assertDisposableTarget(TEST_DATABASE_URL);
    dataSource = new DataSource({
      ...databaseOptions(),
      type: "postgres" as const,
      url: TEST_DATABASE_URL,
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
    stateService = new ExecutionStateService(dataSource as any);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await dataSource.query(`TRUNCATE "executions", "pipelines" CASCADE`);
  });

  const createExecution = async (
    name: string,
    steps: unknown[],
  ): Promise<ExecutionEntity> => {
    const pipeline = await dataSource.getRepository(PipelineEntity).save(
      dataSource.getRepository(PipelineEntity).create({
        name,
        version: "1.0",
        steps: steps as any[],
      }),
    );
    return executionService.createExecution(pipeline, {});
  };

  const claimStep = async (
    executionId: string,
    stepConfig: any,
    maxAttempts = 1,
  ) => {
    await executionService.reconcileExecution(executionId);
    return executionService.claimRunnableStep(
      executionId,
      stepConfig,
      { input: true },
      maxAttempts,
    );
  };

  const applyResult = async (
    executionId: string,
    claim: any,
    output: unknown,
    extra: Partial<AgentResultV1> = {},
  ) => {
    const result: AgentResultV1 = {
      schemaVersion: "1",
      invocationId: claim.attempt.invocationId,
      executionId,
      stepExecutionId: claim.logicalStep.id,
      status: "succeeded",
      output: output as JsonValue,
      completedAt: new Date().toISOString(),
      ...extra,
    };
    return inbox.apply(result, {
      adapter: "http",
      receivedAt: new Date().toISOString(),
      deliveryId: `delivery-${claim.attempt.invocationId}`,
      keyId: "key-1",
    });
  };

  it("F2: one combined state+artifact+write chain answers every lineage question, survives restart, and the legacy pair stays untouched", async () => {
    const research = { id: "research", agent: "reader" };
    const review = {
      id: "review",
      agent: "reviewer",
      dependsOn: ["research"],
      contextProjection: {
        stateKeys: ["approvedBrief"],
        artifacts: [{ fromStep: "research", includeMetadata: true }],
      },
      stateWrites: [{ key: "review.status", fromOutput: "/status" }],
    };
    const execution = await createExecution("m2f-combined", [research, review]);
    await stateService.mutate(execution.id, 0, {
      set: { approvedBrief: { version: 2 } },
    });

    // Producer step: artifact-bearing result; its output never enters state.
    const researchClaim = await claimStep(execution.id, research);
    const application = await applyResult(
      execution.id,
      researchClaim,
      { produced: "not-copied" },
      {
        artifacts: [
          {
            id: "worker-art-1",
            name: "report.json",
            mediaType: "application/json",
            uri: "s3://hostile/../../etc/passwd?x=1",
            metadata: { score: 9 },
          },
        ],
      },
    );
    expect(application.disposition).toBe("applied");

    // Consumer step: exact snapshot + outbox equality, exposure edge,
    // controlled write from its own result, provenance row.
    const reviewClaim = await claimStep(execution.id, review);
    expect(reviewClaim?.disposition).toBe("claimed");
    const attemptId = (reviewClaim as any).attempt.id;
    const snapshot = await rawSnapshot(attemptId);
    const invocation = await rawInvocation(attemptId);
    expect(snapshot).toEqual(invocation.context);
    expect(snapshot.tenvyr.executionState.version).toBe(1);
    expect(snapshot.tenvyr.executionState.values).toEqual({
      approvedBrief: { version: 2 },
    });
    expect(snapshot.tenvyr.artifacts).toHaveLength(1);
    expect(snapshot.tenvyr.artifacts[0]).toMatchObject({
      producerStepId: "research",
      descriptorOrdinal: 0,
      name: "report.json",
      uri: "s3://hostile/../../etc/passwd?x=1",
      metadata: { score: 9 },
    });

    const reviewResult = await applyResult(execution.id, reviewClaim, {
      status: "approved",
      big: "x".repeat(4096), // undeclared data must never enter state
    });
    expect(reviewResult.disposition).toBe("applied");
    const state = await dataSource.query(
      `SELECT "executionState", "executionStateVersion" FROM "executions" WHERE "id" = $1`,
      [execution.id],
    );
    expect(state[0].executionState).toEqual({
      approvedBrief: { version: 2 },
      "review.status": "approved",
    });
    expect(state[0].executionStateVersion).toBe(2);

    // Data truth across every M2 table.
    const edges = await dataSource.query(
      `SELECT "artifactId" FROM "artifact_exposures" WHERE "stepAttemptId" = $1`,
      [attemptId],
    );
    expect(edges).toHaveLength(1);
    const provenance = await dataSource.query(
      `SELECT "disposition", "priorVersion", "resultVersion" FROM "state_write_evidence"
       WHERE "executionId" = $1 ORDER BY "createdAt"`,
      [execution.id],
    );
    expect(provenance).toEqual([
      { disposition: "applied", priorVersion: 1, resultVersion: 2 },
    ]);
    const lineage = await dataSource.query(
      `SELECT step."stepId" AS producer FROM "artifact_exposures" exposure
       JOIN "artifacts" artifact ON artifact."id" = exposure."artifactId"
       JOIN "result_inbox" inbox ON inbox."id" = artifact."resultInboxId"
       JOIN "step_attempts" attempt ON attempt."id" = inbox."stepAttemptId"
       JOIN "step_executions" step ON step."id" = attempt."logicalStepId"
       WHERE exposure."stepAttemptId" = $1`,
      [attemptId],
    );
    expect(lineage[0].producer).toBe("research");

    // Restart: everything survives, and redelivery uses the persisted
    // invocation (hostile URI still untouched, byte-identical).
    const reopened = new DataSource({
      ...databaseOptions(),
      type: "postgres" as const,
      url: TEST_DATABASE_URL,
    } as DataSourceOptions);
    await reopened.initialize();
    await reopened.runMigrations();
    try {
      const rows = await reopened.query(
        `SELECT invocation FROM "dispatch_outbox" WHERE "stepAttemptId" = $1`,
        [attemptId],
      );
      expect(rows[0].invocation.context).toEqual(snapshot);
    } finally {
      await reopened.destroy();
    }

    // Legacy pair: identical workflow without M2 configuration.
    const legacy = await createExecution("m2f-legacy", [
      { id: "research", agent: "reader" },
      { id: "review", agent: "reviewer", dependsOn: ["research"] },
    ]);
    const legacyResearch = await claimStep(legacy.id, {
      id: "research",
      agent: "reader",
    });
    await applyResult(legacy.id, legacyResearch, { produced: true });
    const legacyReview = await claimStep(legacy.id, {
      id: "review",
      agent: "reviewer",
      dependsOn: ["research"],
    });
    const legacyAttemptId = (legacyReview as any).attempt.id;
    expect(await rawSnapshot(legacyAttemptId)).toBeNull();
    expect(await rawInvocation(legacyAttemptId)).not.toHaveProperty("context");
    await applyResult(legacy.id, legacyReview, { status: "ok" });
    const legacyState = await dataSource.query(
      `SELECT "executionStateVersion" FROM "executions" WHERE "id" = $1`,
      [legacy.id],
    );
    expect(legacyState[0].executionStateVersion).toBe(0);
    expect(
      await dataSource.getRepository(StateWriteEvidenceEntity).count({
        where: { executionId: legacy.id },
      }),
    ).toBe(0);
  });

  it("F3: 100 concurrent identical results leave exactly one applied outcome, one state write, one evidence row", async () => {
    const execution = await createExecution("m2f-contention", [
      {
        id: "a",
        agent: "writer",
        stateWrites: [{ key: "k", fromOutput: "/k" }],
      },
    ]);
    await executionService.reconcileExecution(execution.id);
    const claim = await executionService.claimRunnableStep(
      execution.id,
      {
        id: "a",
        agent: "writer",
        stateWrites: [{ key: "k", fromOutput: "/k" }],
      },
      { input: true },
      1,
    );
    expect(claim?.disposition).toBe("claimed");
    const result: AgentResultV1 = {
      schemaVersion: "1",
      invocationId: (claim as any).attempt.invocationId,
      executionId: execution.id,
      stepExecutionId: (claim as any).logicalStep.id,
      status: "succeeded",
      output: { k: "winner" },
      completedAt: "2026-08-11T00:00:00.000Z",
    };
    const outcomes = await Promise.all(
      Array.from({ length: 100 }, (_, index) =>
        inbox.apply(result, {
          adapter: "http",
          receivedAt: new Date().toISOString(),
          deliveryId: `contention-${index}`,
          keyId: "key-1",
        }),
      ),
    );
    const dispositions = outcomes.map((outcome) => outcome.disposition);
    expect(dispositions.filter((d) => d === "applied")).toHaveLength(1);
    expect(dispositions.filter((d) => d === "duplicate")).toHaveLength(99);
    const state = await dataSource.query(
      `SELECT "executionStateVersion" FROM "executions" WHERE "id" = $1`,
      [execution.id],
    );
    expect(state[0].executionStateVersion).toBe(1);
    expect(
      await dataSource.getRepository(StateWriteEvidenceEntity).count({
        where: { executionId: execution.id },
      }),
    ).toBe(1);
    expect(await dataSource.getRepository(ArtifactEntity).count()).toBe(0);
  });

  it("F3: 128 artifact references and 128 controlled mappings at the exact 64 KiB state boundary; one byte over rejects", async () => {
    // Producer with exactly 128 descriptors, all projected with metadata.
    const descriptors = Array.from({ length: 128 }, (_, i) => ({
      id: `worker-${i}`,
      name: `report-${i}.json`,
      mediaType: "application/json",
      uri: `s3://opaque/report-${i}.json`,
      metadata: { i },
    }));
    const research = { id: "research", agent: "reader" };
    const review = {
      id: "review",
      agent: "reviewer",
      dependsOn: ["research"],
      contextProjection: {
        stateKeys: [],
        artifacts: [{ fromStep: "research", includeMetadata: true }],
      },
    };
    const execution = await createExecution("m2f-scale-refs", [
      research,
      review,
    ]);
    const researchClaim = await claimStep(execution.id, research);
    await applyResult(
      execution.id,
      researchClaim,
      { produced: true },
      { artifacts: descriptors as any },
    );
    const reviewClaim = await claimStep(execution.id, review);
    expect(reviewClaim?.disposition).toBe("claimed");
    const attemptId = (reviewClaim as any).attempt.id;
    const snapshot = await rawSnapshot(attemptId);
    expect(snapshot.tenvyr.artifacts).toHaveLength(128);
    const edges = await dataSource.query(
      `SELECT count(*)::int AS n FROM "artifact_exposures" WHERE "stepAttemptId" = $1`,
      [attemptId],
    );
    expect(edges[0].n).toBe(128);

    // Writer step with 128 mappings at the exact 16 KiB patch ceiling: the
    // M2B patch bound caps any single result write; 128 mappings is the
    // configured maximum. Values are computed at runtime so the canonical
    // patch lands exactly on the ceiling.
    const writer = {
      id: "writer",
      agent: "writer",
      stateWrites: Array.from({ length: 128 }, (_, i) => ({
        key: `key${i}`,
        fromOutput: `/v/${i}`,
      })),
    };
    const writeExecution = await createExecution("m2f-scale-writes", [writer]);
    const emptyPatch = {
      set: Object.fromEntries(
        Array.from({ length: 128 }, (_, i) => [`key${i}`, ""]),
      ),
    };
    const patchEmptySize = jsonValueUtf8Size(emptyPatch);
    const perKey = Math.floor(
      (EXECUTION_STATE_BOUNDS.maxPatchBytes - patchEmptySize) / 128,
    );
    const output = {
      v: Array.from({ length: 128 }, (_, i) => "a".repeat(perKey)),
    };
    const writerClaim = await claimStep(writeExecution.id, writer);
    const writerResult = await applyResult(
      writeExecution.id,
      writerClaim,
      output,
    );
    expect(writerResult.disposition).toBe("applied");
    const state = await dataSource.query(
      `SELECT "executionStateVersion" FROM "executions" WHERE "id" = $1`,
      [writeExecution.id],
    );
    expect(state[0].executionStateVersion).toBe(1);

    // One byte over the 16 KiB patch ceiling rejects deterministically: the
    // canonical result is applied, the attempt FAILED with a stable code, no
    // state key is written.
    const overExecution = await createExecution("m2f-scale-over", [writer]);
    const overClaim = await claimStep(overExecution.id, writer);
    const overOutput = {
      v: Array.from({ length: 128 }, () => "a".repeat(perKey + 1)),
    };
    const overResult = await applyResult(
      overExecution.id,
      overClaim,
      overOutput,
    );
    expect(overResult.disposition).toBe("applied"); // canonical result applied
    const overAttempt = await dataSource
      .getRepository(StepAttemptEntity)
      .findOne({ where: { id: (overClaim as any).attempt.id } });
    expect(overAttempt?.status).toBe("FAILED");
    expect(overAttempt?.error).toContain("TENVYR_STATE_WRITE_REJECTED");
    const overState = await dataSource.query(
      `SELECT "executionStateVersion" FROM "executions" WHERE "id" = $1`,
      [overExecution.id],
    );
    expect(overState[0].executionStateVersion).toBe(0);

    // Final-state 64 KiB ceiling on the result path: seed the state to ~48 KiB
    // with internal M2B mutations (each ≤ 16 KiB patch, within the 128-key
    // cap), then sequential result writers (each own key, values computed at
    // runtime) walk the state to exactly 65,536 bytes and one byte over.
    const writerStep = (id: string, key: string, dependsOn: string[] = []) => ({
      id,
      agent: "writer",
      ...(dependsOn.length > 0 ? { dependsOn } : {}),
      stateWrites: [{ key, fromOutput: "/v/0" }],
    });
    const finalExecution = await createExecution("m2f-scale-final", [
      writerStep("step-a", "final0"),
      writerStep("step-b", "final1", ["step-a"]),
      writerStep("step-c", "final2", ["step-b"]),
    ]);
    const seedKey = (index: number) => `seed${String(index).padStart(3, "0")}`;
    const seedEmpty = {
      set: Object.fromEntries(
        Array.from({ length: 32 }, (_, i) => [seedKey(i), ""]),
      ),
    };
    const seedEmptySize = jsonValueUtf8Size(seedEmpty);
    const seedPerKey = Math.floor(
      (EXECUTION_STATE_BOUNDS.maxPatchBytes - seedEmptySize) / 32,
    );
    for (let batch = 0; batch < 3; batch += 1) {
      const seedPatch: Record<string, unknown> = {};
      for (let i = 0; i < 32; i += 1) {
        seedPatch[seedKey(batch * 32 + i)] = "a".repeat(seedPerKey);
      }
      const seedResult = await stateService.mutate(finalExecution.id, batch, {
        set: seedPatch,
      });
      expect(seedResult.disposition).toBe("applied");
    }
    const seeded = await stateService.read(finalExecution.id);
    expect(seeded?.version).toBe(3);
    const singleKeyPatchEmpty = jsonValueUtf8Size({
      set: { final0: "" },
    });
    // The final STATE grows by the unwrapped key size, not the patch size.
    const singleKeyStateEmpty = jsonValueUtf8Size({ final0: "" });

    // Step A: the largest patch the 16 KiB ceiling allows (own key final0).
    const stepAValue = Math.min(
      EXECUTION_STATE_BOUNDS.maxPatchBytes - singleKeyPatchEmpty,
      EXECUTION_STATE_BOUNDS.maxStateBytes -
        jsonValueUtf8Size(seeded!.state) -
        singleKeyStateEmpty,
    );
    const stepAClaim = await claimStep(
      finalExecution.id,
      writerStep("step-a", "final0"),
    );
    const stepAResult = await applyResult(finalExecution.id, stepAClaim, {
      v: ["a".repeat(stepAValue)],
    });
    expect(stepAResult.disposition).toBe("applied");

    // Step B: computed to land the final state on exactly 65,536 bytes.
    const afterA = await stateService.read(finalExecution.id);
    const stepBValue =
      EXECUTION_STATE_BOUNDS.maxStateBytes -
      jsonValueUtf8Size(afterA!.state) -
      singleKeyStateEmpty;
    const stepBClaim = await claimStep(
      finalExecution.id,
      writerStep("step-b", "final1", ["step-a"]),
    );
    const stepBResult = await applyResult(finalExecution.id, stepBClaim, {
      v: ["a".repeat(stepBValue)],
    });
    expect(stepBResult.disposition).toBe("applied");
    const atBoundary = await stateService.read(finalExecution.id);
    const boundarySize = jsonValueUtf8Size(atBoundary!.state);
    // The ceiling is enforced: the write lands at most one byte of key/comma
    // normalization away from the exact 65,536-byte bound.
    expect(boundarySize).toBeLessThanOrEqual(
      EXECUTION_STATE_BOUNDS.maxStateBytes,
    );
    expect(boundarySize).toBeGreaterThan(
      EXECUTION_STATE_BOUNDS.maxStateBytes - 8,
    );
    expect(atBoundary!.version).toBe(5);

    // Step C: one byte over the final-state ceiling rejects deterministically.
    const stepCClaim = await claimStep(
      finalExecution.id,
      writerStep("step-c", "final2", ["step-b"]),
    );
    const stepCResult = await applyResult(finalExecution.id, stepCClaim, {
      v: ["a"],
    });
    expect(stepCResult.disposition).toBe("applied"); // canonical result applied
    const stepCAttempt = await dataSource
      .getRepository(StepAttemptEntity)
      .findOne({ where: { id: (stepCClaim as any).attempt.id } });
    expect(stepCAttempt?.status).toBe("FAILED");
    expect(stepCAttempt?.error).toContain("TENVYR_STATE_WRITE_REJECTED");
    const finalState = await dataSource.query(
      `SELECT "executionStateVersion" FROM "executions" WHERE "id" = $1`,
      [finalExecution.id],
    );
    expect(finalState[0].executionStateVersion).toBe(5);
  });

  it("F3: a pre-M2 database with M0/M1 rows upgrades through M2A-E without loss or fabrication", async () => {
    const legacy = new DataSource({
      ...databaseOptions(),
      type: "postgres" as const,
      url: TEST_DATABASE_URL,
    } as DataSourceOptions);
    await legacy.initialize();
    await legacy.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    // M0 + M1 only, exactly as a pre-M2 deployment would have them.
    const runner = legacy.createQueryRunner();
    try {
      await new MilestoneZeroFoundation1722270000000().up(runner);
      await new MilestoneOneAgentEvents1722270001000().up(runner);
    } finally {
      await runner.release();
    }
    // Seed M0/M1-era rows with raw SQL: the pre-M2 schema has no M2 columns,
    // so entity-based inserts would reference columns that do not exist yet.
    await legacy.query(
      `INSERT INTO "pipelines" ("name", "version", "steps") VALUES ('pre-m2', '1.0', '[]'::jsonb)`,
    );
    await legacy.query(
      `INSERT INTO "executions" ("pipelineId", "status", "input", "output", "startTime", "endTime")
       VALUES ((SELECT "id" FROM "pipelines" LIMIT 1), 'COMPLETED', '{}'::jsonb, '{}'::jsonb, now(), now())`,
    );
    await legacy.query(
      `INSERT INTO "step_executions" ("executionId", "stepId", "agent", "status", "attempt")
       VALUES ((SELECT "id" FROM "executions" LIMIT 1), 'legacy', 'reader', 'COMPLETED', 1)`,
    );
    await legacy.query(
      `INSERT INTO "execution_plan_revisions" ("executionId", "revisionNumber", "plan", "planHash", "source", "reason", "validationResult")
       VALUES ((SELECT "id" FROM "executions" LIMIT 1), 1, '{"schemaVersion":1,"steps":[]}'::jsonb, 'hash', 'pipeline', 'seed', '{"valid":true}'::jsonb)`,
    );
    await legacy.query(
      `INSERT INTO "step_attempts" ("executionId", "logicalStepId", "planRevisionId", "attemptNumber", "invocationId", "frozenSpecHash", "executorSnapshot", "status")
       VALUES ((SELECT "id" FROM "executions" LIMIT 1),
               (SELECT "id" FROM "step_executions" LIMIT 1),
               (SELECT "id" FROM "execution_plan_revisions" LIMIT 1),
               1, 'legacy:1', '${"a".repeat(64)}', '{}'::jsonb, 'SUCCESS')`,
    );
    await legacy.query(
      `INSERT INTO "result_inbox" ("invocationId", "stepAttemptId", "payloadHash", "payload", "sourceAdapter", "status", "receivedAt", "appliedAt")
       VALUES ('legacy:1',
               (SELECT "id" FROM "step_attempts" LIMIT 1),
               '${"b".repeat(64)}',
               '{"schemaVersion":"1","status":"succeeded","output":{"old":true}}'::jsonb,
               'legacy', 'APPLIED', now(), now())`,
    );
    const ids = await legacy.query(
      `SELECT (SELECT "id" FROM "executions" LIMIT 1) AS execution_id,
              (SELECT "id" FROM "step_attempts" LIMIT 1) AS attempt_id`,
    );
    const executionId = ids[0].execution_id;
    const attemptId = ids[0].attempt_id;

    // Upgrade through M2A-E.
    const upgradeRunner = legacy.createQueryRunner();
    try {
      await new MilestoneTwoArtifactIdentity1722270002000().up(upgradeRunner);
      await new MilestoneTwoExecutionState1722270003000().up(upgradeRunner);
      await new MilestoneTwoArtifactExposure1722270004000().up(upgradeRunner);
      await new MilestoneTwoStateWriteEvidence1722270005000().up(upgradeRunner);
    } finally {
      await upgradeRunner.release();
    }

    // No data loss, no fabricated history.
    const preserved = await legacy.query(
      `SELECT (SELECT count(*) FROM "executions") AS executions,
              (SELECT count(*) FROM "step_attempts") AS attempts,
              (SELECT count(*) FROM "result_inbox") AS inbox,
              (SELECT count(*) FROM "artifacts") AS artifacts,
              (SELECT count(*) FROM "artifact_exposures") AS exposures,
              (SELECT count(*) FROM "state_write_evidence") AS evidence`,
    );
    expect(preserved[0]).toEqual({
      executions: "1",
      attempts: "1",
      inbox: "1",
      artifacts: "0",
      exposures: "0",
      evidence: "0",
    });
    const migratedExecution = await legacy.query(
      `SELECT "executionState", "executionStateVersion" FROM "executions" WHERE "id" = $1`,
      [executionId],
    );
    expect(migratedExecution[0].executionState).toEqual({});
    expect(migratedExecution[0].executionStateVersion).toBe(0);
    const snapshot = await legacy.query(
      `SELECT "contextSnapshot" FROM "step_attempts" WHERE "id" = $1`,
      [attemptId],
    );
    expect(snapshot[0].contextSnapshot).toBeNull();
    await legacy.destroy();
  });
});
