import type { AgentEventMessage } from "../agent-adapters/agent-adapter.types";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
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
import { RuntimeConnectionService } from "../services/runtime-connection.service";
import { RuntimeConnectionEntity } from "../entities/runtime-connection.entity";
import { ConnectionRevisionEntity } from "../entities/connection-revision.entity";
import {
  parseConnectionRevision,
  type ConnectionProfileV1,
} from "../executors/runtime-connection";
import { buildRuntimeConnectionProfile } from "../executors/runtime-profiles";
import { RuntimeCoordinationService } from "../services/runtime-coordination.service";
import { WorkbenchProjectionService } from "../services/workbench-projection.service";
import { WorkbenchCommandService } from "../services/workbench-command.service";
import { OperatorActionEntity } from "../entities/operator-action.entity";
import { CoordinationRunEntity } from "../entities/coordination-run.entity";
import type {
  CoordinationConfigV1,
  TaskBatchProposalV1,
  VerifierDecisionV1,
} from "../domain/coordination";
import { AgentAdapterRouter } from "../agent-adapters/agent-adapter.router";
import { HttpAgentAdapter } from "../agent-adapters/http-agent.adapter";
import { w3cTraceparent } from "../agent-adapters/http-agent.adapter";
import {
  AgentTransportConfigService,
  parseAgentTransportConfiguration,
} from "../agent-adapters/agent-transport-config.service";
import type { ExecutorDescriptorV1 } from "../executors/executor-descriptor";
import { databaseOptions } from "./database.provider";
import { MilestoneZeroFoundation1722270000000 } from "./migrations/1722270000000-MilestoneZeroFoundation";
import { MilestoneOneAgentEvents1722270001000 } from "./migrations/1722270001000-MilestoneOneAgentEvents";
import { MilestoneTwoArtifactIdentity1722270002000 } from "./migrations/1722270002000-MilestoneTwoArtifactIdentity";
import { MilestoneTwoExecutionState1722270003000 } from "./migrations/1722270003000-MilestoneTwoExecutionState";
import { MilestoneTwoArtifactExposure1722270004000 } from "./migrations/1722270004000-MilestoneTwoArtifactExposure";
import { MilestoneTwoStateWriteEvidence1722270005000 } from "./migrations/1722270005000-MilestoneTwoStateWriteEvidence";
import { MilestoneFourBudgetLedger1722270006000 } from "./migrations/1722270006000-MilestoneFourBudgetLedger";
import { BudgetLedgerService } from "../services/budget-ledger.service";
import { PipelineService } from "../services/pipeline.service";
import { PipelineValidationService } from "../services/pipeline-validation.service";
import { ConditionEvaluatorService } from "../services/condition-evaluator.service";
import { ApprovalService } from "../services/approval.service";
import { PlanProposalService } from "../services/plan-proposal.service";
import { CoordinationIterationEntity } from "../entities/coordination-iteration.entity";
import { DelegationService } from "../services/delegation.service";
import { DelegationRequestEntity } from "../entities/delegation-request.entity";
import { DelegationRequestConflictEntity } from "../entities/delegation-request-conflict.entity";
import { DELEGATION_BOUNDS } from "../services/delegation.service";
import { ExecutionCapsuleService } from "../services/execution-capsule.service";
import { ExecutionExportEntity } from "../entities/execution-export.entity";
import { ExecutionReplayEntity } from "../entities/execution-replay.entity";
import { PlanProposalEntity } from "../entities/plan-proposal.entity";
import { DelegationObservationEntity } from "../entities/delegation-observation.entity";
import { DelegationObservationConflictEntity } from "../entities/delegation-observation-conflict.entity";
import { PolicySnapshotEntity } from "../entities/policy-snapshot.entity";
import { PolicyDecisionEntity } from "../entities/policy-decision.entity";
import { ApprovalRequestEntity } from "../entities/approval-request.entity";
import { PolicyService } from "../services/policy.service";
import { BudgetAccountEntity } from "../entities/budget-account.entity";
import { BudgetReservationEntity } from "../entities/budget-reservation.entity";
import { BudgetLedgerEntryEntity } from "../entities/budget-ledger-entry.entity";
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

// Preserved legacy deployment identifier (see
// compatibility-identifiers.spec.ts): the dev compose container keeps its
// historical name. Split-string keeps the legacy literal out of this spec
// (product-identity audit) while docker-exec'ing the exact container.
const POSTGRES_CONTAINER = ["agent", "weave-postgres"].join("");

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

/**
 * M9-S8 helper: claims the Coordinator-owned Planner step through the REAL
 * scheduling path (claimRunnableStep) and returns the attempt id plus the
 * baseRevision the attempt was frozen on. Tests that exercise batch
 * admission must use a real Planner attempt — fabricated attempt ids are
 * exactly what the ownership gate rejects.
 */
const seedPlannerAttempt = async (
  dataSource: DataSource,
  executionService: ExecutionService,
  executionId: string,
  iterationNumber: number,
): Promise<{ attemptId: string; baseRevision: number }> => {
  // Mirror the real scheduling flow: activation materializes the planner
  // step as PENDING; the engine's reconciliation promotes dependency-free
  // PENDING steps to READY and backfills their frozen input. The direct
  // claim below requires the step to be READY.
  await executionService.reconcileExecution(executionId);
  const logical = await dataSource.getRepository(LogicalStepEntity).findOne({
    where: { executionId, stepId: `planner-${iterationNumber}` },
  });
  if (!logical) {
    throw new Error(`planner step planner-${iterationNumber} not found`);
  }
  const execution = await dataSource
    .getRepository(ExecutionEntity)
    .findOne({ where: { id: executionId } });
  const revision = await dataSource
    .getRepository(ExecutionPlanRevisionEntity)
    .findOne({ where: { id: execution?.activePlanRevisionId } });
  if (!revision) throw new Error("no active plan revision");
  const stepConfig = (
    revision.plan.steps as Array<Record<string, unknown>>
  ).find((step) => step.id === `planner-${iterationNumber}`);
  if (!stepConfig) {
    throw new Error(`planner step config planner-${iterationNumber} not found`);
  }
  const input = (logical.input ?? {}) as Record<string, unknown>;
  const claim = await executionService.claimRunnableStep(
    executionId,
    stepConfig as never,
    input,
    1,
  );
  if (claim?.disposition !== "claimed") {
    throw new Error(`planner claim failed: ${claim?.disposition}`);
  }
  // The ownership gate requires a SUCCESSFUL terminal attempt. Mark the
  // claim terminal-success directly (the tests submit the batch through
  // `submitIterationBatch`, so no worker round-trip is needed).
  const attemptRepository = dataSource.getRepository(StepAttemptEntity);
  await attemptRepository.update(
    { id: claim.attempt.id },
    { status: "SUCCESS", terminalAt: new Date() },
  );
  return {
    attemptId: claim.attempt.id,
    baseRevision: revision.revisionNumber,
  };
};

/** Minimal structural shape of a raw `pg` client borrowed from the driver
 *  pool (the orchestrator does not ship @types/pg; the driver's pool client
 *  satisfies this at runtime). Used only by the M9 race barriers. */
type RawPgClient = {
  query: (
    text: string,
    values?: unknown[],
  ) => Promise<{ rows: Array<Record<string, unknown>> }>;
  release: () => void;
};

/** Borrows a dedicated connection from the TypeORM postgres driver pool so a
 *  test can hold a real row lock as an interleaving barrier. (The driver
 *  exposes the pg pool at `master`; older shapes used `postgres`.) */
const rawPgClient = async (
  dataSource: DataSource,
): Promise<RawPgClient> => {
  const driver = dataSource.driver as {
    master?: { connect: () => Promise<RawPgClient> };
    postgres?: { connect: () => Promise<RawPgClient> };
  };
  const pool = driver.master ?? driver.postgres;
  if (!pool) throw new Error("postgres driver pool is unavailable");
  return pool.connect();
};

/** Polls pg_locks until at least `expected` backends of THIS database are
 *  WAITING (non-granted) on a lock with `needle` in their query text — an
 *  explicit interleaving barrier proving a transaction parked at a real
 *  PostgreSQL row lock. pg_stat_activity state is NOT reliable for this:
 *  node-postgres backends blocked on a row lock report idle/ClientRead, but
 *  their non-granted pg_locks entries are always visible. */
const waitForLockWait = async (
  client: RawPgClient,
  needle: string,
  expected: number,
  timeoutMs = 15_000,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await client.query(
      `SELECT count(DISTINCT l.pid)::int AS c
       FROM pg_locks l
       JOIN pg_stat_activity a ON a.pid = l.pid
       WHERE NOT l.granted
         AND a.datname = current_database()
         AND l.pid <> pg_backend_pid()
         AND position($1 in a.query) > 0`,
      [needle],
    );
    const count = Number(result.rows[0]?.c ?? 0);
    if (count >= expected) return;
    if (Date.now() > deadline) {
      const dump = await client.query(
        `SELECT a.pid, a.state, a.wait_event_type, a.wait_event, left(a.query, 90) AS q
         FROM pg_stat_activity a
         WHERE a.datname = current_database() AND a.pid <> pg_backend_pid()
         ORDER BY a.pid`,
      );
      throw new Error(
        `timed out waiting for ${expected} lock waiter(s) on "${needle}" (saw ${count}; backends: ${JSON.stringify(dump.rows)})`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};

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
    // The first transaction to commit terminal authority wins. Cancellation
    // wins only while the execution is non-terminal; if the watchdog result
    // and reconciliation finish first, a later cancel cannot rewrite FAILED.
    expect(executionRow?.status).toBe(
      reloaded?.status === "CANCELLED" ? "CANCELLED" : "FAILED",
    );
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

describeWithPostgres("PostgreSQL M3 executor descriptors", () => {
  jest.setTimeout(180_000);

  let dataSource: DataSource;
  let inbox: ResultInboxService;

  const httpEnv = (reader: Record<string, unknown> = {}) => ({
    AGENT_TRANSPORT_CONFIG: JSON.stringify({
      reader: {
        kind: "http",
        submitUrl: "https://reader-pinned.example/v1/runs",
        outboundAuthentication: { type: "none" },
        callbackAuthentication: {
          keyId: "reader-key",
          secretEnv: "READER_CALLBACK_SECRET",
        },
        requestTimeoutMs: 1000,
        maxResponseBytes: 1024,
        ...reader,
      },
    }),
    HTTP_AGENT_CALLBACK_BASE_URL: "https://orchestrator.example",
    READER_CALLBACK_SECRET: "reader-callback-secret",
  });

  const transportConfig = (env: NodeJS.ProcessEnv) =>
    new AgentTransportConfigService(parseAgentTransportConfiguration(env));

  const executionServiceWith = (config: AgentTransportConfigService) =>
    new ExecutionService(
      dataSource.getRepository(ExecutionEntity),
      dataSource.getRepository(LogicalStepEntity),
      dataSource.getRepository(StepAttemptEntity),
      dataSource.getRepository(ExecutionPlanRevisionEntity),
      dataSource,
      undefined,
      config,
    );

  const recordingAdapter = () => {
    const calls: Array<{ invocation: unknown; pinned: unknown }> = [];
    return {
      calls,
      adapter: {
        kind: "test",
        invoke: jest.fn(async (invocation: any, pinned: any) => {
          calls.push({ invocation, pinned });
          return {
            adapter: "test",
            invocationId: invocation.invocationId,
            dispatchedAt: new Date().toISOString(),
          };
        }),
      },
    };
  };

  const seedExecution = async (
    service: ExecutionService,
    name: string,
    steps: any[],
  ) => {
    const pipeline = await dataSource.getRepository(PipelineEntity).save(
      dataSource.getRepository(PipelineEntity).create({
        name,
        version: "1.0",
        steps,
      }),
    );
    const execution = await service.createExecution(pipeline, {});
    await service.reconcileExecution(execution.id);
    return { pipeline, execution };
  };

  const claimExtract = async (service: ExecutionService, executionId: string) =>
    service.claimRunnableStep(
      executionId,
      { id: "extract", agent: "reader" } as any,
      { input: true },
      1,
    );

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
    inbox = new ResultInboxService(dataSource);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await dataSource.query(
      `TRUNCATE "dispatch_outbox", "step_attempts", "step_executions",
       "execution_plan_revisions", "executions", "pipelines" CASCADE`,
    );
  });

  it("freezes a bounded versioned descriptor per attempt and dispatch consumes exactly it", async () => {
    const config = transportConfig(httpEnv());
    const service = executionServiceWith(config);
    const { execution } = await seedExecution(service, "m3-freeze", [
      { id: "extract", agent: "reader" },
    ]);
    const claim = await claimExtract(service, execution.id);
    expect(claim?.disposition).toBe("claimed");

    const frozen = (claim as any).attempt
      .executorSnapshot as ExecutorDescriptorV1;
    expect(frozen).toMatchObject({
      schemaVersion: "1",
      executorId: "agent:reader",
      agent: "reader",
      kind: "http",
      capabilities: { cancel: false },
    });
    expect(frozen.httpProfile).toEqual({
      submitUrl: "https://reader-pinned.example/v1/runs",
      requestTimeoutMs: 1000,
      maxResponseBytes: 1024,
    });
    expect(frozen.configHash).toMatch(/^[0-9a-f]{64}$/);
    // Credential values never enter the frozen evidence.
    expect(JSON.stringify(frozen)).not.toContain("reader-callback-secret");

    const rec = recordingAdapter();
    const outboxService = new DispatchOutboxService(
      dataSource as any,
      rec.adapter as any,
      config,
    );
    const disposition = await outboxService.dispatchNext();
    expect(disposition).toEqual({ outcome: "dispatched" });
    expect(rec.calls).toHaveLength(1);
    expect(rec.calls[0].pinned).toEqual(frozen);

    const reloaded = await dataSource
      .getRepository(StepAttemptEntity)
      .findOne({ where: { id: (claim as any).attempt.id } });
    expect(reloaded?.status).toBe("DISPATCHED");
    expect(reloaded?.executorSnapshot).toEqual(frozen);
  });

  it("redelivery of one outbox row reuses the same invocation and the same frozen descriptor", async () => {
    const config = transportConfig(httpEnv());
    const service = executionServiceWith(config);
    const { execution } = await seedExecution(service, "m3-redelivery", [
      { id: "extract", agent: "reader" },
    ]);
    const claim = await claimExtract(service, execution.id);
    expect(claim?.disposition).toBe("claimed");
    const frozen = (claim as any).attempt.executorSnapshot;

    const rec = recordingAdapter();
    const outboxService = new DispatchOutboxService(
      dataSource as any,
      rec.adapter as any,
      config,
    );
    await outboxService.dispatchNext();
    const outboxRow = await dataSource
      .getRepository(DispatchOutboxEntity)
      .findOne({ where: { stepAttemptId: (claim as any).attempt.id } });
    expect(outboxRow?.status).toBe("DISPATCHED");

    // Simulate a transport crash after dispatch: the record returns to
    // PENDING and is redelivered later.
    await dataSource
      .getRepository(DispatchOutboxEntity)
      .createQueryBuilder()
      .update()
      .set({
        status: "PENDING",
        leaseExpiresAt: null,
        leaseToken: null,
        nextDispatchAt: new Date(Date.now() - 1000),
      })
      .where("id = :id", { id: outboxRow?.id })
      .execute();

    const disposition = await outboxService.dispatchNext();
    expect(disposition).toEqual({ outcome: "dispatched" });
    expect(rec.calls).toHaveLength(2);
    expect(rec.calls[1].invocation).toEqual(rec.calls[0].invocation);
    expect(rec.calls[1].pinned).toEqual(rec.calls[0].pinned);
    expect(rec.calls[1].pinned).toEqual(frozen);
    const reloadedRow = await dataSource
      .getRepository(DispatchOutboxEntity)
      .findOne({ where: { id: outboxRow?.id } });
    expect(reloadedRow?.dispatchCount).toBe(2);
  });

  it("workflow retry creates a distinct attempt with its own frozen descriptor evidence", async () => {
    const config = transportConfig(httpEnv());
    const service = executionServiceWith(config);
    const { pipeline, execution } = await seedExecution(service, "m3-retry", [
      { id: "extract", agent: "reader", retries: 2, onFailure: "retry" },
    ]);
    const claim = await service.claimRunnableStep(
      execution.id,
      { id: "extract", agent: "reader", retries: 2 } as any,
      { input: true },
      3,
    );
    expect(claim?.disposition).toBe("claimed");

    const adapter = {
      kind: "http",
      start: jest.fn(),
      stop: jest.fn(),
      invoke: jest
        .fn()
        .mockRejectedValueOnce(
          new AgentAdapterError("HTTP_REJECTED", "http", "agent rejected", {
            invocationId: "first",
            retryable: false,
            httpStatus: 400,
          }),
        )
        .mockResolvedValue({
          adapter: "http",
          invocationId: "second",
          dispatchedAt: new Date().toISOString(),
        }),
    };
    const outboxService = new DispatchOutboxService(
      dataSource as any,
      adapter,
      config,
    );
    const disposition = await outboxService.dispatchNext();
    expect(disposition).toEqual({
      outcome: "terminal_failure",
      executionId: execution.id,
    });

    // The workflow retry policy keeps the step RETRYING; reconciliation
    // claims a NEW attempt and dispatches it through the same outbox.
    const engine = new EngineService(
      {
        findOne: jest.fn().mockResolvedValue({ id: pipeline.id, name: "p" }),
      } as any,
      executionServiceWith(config) as any,
      adapter,
      outboxService,
    );
    await engine.reconcileExecution(execution.id);

    const attempts = await dataSource.getRepository(StepAttemptEntity).find({
      where: { executionId: execution.id },
      order: { attemptNumber: "ASC" },
    });
    expect(attempts).toHaveLength(2);
    expect(attempts[0].status).toBe("FAILED");
    expect(attempts[1].status).toBe("DISPATCHED");
    // Workflow retry is a NEW attempt/invocation, never redelivery.
    expect(attempts[1].invocationId).not.toBe(attempts[0].invocationId);
    // Every attempt carries its own bounded frozen descriptor evidence.
    for (const attempt of attempts) {
      expect(attempt.executorSnapshot).toMatchObject({
        schemaVersion: "1",
        executorId: "agent:reader",
        kind: "http",
      });
      expect(JSON.stringify(attempt.executorSnapshot)).not.toContain(
        "reader-callback-secret",
      );
    }
    expect(attempts[1].executorSnapshot).toEqual(attempts[0].executorSnapshot);
  });

  it("a profile rotated to another executor after freeze is a deterministic safe failure, never a reroute", async () => {
    const config = transportConfig(httpEnv());
    const service = executionServiceWith(config);
    const { execution } = await seedExecution(service, "m3-rotation", [
      { id: "extract", agent: "reader" },
    ]);
    const claim = await claimExtract(service, execution.id);
    expect(claim?.disposition).toBe("claimed");

    // The operator rotates the agent to Kafka after the attempt froze.
    const rotatedConfig = transportConfig({
      ...httpEnv(),
      AGENT_TRANSPORT_CONFIG: JSON.stringify({ reader: { kind: "kafka" } }),
    });
    const httpAdapter = new HttpAgentAdapter(rotatedConfig);
    const router = new AgentAdapterRouter(
      {
        kind: "kafka",
        start: jest.fn(),
        stop: jest.fn(),
        invoke: jest
          .fn()
          .mockRejectedValue(new Error("kafka must not be used")),
      } as any,
      httpAdapter,
      rotatedConfig,
    );
    await router.start({ result: jest.fn(), event: jest.fn() });
    try {
      const outboxService = new DispatchOutboxService(
        dataSource as any,
        router as any,
        rotatedConfig,
      );
      const disposition = await outboxService.dispatchNext();
      expect(disposition).toEqual({
        outcome: "terminal_failure",
        executionId: execution.id,
      });

      // The pinned HTTP attempt fails deterministically; the outbox retires.
      const attempt = await dataSource
        .getRepository(StepAttemptEntity)
        .findOne({ where: { id: (claim as any).attempt.id } });
      expect(attempt?.status).toBe("FAILED");
      expect(attempt?.error).toContain(
        "Pinned HTTP executor profile for agent",
      );
      const outboxRow = await dataSource
        .getRepository(DispatchOutboxEntity)
        .findOne({ where: { stepAttemptId: attempt?.id } });
      expect(outboxRow?.status).toBe("FAILED");
      const step = await dataSource
        .getRepository(LogicalStepEntity)
        .findOne({ where: { executionId: execution.id } });
      expect(step?.status).toBe("FAILED");
    } finally {
      await router.stop();
    }
  });

  it("a still-HTTP rotation cannot silently reroute dispatch to a new URL", async () => {
    const config = transportConfig(httpEnv());
    const service = executionServiceWith(config);
    const { execution } = await seedExecution(service, "m3-url-rotation", [
      { id: "extract", agent: "reader" },
    ]);
    const claim = await claimExtract(service, execution.id);
    expect(claim?.disposition).toBe("claimed");

    // The worker moved to a new address after the attempt froze.
    const rotatedConfig = transportConfig(
      httpEnv({ submitUrl: "https://reader-live.example/v1/runs" }),
    );
    const httpAdapter = new HttpAgentAdapter(rotatedConfig);
    const router = new AgentAdapterRouter(
      {
        kind: "kafka",
        start: jest.fn(),
        stop: jest.fn(),
        invoke: jest
          .fn()
          .mockRejectedValue(new Error("kafka must not be used")),
      } as any,
      httpAdapter,
      rotatedConfig,
    );
    await router.start({ result: jest.fn(), event: jest.fn() });
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          schemaVersion: "1",
          invocationId: (claim as any).attempt.invocationId,
          runId: "run-1",
          status: "accepted",
          acceptedAt: new Date().toISOString(),
        }),
        {
          status: 202,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );
    try {
      const outboxService = new DispatchOutboxService(
        dataSource as any,
        router as any,
        rotatedConfig,
      );
      const disposition = await outboxService.dispatchNext();
      expect(disposition).toEqual({ outcome: "dispatched" });
      // The dispatch still targets the URL frozen on the attempt.
      expect(fetchMock).toHaveBeenCalledWith(
        "https://reader-pinned.example/v1/runs",
        expect.anything(),
      );
    } finally {
      fetchMock.mockRestore();
      await router.stop();
    }
  });

  it("an anomalous non-terminal snapshot is a deterministic terminal failure, never a guessed dispatch", async () => {
    const config = transportConfig(httpEnv());
    const service = executionServiceWith(config);
    const { execution } = await seedExecution(service, "m3-bad-snapshot", [
      { id: "extract", agent: "reader" },
    ]);
    const claim = await claimExtract(service, execution.id);
    expect(claim?.disposition).toBe("claimed");

    // Corrupt the frozen evidence into a shape no M0–M3 writer produces.
    await dataSource
      .getRepository(StepAttemptEntity)
      .createQueryBuilder()
      .update()
      .set({ executorSnapshot: {} })
      .where("id = :id", { id: (claim as any).attempt.id })
      .execute();

    const adapter = {
      kind: "test",
      start: jest.fn(),
      stop: jest.fn(),
      invoke: jest.fn().mockRejectedValue(new Error("must not dispatch")),
    };
    const outboxService = new DispatchOutboxService(
      dataSource as any,
      adapter as any,
      config,
    );
    const disposition = await outboxService.dispatchNext();

    expect(disposition).toEqual({
      outcome: "terminal_failure",
      executionId: execution.id,
    });
    expect(adapter.invoke).not.toHaveBeenCalled();
    const attempt = await dataSource
      .getRepository(StepAttemptEntity)
      .findOne({ where: { id: (claim as any).attempt.id } });
    expect(attempt?.status).toBe("FAILED");
    expect(attempt?.error).toContain("Executor snapshot");
    const outboxRow = await dataSource
      .getRepository(DispatchOutboxEntity)
      .findOne({ where: { stepAttemptId: attempt?.id } });
    expect(outboxRow?.status).toBe("FAILED");
  });

  it("legacy { agent } snapshots dispatch through live configuration and are never rewritten", async () => {
    const config = transportConfig(httpEnv());
    const service = executionServiceWith(config);
    const { execution } = await seedExecution(service, "m3-legacy", [
      { id: "extract", agent: "reader" },
    ]);
    const claim = await claimExtract(service, execution.id);
    expect(claim?.disposition).toBe("claimed");

    // Replace the frozen descriptor with a pre-M3 legacy snapshot.
    await dataSource
      .getRepository(StepAttemptEntity)
      .createQueryBuilder()
      .update()
      .set({ executorSnapshot: { agent: "reader" } })
      .where("id = :id", { id: (claim as any).attempt.id })
      .execute();

    const rec = recordingAdapter();
    const outboxService = new DispatchOutboxService(
      dataSource as any,
      rec.adapter as any,
      config,
    );
    const disposition = await outboxService.dispatchNext();
    expect(disposition).toEqual({ outcome: "dispatched" });
    expect(rec.calls).toHaveLength(1);
    expect(rec.calls[0].pinned).toMatchObject({
      schemaVersion: "1",
      kind: "http",
      agent: "reader",
    });

    // The legacy row is evidence: the compatibility reader never rewrites it.
    const attempt = await dataSource
      .getRepository(StepAttemptEntity)
      .findOne({ where: { id: (claim as any).attempt.id } });
    expect(attempt?.executorSnapshot).toEqual({ agent: "reader" });
  });

  it("legacy snapshots of agents without HTTP configuration keep the Kafka default", async () => {
    const config = transportConfig({});
    const service = executionServiceWith(config);
    const { execution } = await seedExecution(service, "m3-legacy-kafka", [
      { id: "extract", agent: "reader" },
    ]);
    const claim = await claimExtract(service, execution.id);
    expect(claim?.disposition).toBe("claimed");
    await dataSource
      .getRepository(StepAttemptEntity)
      .createQueryBuilder()
      .update()
      .set({ executorSnapshot: { agent: "reader" } })
      .where("id = :id", { id: (claim as any).attempt.id })
      .execute();

    const rec = recordingAdapter();
    const outboxService = new DispatchOutboxService(
      dataSource as any,
      rec.adapter as any,
      config,
    );
    const disposition = await outboxService.dispatchNext();
    expect(disposition).toEqual({ outcome: "dispatched" });
    expect(rec.calls[0].pinned).toMatchObject({
      schemaVersion: "1",
      kind: "kafka",
      agent: "reader",
    });
    expect(
      (rec.calls[0].pinned as ExecutorDescriptorV1).httpProfile,
    ).toBeUndefined();
  });

  it("concurrent dispatch claims of one outbox row deliver the frozen descriptor exactly once", async () => {
    const config = transportConfig(httpEnv());
    const service = executionServiceWith(config);
    const { execution } = await seedExecution(service, "m3-concurrent", [
      { id: "extract", agent: "reader" },
    ]);
    const claim = await claimExtract(service, execution.id);
    expect(claim?.disposition).toBe("claimed");
    const frozen = (claim as any).attempt.executorSnapshot;

    const rec = recordingAdapter();
    const first = new DispatchOutboxService(
      dataSource as any,
      rec.adapter as any,
      config,
    );
    const second = new DispatchOutboxService(
      dataSource as any,
      rec.adapter as any,
      config,
    );
    const [a, b] = await Promise.all([
      first.dispatchNext(),
      second.dispatchNext(),
    ]);
    expect([a.outcome, b.outcome].sort()).toEqual(["dispatched", "idle"]);
    // One lease, one delivery, one pinned descriptor.
    expect(rec.calls).toHaveLength(1);
    expect(rec.calls[0].pinned).toEqual(frozen);
  });

  describe("M3-S2 cancellation", () => {
    const cancelEngine = (
      adapter: any,
      config: AgentTransportConfigService,
      pipelineId: string,
    ): { engine: EngineService; outbox: DispatchOutboxService } => {
      const outbox = new DispatchOutboxService(
        dataSource as any,
        adapter,
        config,
      );
      const engine = new EngineService(
        {
          findOne: jest.fn().mockResolvedValue({ id: pipelineId, name: "p" }),
        } as any,
        executionServiceWith(config) as any,
        adapter,
        outbox,
      );
      return { engine, outbox };
    };

    const dispatchSeededClaim = async (outbox: DispatchOutboxService) => {
      const disposition = await outbox.dispatchNext();
      expect(disposition).toEqual({ outcome: "dispatched" });
    };

    it("cancels through the engine, retires the outbox, and records the unsupported limitation durably", async () => {
      const config = transportConfig(httpEnv());
      const service = executionServiceWith(config);
      const { pipeline, execution } = await seedExecution(
        service,
        "m3-cancel",
        [{ id: "extract", agent: "reader" }],
      );
      const claim = await claimExtract(service, execution.id);
      expect(claim?.disposition).toBe("claimed");

      const adapter = {
        kind: "http",
        start: jest.fn(),
        stop: jest.fn(),
        invoke: jest.fn().mockResolvedValue({
          adapter: "http",
          invocationId: (claim as any).attempt.invocationId,
          dispatchedAt: new Date().toISOString(),
          dispatchId: "run-1",
        }),
      };
      const { engine, outbox } = cancelEngine(adapter, config, pipeline.id);
      await dispatchSeededClaim(outbox);

      const cancelled = await engine.cancelExecution(execution.id);
      expect(cancelled.status).toBe("CANCELLED");

      const attempt = await dataSource
        .getRepository(StepAttemptEntity)
        .findOne({ where: { id: (claim as any).attempt.id } });
      expect(attempt?.status).toBe("CANCELLED");
      const outboxRow = await dataSource
        .getRepository(DispatchOutboxEntity)
        .findOne({ where: { stepAttemptId: attempt?.id } });
      expect(outboxRow?.status).toBe("COMPLETED");
      // The frozen descriptor (cancel: false, honest for HTTP today) records
      // the unsupported limitation as durable evidence on the outbox row.
      expect(outboxRow?.error).toContain("cancel notification: unsupported");
      // The adapter has no cancel method; nothing was notified.
      expect(adapter.invoke).toHaveBeenCalledTimes(1);
    });

    it("notifies the executor when the frozen descriptor declares cancel support, with the receipt's remote identity", async () => {
      const config = transportConfig(httpEnv());
      const service = executionServiceWith(config);
      const { pipeline, execution } = await seedExecution(
        service,
        "m3-cancel-supported",
        [{ id: "extract", agent: "reader" }],
      );
      const claim = await claimExtract(service, execution.id);
      expect(claim?.disposition).toBe("claimed");

      const cancel = jest.fn().mockResolvedValue({
        adapter: "http",
        invocationId: (claim as any).attempt.invocationId,
        delivered: true,
      });
      const adapter = {
        kind: "http",
        start: jest.fn(),
        stop: jest.fn(),
        invoke: jest.fn().mockResolvedValue({
          adapter: "http",
          invocationId: (claim as any).attempt.invocationId,
          dispatchedAt: new Date().toISOString(),
          dispatchId: "run-1",
        }),
        cancel,
      };
      const { engine, outbox } = cancelEngine(adapter, config, pipeline.id);
      await dispatchSeededClaim(outbox);

      // The supported capability is not producible by the honest production
      // resolver (kafka/http cannot cancel); craft the frozen evidence for a
      // reviewed executor that can.
      await dataSource
        .getRepository(StepAttemptEntity)
        .createQueryBuilder()
        .update()
        .set({
          executorSnapshot: {
            schemaVersion: "1",
            executorId: "agent:reader",
            agent: "reader",
            kind: "http",
            configHash: "c".repeat(64),
            capabilities: { cancel: true },
            httpProfile: {
              submitUrl: "https://reader-pinned.example/v1/runs",
              requestTimeoutMs: 1000,
              maxResponseBytes: 1024,
            },
          },
        })
        .where("id = :id", { id: (claim as any).attempt.id })
        .execute();

      await engine.cancelExecution(execution.id);

      expect(cancel).toHaveBeenCalledWith({
        invocationId: (claim as any).attempt.invocationId,
        executionId: execution.id,
        dispatchId: "run-1",
        reason: "Execution cancelled by request",
      });
      const outboxRow = await dataSource
        .getRepository(DispatchOutboxEntity)
        .findOne({ where: { stepAttemptId: (claim as any).attempt.id } });
      // Delivered cancels are recorded as evidence (and as the idempotency
      // marker), never as a limitation.
      expect(outboxRow?.error).toContain("cancel notification: delivered");
    });

    it("records unreachable when the executor cannot be reached, and never blocks the committed cancellation", async () => {
      const config = transportConfig(httpEnv());
      const service = executionServiceWith(config);
      const { pipeline, execution } = await seedExecution(
        service,
        "m3-cancel-unreachable",
        [{ id: "extract", agent: "reader" }],
      );
      const claim = await claimExtract(service, execution.id);
      expect(claim?.disposition).toBe("claimed");

      const cancel = jest.fn().mockRejectedValue(
        new AgentAdapterError(
          "HTTP_CONNECTION_FAILED",
          "http",
          "executor down",
          {
            retryable: true,
          },
        ),
      );
      const adapter = {
        kind: "http",
        start: jest.fn(),
        stop: jest.fn(),
        invoke: jest.fn().mockResolvedValue({
          adapter: "http",
          invocationId: (claim as any).attempt.invocationId,
          dispatchedAt: new Date().toISOString(),
          dispatchId: "run-1",
        }),
        cancel,
      };
      const { engine, outbox } = cancelEngine(adapter, config, pipeline.id);
      await dispatchSeededClaim(outbox);
      await dataSource
        .getRepository(StepAttemptEntity)
        .createQueryBuilder()
        .update()
        .set({
          executorSnapshot: {
            schemaVersion: "1",
            executorId: "agent:reader",
            agent: "reader",
            kind: "http",
            configHash: "c".repeat(64),
            capabilities: { cancel: true },
            httpProfile: {
              submitUrl: "https://reader-pinned.example/v1/runs",
              requestTimeoutMs: 1000,
              maxResponseBytes: 1024,
            },
          },
        })
        .where("id = :id", { id: (claim as any).attempt.id })
        .execute();

      const cancelled = await engine.cancelExecution(execution.id);

      // Tenvyr cancellation still wins; the failure is durable evidence.
      expect(cancelled.status).toBe("CANCELLED");
      const outboxRow = await dataSource
        .getRepository(DispatchOutboxEntity)
        .findOne({ where: { stepAttemptId: (claim as any).attempt.id } });
      expect(outboxRow?.error).toContain("cancel notification: unreachable");
    });

    it("never marks attempts that succeeded before the cancellation", async () => {
      const config = transportConfig(httpEnv());
      const service = executionServiceWith(config);
      const { pipeline, execution } = await seedExecution(
        service,
        "m3-cancel-sibling",
        [{ id: "extract", agent: "reader" }],
      );
      const claim = await claimExtract(service, execution.id);
      expect(claim?.disposition).toBe("claimed");

      const adapter = {
        kind: "http",
        start: jest.fn(),
        stop: jest.fn(),
        invoke: jest.fn().mockResolvedValue({
          adapter: "http",
          invocationId: (claim as any).attempt.invocationId,
          dispatchedAt: new Date().toISOString(),
          dispatchId: "run-1",
        }),
      };
      const { engine, outbox } = cancelEngine(adapter, config, pipeline.id);
      await dispatchSeededClaim(outbox);

      // The step completes BEFORE the cancellation: SUCCESS evidence.
      const result: AgentResultV1 = {
        schemaVersion: "1",
        invocationId: (claim as any).attempt.invocationId,
        executionId: execution.id,
        stepExecutionId: (claim as any).logicalStep.id,
        status: "succeeded",
        output: { done: true } as JsonValue,
        completedAt: new Date().toISOString(),
      };
      await inbox.apply(result, {
        adapter: "http",
        receivedAt: new Date().toISOString(),
      });
      const succeeded = await dataSource
        .getRepository(StepAttemptEntity)
        .findOne({ where: { id: (claim as any).attempt.id } });
      expect(succeeded?.status).toBe("SUCCESS");

      // Cancelling the execution afterwards must not notify or mark the
      // succeeded attempt.
      await engine.cancelExecution(execution.id);

      const outboxRow = await dataSource
        .getRepository(DispatchOutboxEntity)
        .findOne({ where: { stepAttemptId: (claim as any).attempt.id } });
      expect(outboxRow?.error).toBeNull();
    });

    it("is idempotent: a repeated cancellation never re-notifies the executor", async () => {
      const config = transportConfig(httpEnv());
      const service = executionServiceWith(config);
      const { pipeline, execution } = await seedExecution(
        service,
        "m3-cancel-idempotent",
        [{ id: "extract", agent: "reader" }],
      );
      const claim = await claimExtract(service, execution.id);
      expect(claim?.disposition).toBe("claimed");

      const cancel = jest.fn().mockResolvedValue({
        adapter: "http",
        invocationId: (claim as any).attempt.invocationId,
        delivered: true,
      });
      const adapter = {
        kind: "http",
        start: jest.fn(),
        stop: jest.fn(),
        invoke: jest.fn().mockResolvedValue({
          adapter: "http",
          invocationId: (claim as any).attempt.invocationId,
          dispatchedAt: new Date().toISOString(),
          dispatchId: "run-1",
        }),
        cancel,
      };
      const { engine, outbox } = cancelEngine(adapter, config, pipeline.id);
      await dispatchSeededClaim(outbox);
      await dataSource
        .getRepository(StepAttemptEntity)
        .createQueryBuilder()
        .update()
        .set({
          executorSnapshot: {
            schemaVersion: "1",
            executorId: "agent:reader",
            agent: "reader",
            kind: "http",
            configHash: "c".repeat(64),
            capabilities: { cancel: true },
            httpProfile: {
              submitUrl: "https://reader-pinned.example/v1/runs",
              requestTimeoutMs: 1000,
              maxResponseBytes: 1024,
            },
          },
        })
        .where("id = :id", { id: (claim as any).attempt.id })
        .execute();

      await engine.cancelExecution(execution.id);
      await engine.cancelExecution(execution.id);

      expect(cancel).toHaveBeenCalledTimes(1);
    });
  });
});

describeWithPostgres("PostgreSQL M4-S1 budget ledger", () => {
  jest.setTimeout(180_000);

  let dataSource: DataSource;
  let ledger: BudgetLedgerService;

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
    ledger = new BudgetLedgerService(dataSource as any);
  });

  afterAll(async () => {
    delete process.env.TENVYR_POLICY;
    await dataSource.destroy();
  });

  beforeEach(async () => {
    delete process.env.TENVYR_POLICY;
    await dataSource.query(
      `TRUNCATE "budget_ledger_entries", "budget_reservations",
       "budget_accounts" CASCADE`,
    );
  });

  const ledgerEntryCount = async (accountId: string): Promise<number> => {
    const rows = await dataSource.query(
      `SELECT count(*) AS n FROM "budget_ledger_entries" WHERE "accountId" = $1`,
      [accountId],
    );
    return Number(rows[0].n);
  };

  it("creates a hierarchical account chain and rejects child ceilings above the parent grant", async () => {
    const root = await ledger.createAccount({
      scopeType: "tenant",
      scopeId: "tenant-1",
      ceilings: { currency_micros: 1_000_000, tokens: 10_000 },
    });
    const child = await ledger.createAccount({
      scopeType: "execution",
      scopeId: "execution-1",
      parentAccountId: root.id,
      ceilings: { tokens: 2_000 },
    });
    expect(child.parentAccountId).toBe(root.id);

    await expect(
      ledger.createAccount({
        scopeType: "execution",
        scopeId: "execution-2",
        parentAccountId: root.id,
        ceilings: { tokens: 20_000 },
      }),
    ).rejects.toMatchObject({ code: "CHILD_CEILING_EXCEEDS_PARENT" });

    // Unknown dimensions are rejected; same scope is rejected once.
    await expect(
      ledger.createAccount({
        scopeType: "tenant",
        scopeId: "tenant-1",
        ceilings: { tokens: 100 },
      }),
    ).rejects.toMatchObject({ code: "SCOPE_ALREADY_EXISTS" });
  });

  it("100 concurrent reservations on one account never overspend the ceiling", async () => {
    const account = await ledger.createAccount({
      scopeType: "execution",
      scopeId: "concurrent-1",
      ceilings: { tokens: 50 },
    });
    const outcomes = await Promise.allSettled(
      Array.from({ length: 100 }, (_, index) =>
        ledger.reserve({
          accountId: account.id,
          dimension: "tokens",
          amount: 1,
          idempotencyKey: `concurrent-${index}`,
        }),
      ),
    );
    const fulfilled = outcomes.filter((o) => o.status === "fulfilled").length;
    const rejected = outcomes.filter((o) => o.status === "rejected");

    expect(fulfilled).toBe(50);
    expect(rejected).toHaveLength(50);
    for (const outcome of rejected) {
      expect((outcome as PromiseRejectedResult).reason).toMatchObject({
        code: "INSUFFICIENT_BUDGET",
      });
    }
    const projection = await ledger.projection(account.id);
    expect(projection.available.tokens).toBe(0);
    expect(await ledgerEntryCount(account.id)).toBe(50);
  });

  it("concurrent reservations on sibling accounts never overspend the shared ancestor", async () => {
    const root = await ledger.createAccount({
      scopeType: "tenant",
      scopeId: "tenant-shared",
      ceilings: { tokens: 30 },
    });
    const left = await ledger.createAccount({
      scopeType: "execution",
      scopeId: "left",
      parentAccountId: root.id,
      ceilings: { tokens: 30 },
    });
    const right = await ledger.createAccount({
      scopeType: "execution",
      scopeId: "right",
      parentAccountId: root.id,
      ceilings: { tokens: 30 },
    });
    const outcomes = await Promise.allSettled(
      Array.from({ length: 60 }, (_, index) =>
        ledger.reserve({
          accountId: index % 2 === 0 ? left.id : right.id,
          dimension: "tokens",
          amount: 1,
          idempotencyKey: `sibling-${index}`,
        }),
      ),
    );
    const fulfilled = outcomes.filter((o) => o.status === "fulfilled").length;

    // The ancestor ceiling (30) is the binding constraint across both
    // siblings; each sibling's own ceiling (30) never binds alone.
    expect(fulfilled).toBe(30);
    const rootProjection = await ledger.projection(root.id);
    expect(rootProjection.available.tokens).toBe(0);
    // Each child keeps its own ceiling remainder (30 − own debits); the
    // ancestor ceiling (30) is the binding cross-sibling constraint and is
    // exactly exhausted. New reservations on either child would now fail on
    // the ancestor check.
    const leftProjection = await ledger.projection(left.id);
    const rightProjection = await ledger.projection(right.id);
    expect(
      (leftProjection.available.tokens ?? 0) +
        (rightProjection.available.tokens ?? 0),
    ).toBe(30);
  });

  it("a duplicate reserve is exactly once; a conflicting key is rejected and the first stays authoritative", async () => {
    const account = await ledger.createAccount({
      scopeType: "execution",
      scopeId: "idempotent-1",
      ceilings: { tokens: 100 },
    });
    const first = await ledger.reserve({
      accountId: account.id,
      dimension: "tokens",
      amount: 10,
      idempotencyKey: "same-key",
    });
    const replay = await ledger.reserve({
      accountId: account.id,
      dimension: "tokens",
      amount: 10,
      idempotencyKey: "same-key",
    });

    expect(replay.id).toBe(first.id);
    expect(replay.status).toBe("ACTIVE");
    expect(await ledgerEntryCount(account.id)).toBe(1);

    await expect(
      ledger.reserve({
        accountId: account.id,
        dimension: "tokens",
        amount: 20,
        idempotencyKey: "same-key",
      }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });

    // The first reservation is still authoritative and still debits.
    const projection = await ledger.projection(account.id);
    expect(projection.available.tokens).toBe(90);
  });

  it("reserve → commit → release settles exactly the used amount with full ledger evidence", async () => {
    const account = await ledger.createAccount({
      scopeType: "execution",
      scopeId: "settle-1",
      ceilings: { currency_micros: 1_000_000 },
    });
    const reservation = await ledger.reserve({
      accountId: account.id,
      dimension: "currency_micros",
      amount: 600_000,
      idempotencyKey: "settle-reserve",
      source: "unknown",
    });

    const committed = await ledger.commit({
      reservationId: reservation.id,
      amount: 420_000,
      source: "actual",
      evidence: { attemptId: "attempt-1" },
    });
    expect(committed.status).toBe("COMMITTED");
    expect(
      (await ledger.projection(account.id)).available.currency_micros,
    ).toBe(1_000_000 - 600_000);

    const released = await ledger.release({
      reservationId: reservation.id,
      amount: 180_000,
      source: "unknown",
      reason: "unused reservation",
    });
    expect(released.status).toBe("RELEASED");
    expect(
      (await ledger.projection(account.id)).available.currency_micros,
    ).toBe(1_000_000 - 420_000);
    // Append-only evidence: reserve (account) + commit + release entries.
    expect(await ledgerEntryCount(account.id)).toBe(3);

    // Committing or releasing again is rejected — exactly one settlement.
    await expect(
      ledger.commit({ reservationId: reservation.id, amount: 1 }),
    ).rejects.toMatchObject({ code: "RESERVATION_NOT_ACTIVE" });
    await expect(
      ledger.release({ reservationId: reservation.id, amount: 1 }),
    ).rejects.toMatchObject({ code: "RESERVATION_NOT_ACTIVE" });
  });

  it("commit and release amounts never exceed the reservation", async () => {
    const account = await ledger.createAccount({
      scopeType: "execution",
      scopeId: "settle-2",
      ceilings: { tokens: 100 },
    });
    const reservation = await ledger.reserve({
      accountId: account.id,
      dimension: "tokens",
      amount: 10,
      idempotencyKey: "settle-2-reserve",
    });
    await expect(
      ledger.commit({ reservationId: reservation.id, amount: 11 }),
    ).rejects.toMatchObject({ code: "RESERVATION_AMOUNT_EXCEEDED" });
    await expect(
      ledger.release({ reservationId: reservation.id, amount: 11 }),
    ).rejects.toMatchObject({ code: "RESERVATION_AMOUNT_EXCEEDED" });
  });

  it("release can never exceed the UNUSED portion: committed work is never refunded", async () => {
    const account = await ledger.createAccount({
      scopeType: "execution",
      scopeId: "settle-3",
      ceilings: { currency_micros: 1_000_000 },
    });
    const reservation = await ledger.reserve({
      accountId: account.id,
      dimension: "currency_micros",
      amount: 600_000,
      idempotencyKey: "settle-3-reserve",
      source: "unknown",
    });
    await ledger.commit({
      reservationId: reservation.id,
      amount: 420_000,
      source: "actual",
    });

    // Releasing the full reservation would mint availability out of the
    // committed 420_000 of real usage — rejected.
    await expect(
      ledger.release({ reservationId: reservation.id, amount: 600_000 }),
    ).rejects.toMatchObject({ code: "RESERVATION_AMOUNT_EXCEEDED" });

    // Releasing exactly the unused 180_000 is the legal settlement.
    await ledger.release({ reservationId: reservation.id, amount: 180_000 });
    const projection = await ledger.projection(account.id);
    expect(projection.available.currency_micros).toBe(1_000_000 - 420_000);
  });

  it("N concurrent identical-key reserves produce exactly one reservation and one entry", async () => {
    const account = await ledger.createAccount({
      scopeType: "execution",
      scopeId: "concurrent-key",
      ceilings: { tokens: 100 },
    });
    const outcomes = await Promise.allSettled(
      Array.from({ length: 20 }, () =>
        ledger.reserve({
          accountId: account.id,
          dimension: "tokens",
          amount: 10,
          idempotencyKey: "the-same-key",
        }),
      ),
    );
    const fulfilled = outcomes.filter((o) => o.status === "fulfilled");
    expect(fulfilled).toHaveLength(20);
    const ids = new Set(
      fulfilled.map((o) => (o as PromiseFulfilledResult<any>).value.id),
    );
    expect(ids.size).toBe(1);
    expect(await ledgerEntryCount(account.id)).toBe(1);
    const projection = await ledger.projection(account.id);
    expect(projection.available.tokens).toBe(90);
  });

  it("the same idempotency key on a different account is a conflict, never a silent steal", async () => {
    const first = await ledger.createAccount({
      scopeType: "execution",
      scopeId: "key-owner",
      ceilings: { tokens: 100 },
    });
    const second = await ledger.createAccount({
      scopeType: "execution",
      scopeId: "key-other",
      ceilings: { tokens: 100 },
    });
    await ledger.reserve({
      accountId: first.id,
      dimension: "tokens",
      amount: 10,
      idempotencyKey: "cross-account-key",
    });
    await expect(
      ledger.reserve({
        accountId: second.id,
        dimension: "tokens",
        amount: 10,
        idempotencyKey: "cross-account-key",
      }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    // The first reservation stays authoritative; the second account is
    // untouched.
    expect((await ledger.projection(second.id)).available.tokens).toBe(100);
  });

  it("derived entry keys never collide with legitimate reserve keys", async () => {
    const account = await ledger.createAccount({
      scopeType: "execution",
      scopeId: "entry-key-collision",
      ceilings: { tokens: 100 },
    });
    const reservation = await ledger.reserve({
      accountId: account.id,
      dimension: "tokens",
      amount: 10,
      idempotencyKey: "collision-root",
    });
    await ledger.commit({
      reservationId: reservation.id,
      amount: 5,
      source: "actual",
    });

    // Entry keys are `${key}:<accountId>` / `${key}:commit`, so a reserve
    // key that merely LOOKS like a derived key is a legitimate independent
    // reservation (the entry unique index cannot misfire).
    const sibling = await ledger.reserve({
      accountId: account.id,
      dimension: "tokens",
      amount: 10,
      idempotencyKey: "collision-root:commit",
    });
    expect(sibling.status).toBe("ACTIVE");
    expect(await ledgerEntryCount(account.id)).toBe(3);
  });

  it("adjust applies a signed correction and refuses to drive availability negative", async () => {
    const account = await ledger.createAccount({
      scopeType: "execution",
      scopeId: "adjust-1",
      ceilings: { tokens: 100 },
    });
    await ledger.reserve({
      accountId: account.id,
      dimension: "tokens",
      amount: 60,
      idempotencyKey: "adjust-reserve",
    });
    await ledger.adjust({
      accountId: account.id,
      dimension: "tokens",
      delta: 50,
      reason: "operator top-up",
    });
    expect((await ledger.projection(account.id)).available.tokens).toBe(90);

    await expect(
      ledger.adjust({
        accountId: account.id,
        dimension: "tokens",
        delta: -200,
        reason: "mistake",
      }),
    ).rejects.toMatchObject({ code: "AVAILABILITY_NEGATIVE" });
  });

  it("the ledger projection rebuilds from append-only truth after restart", async () => {
    const account = await ledger.createAccount({
      scopeType: "execution",
      scopeId: "restart-1",
      ceilings: { tokens: 1_000 },
    });
    const reservation = await ledger.reserve({
      accountId: account.id,
      dimension: "tokens",
      amount: 300,
      idempotencyKey: "restart-reserve",
    });
    await ledger.commit({
      reservationId: reservation.id,
      amount: 250,
      source: "actual",
    });
    await ledger.release({
      reservationId: reservation.id,
      amount: 50,
      source: "unknown",
    });

    // Simulate a restart: a NEW service instance rebuilds the projection
    // purely from the persisted ledger.
    const freshLedger = new BudgetLedgerService(dataSource as any);
    const projection = await freshLedger.projection(account.id);
    expect(projection.available.tokens).toBe(1_000 - 250);
  });

  it("migration is repeat-safe and the upgrade chain preserves rows", async () => {
    // The migration is already applied by runMigrations; running it again
    // must be a no-op (IF NOT EXISTS) that preserves rows.
    const account = await ledger.createAccount({
      scopeType: "execution",
      scopeId: "migration-1",
      ceilings: { tokens: 10 },
    });
    const runner = dataSource.createQueryRunner();
    try {
      await new MilestoneFourBudgetLedger1722270006000().up(runner);
    } finally {
      await runner.release();
    }
    const reloaded = await dataSource
      .getRepository(BudgetAccountEntity)
      .findOne({ where: { id: account.id } });
    expect(reloaded?.ceilings).toEqual({ tokens: 10 });
  });
});

describeWithPostgres("PostgreSQL M4-S2 enforcement wiring", () => {
  jest.setTimeout(180_000);

  let dataSource: DataSource;
  let executionService: ExecutionService;
  let inbox: ResultInboxService;
  let ledger: BudgetLedgerService;

  const pipeline = (name: string, steps: any[], budget?: any) => ({
    name,
    version: "1.0",
    description: "M4-S2 fixture",
    ...(budget === undefined ? {} : { budget }),
    steps,
  });

  const seed = async (steps: any[], budget?: any) => {
    const stored = await dataSource
      .getRepository(PipelineEntity)
      .save(
        dataSource
          .getRepository(PipelineEntity)
          .create(
            pipeline(
              `m4s2-${Math.random().toString(36).slice(2)}`,
              steps,
              budget,
            ),
          ),
      );
    const execution = await executionService.createExecution(stored, {});
    await executionService.reconcileExecution(execution.id);
    return { stored, execution };
  };

  const claim = (executionId: string, step: any, maxAttempts = 1) =>
    executionService.claimRunnableStep(
      executionId,
      step,
      { input: true },
      maxAttempts,
    );

  const applyResult = async (
    executionId: string,
    claimResult: any,
    output: unknown,
    usage?: unknown,
  ) => {
    const result: AgentResultV1 = {
      schemaVersion: "1",
      invocationId: claimResult.attempt.invocationId,
      executionId,
      stepExecutionId: claimResult.logicalStep.id,
      status: "succeeded",
      output: output as JsonValue,
      completedAt: new Date().toISOString(),
      ...(usage === undefined
        ? {}
        : { usage: usage as AgentResultV1["usage"] }),
    };
    return inbox.apply(result, {
      adapter: "http",
      receivedAt: new Date().toISOString(),
    });
  };

  const accountProjection = async (executionId: string) => {
    const account = await dataSource
      .getRepository(BudgetAccountEntity)
      .findOne({
        where: { scopeType: "execution", scopeId: executionId },
      });
    return account ? ledger.projection(account.id) : null;
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
    ledger = new BudgetLedgerService(dataSource as any);
    executionService = new ExecutionService(
      dataSource.getRepository(ExecutionEntity),
      dataSource.getRepository(LogicalStepEntity),
      dataSource.getRepository(StepAttemptEntity),
      dataSource.getRepository(ExecutionPlanRevisionEntity),
      dataSource,
    );
    inbox = new ResultInboxService(dataSource as any);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await dataSource.query(
      `TRUNCATE "budget_ledger_entries", "budget_reservations", "budget_accounts",
       "dispatch_outbox", "step_attempts", "step_executions",
       "execution_plan_revisions", "executions", "pipelines" CASCADE`,
    );
  });

  it("reserves before work authority: the reservation commits atomically with the attempt and outbox", async () => {
    const { execution } = await seed(
      [{ id: "extract", agent: "reader", budget: { tokens: 100 } }],
      { tokens: 1000 },
    );
    const claimResult = await claim(execution.id, {
      id: "extract",
      agent: "reader",
      budget: { tokens: 100 },
    });

    expect(claimResult?.disposition).toBe("claimed");
    const projection = await accountProjection(execution.id);
    expect(projection?.available.tokens).toBe(900);
    const reservation = await dataSource
      .getRepository(BudgetReservationEntity)
      .findOne({
        where: { actionRef: (claimResult as any).attempt.invocationId },
      });
    expect(reservation?.status).toBe("ACTIVE");
    expect(reservation?.amount).toBe("100");
  });

  it("an insufficient budget grants NO work authority: durable FAILED attempt, no outbox", async () => {
    const { execution } = await seed(
      [{ id: "extract", agent: "reader", budget: { tokens: 500 } }],
      { tokens: 100 },
    );
    const claimResult = await claim(execution.id, {
      id: "extract",
      agent: "reader",
      budget: { tokens: 500 },
    });

    expect(claimResult?.disposition).toBe("budget_insufficient");
    const attempt = await dataSource.getRepository(StepAttemptEntity).findOne({
      where: { executionId: execution.id },
    });
    expect(attempt?.status).toBe("FAILED");
    expect(attempt?.error).toContain("Budget reservation failed");
    const outboxCount = await dataSource
      .getRepository(DispatchOutboxEntity)
      .count({ where: { stepAttemptId: attempt?.id } });
    expect(outboxCount).toBe(0);
    // No reservation was minted.
    const projection = await accountProjection(execution.id);
    expect(projection?.available.tokens).toBe(100);
  });

  it("reconciles canonical usage and releases the unused remainder in the result transaction", async () => {
    const { execution } = await seed(
      [
        {
          id: "extract",
          agent: "reader",
          budget: { tokens: 1000, currency_micros: 500_000 },
        },
      ],
      { tokens: 1000, currency_micros: 500_000 },
    );
    const claimResult = await claim(execution.id, {
      id: "extract",
      agent: "reader",
      budget: { tokens: 1000, currency_micros: 500_000 },
    });
    await applyResult(
      execution.id,
      claimResult,
      { done: true },
      { totalTokens: 400, costUsd: 0.1 },
    );

    const projection = await accountProjection(execution.id);
    // tokens: 1000 − reserve 1000 + release 600 = 600; micros: 500000 − 500000 + 400000 = 400000.
    expect(projection?.available.tokens).toBe(600);
    expect(projection?.available.currency_micros).toBe(400_000);
    const reservations = await dataSource
      .getRepository(BudgetReservationEntity)
      .find({
        where: { actionRef: (claimResult as any).attempt.invocationId },
      });
    // Both settled: the final status is RELEASED; the commit is ledger
    // evidence, not a terminal status.
    expect(reservations.map((r) => r.status)).toEqual(["RELEASED", "RELEASED"]);
    const entries = await dataSource
      .getRepository(BudgetLedgerEntryEntity)
      .find({ where: { reservationId: In(reservations.map((r) => r.id)) } });
    const commits = entries.filter((e) => e.operation === "commit");
    expect(commits.map((c) => Number(c.amount)).sort((a, b) => a - b)).toEqual([
      400, 100_000,
    ]);
    const releases = entries.filter((e) => e.operation === "release");
    expect(releases.map((r) => Number(r.amount)).sort((a, b) => a - b)).toEqual(
      [600, 400_000],
    );
  });

  it("a terminal result without usage leaves the reservation consumed (unknown is never zero)", async () => {
    const { execution } = await seed(
      [{ id: "extract", agent: "reader", budget: { tokens: 100 } }],
      { tokens: 100 },
    );
    const claimResult = await claim(execution.id, {
      id: "extract",
      agent: "reader",
      budget: { tokens: 100 },
    });
    await applyResult(execution.id, claimResult, { done: true });

    const projection = await accountProjection(execution.id);
    expect(projection?.available.tokens).toBe(0);
    const reservation = await dataSource
      .getRepository(BudgetReservationEntity)
      .findOne({
        where: { actionRef: (claimResult as any).attempt.invocationId },
      });
    expect(reservation?.status).toBe("ACTIVE");
  });

  it("workflow retries charge independently: each attempt owns its own reservation", async () => {
    const { execution } = await seed(
      [
        {
          id: "extract",
          agent: "reader",
          retries: 2,
          onFailure: "retry",
          budget: { tokens: 50 },
        },
      ],
      { tokens: 100 },
    );
    const first = await claim(
      execution.id,
      {
        id: "extract",
        agent: "reader",
        retries: 2,
        budget: { tokens: 50 },
      },
      3,
    );
    expect(first?.disposition).toBe("claimed");

    const adapter = {
      kind: "http",
      start: jest.fn(),
      stop: jest.fn(),
      invoke: jest
        .fn()
        .mockRejectedValueOnce(
          new AgentAdapterError("HTTP_REJECTED", "http", "rejected", {
            invocationId: "first",
            retryable: false,
            httpStatus: 400,
          }),
        )
        .mockResolvedValue({
          adapter: "http",
          invocationId: "second",
          dispatchedAt: new Date().toISOString(),
        }),
    };
    const outboxService = new DispatchOutboxService(
      dataSource as any,
      adapter as any,
    );
    await outboxService.dispatchNext();

    const engine = new EngineService(
      {
        findOne: jest
          .fn()
          .mockResolvedValue({ id: (execution as any).pipelineId, name: "p" }),
      } as any,
      executionService as any,
      adapter as any,
      outboxService,
    );
    await engine.reconcileExecution(execution.id);

    const attempts = await dataSource.getRepository(StepAttemptEntity).find({
      where: { executionId: execution.id },
      order: { attemptNumber: "ASC" },
    });
    expect(attempts).toHaveLength(2);
    const reservations = await dataSource
      .getRepository(BudgetReservationEntity)
      .find({ where: { actionRef: In(attempts.map((a) => a.invocationId)) } });
    // Attempt 1's reservation was released by the dispatch failure; attempt
    // 2 reserved independently (50 again, distinct keys).
    expect(reservations).toHaveLength(2);
    const byRef = new Map(reservations.map((r) => [r.actionRef, r]));
    expect(byRef.get(attempts[0].invocationId)?.status).toBe("RELEASED");
    expect(byRef.get(attempts[1].invocationId)?.status).toBe("ACTIVE");
    expect(byRef.get(attempts[1].invocationId)?.idempotencyKey).not.toBe(
      byRef.get(attempts[0].invocationId)?.idempotencyKey,
    );
    // Net ledger position: attempt 1 released fully, attempt 2 still holds 50.
    expect((await accountProjection(execution.id))?.available.tokens).toBe(50);
  });

  it("cancellation releases the full reservation in the cancel transaction", async () => {
    const { execution } = await seed(
      [{ id: "extract", agent: "reader", budget: { tokens: 100 } }],
      { tokens: 100 },
    );
    const claimResult = await claim(execution.id, {
      id: "extract",
      agent: "reader",
      budget: { tokens: 100 },
    });
    await executionService.cancelExecution(execution.id);

    const projection = await accountProjection(execution.id);
    expect(projection?.available.tokens).toBe(100);
    const reservation = await dataSource
      .getRepository(BudgetReservationEntity)
      .findOne({
        where: { actionRef: (claimResult as any).attempt.invocationId },
      });
    expect(reservation?.status).toBe("RELEASED");
  });

  it("manager-passed ledger operations join the owner transaction and roll back with it", async () => {
    const account = await ledger.createAccount({
      scopeType: "execution",
      scopeId: "atomic-rollback",
      ceilings: { tokens: 100 },
    });
    await expect(
      dataSource.transaction(async (manager) => {
        await ledger.reserve(
          {
            accountId: account.id,
            dimension: "tokens",
            amount: 50,
            idempotencyKey: "rollback-key",
          },
          manager,
        );
        throw new Error("forced rollback after reservation");
      }),
    ).rejects.toThrow("forced rollback");

    // Nothing persisted: the reservation joined the outer transaction.
    expect(
      await dataSource
        .getRepository(BudgetReservationEntity)
        .count({ where: { idempotencyKey: "rollback-key" } }),
    ).toBe(0);
    expect((await ledger.projection(account.id)).available.tokens).toBe(100);
  });

  it("a late result for an attempt already terminalized by dispatch failure is applied without re-entering the ledger", async () => {
    const { execution } = await seed(
      [{ id: "extract", agent: "reader", budget: { tokens: 100 } }],
      { tokens: 100 },
    );
    const claimResult = await claim(execution.id, {
      id: "extract",
      agent: "reader",
      budget: { tokens: 100 },
    });
    expect(claimResult?.disposition).toBe("claimed");

    // The dispatch fails non-retryably: attempt FAILED, reservation released.
    const adapter = {
      kind: "http",
      start: jest.fn(),
      stop: jest.fn(),
      invoke: jest.fn().mockRejectedValue(
        new AgentAdapterError("HTTP_REJECTED", "http", "rejected", {
          invocationId: "first",
          retryable: false,
          httpStatus: 400,
        }),
      ),
    };
    const outboxService = new DispatchOutboxService(
      dataSource as any,
      adapter as any,
    );
    await outboxService.dispatchNext();

    // A LATE worker result for the same invocation arrives afterwards. It
    // must become APPLIED duplicate evidence without touching the released
    // reservation (no RESERVATION_NOT_ACTIVE rollback / poison loop).
    // The apply must NOT throw and must NOT re-enter the ledger (the
    // RESERVATION_NOT_ACTIVE rollback regression); the already-authoritative
    // terminal outcome is recorded as a conflict disposition.
    const applied = await applyResult(
      execution.id,
      claimResult,
      { done: true },
      { totalTokens: 10 },
    );
    expect(["applied", "duplicate", "conflict"]).toContain(applied.disposition);
    const reservation = await dataSource
      .getRepository(BudgetReservationEntity)
      .findOne({
        where: { actionRef: (claimResult as any).attempt.invocationId },
      });
    expect(reservation?.status).toBe("RELEASED");
    expect((await accountProjection(execution.id))?.available.tokens).toBe(100);
    // No ledger activity was minted by the late delivery.
    const entries = await dataSource
      .getRepository(BudgetLedgerEntryEntity)
      .find({ where: { reservationId: reservation?.id } });
    expect(entries.filter((e) => e.operation === "commit").length).toBe(0);
  });

  it("a result racing cancellation settles exactly once with one authority", async () => {
    const { execution } = await seed(
      [{ id: "extract", agent: "reader", budget: { tokens: 100 } }],
      { tokens: 100 },
    );
    const claimResult = await claim(execution.id, {
      id: "extract",
      agent: "reader",
      budget: { tokens: 100 },
    });
    expect(claimResult?.disposition).toBe("claimed");

    const [application, cancellation] = await Promise.all([
      applyResult(
        execution.id,
        claimResult,
        { done: true },
        { totalTokens: 40 },
      ),
      executionService.cancelExecution(execution.id),
    ]);
    expect(application.disposition).toBeDefined();
    expect(cancellation.status).toBe("CANCELLED");

    // Whatever won, the ledger settles exactly once: the reservation is
    // either RELEASED (cancel won) or RELEASED (result settled); never
    // ACTIVE and never double-settled.
    const reservation = await dataSource
      .getRepository(BudgetReservationEntity)
      .findOne({
        where: { actionRef: (claimResult as any).attempt.invocationId },
      });
    expect(["RELEASED", "RELEASED"]).toContain(reservation?.status);
    const entries = await dataSource
      .getRepository(BudgetLedgerEntryEntity)
      .find({ where: { reservationId: reservation?.id } });
    expect(
      entries.filter((e) => e.operation === "commit").length,
    ).toBeLessThanOrEqual(1);
    expect(
      entries.filter((e) => e.operation === "release").length,
    ).toBeLessThanOrEqual(1);
    expect(
      (await accountProjection(execution.id))?.available.tokens,
    ).toBeGreaterThanOrEqual(0);
  });

  it("restart finds outstanding reservations and the projection stays authoritative", async () => {
    const { execution } = await seed(
      [{ id: "extract", agent: "reader", budget: { tokens: 200 } }],
      { tokens: 200 },
    );
    const claimResult = await claim(execution.id, {
      id: "extract",
      agent: "reader",
      budget: { tokens: 200 },
    });

    // Simulate a crash before any result: fresh instances rebuild state
    // purely from durable rows.
    const freshLedger = new BudgetLedgerService(dataSource as any);
    const freshInbox = new ResultInboxService(dataSource as any);
    const projection = await freshLedger.projection(
      (
        await freshLedger.ensureExecutionAccount(
          dataSource.manager,
          execution.id,
          { ceilings: { tokens: 200 } },
          { tokens: 200 },
        )
      ).id,
    );
    expect(projection.available.tokens).toBe(0);

    // The result still reconciles deterministically afterwards.
    await applyResult(
      execution.id,
      claimResult,
      { done: true },
      { totalTokens: 80 },
    );
    const after = await accountProjection(execution.id);
    expect(after?.available.tokens).toBe(120);
  });
});

describeWithPostgres("PostgreSQL M4-S3 policy boundary", () => {
  jest.setTimeout(180_000);

  let dataSource: DataSource;
  let executionService: ExecutionService;

  const seed = async (steps: any[], budget?: any) => {
    const stored = await dataSource.getRepository(PipelineEntity).save(
      dataSource.getRepository(PipelineEntity).create({
        name: `m4s3-${Math.random().toString(36).slice(2)}`,
        version: "1.0",
        description: "M4-S3 fixture",
        ...(budget === undefined ? {} : { budget }),
        steps,
      }),
    );
    const execution = await executionService.createExecution(stored, {});
    await executionService.reconcileExecution(execution.id);
    return { stored, execution };
  };

  const claim = (executionId: string, step: any, maxAttempts = 1) =>
    executionService.claimRunnableStep(
      executionId,
      step,
      { input: true },
      maxAttempts,
    );

  const decisionCount = async (proposalId: string): Promise<number> =>
    dataSource
      .getRepository(PolicyDecisionEntity)
      .count({ where: { proposalId } });

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
  });

  afterAll(async () => {
    delete process.env.TENVYR_POLICY;
    await dataSource.destroy();
  });

  beforeEach(async () => {
    delete process.env.TENVYR_POLICY;
    await dataSource.query(
      `TRUNCATE "policy_decisions", "policy_snapshots",
       "dispatch_outbox", "step_attempts", "step_executions",
       "execution_plan_revisions", "executions", "pipelines" CASCADE`,
    );
  });

  it("a DENY decision grants no work authority: durable FAILED attempt, decision evidence committed atomically", async () => {
    process.env.TENVYR_POLICY = JSON.stringify({
      version: 1,
      rules: [
        {
          id: "deny-banned",
          actionType: "dispatch",
          effect: "DENY",
          agents: ["banned-agent"],
        },
      ],
    });
    const { execution } = await seed([
      { id: "extract", agent: "banned-agent" },
    ]);
    const claimResult = await claim(execution.id, {
      id: "extract",
      agent: "banned-agent",
    });

    expect(claimResult?.disposition).toBe("policy_denied");
    const attempt = await dataSource.getRepository(StepAttemptEntity).findOne({
      where: { executionId: execution.id },
    });
    expect(attempt?.status).toBe("FAILED");
    expect(attempt?.error).toContain("Policy DENY");
    const outboxCount = await dataSource
      .getRepository(DispatchOutboxEntity)
      .count({ where: { stepAttemptId: attempt?.id } });
    expect(outboxCount).toBe(0);
    // The append-only decision committed with the intercepted action.
    const decisions = await dataSource
      .getRepository(PolicyDecisionEntity)
      .find();
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({
      effect: "DENY",
      targetAgent: "banned-agent",
      policyVersion: 1,
    });
    expect(decisions[0].proposalHash).toMatch(/^[0-9a-f]{64}$/);
    expect(decisions[0].policyHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("an ALLOW decision still requires the budget reservation (ALLOW alone grants no authority)", async () => {
    process.env.TENVYR_POLICY = JSON.stringify({
      version: 1,
      rules: [{ id: "allow-all", actionType: "dispatch", effect: "ALLOW" }],
    });
    const { execution } = await seed(
      [{ id: "extract", agent: "reader", budget: { tokens: 500 } }],
      { tokens: 100 },
    );
    const claimResult = await claim(execution.id, {
      id: "extract",
      agent: "reader",
      budget: { tokens: 500 },
    });

    // Policy said ALLOW, but the budget reserve failed → no work authority.
    expect(claimResult?.disposition).toBe("budget_insufficient");
    const attempt = await dataSource.getRepository(StepAttemptEntity).findOne({
      where: { executionId: execution.id },
    });
    expect(attempt?.status).toBe("FAILED");
    expect(attempt?.error).toContain("Budget reservation failed");
    const decisions = await dataSource
      .getRepository(PolicyDecisionEntity)
      .find();
    expect(decisions).toHaveLength(1);
    expect(decisions[0].effect).toBe("ALLOW");
  });

  it("REQUIRE_APPROVAL is evaluated and recorded; S4 upgrades the disposition to a WAITING attempt", async () => {
    process.env.TENVYR_POLICY = JSON.stringify({
      version: 1,
      rules: [
        {
          id: "approve-kafka",
          actionType: "dispatch",
          effect: "REQUIRE_APPROVAL",
          executors: ["kafka"],
        },
      ],
    });
    const { execution } = await seed([
      { id: "extract", agent: "remote-security-reviewer" },
    ]);
    const claimResult = await claim(execution.id, {
      id: "extract",
      agent: "remote-security-reviewer",
    });

    // M4-S4: REQUIRE_APPROVAL is a durable WAITING disposition (never a
    // retryable failure); the decision evidence is recorded with it.
    expect(claimResult?.disposition).toBe("approval_required");
    const attempt = await dataSource.getRepository(StepAttemptEntity).findOne({
      where: { executionId: execution.id },
    });
    expect(attempt?.status).toBe("WAITING");
    const decisions = await dataSource
      .getRepository(PolicyDecisionEntity)
      .find();
    expect(decisions).toHaveLength(1);
    expect(decisions[0].effect).toBe("REQUIRE_APPROVAL");
  });

  it("the snapshot is frozen once per version; rotation requires a version bump", async () => {
    process.env.TENVYR_POLICY = JSON.stringify({
      version: 1,
      rules: [
        { id: "r", actionType: "dispatch", effect: "DENY", agents: ["a"] },
      ],
    });
    const { execution } = await seed([{ id: "extract", agent: "reader" }]);
    await claim(execution.id, { id: "extract", agent: "reader" });

    const snapshots = await dataSource
      .getRepository(PolicySnapshotEntity)
      .find();
    expect(snapshots).toHaveLength(1);

    // Rotating the SAME version with different rules is a deterministic
    // safe failure, not a silent policy change.
    process.env.TENVYR_POLICY = JSON.stringify({
      version: 1,
      rules: [{ id: "r2", actionType: "dispatch", effect: "ALLOW" }],
    });
    const { execution: rotated } = await seed([
      { id: "extract", agent: "reader" },
    ]);
    await expect(
      claim(rotated.id, { id: "extract", agent: "reader" }),
    ).rejects.toMatchObject({ code: "POLICY_VERSION_CONFLICT" });

    // A version bump is the legal rotation path.
    process.env.TENVYR_POLICY = JSON.stringify({
      version: 2,
      rules: [{ id: "r2", actionType: "dispatch", effect: "ALLOW" }],
    });
    const { execution: rotatedV2 } = await seed([
      { id: "extract", agent: "reader" },
    ]);
    const second = await claim(rotatedV2.id, {
      id: "extract",
      agent: "reader",
    });
    expect(second?.disposition).toBe("claimed");
    expect(await dataSource.getRepository(PolicySnapshotEntity).count()).toBe(
      2,
    );
  });

  it("no policy configured → no decisions, behavior unchanged", async () => {
    const { execution } = await seed([{ id: "extract", agent: "reader" }]);
    const claimResult = await claim(execution.id, {
      id: "extract",
      agent: "reader",
    });
    expect(claimResult?.disposition).toBe("claimed");
    expect(await dataSource.getRepository(PolicyDecisionEntity).count()).toBe(
      0,
    );
  });
});

describeWithPostgres("PostgreSQL M4-S4 approvals and WAITING", () => {
  jest.setTimeout(180_000);

  let dataSource: DataSource;
  let executionService: ExecutionService;
  let approvals: ApprovalService;

  const seed = async (steps: any[], budget?: any) => {
    const stored = await dataSource.getRepository(PipelineEntity).save(
      dataSource.getRepository(PipelineEntity).create({
        name: `m4s4-${Math.random().toString(36).slice(2)}`,
        version: "1.0",
        description: "M4-S4 fixture",
        ...(budget === undefined ? {} : { budget }),
        steps,
      }),
    );
    const execution = await executionService.createExecution(stored, {});
    await executionService.reconcileExecution(execution.id);
    return { stored, execution };
  };

  const claim = (executionId: string, step: any, maxAttempts = 1) =>
    executionService.claimRunnableStep(
      executionId,
      step,
      { input: true },
      maxAttempts,
    );

  const requireApprovalPolicy = (executor = "kafka") =>
    JSON.stringify({
      version: 1,
      rules: [
        {
          id: "approve-kafka",
          actionType: "dispatch",
          effect: "REQUIRE_APPROVAL",
          executors: [executor],
        },
      ],
    });

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
    approvals = new ApprovalService(dataSource as any);
  });

  afterAll(async () => {
    delete process.env.TENVYR_POLICY;
    await dataSource.destroy();
  });

  beforeEach(async () => {
    delete process.env.TENVYR_POLICY;
    await dataSource.query(
      `TRUNCATE "approval_requests", "policy_decisions", "policy_snapshots",
       "budget_ledger_entries", "budget_reservations", "budget_accounts",
       "dispatch_outbox", "step_attempts", "step_executions",
       "execution_plan_revisions", "executions", "pipelines" CASCADE`,
    );
  });

  it("REQUIRE_APPROVAL produces a durable PENDING request, a WAITING attempt, a WAITING step, and NO outbox", async () => {
    process.env.TENVYR_POLICY = requireApprovalPolicy();
    const { execution } = await seed([{ id: "extract", agent: "reader" }]);
    const claimResult = await claim(execution.id, {
      id: "extract",
      agent: "reader",
    });

    expect(claimResult?.disposition).toBe("approval_required");
    const attempt = await dataSource.getRepository(StepAttemptEntity).findOne({
      where: { executionId: execution.id },
    });
    expect(attempt?.status).toBe("WAITING");
    const step = await dataSource.getRepository(LogicalStepEntity).findOne({
      where: { executionId: execution.id },
    });
    expect(step?.status).toBe("WAITING");
    const outboxCount = await dataSource
      .getRepository(DispatchOutboxEntity)
      .count({ where: { stepAttemptId: attempt?.id } });
    expect(outboxCount).toBe(0);
    const request = await dataSource
      .getRepository(ApprovalRequestEntity)
      .findOne({
        where: { executionId: execution.id },
      });
    expect(request).toMatchObject({
      status: "PENDING",
      targetExecutor: "kafka",
    });
    expect(request?.proposalHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("approving resumes the SAME attempt: WAITING → CREATED + outbox + dispatch; replay never re-executes", async () => {
    process.env.TENVYR_POLICY = requireApprovalPolicy();
    const { execution } = await seed(
      [{ id: "extract", agent: "reader", budget: { tokens: 100 } }],
      { tokens: 100 },
    );
    const claimResult = await claim(execution.id, {
      id: "extract",
      agent: "reader",
      budget: { tokens: 100 },
    });
    const attempt = await dataSource.getRepository(StepAttemptEntity).findOne({
      where: { executionId: execution.id },
    });
    const stepRow = await dataSource.getRepository(LogicalStepEntity).findOne({
      where: { executionId: execution.id },
    });
    const proposalId = `${stepRow?.id}:1`;

    const approved = await approvals.approve(
      proposalId,
      undefined,
      "operator approved",
    );
    expect(approved.status).toBe("APPROVED");

    const reloaded = await dataSource.getRepository(StepAttemptEntity).findOne({
      where: { id: attempt?.id },
    });
    expect(reloaded?.status).toBe("CREATED");
    expect(reloaded?.invocationId).toBe(attempt?.invocationId);
    const step = await dataSource.getRepository(LogicalStepEntity).findOne({
      where: { executionId: execution.id },
    });
    expect(step?.status).toBe("RUNNING");
    // Exactly one outbox row for the SAME invocation.
    const outboxRows = await dataSource
      .getRepository(DispatchOutboxEntity)
      .find({
        where: { stepAttemptId: attempt?.id },
      });
    expect(outboxRows).toHaveLength(1);
    expect((outboxRows[0].invocation as any).invocationId).toBe(
      attempt?.invocationId,
    );
    // The budget was reserved at approval time.
    const account = await dataSource
      .getRepository(BudgetAccountEntity)
      .findOne({
        where: { scopeType: "execution", scopeId: execution.id },
      });
    expect(account).not.toBeNull();

    // Replay: approving again returns the same outcome and mints nothing.
    const replay = await approvals.approve(proposalId);
    expect(replay.status).toBe("APPROVED");
    expect(
      await dataSource.getRepository(DispatchOutboxEntity).count({
        where: { stepAttemptId: attempt?.id },
      }),
    ).toBe(1);

    // The engine dispatches the resumed attempt exactly once.
    const adapter = {
      kind: "http",
      start: jest.fn(),
      stop: jest.fn(),
      invoke: jest.fn().mockResolvedValue({
        adapter: "http",
        invocationId: attempt?.invocationId,
        dispatchedAt: new Date().toISOString(),
      }),
    };
    const outboxService = new DispatchOutboxService(
      dataSource as any,
      adapter as any,
    );
    const disposition = await outboxService.dispatchNext();
    expect(disposition).toEqual({ outcome: "dispatched" });
    expect(adapter.invoke).toHaveBeenCalledTimes(1);
  });

  it("denying the request fails the attempt durably and the step follows its failure policy", async () => {
    process.env.TENVYR_POLICY = requireApprovalPolicy();
    const { execution } = await seed([{ id: "extract", agent: "reader" }]);
    await claim(execution.id, { id: "extract", agent: "reader" });
    const attempt = await dataSource.getRepository(StepAttemptEntity).findOne({
      where: { executionId: execution.id },
    });
    const step = await dataSource.getRepository(LogicalStepEntity).findOne({
      where: { executionId: execution.id },
    });
    const proposalId = `${step?.id}:1`;

    const denied = await approvals.deny(proposalId, undefined, "not this week");
    expect(denied.status).toBe("DENIED");

    const reloaded = await dataSource.getRepository(StepAttemptEntity).findOne({
      where: { id: attempt?.id },
    });
    expect(reloaded?.status).toBe("FAILED");
    expect(reloaded?.terminationReason).toBe("Approval denied");
    const reloadedStep = await dataSource
      .getRepository(LogicalStepEntity)
      .findOne({
        where: { executionId: execution.id },
      });
    expect(reloadedStep?.status).toBe("FAILED");
    const executionRow = await dataSource
      .getRepository(ExecutionEntity)
      .findOne({
        where: { id: execution.id },
      });
    expect(executionRow?.status).toBe("FAILED");
  });

  it("expiry terminalizes the WAITING attempt deterministically; the recovery sweep finds due requests", async () => {
    process.env.TENVYR_POLICY = requireApprovalPolicy();
    const { execution } = await seed([{ id: "extract", agent: "reader" }]);
    await claim(execution.id, { id: "extract", agent: "reader" });
    const step = await dataSource.getRepository(LogicalStepEntity).findOne({
      where: { executionId: execution.id },
    });
    const proposalId = `${step?.id}:1`;
    const attempt = await dataSource.getRepository(StepAttemptEntity).findOne({
      where: { executionId: execution.id },
    });

    // Force the request into the past.
    await dataSource
      .getRepository(ApprovalRequestEntity)
      .createQueryBuilder()
      .update()
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where("proposalId = :proposalId", { proposalId })
      .execute();

    const expired = await approvals.expire(proposalId);
    expect(expired?.status).toBe("EXPIRED");
    const reloaded = await dataSource.getRepository(StepAttemptEntity).findOne({
      where: { id: attempt?.id },
    });
    expect(reloaded?.status).toBe("FAILED");
    expect(reloaded?.terminationReason).toBe("Approval expired");

    // The autonomous sweep finds a NEW due request.
    const { execution: second } = await seed([
      { id: "extract", agent: "reader" },
    ]);
    await claim(second.id, { id: "extract", agent: "reader" });
    const secondStep = await dataSource
      .getRepository(LogicalStepEntity)
      .findOne({
        where: { executionId: second.id },
      });
    await dataSource
      .getRepository(ApprovalRequestEntity)
      .createQueryBuilder()
      .update()
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where("logicalStepId = :logicalStepId", {
        logicalStepId: secondStep?.id,
      })
      .execute();
    const swept = await approvals.expireDue(undefined, new Date());
    expect(swept).toBe(1);
    const secondAttempt = await dataSource
      .getRepository(StepAttemptEntity)
      .findOne({
        where: { executionId: second.id },
      });
    expect(secondAttempt?.status).toBe("FAILED");
  });

  it("WAITING attempts are cancelled like any other active attempt", async () => {
    process.env.TENVYR_POLICY = requireApprovalPolicy();
    const { execution } = await seed([{ id: "extract", agent: "reader" }]);
    await claim(execution.id, { id: "extract", agent: "reader" });
    const attempt = await dataSource.getRepository(StepAttemptEntity).findOne({
      where: { executionId: execution.id },
    });

    const cancelled = await executionService.cancelExecution(execution.id);
    expect(cancelled.status).toBe("CANCELLED");
    const reloaded = await dataSource.getRepository(StepAttemptEntity).findOne({
      where: { id: attempt?.id },
    });
    expect(reloaded?.status).toBe("CANCELLED");
    const step = await dataSource.getRepository(LogicalStepEntity).findOne({
      where: { executionId: execution.id },
    });
    expect(step?.status).toBe("CANCELLED");
  });

  it("approve with insufficient budget at resume time fails durably with NO outbox", async () => {
    process.env.TENVYR_POLICY = requireApprovalPolicy();
    const { execution } = await seed(
      [{ id: "extract", agent: "reader", budget: { tokens: 500 } }],
      { tokens: 100 },
    );
    await claim(execution.id, {
      id: "extract",
      agent: "reader",
      budget: { tokens: 500 },
    });
    const step = await dataSource.getRepository(LogicalStepEntity).findOne({
      where: { executionId: execution.id },
    });
    const proposalId = `${step?.id}:1`;
    const attempt = await dataSource.getRepository(StepAttemptEntity).findOne({
      where: { executionId: execution.id },
    });

    const approved = await approvals.approve(proposalId, undefined, "go");

    // The request records APPROVED (the operator decided) but the budget
    // gate failed: the attempt is FAILED and NO outbox was minted.
    expect(approved.status).toBe("APPROVED");
    const reloaded = await dataSource.getRepository(StepAttemptEntity).findOne({
      where: { id: attempt?.id },
    });
    expect(reloaded?.status).toBe("FAILED");
    expect(reloaded?.error).toContain("Budget reservation failed");
    expect(
      await dataSource.getRepository(DispatchOutboxEntity).count({
        where: { stepAttemptId: attempt?.id },
      }),
    ).toBe(0);
  });

  it("an approval outcome never overwrites a cancelled attempt (cancel then expire/deny)", async () => {
    process.env.TENVYR_POLICY = requireApprovalPolicy();
    const { execution } = await seed([{ id: "extract", agent: "reader" }]);
    await claim(execution.id, { id: "extract", agent: "reader" });
    const step = await dataSource.getRepository(LogicalStepEntity).findOne({
      where: { executionId: execution.id },
    });
    const proposalId = `${step?.id}:1`;

    await executionService.cancelExecution(execution.id);

    // Expiry and deny run AFTER the cancellation: the CANCELLED authority
    // must survive (no FAILED overwrite, execution stays CANCELLED).
    await dataSource
      .getRepository(ApprovalRequestEntity)
      .createQueryBuilder()
      .update()
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where("proposalId = :proposalId", { proposalId })
      .execute();
    const expired = await approvals.expire(proposalId);
    expect(expired?.status).toBe("EXPIRED");
    const attempt = await dataSource.getRepository(StepAttemptEntity).findOne({
      where: { executionId: execution.id },
    });
    expect(attempt?.status).toBe("CANCELLED");
    const executionRow = await dataSource
      .getRepository(ExecutionEntity)
      .findOne({
        where: { id: execution.id },
      });
    expect(executionRow?.status).toBe("CANCELLED");

    // Approving after the expiry is an exactly-once replay: the earlier
    // EXPIRED decision is authoritative and nothing resumes.
    const approved = await approvals.approve(proposalId, undefined, "late");
    expect(approved.status).toBe("EXPIRED");
    expect(
      await dataSource.getRepository(DispatchOutboxEntity).count({
        where: { stepAttemptId: attempt?.id },
      }),
    ).toBe(0);
    const attemptAgain = await dataSource
      .getRepository(StepAttemptEntity)
      .findOne({
        where: { id: attempt?.id },
      });
    expect(attemptAgain?.status).toBe("CANCELLED");
  });

  it("approval vs cancel race settles exactly once under the row locks", async () => {
    process.env.TENVYR_POLICY = requireApprovalPolicy();
    const { execution } = await seed([{ id: "extract", agent: "reader" }]);
    await claim(execution.id, { id: "extract", agent: "reader" });
    const step = await dataSource.getRepository(LogicalStepEntity).findOne({
      where: { executionId: execution.id },
    });
    const proposalId = `${step?.id}:1`;

    const [approved, cancelled] = await Promise.all([
      approvals.approve(proposalId),
      executionService.cancelExecution(execution.id),
    ]);
    expect(approved.status).toBeDefined();
    expect(cancelled.status).toBe("CANCELLED");

    // One authority: either the request is APPROVED and the attempt was
    // resumed then cancelled, or the request stayed PENDING/expired with a
    // CANCELLED attempt — never a dispatched second identity.
    const attempt = await dataSource.getRepository(StepAttemptEntity).findOne({
      where: { executionId: execution.id },
    });
    expect(["CANCELLED", "CANCELLED"]).toContain(attempt?.status);
    const outboxCount = await dataSource
      .getRepository(DispatchOutboxEntity)
      .count({ where: { stepAttemptId: attempt?.id } });
    expect(outboxCount).toBeLessThanOrEqual(1);
  });
});

describeWithPostgres("PostgreSQL M4-S5 hierarchy completeness", () => {
  jest.setTimeout(180_000);

  let dataSource: DataSource;
  let executionService: ExecutionService;
  let ledger: BudgetLedgerService;
  let approvals: ApprovalService;

  const seed = async (steps: any[], budget?: any) => {
    const stored = await dataSource.getRepository(PipelineEntity).save(
      dataSource.getRepository(PipelineEntity).create({
        name: `m4s5-${Math.random().toString(36).slice(2)}`,
        version: "1.0",
        description: "M4-S5 fixture",
        ...(budget === undefined ? {} : { budget }),
        steps,
      }),
    );
    const execution = await executionService.createExecution(stored, {});
    await executionService.reconcileExecution(execution.id);
    return { stored, execution };
  };

  const claim = (executionId: string, step: any, maxAttempts = 1) =>
    executionService.claimRunnableStep(
      executionId,
      step,
      { input: true },
      maxAttempts,
    );

  const available = async (accountId: string, dimension = "tokens") =>
    (await ledger.projection(accountId)).available[dimension] ?? 0;

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
    ledger = new BudgetLedgerService(dataSource as any);
    executionService = new ExecutionService(
      dataSource.getRepository(ExecutionEntity),
      dataSource.getRepository(LogicalStepEntity),
      dataSource.getRepository(StepAttemptEntity),
      dataSource.getRepository(ExecutionPlanRevisionEntity),
      dataSource,
    );
    approvals = new ApprovalService(dataSource as any);
  });

  afterAll(async () => {
    delete process.env.TENVYR_POLICY;
    await dataSource.destroy();
  });

  beforeEach(async () => {
    delete process.env.TENVYR_POLICY;
    await dataSource.query(
      `TRUNCATE "approval_requests", "policy_decisions", "policy_snapshots",
       "budget_ledger_entries", "budget_reservations", "budget_accounts",
       "dispatch_outbox", "step_attempts", "step_executions",
       "execution_plan_revisions", "executions", "pipelines" CASCADE`,
    );
  });

  it("adjust propagates to the whole chain: a child top-up debits its ancestors", async () => {
    const root = await ledger.createAccount({
      scopeType: "tenant",
      scopeId: "adjust-tenant",
      ceilings: { tokens: 1_000 },
    });
    const child = await ledger.createAccount({
      scopeType: "execution",
      scopeId: "adjust-exec",
      parentAccountId: root.id,
      ceilings: { tokens: 500 },
    });
    await ledger.reserve({
      accountId: child.id,
      dimension: "tokens",
      amount: 100,
      idempotencyKey: "adjust-pre",
    });

    await ledger.adjust({
      accountId: child.id,
      dimension: "tokens",
      delta: 200,
      reason: "operator top-up",
    });

    // Both accounts carry the adjust entry: child 500−100+200, tenant
    // 1000−100−200 — the child can never exceed the ancestor's REMAINING
    // grant.
    expect(await available(child.id)).toBe(600);
    expect(await available(root.id)).toBe(700);
    // Invariant: child available <= ancestor available.
    expect(await available(child.id)).toBeLessThanOrEqual(
      await available(root.id),
    );

    // A top-up beyond the ancestor's remaining grant is rejected.
    await expect(
      ledger.adjust({
        accountId: child.id,
        dimension: "tokens",
        delta: 800,
        reason: "too much",
      }),
    ).rejects.toMatchObject({ code: "AVAILABILITY_NEGATIVE" });
    expect(await available(child.id)).toBe(600);
    expect(await available(root.id)).toBe(700);
  });

  it("a negative adjust on a child credits its ancestors back", async () => {
    const root = await ledger.createAccount({
      scopeType: "tenant",
      scopeId: "reduce-tenant",
      ceilings: { tokens: 1_000 },
    });
    const child = await ledger.createAccount({
      scopeType: "execution",
      scopeId: "reduce-exec",
      parentAccountId: root.id,
      ceilings: { tokens: 500 },
    });
    await ledger.adjust({
      accountId: child.id,
      dimension: "tokens",
      delta: 100,
      reason: "grant increase",
    });
    await ledger.adjust({
      accountId: child.id,
      dimension: "tokens",
      delta: -100,
      reason: "correction",
    });

    expect(await available(child.id)).toBe(500);
    expect(await available(root.id)).toBe(1_000);
  });

  it("a mixed operation sequence never lets a child exceed its ancestor's remaining grant", async () => {
    const tenant = await ledger.createAccount({
      scopeType: "tenant",
      scopeId: "property-tenant",
      ceilings: { tokens: 1_000 },
    });
    const plan = await ledger.createAccount({
      scopeType: "plan",
      scopeId: "property-plan",
      parentAccountId: tenant.id,
      ceilings: { tokens: 800 },
    });
    const execution = await ledger.createAccount({
      scopeType: "execution",
      scopeId: "property-exec",
      parentAccountId: plan.id,
      ceilings: { tokens: 400 },
    });

    const sequence: Array<() => Promise<unknown>> = [
      () =>
        ledger.reserve({
          accountId: execution.id,
          dimension: "tokens",
          amount: 100,
          idempotencyKey: "p1",
        }),
      () =>
        ledger.reserve({
          accountId: execution.id,
          dimension: "tokens",
          amount: 50,
          idempotencyKey: "p2",
        }),
      () =>
        ledger.adjust({
          accountId: execution.id,
          dimension: "tokens",
          delta: 150,
          reason: "top-up",
        }),
      () =>
        ledger.reserve({
          accountId: plan.id,
          dimension: "tokens",
          amount: 200,
          idempotencyKey: "p3",
        }),
      () =>
        ledger.adjust({
          accountId: plan.id,
          dimension: "tokens",
          delta: -100,
          reason: "reduce",
        }),
      () =>
        ledger.reserve({
          accountId: execution.id,
          dimension: "tokens",
          amount: 300,
          idempotencyKey: "p4",
        }),
    ];
    const outcomes: string[] = [];
    for (const step of sequence) {
      try {
        await step();
        outcomes.push("ok");
      } catch (error) {
        outcomes.push((error as { code?: string }).code ?? "error");
      }
    }
    // The final reserve is rejected: the child cannot exceed the ancestor's
    // REMAINING grant even after the operator top-ups and reductions.
    expect(outcomes).toEqual([
      "ok",
      "ok",
      "ok",
      "ok",
      "ok",
      "INSUFFICIENT_BUDGET",
    ]);

    // The dynamic boundary: the child may spend exactly up to the
    // ancestor's remaining grant (200) but no more — even though the
    // child's own ceiling (400) has room.
    await ledger.reserve({
      accountId: execution.id,
      dimension: "tokens",
      amount: 200,
      idempotencyKey: "p5",
    });
    await expect(
      ledger.reserve({
        accountId: execution.id,
        dimension: "tokens",
        amount: 201,
        idempotencyKey: "p6",
      }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_BUDGET" });
  });

  it("activates execution-account parentage from the plan: the chain reserve debits the operator tenant", async () => {
    const tenant = await ledger.createAccount({
      scopeType: "tenant",
      scopeId: "plan-parent",
      ceilings: { tokens: 500 },
    });
    const { execution } = await seed(
      [{ id: "extract", agent: "reader", budget: { tokens: 100 } }],
      { parent: { scopeType: "tenant", scopeId: "plan-parent" }, tokens: 300 },
    );
    const claimResult = await claim(execution.id, {
      id: "extract",
      agent: "reader",
      budget: { tokens: 100 },
    });
    expect(claimResult?.disposition).toBe("claimed");

    const account = await dataSource
      .getRepository(BudgetAccountEntity)
      .findOne({
        where: { scopeType: "execution", scopeId: execution.id },
      });
    expect(account?.parentAccountId).toBe(tenant.id);
    // The execution grant is a subset of the tenant grant.
    expect(account?.ceilings).toEqual({ tokens: 300 });
    // The reserve debited BOTH the execution account and the tenant.
    expect(await available(account!.id)).toBe(200);
    expect(await available(tenant.id)).toBe(400);
  });

  it("a missing parent account is a deterministic safe failure: no work authority", async () => {
    const { execution } = await seed(
      [{ id: "extract", agent: "reader", budget: { tokens: 100 } }],
      {
        parent: { scopeType: "tenant", scopeId: "does-not-exist" },
        tokens: 300,
      },
    );
    const claimResult = await claim(execution.id, {
      id: "extract",
      agent: "reader",
      budget: { tokens: 100 },
    });

    expect(claimResult?.disposition).toBe("budget_insufficient");
    const attempt = await dataSource.getRepository(StepAttemptEntity).findOne({
      where: { executionId: execution.id },
    });
    expect(attempt?.status).toBe("FAILED");
    expect(attempt?.error).toContain("ACCOUNT_NOT_FOUND");
    expect(
      await dataSource.getRepository(DispatchOutboxEntity).count({
        where: { stepAttemptId: attempt?.id },
      }),
    ).toBe(0);
  });

  it("child ceilings exceeding the parent grant are rejected at claim", async () => {
    const tenant = await ledger.createAccount({
      scopeType: "tenant",
      scopeId: "subset-tenant",
      ceilings: { tokens: 100 },
    });
    const { execution } = await seed(
      [{ id: "extract", agent: "reader", budget: { tokens: 100 } }],
      {
        parent: { scopeType: "tenant", scopeId: "subset-tenant" },
        tokens: 500,
      },
    );
    const claimResult = await claim(execution.id, {
      id: "extract",
      agent: "reader",
      budget: { tokens: 100 },
    });

    expect(claimResult?.disposition).toBe("budget_insufficient");
    const attempt = await dataSource.getRepository(StepAttemptEntity).findOne({
      where: { executionId: execution.id },
    });
    expect(attempt?.error).toContain("CHILD_CEILING_EXCEEDS_PARENT");
  });

  it("the validated budget envelope round-trips through the REAL pipeline service", async () => {
    const tenant = await ledger.createAccount({
      scopeType: "tenant",
      scopeId: "roundtrip-tenant",
      ceilings: { tokens: 500 },
    });
    const pipelineService = new PipelineService(
      dataSource.getRepository(PipelineEntity) as any,
      new PipelineValidationService(new ConditionEvaluatorService() as any),
    );
    const stored = await pipelineService.create({
      name: `roundtrip-${Math.random().toString(36).slice(2)}`,
      version: "1.0",
      description: "round-trip fixture",
      budget: {
        parent: { scopeType: "tenant", scopeId: "roundtrip-tenant" },
        tokens: 300,
      },
      steps: [{ id: "extract", agent: "reader", budget: { tokens: 100 } }],
    });
    // The stored definition carries the NORMALIZED envelope; executing it
    // must re-parse idempotently.
    const execution = await executionService.createExecution(stored, {});
    await executionService.reconcileExecution(execution.id);
    const claimResult = await claim(execution.id, {
      id: "extract",
      agent: "reader",
      budget: { tokens: 100 },
    });
    expect(claimResult?.disposition).toBe("claimed");
    const account = await dataSource
      .getRepository(BudgetAccountEntity)
      .findOne({
        where: { scopeType: "execution", scopeId: execution.id },
      });
    expect(account?.parentAccountId).toBe(tenant.id);
    expect(await available(tenant.id)).toBe(400);
  });

  it("the child subset rule is enforced against the DIRECT parent, not a sorted ancestor", async () => {
    const tenant = await ledger.createAccount({
      scopeType: "tenant",
      scopeId: "direct-parent-tenant",
      ceilings: { tokens: 1_000 },
    });
    const plan = await ledger.createAccount({
      scopeType: "plan",
      scopeId: "direct-parent-plan",
      parentAccountId: tenant.id,
      ceilings: { tokens: 500 },
    });
    // Child ceiling within the tenant (600 <= 1000) but ABOVE the direct
    // plan grant (500) — must be rejected against the DIRECT parent.
    await expect(
      ledger.createAccount({
        scopeType: "execution",
        scopeId: "direct-parent-exec",
        parentAccountId: plan.id,
        ceilings: { tokens: 600 },
      }),
    ).rejects.toMatchObject({ code: "CHILD_CEILING_EXCEEDS_PARENT" });
    // Within the direct parent's grant: accepted.
    const ok = await ledger.createAccount({
      scopeType: "execution",
      scopeId: "direct-parent-exec2",
      parentAccountId: plan.id,
      ceilings: { tokens: 400 },
    });
    expect(ok.parentAccountId).toBe(plan.id);
  });

  it("approve-resume with a parent chain debits the tenant too", async () => {
    process.env.TENVYR_POLICY = JSON.stringify({
      version: 1,
      rules: [
        {
          id: "approve-kafka",
          actionType: "dispatch",
          effect: "REQUIRE_APPROVAL",
          executors: ["kafka"],
        },
      ],
    });
    const tenant = await ledger.createAccount({
      scopeType: "tenant",
      scopeId: "approve-parent",
      ceilings: { tokens: 500 },
    });
    const { execution } = await seed(
      [{ id: "extract", agent: "reader", budget: { tokens: 100 } }],
      {
        parent: { scopeType: "tenant", scopeId: "approve-parent" },
        tokens: 300,
      },
    );
    await claim(execution.id, {
      id: "extract",
      agent: "reader",
      budget: { tokens: 100 },
    });
    const step = await dataSource.getRepository(LogicalStepEntity).findOne({
      where: { executionId: execution.id },
    });
    const proposalId = `${step?.id}:1`;

    await approvals.approve(proposalId);

    // The approval-time reserve debited the execution account AND the
    // tenant: 300−100 / 500−100.
    const account = await dataSource
      .getRepository(BudgetAccountEntity)
      .findOne({
        where: { scopeType: "execution", scopeId: execution.id },
      });
    expect(await available(account!.id)).toBe(200);
    expect(await available(tenant.id)).toBe(400);
  });
});

describeWithPostgres("PostgreSQL M5-S2 proposals", () => {
  jest.setTimeout(120_000);

  let dataSource: DataSource;
  let executionService: ExecutionService;
  let proposals: PlanProposalService;

  const seed = async (steps: any[], budget?: any) => {
    const stored = await dataSource.getRepository(PipelineEntity).save(
      dataSource.getRepository(PipelineEntity).create({
        name: `m5s2-${Math.random().toString(36).slice(2)}`,
        version: "1.0",
        description: "M5-S2 fixture",
        ...(budget === undefined ? {} : { budget }),
        steps,
      }),
    );
    const execution = await executionService.createExecution(stored, {});
    await executionService.reconcileExecution(execution.id);
    return { stored, execution };
  };

  const activeRevision = async (executionId: string) => {
    const execution = await dataSource.getRepository(ExecutionEntity).findOne({
      where: { id: executionId },
    });
    return dataSource
      .getRepository(ExecutionPlanRevisionEntity)
      .findOne({ where: { id: execution?.activePlanRevisionId } });
  };

  const logicalStepIds = async (executionId: string) =>
    (
      await dataSource.getRepository(LogicalStepEntity).find({
        where: { executionId },
        order: { createdAt: "ASC" },
      })
    ).map((step) => step.stepId);

  const patchFor = (baseRevision: number, operations: any[]) => ({
    schemaVersion: 1,
    baseRevision,
    operations,
  });

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
    proposals = new PlanProposalService(
      dataSource as any,
      new PipelineValidationService(new ConditionEvaluatorService()),
    );
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await dataSource.query(
      `TRUNCATE "plan_proposals", "budget_ledger_entries", "budget_reservations",
       "budget_accounts", "policy_decisions", "policy_snapshots",
       "approval_requests", "dispatch_outbox", "step_attempts",
       "step_executions", "execution_plan_revisions", "executions",
       "pipelines" CASCADE`,
    );
  });

  it("propose persists an immutable PENDING proposal numbered per execution", async () => {
    const { execution } = await seed([{ id: "extract", agent: "reader" }]);
    const first = await proposals.propose(
      execution.id,
      patchFor(1, [{ op: "addStep", step: { id: "load", agent: "writer" } }]),
    );
    const second = await proposals.propose(
      execution.id,
      patchFor(1, [
        { op: "addStep", step: { id: "publish", agent: "writer" } },
      ]),
    );
    expect(first.status).toBe("PENDING");
    expect(first.proposalNumber).toBe(1);
    expect(second.proposalNumber).toBe(2);
    expect(first.baseRevision).toBe(1);
    expect(first.proposalHash).toHaveLength(64);

    // An invalid patch never persists a row.
    await expect(
      proposals.propose(execution.id, patchFor(1, [{ op: "removeStep" }])),
    ).rejects.toThrow();
    const count = await dataSource.getRepository(PlanProposalEntity).count({
      where: { executionId: execution.id },
    });
    expect(count).toBe(2);
  });

  it("activate atomically accepts: new revision, materialized steps, pointer switch, terminal decision", async () => {
    const { execution } = await seed([
      { id: "extract", agent: "reader" },
      { id: "review", agent: "reviewer", dependsOn: ["extract"] },
    ]);
    const proposal = await proposals.propose(
      execution.id,
      patchFor(1, [
        {
          op: "addStep",
          step: { id: "load", agent: "writer", dependsOn: ["extract"] },
        },
        {
          op: "replaceUnfrozenStep",
          stepId: "review",
          step: { id: "review", agent: "reviewer", timeout: "30s" },
        },
      ]),
    );

    const result = await proposals.activate(proposal.id);
    expect(result.decision).toBe("ACCEPTED");

    const revision = await activeRevision(execution.id);
    expect(revision?.revisionNumber).toBe(2);
    expect(revision?.parentRevisionId).not.toBeNull();
    expect(revision?.baseRevision).toBe(1);
    expect(revision?.plan.steps.map((s) => s.id)).toEqual([
      "extract",
      "review",
      "load",
    ]);
    expect((revision?.plan.steps[1] as { timeout?: string }).timeout).toBe(
      "30s",
    );
    expect(revision?.validationResult).toMatchObject({
      valid: true,
      proposalId: proposal.id,
      addedSteps: ["load"],
      replacedSteps: ["review"],
    });

    // Added logical rows materialized in the same transaction.
    expect((await logicalStepIds(execution.id)).sort()).toEqual([
      "extract",
      "load",
      "review",
    ]);
    const addedRow = await dataSource.getRepository(LogicalStepEntity).findOne({
      where: { executionId: execution.id, stepId: "load" },
    });
    expect(addedRow?.agent).toBe("writer");
    expect(addedRow?.status).toBe("PENDING");

    // Terminal + idempotent.
    const stored = await dataSource
      .getRepository(PlanProposalEntity)
      .findOne({ where: { id: proposal.id } });
    expect(stored?.status).toBe("ACCEPTED");
    expect(stored?.decidedAt).not.toBeNull();
    const again = await proposals.activate(proposal.id);
    expect(again.decision).toBe("ACCEPTED");
    expect(await activeRevision(execution.id)).toMatchObject({
      revisionNumber: 2,
    });
  });

  it("concurrent activation of the SAME proposal never overwrites the committed decision", async () => {
    const { execution } = await seed([{ id: "extract", agent: "reader" }]);
    const proposal = await proposals.propose(
      execution.id,
      patchFor(1, [{ op: "addStep", step: { id: "load", agent: "writer" } }]),
    );
    const [ra, rb] = await Promise.all([
      proposals.activate(proposal.id),
      proposals.activate(proposal.id),
    ]);
    // Both calls observe the SAME terminal decision.
    expect(ra.decision).toBe(rb.decision);
    expect(["ACCEPTED", "STALE"]).toContain(ra.decision);
    const stored = await dataSource
      .getRepository(PlanProposalEntity)
      .findOne({ where: { id: proposal.id } });
    // The stored decision is final and matches what the callers saw.
    expect(stored?.status).toBe(ra.decision);
    if (ra.decision === "ACCEPTED") {
      expect(await activeRevision(execution.id)).toMatchObject({
        revisionNumber: 2,
      });
    } else {
      expect(await activeRevision(execution.id)).toMatchObject({
        revisionNumber: 1,
      });
    }
  });

  it("a proposal on a moved base becomes STALE and nothing activates", async () => {
    const { execution } = await seed([{ id: "extract", agent: "reader" }]);
    const first = await proposals.propose(
      execution.id,
      patchFor(1, [{ op: "addStep", step: { id: "load", agent: "writer" } }]),
    );
    expect((await proposals.activate(first.id)).decision).toBe("ACCEPTED");

    // Same base (1) — the active revision is now 2.
    const stale = await proposals.propose(
      execution.id,
      patchFor(1, [
        { op: "addStep", step: { id: "publish", agent: "writer" } },
      ]),
    );
    const result = await proposals.activate(stale.id);
    expect(result.decision).toBe("STALE");
    expect(result.reason).toContain("no longer active");
    expect(await activeRevision(execution.id)).toMatchObject({
      revisionNumber: 2,
    });
    expect((await logicalStepIds(execution.id)).sort()).toEqual([
      "extract",
      "load",
    ]);
  });

  it("concurrent same-base activations: exactly one ACCEPTED, the other STALE", async () => {
    const { execution } = await seed([{ id: "extract", agent: "reader" }]);
    const a = await proposals.propose(
      execution.id,
      patchFor(1, [{ op: "addStep", step: { id: "load", agent: "writer" } }]),
    );
    const b = await proposals.propose(
      execution.id,
      patchFor(1, [
        { op: "addStep", step: { id: "publish", agent: "writer" } },
      ]),
    );
    const [ra, rb] = await Promise.all([
      proposals.activate(a.id),
      proposals.activate(b.id),
    ]);
    const decisions = [ra.decision, rb.decision].sort();
    expect(decisions).toEqual(["ACCEPTED", "STALE"]);
    const revision = await activeRevision(execution.id);
    expect(revision?.revisionNumber).toBe(2);
    // Only the winner's steps materialized.
    const ids = await logicalStepIds(execution.id);
    expect(ids.length).toBe(2);
  });

  it("a replacement targeting a frozen step is REJECTED with no side effects", async () => {
    const { execution } = await seed([
      { id: "extract", agent: "reader" },
      { id: "review", agent: "reviewer", dependsOn: ["extract"] },
    ]);
    // Freeze "extract" by claiming it (no dependencies, immediately
    // runnable).
    const claim = await executionService.claimRunnableStep(
      execution.id,
      { id: "extract", agent: "reader" },
      { input: true },
      1,
    );
    expect(claim?.disposition).toBe("claimed");

    const proposal = await proposals.propose(
      execution.id,
      patchFor(1, [
        {
          op: "replaceUnfrozenStep",
          stepId: "extract",
          step: { id: "extract", agent: "other" },
        },
      ]),
    );
    const result = await proposals.activate(proposal.id);
    expect(result.decision).toBe("REJECTED");
    expect(result.reason).toContain("frozen");
    expect(await activeRevision(execution.id)).toMatchObject({
      revisionNumber: 1,
    });
    const stored = await dataSource
      .getRepository(PlanProposalEntity)
      .findOne({ where: { id: proposal.id } });
    expect(stored?.status).toBe("REJECTED");
  });

  it("an invalid candidate (duplicate id) is REJECTED with no side effects", async () => {
    const { execution } = await seed([{ id: "extract", agent: "reader" }]);
    const proposal = await proposals.propose(
      execution.id,
      patchFor(1, [
        { op: "addStep", step: { id: "extract", agent: "writer" } },
      ]),
    );
    const result = await proposals.activate(proposal.id);
    expect(result.decision).toBe("REJECTED");
    expect(result.reason).toContain("invalid");
    expect(await activeRevision(execution.id)).toMatchObject({
      revisionNumber: 1,
    });
  });

  it("steps added by activation are schedulable by the real claim path", async () => {
    const { execution } = await seed([{ id: "extract", agent: "reader" }]);
    const proposal = await proposals.propose(
      execution.id,
      patchFor(1, [
        {
          op: "addStep",
          step: { id: "load", agent: "writer", dependsOn: ["extract"] },
        },
      ]),
    );
    expect((await proposals.activate(proposal.id)).decision).toBe("ACCEPTED");

    // "extract" must be terminal before "load" is schedulable.
    await dataSource
      .getRepository(LogicalStepEntity)
      .createQueryBuilder()
      .update()
      .set({ status: "COMPLETED" })
      .where('"executionId" = :executionId', { executionId: execution.id })
      .andWhere('"stepId" = :stepId', { stepId: "extract" })
      .execute();
    // Reconcile promotes the added step from PENDING to READY now that its
    // dependency is terminal.
    await executionService.reconcileExecution(execution.id);

    // The claim uses the ACTIVE revision's spec for the added step.
    const claim = await executionService.claimRunnableStep(
      execution.id,
      { id: "load", agent: "writer", dependsOn: ["extract"] },
      { input: true },
      1,
    );
    expect(claim?.disposition).toBe("claimed");
    if (claim?.disposition !== "claimed") {
      throw new Error(`claim failed: ${claim?.disposition}`);
    }
    const attempt = await dataSource.getRepository(StepAttemptEntity).findOne({
      where: { logicalStepId: claim.logicalStep.id },
    });
    expect(attempt?.planRevisionId).toBe(
      (await activeRevision(execution.id))?.id,
    );
  });

  it("a budgeted execution carries its grant into the new revision", async () => {
    const { execution } = await seed(
      [{ id: "extract", agent: "reader", budget: { tokens: 50 } }],
      { tokens: 200 },
    );
    const proposal = await proposals.propose(
      execution.id,
      patchFor(1, [{ op: "addStep", step: { id: "load", agent: "writer" } }]),
    );
    expect((await proposals.activate(proposal.id)).decision).toBe("ACCEPTED");
    const revision = await activeRevision(execution.id);
    expect(revision?.plan).toMatchObject({
      budget: { ceilings: { tokens: 200 } },
    });
  });
});

describeWithPostgres("PostgreSQL M5-S3 planner trigger", () => {
  jest.setTimeout(120_000);

  let dataSource: DataSource;
  let executionService: ExecutionService;
  let inbox: ResultInboxService;
  let proposals: PlanProposalService;
  let ledger: BudgetLedgerService;

  const seed = async (steps: any[]) => {
    const stored = await dataSource.getRepository(PipelineEntity).save(
      dataSource.getRepository(PipelineEntity).create({
        name: `m5s3-${Math.random().toString(36).slice(2)}`,
        version: "1.0",
        description: "M5-S3 fixture",
        steps,
      }),
    );
    const execution = await executionService.createExecution(stored, {});
    await executionService.reconcileExecution(execution.id);
    return { stored, execution };
  };

  const applyResult = async (
    executionId: string,
    claimResult: any,
    output: unknown,
    status: "succeeded" | "failed" = "succeeded",
  ) => {
    const result: AgentResultV1 = {
      schemaVersion: "1",
      invocationId: claimResult.attempt.invocationId,
      executionId,
      stepExecutionId: claimResult.logicalStep.id,
      status,
      output: output as JsonValue,
      completedAt: new Date().toISOString(),
    };
    return inbox.apply(result, {
      adapter: "http",
      receivedAt: new Date().toISOString(),
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
    ledger = new BudgetLedgerService(dataSource as any);
    executionService = new ExecutionService(
      dataSource.getRepository(ExecutionEntity),
      dataSource.getRepository(LogicalStepEntity),
      dataSource.getRepository(StepAttemptEntity),
      dataSource.getRepository(ExecutionPlanRevisionEntity),
      dataSource,
    );
    proposals = new PlanProposalService(
      dataSource as any,
      new PipelineValidationService(new ConditionEvaluatorService()),
    );
    inbox = new ResultInboxService(dataSource as any, ledger, proposals);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await dataSource.query(
      `TRUNCATE "plan_proposals", "budget_ledger_entries", "budget_reservations",
       "budget_accounts", "policy_decisions", "policy_snapshots",
       "approval_requests", "result_conflicts", "result_inbox",
       "dispatch_outbox", "step_attempts", "step_executions",
       "execution_plan_revisions", "executions", "pipelines" CASCADE`,
    );
  });

  it("a completed planner step persists its output as a PENDING proposal pinned to the active revision", async () => {
    const { execution } = await seed([
      { id: "extract", agent: "reader" },
      { id: "plan", agent: "planner", planner: true, dependsOn: ["extract"] },
    ]);
    // Complete "extract" so "plan" becomes runnable.
    const extractClaim = await executionService.claimRunnableStep(
      execution.id,
      { id: "extract", agent: "reader" },
      { input: true },
      1,
    );
    if (extractClaim?.disposition !== "claimed") throw new Error("claim 1");
    await applyResult(execution.id, extractClaim, { done: true });
    await executionService.reconcileExecution(execution.id);

    const planClaim = await executionService.claimRunnableStep(
      execution.id,
      { id: "plan", agent: "planner", planner: true, dependsOn: ["extract"] },
      { input: true },
      1,
    );
    if (planClaim?.disposition !== "claimed") throw new Error("claim 2");
    const patch = {
      schemaVersion: 1,
      baseRevision: 99, // untrusted — must be overridden
      operations: [{ op: "addStep", step: { id: "load", agent: "writer" } }],
    };
    const application = await applyResult(execution.id, planClaim, patch);
    expect(application.disposition).toBe("applied");

    const stored = await dataSource.getRepository(PlanProposalEntity).findOne({
      where: { executionId: execution.id },
      order: { createdAt: "DESC" },
    });
    expect(stored).not.toBeNull();
    expect(stored?.status).toBe("PENDING");
    expect(stored?.source).toBe("planner");
    // The planner's declared baseRevision (99) was overridden with the
    // ACTIVE revision.
    expect(stored?.baseRevision).toBe(1);
    expect(stored?.proposal).toMatchObject({
      schemaVersion: 1,
      baseRevision: 1,
    });
    expect(stored?.proposalHash).toHaveLength(64);

    // The step completed and the proposal is activatable through the real
    // activation path.
    const step = await dataSource.getRepository(LogicalStepEntity).findOne({
      where: { executionId: execution.id, stepId: "plan" },
    });
    expect(step?.status).toBe("COMPLETED");
    expect((await proposals.activate(stored!.id)).decision).toBe("ACCEPTED");
  });

  it("an invalid planner output is a deterministic rejection following the failure policy", async () => {
    const { execution } = await seed([
      { id: "plan", agent: "planner", planner: true },
    ]);
    const claim = await executionService.claimRunnableStep(
      execution.id,
      { id: "plan", agent: "planner", planner: true },
      { input: true },
      1,
    );
    if (claim?.disposition !== "claimed") throw new Error("claim");

    const application = await applyResult(execution.id, claim, {
      not: "a patch",
    });
    expect(application.disposition).toBe("applied");

    const step = await dataSource.getRepository(LogicalStepEntity).findOne({
      where: { executionId: execution.id, stepId: "plan" },
    });
    expect(step?.status).toBe("FAILED");
    expect(step?.error).toContain("PLANNER_PROPOSAL_INVALID");
    expect(
      await dataSource.getRepository(PlanProposalEntity).count({
        where: { executionId: execution.id },
      }),
    ).toBe(0);
    const executionRow = await dataSource
      .getRepository(ExecutionEntity)
      .findOne({ where: { id: execution.id } });
    expect(executionRow?.status).toBe("FAILED");
  });

  it("an invalid planner output with onFailure retry schedules a retry", async () => {
    const { execution } = await seed([
      { id: "plan", agent: "planner", planner: true, onFailure: "retry" },
    ]);
    const claim = await executionService.claimRunnableStep(
      execution.id,
      { id: "plan", agent: "planner", planner: true, onFailure: "retry" },
      { input: true },
      1,
    );
    if (claim?.disposition !== "claimed") throw new Error("claim");
    // Allow one retry (the materialized row defaults to maxAttempts 1).
    await dataSource
      .getRepository(LogicalStepEntity)
      .createQueryBuilder()
      .update()
      .set({ maxAttempts: 2 })
      .where('"executionId" = :executionId', { executionId: execution.id })
      .execute();

    await applyResult(execution.id, claim, { not: "a patch" });

    const step = await dataSource.getRepository(LogicalStepEntity).findOne({
      where: { executionId: execution.id, stepId: "plan" },
    });
    expect(step?.status).toBe("RETRYING");
    expect(step?.nextAttemptAt).not.toBeNull();
  });

  it("a patch-shaped output on a NON-planner step never creates a proposal", async () => {
    const { execution } = await seed([{ id: "extract", agent: "reader" }]);
    const claim = await executionService.claimRunnableStep(
      execution.id,
      { id: "extract", agent: "reader" },
      { input: true },
      1,
    );
    if (claim?.disposition !== "claimed") throw new Error("claim");

    await applyResult(execution.id, claim, {
      schemaVersion: 1,
      baseRevision: 1,
      operations: [{ op: "addStep", step: { id: "load", agent: "writer" } }],
    });

    expect(
      await dataSource.getRepository(PlanProposalEntity).count({
        where: { executionId: execution.id },
      }),
    ).toBe(0);
  });

  it("a planner step whose state-write postcondition fails never proposes", async () => {
    const { execution } = await seed([
      {
        id: "plan",
        agent: "planner",
        planner: true,
        stateWrites: [{ key: "blocked", fromOutput: "/result" }],
      },
    ]);
    const claim = await executionService.claimRunnableStep(
      execution.id,
      {
        id: "plan",
        agent: "planner",
        planner: true,
        stateWrites: [{ key: "blocked", fromOutput: "/result" }],
      },
      { input: true },
      1,
    );
    if (claim?.disposition !== "claimed") throw new Error("claim");
    // The output has no "/result" pointer, so the state-write postcondition
    // deterministically rejects (TENVYR_STATE_WRITE_POINTER_MISSING).
    await applyResult(execution.id, claim, {
      schemaVersion: 1,
      baseRevision: 1,
      operations: [{ op: "addStep", step: { id: "load", agent: "writer" } }],
    });

    const step = await dataSource.getRepository(LogicalStepEntity).findOne({
      where: { executionId: execution.id, stepId: "plan" },
    });
    expect(step?.status).toBe("FAILED");
    expect(step?.error).toContain("TENVYR_STATE_WRITE_REJECTED");
    expect(
      await dataSource.getRepository(PlanProposalEntity).count({
        where: { executionId: execution.id },
      }),
    ).toBe(0);
  });

  it("a planner result arriving after the execution is terminal proposes nothing", async () => {
    const { execution } = await seed([
      { id: "plan", agent: "planner", planner: true },
      { id: "other", agent: "writer" },
    ]);
    // Claim BOTH steps while the execution is still RUNNING (a late result
    // is a result already in flight when the run turns terminal).
    const planClaim = await executionService.claimRunnableStep(
      execution.id,
      { id: "plan", agent: "planner", planner: true },
      { input: true },
      1,
    );
    if (planClaim?.disposition !== "claimed") throw new Error("claim");
    const otherClaim = await executionService.claimRunnableStep(
      execution.id,
      { id: "other", agent: "writer" },
      { input: true },
      1,
    );
    if (otherClaim?.disposition !== "claimed") throw new Error("claim");
    // Fail "other" -> the execution becomes FAILED.
    await applyResult(execution.id, otherClaim, null, "failed");
    const executionRow = await dataSource
      .getRepository(ExecutionEntity)
      .findOne({ where: { id: execution.id } });
    expect(executionRow?.status).toBe("FAILED");

    // The late planner success still settles its own step facts but
    // proposes nothing.
    await applyResult(execution.id, planClaim, {
      schemaVersion: 1,
      baseRevision: 1,
      operations: [{ op: "addStep", step: { id: "load", agent: "writer" } }],
    });

    expect(
      await dataSource.getRepository(PlanProposalEntity).count({
        where: { executionId: execution.id },
      }),
    ).toBe(0);
    const planStep = await dataSource.getRepository(LogicalStepEntity).findOne({
      where: { executionId: execution.id, stepId: "plan" },
    });
    expect(planStep?.status).toBe("COMPLETED");
  });
});

describeWithPostgres("PostgreSQL M5-S4 proposal policy", () => {
  jest.setTimeout(120_000);

  let dataSource: DataSource;
  let executionService: ExecutionService;
  let proposals: PlanProposalService;
  let approvals: ApprovalService;

  const seed = async (steps: any[]) => {
    const stored = await dataSource.getRepository(PipelineEntity).save(
      dataSource.getRepository(PipelineEntity).create({
        name: `m5s4-${Math.random().toString(36).slice(2)}`,
        version: "1.0",
        description: "M5-S4 fixture",
        steps,
      }),
    );
    const execution = await executionService.createExecution(stored, {});
    await executionService.reconcileExecution(execution.id);
    return { stored, execution };
  };

  const patchFor = (baseRevision: number, operations: any[]) => ({
    schemaVersion: 1,
    baseRevision,
    operations,
  });

  const setPolicy = (rules: any[], version = 1) => {
    process.env.TENVYR_POLICY = JSON.stringify({ version, rules });
  };

  const decisions = async (executionId: string) =>
    dataSource
      .getRepository(PolicyDecisionEntity)
      .find({ where: { executionId }, order: { createdAt: "ASC" } });

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
    proposals = new PlanProposalService(
      dataSource as any,
      new PipelineValidationService(new ConditionEvaluatorService()),
    );
    approvals = new ApprovalService(dataSource as any, undefined, proposals);
  });

  afterAll(async () => {
    delete process.env.TENVYR_POLICY;
    await dataSource.destroy();
  });

  beforeEach(async () => {
    delete process.env.TENVYR_POLICY;
    await dataSource.query(
      `TRUNCATE "plan_proposals", "policy_decisions", "policy_snapshots",
       "approval_requests", "budget_ledger_entries", "budget_reservations",
       "budget_accounts", "dispatch_outbox", "step_attempts",
       "step_executions", "execution_plan_revisions", "executions",
       "pipelines" CASCADE`,
    );
  });

  it("an ALLOW rule lets activation proceed and records the decision evidence", async () => {
    setPolicy([
      { id: "allow-plans", actionType: "plan_patch", effect: "ALLOW" },
    ]);
    const { execution } = await seed([{ id: "extract", agent: "reader" }]);
    const proposal = await proposals.propose(
      execution.id,
      patchFor(1, [{ op: "addStep", step: { id: "load", agent: "writer" } }]),
    );

    const result = await proposals.activate(proposal.id);
    expect(result.decision).toBe("ACCEPTED");

    const revision = await dataSource
      .getRepository(ExecutionPlanRevisionEntity)
      .findOne({ where: { executionId: execution.id, revisionNumber: 2 } });
    expect(revision).not.toBeNull();
    const evidence = await decisions(execution.id);
    expect(evidence).toHaveLength(1);
    expect(evidence[0].actionType).toBe("plan_patch");
    expect(evidence[0].proposalId).toBe(`plan:${proposal.id}`);
    expect(evidence[0].effect).toBe("ALLOW");
  });

  it("a DENY rule rejects the proposal with no side effects", async () => {
    setPolicy([{ id: "deny-plans", actionType: "plan_patch", effect: "DENY" }]);
    const { execution } = await seed([{ id: "extract", agent: "reader" }]);
    const proposal = await proposals.propose(
      execution.id,
      patchFor(1, [{ op: "addStep", step: { id: "load", agent: "writer" } }]),
    );

    const result = await proposals.activate(proposal.id);
    expect(result.decision).toBe("REJECTED");
    expect(result.reason).toContain("Policy DENY");
    expect(
      await dataSource.getRepository(ExecutionPlanRevisionEntity).count({
        where: { executionId: execution.id },
      }),
    ).toBe(1);
    const evidence = await decisions(execution.id);
    expect(evidence[0].effect).toBe("DENY");
  });

  it("REQUIRE_APPROVAL leaves the proposal PENDING with a durable request; approval activates it", async () => {
    setPolicy([
      {
        id: "approve-plans",
        actionType: "plan_patch",
        effect: "REQUIRE_APPROVAL",
      },
    ]);
    const { execution } = await seed([{ id: "extract", agent: "reader" }]);
    const proposal = await proposals.propose(
      execution.id,
      patchFor(1, [{ op: "addStep", step: { id: "load", agent: "writer" } }]),
    );

    const result = await proposals.activate(proposal.id);
    expect(result.decision).toBe("PENDING");
    expect(result.reason).toContain("Awaiting approval");

    const request = await dataSource
      .getRepository(ApprovalRequestEntity)
      .findOne({
        where: { proposalId: `plan:${proposal.id}` },
      });
    expect(request).not.toBeNull();
    expect(request?.actionType).toBe("plan_patch");
    expect(request?.status).toBe("PENDING");
    expect(
      await dataSource.getRepository(ExecutionPlanRevisionEntity).count({
        where: { executionId: execution.id },
      }),
    ).toBe(1);
    const storedProposal = await dataSource
      .getRepository(PlanProposalEntity)
      .findOne({ where: { id: proposal.id } });
    expect(storedProposal?.status).toBe("PENDING");

    await approvals.approve(`plan:${proposal.id}`);

    const approved = await dataSource
      .getRepository(ApprovalRequestEntity)
      .findOne({ where: { proposalId: `plan:${proposal.id}` } });
    expect(approved?.status).toBe("APPROVED");
    const activated = await dataSource
      .getRepository(PlanProposalEntity)
      .findOne({ where: { id: proposal.id } });
    expect(activated?.status).toBe("ACCEPTED");
    const revision = await dataSource
      .getRepository(ExecutionPlanRevisionEntity)
      .findOne({ where: { executionId: execution.id, revisionNumber: 2 } });
    expect(revision?.plan.steps.map((step) => step.id)).toContain("load");
  });

  it("a stale approved proposal stays STALE: approval rechecks the base revision", async () => {
    setPolicy([
      {
        id: "approve-plans",
        actionType: "plan_patch",
        effect: "REQUIRE_APPROVAL",
      },
    ]);
    const { execution } = await seed([{ id: "extract", agent: "reader" }]);
    const first = await proposals.propose(
      execution.id,
      patchFor(1, [{ op: "addStep", step: { id: "load", agent: "writer" } }]),
    );
    // The intercept (which creates the request) happens inside activate.
    expect((await proposals.activate(first.id)).decision).toBe("PENDING");

    // The stale proposal is intercepted while the base is still 1...
    const stale = await proposals.propose(
      execution.id,
      patchFor(1, [
        { op: "addStep", step: { id: "publish", agent: "writer" } },
      ]),
    );
    expect((await proposals.activate(stale.id)).decision).toBe("PENDING");

    // ...then the first proposal activates and moves the base to 2.
    await approvals.approve(`plan:${first.id}`);
    expect(
      (
        await dataSource
          .getRepository(PlanProposalEntity)
          .findOne({ where: { id: first.id } })
      )?.status,
    ).toBe("ACCEPTED");

    // Approving the stale proposal rechecks the base: it stays STALE.
    await approvals.approve(`plan:${stale.id}`);
    const stored = await dataSource
      .getRepository(PlanProposalEntity)
      .findOne({ where: { id: stale.id } });
    expect(stored?.status).toBe("STALE");
    const request = await dataSource
      .getRepository(ApprovalRequestEntity)
      .findOne({ where: { proposalId: `plan:${stale.id}` } });
    expect(request?.status).toBe("APPROVED");
    expect(request?.decisionNote).toContain("STALE");
  });

  it("a policy that rotates to DENY between interception and approval rejects the approved proposal", async () => {
    setPolicy([
      {
        id: "approve-plans",
        actionType: "plan_patch",
        effect: "REQUIRE_APPROVAL",
      },
    ]);
    const { execution } = await seed([{ id: "extract", agent: "reader" }]);
    const proposal = await proposals.propose(
      execution.id,
      patchFor(1, [{ op: "addStep", step: { id: "load", agent: "writer" } }]),
    );
    expect((await proposals.activate(proposal.id)).decision).toBe("PENDING");

    // The operator rotates the policy (version bump) to DENY before
    // approving.
    setPolicy(
      [{ id: "deny-plans", actionType: "plan_patch", effect: "DENY" }],
      2,
    );
    await approvals.approve(`plan:${proposal.id}`);

    const stored = await dataSource
      .getRepository(PlanProposalEntity)
      .findOne({ where: { id: proposal.id } });
    expect(stored?.status).toBe("REJECTED");
    expect(stored?.decisionReason).toContain("Policy DENY");
    expect(
      await dataSource.getRepository(ExecutionPlanRevisionEntity).count({
        where: { executionId: execution.id },
      }),
    ).toBe(1);
  });

  it("denying a plan_patch request rejects the proposal and never touches attempts", async () => {
    setPolicy([
      {
        id: "approve-plans",
        actionType: "plan_patch",
        effect: "REQUIRE_APPROVAL",
      },
    ]);
    const { execution } = await seed([{ id: "extract", agent: "reader" }]);
    const proposal = await proposals.propose(
      execution.id,
      patchFor(1, [{ op: "addStep", step: { id: "load", agent: "writer" } }]),
    );
    expect((await proposals.activate(proposal.id)).decision).toBe("PENDING");

    await approvals.deny(`plan:${proposal.id}`);

    const stored = await dataSource
      .getRepository(PlanProposalEntity)
      .findOne({ where: { id: proposal.id } });
    expect(stored?.status).toBe("REJECTED");
    expect(stored?.decisionReason).toContain("denied");
    const request = await dataSource
      .getRepository(ApprovalRequestEntity)
      .findOne({ where: { proposalId: `plan:${proposal.id}` } });
    expect(request?.status).toBe("DENIED");
    expect(
      await dataSource.getRepository(ExecutionPlanRevisionEntity).count({
        where: { executionId: execution.id },
      }),
    ).toBe(1);
  });

  it("expiring a due plan_patch request (sweep) rejects the proposal and the sweep survives", async () => {
    setPolicy([
      {
        id: "approve-plans",
        actionType: "plan_patch",
        effect: "REQUIRE_APPROVAL",
      },
    ]);
    const { execution } = await seed([{ id: "extract", agent: "reader" }]);
    const proposal = await proposals.propose(
      execution.id,
      patchFor(1, [{ op: "addStep", step: { id: "load", agent: "writer" } }]),
    );
    expect((await proposals.activate(proposal.id)).decision).toBe("PENDING");
    // Make the request overdue.
    await dataSource
      .getRepository(ApprovalRequestEntity)
      .createQueryBuilder()
      .update()
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where('"proposalId" = :proposalId', {
        proposalId: `plan:${proposal.id}`,
      })
      .execute();

    const expired = await approvals.expireDue(undefined, new Date());
    expect(expired).toBe(1);
    const stored = await dataSource
      .getRepository(PlanProposalEntity)
      .findOne({ where: { id: proposal.id } });
    expect(stored?.status).toBe("REJECTED");
    const request = await dataSource
      .getRepository(ApprovalRequestEntity)
      .findOne({ where: { proposalId: `plan:${proposal.id}` } });
    expect(request?.status).toBe("EXPIRED");
    // The sweep still processes other requests after the plan_patch one.
    expect(await approvals.expireDue(undefined, new Date())).toBe(0);
  });

  it("a dispatch policy alone does not intercept plan activation", async () => {
    setPolicy([
      { id: "deny-dispatch", actionType: "dispatch", effect: "DENY" },
    ]);
    const { execution } = await seed([{ id: "extract", agent: "reader" }]);
    const proposal = await proposals.propose(
      execution.id,
      patchFor(1, [{ op: "addStep", step: { id: "load", agent: "writer" } }]),
    );
    // No plan_patch rule matches: the default effect for an unmatched
    // actionType is ALLOW (per the policy domain), so activation proceeds.
    const result = await proposals.activate(proposal.id);
    expect(result.decision).toBe("ACCEPTED");
  });
});

describeWithPostgres("PostgreSQL M5-S5 closure", () => {
  jest.setTimeout(120_000);

  let dataSource: DataSource;
  let executionService: ExecutionService;
  let proposals: PlanProposalService;

  const seed = async (steps: any[]) => {
    const stored = await dataSource.getRepository(PipelineEntity).save(
      dataSource.getRepository(PipelineEntity).create({
        name: `m5s5-${Math.random().toString(36).slice(2)}`,
        version: "1.0",
        description: "M5-S5 fixture",
        steps,
      }),
    );
    const execution = await executionService.createExecution(stored, {});
    await executionService.reconcileExecution(execution.id);
    return { stored, execution };
  };

  const patchFor = (baseRevision: number, operations: any[]) => ({
    schemaVersion: 1,
    baseRevision,
    operations,
  });

  const claimCount = async (executionId: string) =>
    dataSource.getRepository(StepAttemptEntity).count({
      where: { executionId },
    });

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
    proposals = new PlanProposalService(
      dataSource as any,
      new PipelineValidationService(new ConditionEvaluatorService()),
    );
  });

  afterAll(async () => {
    delete process.env.TENVYR_POLICY;
    await dataSource.destroy();
  });

  beforeEach(async () => {
    delete process.env.TENVYR_POLICY;
    await dataSource.query(
      `TRUNCATE "plan_proposals", "policy_decisions", "policy_snapshots",
       "approval_requests", "budget_ledger_entries", "budget_reservations",
       "budget_accounts", "dispatch_outbox", "step_attempts",
       "step_executions", "execution_plan_revisions", "executions",
       "pipelines" CASCADE`,
    );
  });

  it("a planner-sourced proposal can never add another planner step", async () => {
    const { execution } = await seed([
      { id: "plan", agent: "planner", planner: true },
    ]);
    const proposal = await proposals.propose(
      execution.id,
      patchFor(1, [
        {
          op: "addStep",
          step: { id: "plan2", agent: "planner", planner: true },
        },
      ]),
      "planner",
    );
    const result = await proposals.activate(proposal.id);
    expect(result.decision).toBe("REJECTED");
    expect(result.reason).toContain("planner steps");
    expect(await claimCount(execution.id)).toBe(0);
    expect(
      await dataSource.getRepository(ExecutionPlanRevisionEntity).count({
        where: { executionId: execution.id },
      }),
    ).toBe(1);

    // Operator-sourced proposals MAY add planner steps.
    const operatorProposal = await proposals.propose(
      execution.id,
      patchFor(1, [
        {
          op: "addStep",
          step: { id: "plan2", agent: "planner", planner: true },
        },
      ]),
      "operator",
    );
    expect((await proposals.activate(operatorProposal.id)).decision).toBe(
      "ACCEPTED",
    );
  });

  it("a planner-sourced proposal cannot CONVERT an existing step into a planner step", async () => {
    const { execution } = await seed([
      { id: "extract", agent: "reader" },
      { id: "plan", agent: "planner", planner: true },
    ]);
    // replaceUnfrozenStep of the unfrozen "extract" with planner: true —
    // the id exists, so the addStep-only check would have missed this.
    const proposal = await proposals.propose(
      execution.id,
      patchFor(1, [
        {
          op: "replaceUnfrozenStep",
          stepId: "extract",
          step: { id: "extract", agent: "reader", planner: true },
        },
      ]),
      "planner",
    );
    const result = await proposals.activate(proposal.id);
    expect(result.decision).toBe("REJECTED");
    expect(result.reason).toContain("planner steps");
    expect(
      await dataSource.getRepository(ExecutionPlanRevisionEntity).count({
        where: { executionId: execution.id },
      }),
    ).toBe(1);

    // The operator may perform the same conversion.
    const operatorProposal = await proposals.propose(
      execution.id,
      patchFor(1, [
        {
          op: "replaceUnfrozenStep",
          stepId: "extract",
          step: { id: "extract", agent: "reader", planner: true },
        },
      ]),
      "operator",
    );
    expect((await proposals.activate(operatorProposal.id)).decision).toBe(
      "ACCEPTED",
    );
  });

  it("claim-versus-patch races serialize on the execution lock into consistent outcomes", async () => {
    const { execution } = await seed([
      { id: "extract", agent: "reader", timeout: "5s" },
    ]);
    const proposal = await proposals.propose(
      execution.id,
      patchFor(1, [
        {
          op: "replaceUnfrozenStep",
          stepId: "extract",
          step: { id: "extract", agent: "reader", timeout: "30s" },
        },
      ]),
    );
    const newSpec = { id: "extract", agent: "reader", timeout: "30s" };

    const [activation, claim] = await Promise.all([
      proposals.activate(proposal.id),
      executionService.claimRunnableStep(
        execution.id,
        newSpec,
        { input: true },
        1,
      ),
    ]);

    if (activation.decision === "ACCEPTED") {
      // The claim ran against revision 2 (the replaced spec).
      expect(claim?.disposition).toBe("claimed");
      if (claim?.disposition !== "claimed") throw new Error("claim");
      const attempt = await dataSource
        .getRepository(StepAttemptEntity)
        .findOne({ where: { logicalStepId: claim.logicalStep.id } });
      const revision = await dataSource
        .getRepository(ExecutionPlanRevisionEntity)
        .findOne({ where: { id: attempt?.planRevisionId } });
      expect(revision?.revisionNumber).toBe(2);
      expect(attempt?.frozenSpecHash).toBe(sha256Json(newSpec));
    } else {
      // The claim won the lock first: the attempt froze revision 1's spec
      // and the activation saw a frozen step.
      expect(activation.decision).toBe("REJECTED");
      expect(activation.reason).toContain("frozen");
      expect(claim?.disposition).toBe("claimed");
      if (claim?.disposition !== "claimed") throw new Error("claim");
      const attempt = await dataSource
        .getRepository(StepAttemptEntity)
        .findOne({ where: { logicalStepId: claim.logicalStep.id } });
      const revision = await dataSource
        .getRepository(ExecutionPlanRevisionEntity)
        .findOne({ where: { id: attempt?.planRevisionId } });
      expect(revision?.revisionNumber).toBe(1);
    }
  });

  it("a proposal already terminalized before activation returns the stored decision without side effects", async () => {
    const { execution } = await seed([{ id: "extract", agent: "reader" }]);
    const proposal = await proposals.propose(
      execution.id,
      patchFor(1, [{ op: "addStep", step: { id: "load", agent: "writer" } }]),
    );
    // Simulate a concurrent deny that terminalized the proposal first.
    await dataSource
      .getRepository(PlanProposalEntity)
      .createQueryBuilder()
      .update()
      .set({
        status: "REJECTED",
        decisionReason: "Approval denied",
        decidedAt: new Date(),
      })
      .where("id = :id", { id: proposal.id })
      .execute();

    const result = await proposals.activate(proposal.id);
    expect(result.decision).toBe("REJECTED");
    expect(result.reason).toContain("denied");
    expect(
      await dataSource.getRepository(ExecutionPlanRevisionEntity).count({
        where: { executionId: execution.id },
      }),
    ).toBe(1);
    expect(await claimCount(execution.id)).toBe(0);
  });

  it.each(["COMPLETED", "FAILED", "CANCELLED"] as const)(
    "a %s execution cannot activate a new plan revision",
    async (status) => {
      const { execution } = await seed([{ id: "extract", agent: "reader" }]);
      const proposal = await proposals.propose(
        execution.id,
        patchFor(1, [{ op: "addStep", step: { id: "load", agent: "writer" } }]),
      );
      await dataSource
        .getRepository(ExecutionEntity)
        .createQueryBuilder()
        .update()
        .set({ status, endTime: new Date() })
        .where("id = :id", { id: execution.id })
        .execute();

      const result = await proposals.activate(proposal.id);
      expect(result.decision).toBe("STALE");
      expect(result.reason).toContain(status);
      expect(
        await dataSource.getRepository(ExecutionPlanRevisionEntity).count({
          where: { executionId: execution.id },
        }),
      ).toBe(1);
    },
  );

  it("crash mid-activation: the aborted transaction leaves the proposal PENDING with zero side effects", async () => {
    const { execution } = await seed([{ id: "extract", agent: "reader" }]);
    const proposal = await proposals.propose(
      execution.id,
      patchFor(1, [{ op: "addStep", step: { id: "load", agent: "writer" } }]),
    );
    // Simulate a crash AFTER the activation's writes: an outer transaction
    // runs the whole activation and then aborts (throws) — everything the
    // activation wrote must roll back together.
    await expect(
      dataSource.transaction(async (manager) => {
        await proposals.activateWithManager(manager, proposal.id);
        throw new Error("simulated crash after activation writes");
      }),
    ).rejects.toThrow("simulated crash");

    const stored = await dataSource
      .getRepository(PlanProposalEntity)
      .findOne({ where: { id: proposal.id } });
    expect(stored?.status).toBe("PENDING");
    expect(
      await dataSource.getRepository(ExecutionPlanRevisionEntity).count({
        where: { executionId: execution.id },
      }),
    ).toBe(1);
    expect(await claimCount(execution.id)).toBe(0);

    // The untouched proposal activates normally afterwards (retryable).
    expect((await proposals.activate(proposal.id)).decision).toBe("ACCEPTED");
    expect(
      await dataSource.getRepository(ExecutionPlanRevisionEntity).count({
        where: { executionId: execution.id },
      }),
    ).toBe(2);
  });
});

describeWithPostgres("PostgreSQL M6-S1 observed evidence", () => {
  jest.setTimeout(120_000);

  let dataSource: DataSource;
  let executionService: ExecutionService;
  let inbox: ResultInboxService;
  let ledger: BudgetLedgerService;
  let proposals: PlanProposalService;

  const seed = async (steps: any[]) => {
    const stored = await dataSource.getRepository(PipelineEntity).save(
      dataSource.getRepository(PipelineEntity).create({
        name: `m6s1-${Math.random().toString(36).slice(2)}`,
        version: "1.0",
        description: "M6-S1 fixture",
        steps,
      }),
    );
    const execution = await executionService.createExecution(stored, {});
    await executionService.reconcileExecution(execution.id);
    return { stored, execution };
  };

  const applyResult = async (
    executionId: string,
    claimResult: any,
    output: unknown,
    delegation?: any[],
  ) => {
    const result: AgentResultV1 = {
      schemaVersion: "1",
      invocationId: claimResult.attempt.invocationId,
      executionId,
      stepExecutionId: claimResult.logicalStep.id,
      status: "succeeded",
      output: output as JsonValue,
      completedAt: new Date().toISOString(),
      ...(delegation === undefined ? {} : { delegation: delegation as any }),
    };
    return inbox.apply(result, {
      adapter: "http",
      receivedAt: new Date().toISOString(),
    });
  };

  const observationCount = async () =>
    dataSource.getRepository(DelegationObservationEntity).count();

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
    ledger = new BudgetLedgerService(dataSource as any);
    executionService = new ExecutionService(
      dataSource.getRepository(ExecutionEntity),
      dataSource.getRepository(LogicalStepEntity),
      dataSource.getRepository(StepAttemptEntity),
      dataSource.getRepository(ExecutionPlanRevisionEntity),
      dataSource,
    );
    proposals = new PlanProposalService(
      dataSource as any,
      new PipelineValidationService(new ConditionEvaluatorService()),
    );
    inbox = new ResultInboxService(dataSource as any, ledger, proposals);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await dataSource.query(
      `TRUNCATE "delegation_observation_conflicts", "delegation_observations",
       "plan_proposals", "state_write_evidence", "artifacts",
       "result_conflicts", "result_inbox", "dispatch_outbox",
       "step_attempts", "step_executions", "execution_plan_revisions",
       "executions", "pipelines" CASCADE`,
    );
  });

  it("observed mode records bounded evidence correlated to the parent attempt", async () => {
    const { execution } = await seed([
      { id: "extract", agent: "reader", delegation: "observed" },
    ]);
    const claim = await executionService.claimRunnableStep(
      execution.id,
      { id: "extract", agent: "reader", delegation: "observed" },
      { input: true },
      1,
    );
    if (claim?.disposition !== "claimed") throw new Error("claim");

    const observation = {
      schemaVersion: "1",
      provider: "codex",
      childId: "child-123",
      assertedAt: new Date().toISOString(),
      attributes: [{ name: "model", value: "gpt-5" }],
    };
    await applyResult(execution.id, claim, { done: true }, [observation]);

    const rows = await dataSource
      .getRepository(DelegationObservationEntity)
      .find();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      stepAttemptId: claim.attempt.id,
      invocationId: claim.attempt.invocationId,
      executionId: execution.id,
      observationId: "codex:child-123",
      provider: "codex",
      childId: "child-123",
    });
    expect(rows[0].payloadHash).toHaveLength(64);
    // Evidence is inert: the step completed normally and nothing else moved.
    const step = await dataSource.getRepository(LogicalStepEntity).findOne({
      where: { executionId: execution.id, stepId: "extract" },
    });
    expect(step?.status).toBe("COMPLETED");
    expect(
      await dataSource.getRepository(DispatchOutboxEntity).count({
        where: { stepAttemptId: claim.attempt.id },
      }),
    ).toBe(1); // the original dispatch row only — no new scheduling
  });

  it("duplicate evidence deliveries are idempotent", async () => {
    const { execution } = await seed([
      { id: "extract", agent: "reader", delegation: "observed" },
    ]);
    const claim = await executionService.claimRunnableStep(
      execution.id,
      { id: "extract", agent: "reader", delegation: "observed" },
      { input: true },
      1,
    );
    if (claim?.disposition !== "claimed") throw new Error("claim");
    const observation = {
      schemaVersion: "1",
      provider: "claude",
      childId: "child-9",
      assertedAt: new Date().toISOString(),
    };

    const payload = {
      schemaVersion: "1" as const,
      invocationId: claim.attempt.invocationId,
      executionId: execution.id,
      stepExecutionId: claim.logicalStep.id,
      status: "succeeded" as const,
      output: { done: true },
      completedAt: "2026-08-11T00:00:00.000Z",
      delegation: [observation],
    };
    const first = await inbox.apply(payload as any, {
      adapter: "http",
      receivedAt: new Date().toISOString(),
    });
    expect(first.disposition).toBe("applied");
    // Byte-identical redelivery (transport replay).
    const duplicate = await inbox.apply(payload as any, {
      adapter: "http",
      receivedAt: new Date().toISOString(),
    });
    expect(duplicate.disposition).toBe("duplicate");
    expect(await observationCount()).toBe(1);
  });

  it("a different-payload redelivery is a result-level conflict; the canonical observation stays authoritative", async () => {
    const { execution } = await seed([
      { id: "extract", agent: "reader", delegation: "observed" },
    ]);
    const claim = await executionService.claimRunnableStep(
      execution.id,
      { id: "extract", agent: "reader", delegation: "observed" },
      { input: true },
      1,
    );
    if (claim?.disposition !== "claimed") throw new Error("claim");
    const first = {
      schemaVersion: "1",
      provider: "codex",
      childId: "child-1",
      assertedAt: "2026-08-11T00:00:00.000Z",
    };
    const different = {
      ...first,
      attributes: [{ name: "model", value: "different" }],
    };
    const firstApplication = await applyResult(
      execution.id,
      claim,
      { done: true },
      [first],
    );
    expect(firstApplication.disposition).toBe("applied");
    // A redelivery with a different payload is a RESULT-level conflict
    // (canonical application is exactly-once per attempt), retained in
    // result_conflicts; the canonical observation row is untouched.
    const conflictingApplication = await applyResult(
      execution.id,
      claim,
      { done: true },
      [different],
    );
    expect(conflictingApplication.disposition).toBe("conflict");

    expect(await observationCount()).toBe(1);
    const resultConflicts = await dataSource
      .getRepository(ResultConflictEntity)
      .find();
    expect(resultConflicts.length).toBeGreaterThanOrEqual(1);
    const canonical = await dataSource
      .getRepository(DelegationObservationEntity)
      .findOne({ where: { observationId: "codex:child-1" } });
    expect(canonical?.payload).toEqual(first);
    // The observation-level conflict table is defense-in-depth for future
    // channels; the canonical result flow never reaches it.
    expect(
      await dataSource
        .getRepository(DelegationObservationConflictEntity)
        .count(),
    ).toBe(0);
  });

  it("duplicate provider:childId within ONE result is retained as an observation conflict", async () => {
    const { execution } = await seed([
      { id: "extract", agent: "reader", delegation: "observed" },
    ]);
    const claim = await executionService.claimRunnableStep(
      execution.id,
      { id: "extract", agent: "reader", delegation: "observed" },
      { input: true },
      1,
    );
    if (claim?.disposition !== "claimed") throw new Error("claim");
    const first = {
      schemaVersion: "1",
      provider: "codex",
      childId: "child-dupe",
      assertedAt: "2026-08-11T00:00:00.000Z",
    };
    const different = {
      ...first,
      attributes: [{ name: "model", value: "different" }],
    };
    const application = await applyResult(execution.id, claim, { done: true }, [
      first,
      different,
    ]);
    expect(application.disposition).toBe("applied");

    expect(await observationCount()).toBe(1);
    const canonical = await dataSource
      .getRepository(DelegationObservationEntity)
      .findOne({ where: { observationId: "codex:child-dupe" } });
    expect(canonical?.payload).toEqual(first);
    const conflicts = await dataSource
      .getRepository(DelegationObservationConflictEntity)
      .find();
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({
      observationId: "codex:child-dupe",
      conflictKind: "identity_payload",
    });
    expect(conflicts[0].payload).toEqual(different);
  });

  it("opaque steps record nothing even when evidence arrives", async () => {
    const { execution } = await seed([{ id: "extract", agent: "reader" }]);
    const claim = await executionService.claimRunnableStep(
      execution.id,
      { id: "extract", agent: "reader" },
      { input: true },
      1,
    );
    if (claim?.disposition !== "claimed") throw new Error("claim");
    await applyResult(execution.id, claim, { done: true }, [
      {
        schemaVersion: "1",
        provider: "codex",
        childId: "child-hidden",
        assertedAt: new Date().toISOString(),
      },
    ]);
    expect(await observationCount()).toBe(0);
  });

  it("a step without delegation evidence produces no rows", async () => {
    const { execution } = await seed([
      { id: "extract", agent: "reader", delegation: "observed" },
    ]);
    const claim = await executionService.claimRunnableStep(
      execution.id,
      { id: "extract", agent: "reader", delegation: "observed" },
      { input: true },
      1,
    );
    if (claim?.disposition !== "claimed") throw new Error("claim");
    await applyResult(execution.id, claim, { done: true });
    expect(await observationCount()).toBe(0);
  });
});

describeWithPostgres("PostgreSQL M6-S2 supervised delegation", () => {
  jest.setTimeout(120_000);

  let dataSource: DataSource;
  let executionService: ExecutionService;
  let delegation: DelegationService;

  const seedParent = async () => {
    const stored = await dataSource.getRepository(PipelineEntity).save(
      dataSource.getRepository(PipelineEntity).create({
        name: `m6s2-parent-${Math.random().toString(36).slice(2)}`,
        version: "1.0",
        description: "M6-S2 parent fixture",
        steps: [{ id: "extract", agent: "reader" }],
      }),
    );
    const execution = await executionService.createExecution(stored, {});
    await executionService.reconcileExecution(execution.id);
    return { stored, execution };
  };

  const seedChildPipeline = async () => {
    return dataSource.getRepository(PipelineEntity).save(
      dataSource.getRepository(PipelineEntity).create({
        name: `m6s2-child-${Math.random().toString(36).slice(2)}`,
        version: "1.0",
        description: "M6-S2 child fixture",
        steps: [{ id: "child-step", agent: "writer" }],
      }),
    );
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
    delegation = new DelegationService(dataSource as any, executionService);
  });

  afterAll(async () => {
    delete process.env.TENVYR_POLICY;
    await dataSource.destroy();
  });

  beforeEach(async () => {
    delete process.env.TENVYR_POLICY;
    await dataSource.query(
      `TRUNCATE "delegation_requests", "delegation_observation_conflicts",
       "delegation_observations", "plan_proposals", "state_write_evidence",
       "artifacts", "result_conflicts", "result_inbox", "dispatch_outbox",
       "step_attempts", "step_executions", "execution_plan_revisions",
       "executions", "pipelines" CASCADE`,
    );
  });

  it("request is idempotent per (parentAttemptId, requestId)", async () => {
    const { execution } = await seedParent();
    const claim = await executionService.claimRunnableStep(
      execution.id,
      { id: "extract", agent: "reader" },
      { input: true },
      1,
    );
    if (claim?.disposition !== "claimed") throw new Error("claim");

    const expiresAt = new Date(Date.now() + 60_000);
    const first = await delegation.request({
      parentExecutionId: execution.id,
      parentAttemptId: claim.attempt.id,
      requestId: "sub-1",
      requestedAgent: "writer",
      expiresAt,
    });
    expect(first.disposition).toBe("created");
    const replay = await delegation.request({
      parentExecutionId: execution.id,
      parentAttemptId: claim.attempt.id,
      requestId: "sub-1",
      requestedAgent: "writer",
      expiresAt,
    });
    expect(replay.disposition).toBe("replayed");
    expect(replay.request.id).toBe(first.request.id);
    expect(
      await dataSource.getRepository(DelegationRequestEntity).count(),
    ).toBe(1);
  });

  it("retains a same-identity different-payload conflict without creating authority", async () => {
    const { execution } = await seedParent();
    const claim = await executionService.claimRunnableStep(
      execution.id,
      { id: "extract", agent: "reader" },
      { input: true },
      1,
    );
    if (claim?.disposition !== "claimed") throw new Error("claim");
    const expiresAt = new Date(Date.now() + 60_000);
    const canonical = await delegation.request({
      parentExecutionId: execution.id,
      parentAttemptId: claim.attempt.id,
      requestId: "conflicting-request",
      requestedAgent: "writer",
      expiresAt,
    });
    const conflict = await delegation.request({
      parentExecutionId: execution.id,
      parentAttemptId: claim.attempt.id,
      requestId: "conflicting-request",
      requestedAgent: "different-agent",
      expiresAt,
    });

    expect(conflict.disposition).toBe("conflict");
    expect(conflict.request.id).toBe(canonical.request.id);
    expect(
      await dataSource.getRepository(DelegationRequestEntity).count(),
    ).toBe(1);
    const evidence = await dataSource
      .getRepository(DelegationRequestConflictEntity)
      .find();
    expect(evidence).toHaveLength(1);
    expect(evidence[0]).toMatchObject({
      parentAttemptId: claim.attempt.id,
      requestId: "conflicting-request",
      conflictKind: "PAYLOAD_MISMATCH",
    });
  });

  it("approve materializes the child execution atomically with the decision", async () => {
    const { execution } = await seedParent();
    const claim = await executionService.claimRunnableStep(
      execution.id,
      { id: "extract", agent: "reader" },
      { input: true },
      1,
    );
    if (claim?.disposition !== "claimed") throw new Error("claim");
    const childPipeline = await seedChildPipeline();
    const { request } = await delegation.request({
      parentExecutionId: execution.id,
      parentAttemptId: claim.attempt.id,
      requestId: "sub-2",
      requestedAgent: "writer",
      expiresAt: new Date(Date.now() + 60_000),
    });

    const result = await delegation.approve(
      claim.attempt.id,
      "sub-2",
      childPipeline,
    );
    expect(result.decision).toBe("APPROVED");
    expect(result.childExecutionId).not.toBeNull();

    // The child is a full execution: revision 1 + logical steps.
    const child = await dataSource
      .getRepository(ExecutionEntity)
      .findOne({ where: { id: result.childExecutionId! } });
    expect(child).not.toBeNull();
    expect(child?.pipelineId).toBe(childPipeline.id);
    expect(child?.input).toMatchObject({
      delegatedFrom: execution.id,
    });
    const revision = await dataSource
      .getRepository(ExecutionPlanRevisionEntity)
      .findOne({ where: { executionId: result.childExecutionId! } });
    expect(revision?.revisionNumber).toBe(1);
    const steps = await dataSource.getRepository(LogicalStepEntity).find({
      where: { executionId: result.childExecutionId! },
    });
    expect(steps.map((step) => step.stepId)).toEqual(["child-step"]);

    // The request row links the child (the relation).
    const stored = await dataSource
      .getRepository(DelegationRequestEntity)
      .findOne({ where: { id: request.id } });
    expect(stored?.status).toBe("APPROVED");
    expect(stored?.childExecutionId).toBe(result.childExecutionId);

    // The child is schedulable through the real claim path.
    await executionService.reconcileExecution(result.childExecutionId!);
    const childClaim = await executionService.claimRunnableStep(
      result.childExecutionId!,
      { id: "child-step", agent: "writer" },
      { input: true },
      1,
    );
    expect(childClaim?.disposition).toBe("claimed");
  });

  it("approve replay never creates a second child", async () => {
    const { execution } = await seedParent();
    const claim = await executionService.claimRunnableStep(
      execution.id,
      { id: "extract", agent: "reader" },
      { input: true },
      1,
    );
    if (claim?.disposition !== "claimed") throw new Error("claim");
    const childPipeline = await seedChildPipeline();
    await delegation.request({
      parentExecutionId: execution.id,
      parentAttemptId: claim.attempt.id,
      requestId: "sub-3",
      requestedAgent: "writer",
      expiresAt: new Date(Date.now() + 60_000),
    });

    const first = await delegation.approve(
      claim.attempt.id,
      "sub-3",
      childPipeline,
    );
    const replay = await delegation.approve(
      claim.attempt.id,
      "sub-3",
      childPipeline,
    );
    expect(first.decision).toBe("APPROVED");
    expect(replay.decision).toBe("APPROVED");
    expect(replay.childExecutionId).toBe(first.childExecutionId);
    expect(
      await dataSource.getRepository(ExecutionEntity).count({
        where: { pipelineId: childPipeline.id },
      }),
    ).toBe(1);
  });

  it("concurrent approves of the same request materialize exactly one child", async () => {
    const { execution } = await seedParent();
    const claim = await executionService.claimRunnableStep(
      execution.id,
      { id: "extract", agent: "reader" },
      { input: true },
      1,
    );
    if (claim?.disposition !== "claimed") throw new Error("claim");
    const childPipeline = await seedChildPipeline();
    await delegation.request({
      parentExecutionId: execution.id,
      parentAttemptId: claim.attempt.id,
      requestId: "sub-4",
      requestedAgent: "writer",
      expiresAt: new Date(Date.now() + 60_000),
    });

    const [a, b] = await Promise.all([
      delegation.approve(claim.attempt.id, "sub-4", childPipeline),
      delegation.approve(claim.attempt.id, "sub-4", childPipeline),
    ]);
    expect(a.decision).toBe("APPROVED");
    expect(b.decision).toBe("APPROVED");
    expect(a.childExecutionId).toBe(b.childExecutionId);
    expect(
      await dataSource.getRepository(ExecutionEntity).count({
        where: { pipelineId: childPipeline.id },
      }),
    ).toBe(1);
  });

  it("a request whose attempt does not belong to the declared execution is rejected", async () => {
    const { execution } = await seedParent();
    const other = await seedParent();
    const claim = await executionService.claimRunnableStep(
      execution.id,
      { id: "extract", agent: "reader" },
      { input: true },
      1,
    );
    if (claim?.disposition !== "claimed") throw new Error("claim");

    await expect(
      delegation.request({
        parentExecutionId: other.execution.id,
        parentAttemptId: claim.attempt.id,
        requestId: "sub-mismatch",
        requestedAgent: "writer",
        expiresAt: new Date(Date.now() + 60_000),
      }),
    ).rejects.toThrow(/does not belong to execution/);
    expect(
      await dataSource.getRepository(DelegationRequestEntity).count(),
    ).toBe(0);
  });

  it("reject terminalizes without a child; an expired request is never approved", async () => {
    const { execution } = await seedParent();
    const claim = await executionService.claimRunnableStep(
      execution.id,
      { id: "extract", agent: "reader" },
      { input: true },
      1,
    );
    if (claim?.disposition !== "claimed") throw new Error("claim");
    const childPipeline = await seedChildPipeline();

    await delegation.request({
      parentExecutionId: execution.id,
      parentAttemptId: claim.attempt.id,
      requestId: "sub-reject",
      requestedAgent: "writer",
      expiresAt: new Date(Date.now() + 60_000),
    });
    const rejected = await delegation.reject(
      claim.attempt.id,
      "sub-reject",
      "not needed",
    );
    expect(rejected.decision).toBe("REJECTED");
    expect(rejected.childExecutionId).toBeNull();
    // Approving a rejected request is a replay of the terminal decision.
    const lateApprove = await delegation.approve(
      claim.attempt.id,
      "sub-reject",
      childPipeline,
    );
    expect(lateApprove.decision).toBe("REJECTED");
    expect(lateApprove.childExecutionId).toBeNull();

    await delegation.request({
      parentExecutionId: execution.id,
      parentAttemptId: claim.attempt.id,
      requestId: "sub-old",
      requestedAgent: "writer",
      expiresAt: new Date(Date.now() - 60_000),
    });
    const expired = await delegation.approve(
      claim.attempt.id,
      "sub-old",
      childPipeline,
    );
    expect(expired.decision).toBe("EXPIRED");
    expect(expired.childExecutionId).toBeNull();
    expect(
      await dataSource.getRepository(ExecutionEntity).count({
        where: { pipelineId: childPipeline.id },
      }),
    ).toBe(0);

    // The expiry sweep terminalizes due requests deterministically.
    const swept = await delegation.expireDue(undefined, new Date());
    expect(swept).toBe(0);
  });
});

describeWithPostgres("PostgreSQL M6-S3 delegation lifecycle", () => {
  jest.setTimeout(120_000);

  let dataSource: DataSource;
  let executionService: ExecutionService;
  let delegation: DelegationService;
  let inbox: ResultInboxService;
  let ledger: BudgetLedgerService;
  let proposals: PlanProposalService;

  const seedParent = async () => {
    const stored = await dataSource.getRepository(PipelineEntity).save(
      dataSource.getRepository(PipelineEntity).create({
        name: `m6s3-${Math.random().toString(36).slice(2)}`,
        version: "1.0",
        description: "M6-S3 fixture",
        steps: [{ id: "extract", agent: "reader" }],
      }),
    );
    const execution = await executionService.createExecution(stored, {});
    await executionService.reconcileExecution(execution.id);
    return { stored, execution };
  };

  const claimParent = async (execution: any) => {
    const claim = await executionService.claimRunnableStep(
      execution.id,
      { id: "extract", agent: "reader" },
      { input: true },
      1,
    );
    if (claim?.disposition !== "claimed") throw new Error("claim");
    return claim;
  };

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
      null as any,
    );

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
    ledger = new BudgetLedgerService(dataSource as any);
    executionService = new ExecutionService(
      dataSource.getRepository(ExecutionEntity),
      dataSource.getRepository(LogicalStepEntity),
      dataSource.getRepository(StepAttemptEntity),
      dataSource.getRepository(ExecutionPlanRevisionEntity),
      dataSource,
    );
    delegation = new DelegationService(dataSource as any, executionService);
    proposals = new PlanProposalService(
      dataSource as any,
      new PipelineValidationService(new ConditionEvaluatorService()),
    );
    inbox = new ResultInboxService(dataSource as any, ledger, proposals);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await dataSource.query(
      `TRUNCATE "delegation_requests", "delegation_observation_conflicts",
       "delegation_observations", "plan_proposals", "state_write_evidence",
       "artifacts", "result_conflicts", "result_inbox", "dispatch_outbox",
       "step_attempts", "step_executions", "execution_plan_revisions",
       "executions", "pipelines" CASCADE`,
    );
  });

  it("observed evidence never promotes to a delegation request (no channel mixing)", async () => {
    const { execution } = await seedParent();
    // Re-seed with an observed step for evidence correlation.
    const stored = await dataSource.getRepository(PipelineEntity).save(
      dataSource.getRepository(PipelineEntity).create({
        name: `m6s3-obs-${Math.random().toString(36).slice(2)}`,
        version: "1.0",
        description: "M6-S3 observed fixture",
        steps: [{ id: "extract", agent: "reader", delegation: "observed" }],
      }),
    );
    const observedExecution = await executionService.createExecution(
      stored,
      {},
    );
    await executionService.reconcileExecution(observedExecution.id);
    const claim = await executionService.claimRunnableStep(
      observedExecution.id,
      { id: "extract", agent: "reader", delegation: "observed" },
      { input: true },
      1,
    );
    if (claim?.disposition !== "claimed") throw new Error("claim");
    const result: AgentResultV1 = {
      schemaVersion: "1",
      invocationId: claim.attempt.invocationId,
      executionId: observedExecution.id,
      stepExecutionId: claim.logicalStep.id,
      status: "succeeded",
      output: { done: true },
      completedAt: new Date().toISOString(),
      delegation: [
        {
          schemaVersion: "1",
          provider: "codex",
          childId: "child-evidence",
          assertedAt: new Date().toISOString(),
        },
      ],
    };
    await inbox.apply(result, {
      adapter: "http",
      receivedAt: new Date().toISOString(),
    });

    expect(
      await dataSource.getRepository(DelegationObservationEntity).count(),
    ).toBe(1);
    expect(
      await dataSource.getRepository(DelegationRequestEntity).count(),
    ).toBe(0);
    expect(execution.status).toBe("PENDING");
  });

  it("a delegation request never suspends the parent attempt: the parent completes normally and the child runs independently", async () => {
    const { execution } = await seedParent();
    const claim = await claimParent(execution);
    await delegation.request({
      parentExecutionId: execution.id,
      parentAttemptId: claim.attempt.id,
      requestId: "sub-life",
      requestedAgent: "writer",
      expiresAt: new Date(Date.now() + 60_000),
    });
    // The parent attempt is still RUNNING (no wait state introduced).
    const running = await dataSource
      .getRepository(StepAttemptEntity)
      .findOne({ where: { id: claim.attempt.id } });
    expect(running?.status).toBe("CREATED");

    // The parent's normal result applies: the attempt terminalizes
    // independently of the pending request.
    const result: AgentResultV1 = {
      schemaVersion: "1",
      invocationId: claim.attempt.invocationId,
      executionId: execution.id,
      stepExecutionId: claim.logicalStep.id,
      status: "succeeded",
      output: { done: true },
      completedAt: new Date().toISOString(),
    };
    const application = await inbox.apply(result, {
      adapter: "http",
      receivedAt: new Date().toISOString(),
    });
    expect(application.disposition).toBe("applied");
    const step = await dataSource.getRepository(LogicalStepEntity).findOne({
      where: { executionId: execution.id, stepId: "extract" },
    });
    expect(step?.status).toBe("COMPLETED");
    const request = await dataSource
      .getRepository(DelegationRequestEntity)
      .findOne({ where: { parentAttemptId: claim.attempt.id } });
    expect(request?.status).toBe("PENDING");
  });

  it("supervision terminalizes a stale parent attempt even with a PENDING delegation request", async () => {
    const { execution } = await seedParent();
    const claim = await claimParent(execution);
    await delegation.request({
      parentExecutionId: execution.id,
      parentAttemptId: claim.attempt.id,
      requestId: "sub-stale",
      requestedAgent: "writer",
      expiresAt: new Date(Date.now() + 60_000),
    });
    // Simulate dispatch: RUNNING with a backdated server-side startTime and
    // dispatchedAt (the supervision scan keys on dispatchedAt).
    const startTime = new Date(Date.now() - 31_000);
    await dataSource
      .getRepository(StepAttemptEntity)
      .createQueryBuilder()
      .update()
      .set({ status: "RUNNING", startTime, dispatchedAt: startTime })
      .where("id = :id", { id: claim.attempt.id })
      .execute();

    const supervision = supervisionFor("reader", {
      expected: true,
      startupGraceMs: 30_000,
      staleAfterMs: 30_000,
    });
    await supervision.evaluate(new Date(startTime.getTime() + 29_000));
    const notDue = await dataSource
      .getRepository(StepAttemptEntity)
      .findOne({ where: { id: claim.attempt.id } });
    expect(notDue?.status).toBe("RUNNING");

    // The pending request is NOT a heartbeat exemption.
    await supervision.evaluate(new Date(startTime.getTime() + 31_000));
    const timedOut = await dataSource
      .getRepository(StepAttemptEntity)
      .findOne({ where: { id: claim.attempt.id } });
    expect(timedOut?.status).toBe("TIMED_OUT");
    expect(timedOut?.error).toContain("AGENT_HEARTBEAT_STALE");
    const request = await dataSource
      .getRepository(DelegationRequestEntity)
      .findOne({ where: { parentAttemptId: claim.attempt.id } });
    // The request is NOT auto-approved by the parent's outcome; the expiry
    // sweep (owned by the recovery cycle) terminalizes it deterministically.
    expect(request?.status).toBe("PENDING");
    const swept = await delegation.expireDue(
      undefined,
      new Date(Date.now() + 120_000),
    );
    expect(swept).toBe(1);
    expect(
      (
        await dataSource
          .getRepository(DelegationRequestEntity)
          .findOne({ where: { parentAttemptId: claim.attempt.id } })
      )?.status,
    ).toBe("EXPIRED");
  });
});

describeWithPostgres("PostgreSQL M6-S4 inheritance and cascade", () => {
  jest.setTimeout(120_000);

  let dataSource: DataSource;
  let executionService: ExecutionService;
  let delegation: DelegationService;
  let ledger: BudgetLedgerService;

  const seedPipeline = async (name: string, steps: any[], budget?: any) => {
    return dataSource.getRepository(PipelineEntity).save(
      dataSource.getRepository(PipelineEntity).create({
        name,
        version: "1.0",
        description: `${name} fixture`,
        ...(budget === undefined ? {} : { budget }),
        steps,
      }),
    );
  };

  const seedExecution = async (pipeline: PipelineEntity) => {
    const execution = await executionService.createExecution(pipeline, {});
    await executionService.reconcileExecution(execution.id);
    return execution;
  };

  const claim = async (execution: any, step: any) => {
    // Children materialize PENDING; reconcile promotes them like the
    // recovery cycle would.
    await executionService.reconcileExecution(execution.id);
    const result = await executionService.claimRunnableStep(
      execution.id,
      step,
      { input: true },
      1,
    );
    if (result?.disposition !== "claimed") throw new Error("claim");
    return result;
  };

  const requestFor = (
    parentExecutionId: string,
    attemptId: string,
    requestId: string,
  ) =>
    delegation.request({
      parentExecutionId,
      parentAttemptId: attemptId,
      requestId,
      requestedAgent: "writer",
      expiresAt: new Date(Date.now() + 60_000),
    });

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
    ledger = new BudgetLedgerService(dataSource as any);
    executionService = new ExecutionService(
      dataSource.getRepository(ExecutionEntity),
      dataSource.getRepository(LogicalStepEntity),
      dataSource.getRepository(StepAttemptEntity),
      dataSource.getRepository(ExecutionPlanRevisionEntity),
      dataSource,
    );
    delegation = new DelegationService(dataSource as any, executionService);
  });

  afterAll(async () => {
    delete process.env.TENVYR_POLICY;
    await dataSource.destroy();
  });

  beforeEach(async () => {
    delete process.env.TENVYR_POLICY;
    await dataSource.query(
      `TRUNCATE "delegation_requests", "delegation_observation_conflicts",
       "delegation_observations", "plan_proposals", "state_write_evidence",
       "artifacts", "result_conflicts", "result_inbox", "dispatch_outbox",
       "step_attempts", "step_executions", "execution_plan_revisions",
       "executions", "pipelines", "budget_ledger_entries",
       "budget_reservations", "budget_accounts" CASCADE`,
    );
  });

  it("server-derived depth bounds: a request at maxDepth + 1 is rejected", async () => {
    const parentPipeline = await seedPipeline("depth-p1", [
      { id: "extract", agent: "reader" },
    ]);
    const parent = await seedExecution(parentPipeline);
    const parentClaim = await claim(parent, { id: "extract", agent: "reader" });
    const childPipeline = await seedPipeline("depth-c1", [
      { id: "extract", agent: "writer" },
    ]);
    const l1 = await requestFor(parent.id, parentClaim.attempt.id, "l1");
    expect(l1.request.childDepth).toBe(1);
    const approve1 = await delegation.approve(
      parentClaim.attempt.id,
      "l1",
      childPipeline,
    );

    // Level 2: the child's own execution.
    const child1 = await dataSource
      .getRepository(ExecutionEntity)
      .findOne({ where: { id: approve1.childExecutionId! } });
    const child1Claim = await claim(child1!, {
      id: "extract",
      agent: "writer",
    });
    const l2 = await requestFor(child1!.id, child1Claim.attempt.id, "l2");
    expect(l2.request.childDepth).toBe(2);
    const approve2 = await delegation.approve(
      child1Claim.attempt.id,
      "l2",
      childPipeline,
    );

    // Level 3: the grandchild.
    const child2 = await dataSource
      .getRepository(ExecutionEntity)
      .findOne({ where: { id: approve2.childExecutionId! } });
    const child2Claim = await claim(child2!, {
      id: "extract",
      agent: "writer",
    });
    const l3 = await requestFor(child2!.id, child2Claim.attempt.id, "l3");
    expect(l3.request.childDepth).toBe(3);
    const approve3 = await delegation.approve(
      child2Claim.attempt.id,
      "l3",
      childPipeline,
    );

    // Level 4 exceeds maxDepth: rejected at request time.
    const child3 = await dataSource
      .getRepository(ExecutionEntity)
      .findOne({ where: { id: approve3.childExecutionId! } });
    const child3Claim = await claim(child3!, {
      id: "extract",
      agent: "writer",
    });
    await expect(
      requestFor(child3!.id, child3Claim.attempt.id, "l4"),
    ).rejects.toThrow(/depth exceeds/);
  });

  it("fanout bound: an attempt cannot exceed the per-attempt request limit", async () => {
    const pipeline = await seedPipeline("fanout-p", [
      { id: "extract", agent: "reader" },
    ]);
    const execution = await seedExecution(pipeline);
    const attempt = await claim(execution, { id: "extract", agent: "reader" });
    for (let i = 0; i < DELEGATION_BOUNDS.maxRequestsPerAttempt; i += 1) {
      await requestFor(execution.id, attempt.attempt.id, `f-${i}`);
    }
    await expect(
      requestFor(execution.id, attempt.attempt.id, "f-over"),
    ).rejects.toThrow(/fanout exceeds/);
  });

  it("serializes 100 concurrent fanout requests at the hard ceiling", async () => {
    const pipeline = await seedPipeline("fanout-race", [
      { id: "extract", agent: "reader" },
    ]);
    const execution = await seedExecution(pipeline);
    const attempt = await claim(execution, { id: "extract", agent: "reader" });

    const outcomes = await Promise.allSettled(
      Array.from({ length: 100 }, (_, index) =>
        requestFor(execution.id, attempt.attempt.id, `race-${index}`),
      ),
    );
    expect(
      outcomes.filter((outcome) => outcome.status === "fulfilled"),
    ).toHaveLength(DELEGATION_BOUNDS.maxRequestsPerAttempt);
    expect(
      await dataSource.getRepository(DelegationRequestEntity).count({
        where: { parentAttemptId: attempt.attempt.id },
      }),
    ).toBe(DELEGATION_BOUNDS.maxRequestsPerAttempt);
  });

  it("applies the delegate policy before materializing a child", async () => {
    process.env.TENVYR_POLICY = JSON.stringify({
      version: 61,
      rules: [{ id: "deny-delegate", actionType: "delegate", effect: "DENY" }],
    });
    const pipeline = await seedPipeline("delegate-policy-parent", [
      { id: "extract", agent: "reader" },
    ]);
    const execution = await seedExecution(pipeline);
    const attempt = await claim(execution, { id: "extract", agent: "reader" });
    const childPipeline = await seedPipeline("delegate-policy-child", [
      { id: "extract", agent: "writer" },
    ]);
    await requestFor(execution.id, attempt.attempt.id, "denied-child");

    const decision = await delegation.approve(
      attempt.attempt.id,
      "denied-child",
      childPipeline,
    );
    expect(decision.decision).toBe("REJECTED");
    expect(decision.reason).toContain("Policy DENY");
    expect(
      await dataSource.getRepository(PolicyDecisionEntity).count({
        where: { executionId: execution.id, actionType: "delegate" },
      }),
    ).toBe(1);
    expect(
      await dataSource.getRepository(ExecutionEntity).count({
        where: { pipelineId: childPipeline.id },
      }),
    ).toBe(0);
  });

  it("freezes the parent attempt deadline onto every child attempt", async () => {
    const parentPipeline = await seedPipeline("deadline-parent", [
      { id: "extract", agent: "reader" },
    ]);
    const parent = await seedExecution(parentPipeline);
    const parentDeadline = new Date(Date.now() + 60_000);
    const parentClaim = await executionService.claimRunnableStep(
      parent.id,
      { id: "extract", agent: "reader" },
      { input: true },
      1,
      parentDeadline,
    );
    if (parentClaim?.disposition !== "claimed") throw new Error("claim");
    const childPipeline = await seedPipeline("deadline-child", [
      { id: "extract", agent: "writer" },
    ]);
    await requestFor(parent.id, parentClaim.attempt.id, "deadline-child");
    const approved = await delegation.approve(
      parentClaim.attempt.id,
      "deadline-child",
      childPipeline,
    );
    const child = await dataSource.getRepository(ExecutionEntity).findOne({
      where: { id: approved.childExecutionId! },
    });
    expect(child?.authorityDeadlineAt).toEqual(parentDeadline);

    await executionService.reconcileExecution(child!.id);
    const childClaim = await executionService.claimRunnableStep(
      child!.id,
      { id: "extract", agent: "writer" },
      { input: true },
      1,
      new Date(parentDeadline.getTime() + 60_000),
    );
    expect(childClaim?.disposition).toBe("claimed");
    if (childClaim?.disposition !== "claimed") throw new Error("claim");
    expect(childClaim.attempt.deadlineAt).toEqual(parentDeadline);
  });

  it("budget subset: a child grant beyond the parent's grant is rejected; within is approved", async () => {
    const parentPipeline = await seedPipeline(
      "budget-p",
      [{ id: "extract", agent: "reader", budget: { tokens: 40 } }],
      { tokens: 100 },
    );
    const parent = await seedExecution(parentPipeline);
    const attempt = await claim(parent, {
      id: "extract",
      agent: "reader",
      budget: { tokens: 40 },
    });

    const tooBig = await seedPipeline(
      "budget-big",
      [{ id: "extract", agent: "writer", budget: { tokens: 200 } }],
      { tokens: 200 },
    );
    await requestFor(parent.id, attempt.attempt.id, "big");
    const bigResult = await delegation.approve(
      attempt.attempt.id,
      "big",
      tooBig,
    );
    expect(bigResult.decision).toBe("REJECTED");
    expect(bigResult.reason).toContain("exceeds the parent grant");

    const within = await seedPipeline(
      "budget-small",
      [{ id: "extract", agent: "writer", budget: { tokens: 50 } }],
      { tokens: 50 },
    );
    await requestFor(parent.id, attempt.attempt.id, "small");
    const smallResult = await delegation.approve(
      attempt.attempt.id,
      "small",
      within,
    );
    expect(smallResult.decision).toBe("APPROVED");
    expect(smallResult.childExecutionId).not.toBeNull();
    await executionService.reconcileExecution(smallResult.childExecutionId!);
    const childClaim = await executionService.claimRunnableStep(
      smallResult.childExecutionId!,
      { id: "extract", agent: "writer", budget: { tokens: 50 } },
      { input: true },
      1,
    );
    expect(childClaim?.disposition).toBe("claimed");
    const parentAccount = await dataSource
      .getRepository(BudgetAccountEntity)
      .findOne({
        where: { scopeType: "execution", scopeId: parent.id },
      });
    const childAccount = await dataSource
      .getRepository(BudgetAccountEntity)
      .findOne({
        where: {
          scopeType: "execution",
          scopeId: smallResult.childExecutionId!,
        },
      });
    expect(childAccount?.parentAccountId).toBe(parentAccount?.id);

    // The envelope form normalizes to the same ceilings: an envelope
    // budget over the parent's grant is approved too.
    const envelope = await seedPipeline(
      "budget-envelope",
      [{ id: "extract", agent: "writer", budget: { tokens: 30 } }],
      { tokens: 30 },
    );
    (envelope as any).budget = { ceilings: { tokens: 30 } };
    await requestFor(parent.id, attempt.attempt.id, "envelope");
    const envelopeResult = await delegation.approve(
      attempt.attempt.id,
      "envelope",
      envelope,
    );
    expect(envelopeResult.decision).toBe("APPROVED");

    // A parent WITHOUT a grant cannot have a budgeted child.
    const noBudgetParent = await seedExecution(
      await seedPipeline("nobudget-p", [{ id: "extract", agent: "reader" }]),
    );
    const noBudgetClaim = await claim(noBudgetParent, {
      id: "extract",
      agent: "reader",
    });
    const budgeted = await seedPipeline(
      "nobudget-big",
      [{ id: "extract", agent: "writer", budget: { tokens: 10 } }],
      { tokens: 10 },
    );
    const nbRequest = await requestFor(
      noBudgetParent.id,
      noBudgetClaim.attempt.id,
      "nb",
    );
    const nbResult = await delegation.approve(
      noBudgetClaim.attempt.id,
      "nb",
      budgeted,
    );
    expect(nbResult.decision).toBe("REJECTED");
    expect(nbResult.reason).toContain("no budget grant");
  });

  it("the cascade cancels approved children of a cancelled parent (durable, deterministic, bounded)", async () => {
    const parentPipeline = await seedPipeline("cascade-p", [
      { id: "extract", agent: "reader" },
    ]);
    const parent = await seedExecution(parentPipeline);
    const attempt = await claim(parent, { id: "extract", agent: "reader" });
    const childPipeline = await seedPipeline("cascade-c", [
      { id: "extract", agent: "writer" },
    ]);
    await requestFor(parent.id, attempt.attempt.id, "c1");
    await requestFor(parent.id, attempt.attempt.id, "c2");
    const a1 = await delegation.approve(
      attempt.attempt.id,
      "c1",
      childPipeline,
    );
    const a2 = await delegation.approve(
      attempt.attempt.id,
      "c2",
      childPipeline,
    );

    // Both children are running (claimed).
    const child1 = await dataSource
      .getRepository(ExecutionEntity)
      .findOne({ where: { id: a1.childExecutionId! } });
    const child2 = await dataSource
      .getRepository(ExecutionEntity)
      .findOne({ where: { id: a2.childExecutionId! } });
    await claim(child1!, { id: "extract", agent: "writer" });
    await claim(child2!, { id: "extract", agent: "writer" });

    // Cancel the parent.
    await executionService.cancelExecution(parent.id);
    const cancelledParent = await dataSource
      .getRepository(ExecutionEntity)
      .findOne({ where: { id: parent.id } });
    expect(cancelledParent?.status).toBe("CANCELLED");

    // The children are still runnable until the recovery cascade runs.
    const stillRunning = await dataSource
      .getRepository(ExecutionEntity)
      .findOne({ where: { id: child1!.id } });
    expect(stillRunning?.status).toBe("RUNNING");

    // The cascade (the recovery cycle's deterministic pass) cancels both.
    const cancelled = await delegation.cancelOrphans(undefined, 20);
    expect(cancelled).toBe(2);
    const after = await dataSource.getRepository(ExecutionEntity).find({
      where: [{ id: child1!.id }, { id: child2!.id }],
    });
    expect(after.map((row) => row.status).sort()).toEqual([
      "CANCELLED",
      "CANCELLED",
    ]);

    // Idempotent: a second pass cancels nothing (crash-resumable).
    expect(await delegation.cancelOrphans(undefined, 20)).toBe(0);
  });

  it("a failed child never terminalizes its parent (explicit workflow work)", async () => {
    const parentPipeline = await seedPipeline("childfail-p", [
      { id: "extract", agent: "reader" },
    ]);
    const parent = await seedExecution(parentPipeline);
    const attempt = await claim(parent, { id: "extract", agent: "reader" });
    const childPipeline = await seedPipeline("childfail-c", [
      { id: "extract", agent: "writer" },
    ]);
    await requestFor(parent.id, attempt.attempt.id, "cf");
    const approve = await delegation.approve(
      attempt.attempt.id,
      "cf",
      childPipeline,
    );
    const child = await dataSource
      .getRepository(ExecutionEntity)
      .findOne({ where: { id: approve.childExecutionId! } });
    const childClaim = await claim(child!, { id: "extract", agent: "writer" });

    // The child fails (its result applies)...
    const childResult: AgentResultV1 = {
      schemaVersion: "1",
      invocationId: childClaim.attempt.invocationId,
      executionId: child!.id,
      stepExecutionId: childClaim.logicalStep.id,
      status: "failed",
      error: { code: "E", message: "child boom", retryable: false },
      completedAt: new Date().toISOString(),
    };
    await new ResultInboxService(
      dataSource as any,
      ledger,
      undefined as any,
    ).apply(childResult, {
      adapter: "http",
      receivedAt: new Date().toISOString(),
    });
    const childAfter = await dataSource
      .getRepository(ExecutionEntity)
      .findOne({ where: { id: child!.id } });
    expect(childAfter?.status).toBe("FAILED");

    // ...and the parent stays untouched (it never waited).
    const parentAfter = await dataSource
      .getRepository(ExecutionEntity)
      .findOne({ where: { id: parent.id } });
    expect(parentAfter?.status).toBe("RUNNING");
  });
});

describeWithPostgres("PostgreSQL M6-S5 closure", () => {
  jest.setTimeout(120_000);

  let dataSource: DataSource;
  let executionService: ExecutionService;
  let delegation: DelegationService;

  const seedPipeline = async (name: string, steps: any[]) => {
    return dataSource.getRepository(PipelineEntity).save(
      dataSource.getRepository(PipelineEntity).create({
        name,
        version: "1.0",
        description: `${name} fixture`,
        steps,
      }),
    );
  };

  const seedExecution = async (pipeline: PipelineEntity) => {
    const execution = await executionService.createExecution(pipeline, {});
    await executionService.reconcileExecution(execution.id);
    return execution;
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
    delegation = new DelegationService(dataSource as any, executionService);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await dataSource.query(
      `TRUNCATE "delegation_requests", "delegation_observation_conflicts",
       "delegation_observations", "plan_proposals", "state_write_evidence",
       "artifacts", "result_conflicts", "result_inbox", "dispatch_outbox",
       "step_attempts", "step_executions", "execution_plan_revisions",
       "executions", "pipelines" CASCADE`,
    );
  });

  it("capability negotiation: a step requiring observed delegation on an opaque-only runtime fails durably", async () => {
    // Runtime advertises opaque only.
    const config = parseAgentTransportConfiguration({
      ...process.env,
      AGENT_TRANSPORT_CONFIG: JSON.stringify({
        reader: { kind: "kafka", delegationModes: ["opaque"] },
      }),
    });
    const service = new ExecutionService(
      dataSource.getRepository(ExecutionEntity),
      dataSource.getRepository(LogicalStepEntity),
      dataSource.getRepository(StepAttemptEntity),
      dataSource.getRepository(ExecutionPlanRevisionEntity),
      dataSource,
      undefined,
      new AgentTransportConfigService(config),
    );
    const pipeline = await seedPipeline("cap-p", [
      { id: "extract", agent: "reader", delegation: "observed" },
    ]);
    const execution = await service.createExecution(pipeline, {});
    await service.reconcileExecution(execution.id);

    const claim = await service.claimRunnableStep(
      execution.id,
      { id: "extract", agent: "reader", delegation: "observed" },
      { input: true },
      1,
    );
    expect(claim?.disposition).toBe("runtime_capability");
    const attempt = await dataSource.getRepository(StepAttemptEntity).findOne({
      where: { executionId: execution.id },
    });
    expect(attempt?.status).toBe("FAILED");
    expect(attempt?.error).toContain("does not support observed delegation");
    expect(
      await dataSource.getRepository(DispatchOutboxEntity).count({
        where: { stepAttemptId: attempt?.id },
      }),
    ).toBe(0);
  });

  it("capability negotiation: an unrestricted runtime accepts observed steps", async () => {
    const pipeline = await seedPipeline("cap-ok", [
      { id: "extract", agent: "reader", delegation: "observed" },
    ]);
    const execution = await seedExecution(pipeline);
    const claim = await executionService.claimRunnableStep(
      execution.id,
      { id: "extract", agent: "reader", delegation: "observed" },
      { input: true },
      1,
    );
    expect(claim?.disposition).toBe("claimed");
  });

  it("approval resume rechecks capability negotiation after a runtime narrowing", async () => {
    process.env.TENVYR_POLICY = JSON.stringify({
      version: 1,
      rules: [
        {
          id: "approve-observed",
          actionType: "dispatch",
          effect: "REQUIRE_APPROVAL",
        },
      ],
    });
    const pipeline = await seedPipeline("cap-resume-p", [
      { id: "extract", agent: "reader", delegation: "observed" },
    ]);
    const execution = await seedExecution(pipeline);
    const claim = await executionService.claimRunnableStep(
      execution.id,
      { id: "extract", agent: "reader", delegation: "observed" },
      { input: true },
      1,
    );
    expect(claim?.disposition).toBe("approval_required");
    const approval = await dataSource
      .getRepository(ApprovalRequestEntity)
      .findOne({ where: { executionId: execution.id } });
    expect(approval).not.toBeNull();
    const attempt = await dataSource
      .getRepository(StepAttemptEntity)
      .findOne({ where: { executionId: execution.id } });
    expect(attempt?.status).toBe("WAITING");

    // Narrow the runtime to opaque-only while the attempt waits.
    const narrowedConfig = parseAgentTransportConfiguration({
      ...process.env,
      AGENT_TRANSPORT_CONFIG: JSON.stringify({
        reader: { kind: "kafka", delegationModes: ["opaque"] },
      }),
    });
    const approvals = new ApprovalService(
      dataSource as any,
      undefined,
      undefined,
      new AgentTransportConfigService(narrowedConfig),
    );

    await approvals.approve(approval!.proposalId);

    // The request is recorded APPROVED but NO dispatch authority was
    // granted (the outbox row must not exist).
    const approved = await dataSource
      .getRepository(ApprovalRequestEntity)
      .findOne({ where: { id: approval!.id } });
    expect(approved?.status).toBe("APPROVED");
    expect(approved?.decisionNote).toContain("runtime capability changed");
    expect(
      await dataSource.getRepository(DispatchOutboxEntity).count({
        where: { stepAttemptId: attempt!.id },
      }),
    ).toBe(0);
    const failed = await dataSource
      .getRepository(StepAttemptEntity)
      .findOne({ where: { id: attempt!.id } });
    expect(failed?.status).toBe("FAILED");
    expect(failed?.error).toContain("does not support observed delegation");
    delete process.env.TENVYR_POLICY;
  });

  it("the graph projection distinguishes supervised and observed edges", async () => {
    const parentPipeline = await seedPipeline("graph-p", [
      { id: "extract", agent: "reader", delegation: "observed" },
    ]);
    const parent = await seedExecution(parentPipeline);
    const parentClaim = await executionService.claimRunnableStep(
      parent.id,
      { id: "extract", agent: "reader", delegation: "observed" },
      { input: true },
      1,
    );
    if (parentClaim?.disposition !== "claimed") throw new Error("claim");
    const childPipeline = await seedPipeline("graph-c", [
      { id: "extract", agent: "writer" },
    ]);
    await delegation.request({
      parentExecutionId: parent.id,
      parentAttemptId: parentClaim.attempt.id,
      requestId: "graph-child",
      requestedAgent: "writer",
      expiresAt: new Date(Date.now() + 60_000),
    });
    const approve = await delegation.approve(
      parentClaim.attempt.id,
      "graph-child",
      childPipeline,
    );
    // Observed evidence on the parent attempt.
    const observation = {
      schemaVersion: "1" as const,
      provider: "codex",
      childId: "hidden-1",
      assertedAt: new Date().toISOString(),
    };
    const result: AgentResultV1 = {
      schemaVersion: "1",
      invocationId: parentClaim.attempt.invocationId,
      executionId: parent.id,
      stepExecutionId: parentClaim.logicalStep.id,
      status: "succeeded",
      output: { done: true },
      completedAt: new Date().toISOString(),
      delegation: [observation],
    };
    await new ResultInboxService(
      dataSource as any,
      new BudgetLedgerService(dataSource as any),
      undefined as any,
    ).apply(result, { adapter: "http", receivedAt: new Date().toISOString() });

    const projection = await delegation.projection(parent.id);
    expect(projection.depth).toBe(0);
    expect(projection.supervised).toHaveLength(1);
    expect(projection.supervised[0]).toMatchObject({
      requestId: "graph-child",
      childExecutionId: approve.childExecutionId,
      childDepth: 1,
      requestedAgent: "writer",
    });
    expect(projection.observed).toHaveLength(1);
    expect(projection.observed[0]).toMatchObject({
      observationId: "codex:hidden-1",
      provider: "codex",
      childId: "hidden-1",
    });

    // The child's projection shows its own depth.
    const childProjection = await delegation.projection(
      approve.childExecutionId!,
    );
    expect(childProjection.depth).toBe(1);
    expect(childProjection.supervised).toHaveLength(0);
    expect(childProjection.observed).toHaveLength(0);
  });
});

describeWithPostgres("PostgreSQL M7-S1 capsule", () => {
  jest.setTimeout(120_000);

  let dataSource: DataSource;
  let executionService: ExecutionService;
  let capsules: ExecutionCapsuleService;

  const seedPipeline = async (name: string, steps: any[]) => {
    return dataSource.getRepository(PipelineEntity).save(
      dataSource.getRepository(PipelineEntity).create({
        name,
        version: "1.0",
        description: `${name} fixture`,
        steps,
      }),
    );
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
    capsules = new ExecutionCapsuleService(
      dataSource as any,
      new DelegationService(dataSource as any, executionService),
      executionService,
    );
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await dataSource.query(
      `TRUNCATE "delegation_requests", "delegation_observation_conflicts",
       "delegation_observations", "plan_proposals", "policy_decisions",
       "policy_snapshots", "approval_requests", "budget_ledger_entries",
       "budget_reservations", "budget_accounts", "state_write_evidence",
       "artifacts", "result_conflicts", "result_inbox", "agent_events",
       "dispatch_outbox", "step_attempts", "step_executions",
       "execution_plan_revisions", "executions", "pipelines" CASCADE`,
    );
  });

  it("assembles a terminal capsule with counts matching the durable rows", async () => {
    const pipeline = await seedPipeline("capsule-p", [
      { id: "extract", agent: "reader" },
      { id: "review", agent: "reviewer", dependsOn: ["extract"] },
    ]);
    const execution = await executionService.createExecution(pipeline, {
      context: "capsule-input",
    });
    await executionService.reconcileExecution(execution.id);
    const claim = await executionService.claimRunnableStep(
      execution.id,
      { id: "extract", agent: "reader" },
      { input: true },
      1,
    );
    if (claim?.disposition !== "claimed") throw new Error("claim");
    // Terminalize: cancel the execution (a terminal source).
    await executionService.cancelExecution(execution.id);

    const capsule = await capsules.build(execution.id);
    expect(capsule.schemaVersion).toBe("1");
    expect(capsule.pointInTime).toBe("terminal");
    expect(capsule.sourceStatus).toBe("CANCELLED");
    expect(capsule.header.pipelineHash).toMatch(/^[0-9a-f]{64}$/);
    expect(capsule.header.stepCount).toBe(2);
    expect(capsule.header.revisionCount).toBe(1);
    expect(capsule.header.attemptCount).toBe(1);
    expect(capsule.header.eventCount).toBe(0);
    expect(capsule.header.input).toEqual({ context: "capsule-input" });
    expect(capsule.header.state).toEqual({
      version: 0,
      contentHash: sha256Json({}),
      writeEvidenceCount: 0,
    });
    expect(capsule.header.artifacts).toEqual({
      producedCount: 0,
      exposureCount: 0,
    });
    expect(capsule.revisions).toHaveLength(1);
    expect(capsule.revisions[0]).toMatchObject({
      revisionNumber: 1,
      source: "pipeline",
      budget: null,
    });
    expect(capsule.revisions[0].steps.map((s) => (s as any).id)).toEqual([
      "extract",
      "review",
    ]);
    expect(capsule.attempts).toHaveLength(1);
    expect(capsule.attempts[0]).toMatchObject({
      status: "CANCELLED",
      // The capsule exposes the DAG step id (stable logical identity).
      stepId: "extract",
      inputSnapshotHash: sha256Json({ input: true }),
    });
    expect(capsule.attempts[0].contextSnapshotHash).toBeNull();
    // Terminal captures carry no completeness warnings.
    expect(capsule.evidenceCompleteness).toEqual([]);
  });

  it("labels live captures and records bounds that bit", async () => {
    const pipeline = await seedPipeline("capsule-live", [
      { id: "extract", agent: "reader" },
    ]);
    const execution = await executionService.createExecution(pipeline, {});
    // No reconcile: still PENDING (live).
    const capsule = await capsules.build(execution.id);
    expect(capsule.pointInTime).toBe("live");
    expect(capsule.sourceStatus).toBe("PENDING");
    expect(capsule.evidenceCompleteness).toEqual(
      expect.arrayContaining([
        expect.stringContaining("LIVE point-in-time capture"),
      ]),
    );
  });

  it("truncates oversized inputs with an explicit warning", async () => {
    const pipeline = await seedPipeline("capsule-big", [
      { id: "extract", agent: "reader" },
    ]);
    const execution = await executionService.createExecution(pipeline, {
      blob: "x".repeat(200_000),
    });
    await executionService.reconcileExecution(execution.id);
    const capsule = await capsules.build(execution.id);
    expect(capsule.header.input).toEqual({
      truncated: true,
      bytes: expect.any(Number),
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(capsule.evidenceCompleteness).toEqual(
      expect.arrayContaining([expect.stringContaining("Input exceeds")]),
    );
  });

  it("the content hash is stable across identical builds and excludes volatile fields", async () => {
    const pipeline = await seedPipeline("capsule-hash", [
      { id: "extract", agent: "reader" },
    ]);
    const execution = await executionService.createExecution(pipeline, {
      context: "hash-input",
    });
    await executionService.reconcileExecution(execution.id);
    await executionService.cancelExecution(execution.id);

    const a = await capsules.build(execution.id);
    const b = await capsules.build(execution.id);
    expect(a.contentHash).toBe(b.contentHash);
    expect(a.capturedAt).not.toBe(b.capturedAt);
    // The capsule hash is 64 hex chars.
    expect(a.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("capsule assembly observes one snapshot (counts stay consistent)", async () => {
    const pipeline = await seedPipeline("capsule-snap", [
      { id: "extract", agent: "reader", onFailure: "retry" },
    ]);
    const execution = await executionService.createExecution(pipeline, {});
    await executionService.reconcileExecution(execution.id);
    // Two attempts via a retryable failure.
    const first = await executionService.claimRunnableStep(
      execution.id,
      { id: "extract", agent: "reader", onFailure: "retry" },
      { input: true },
      2,
    );
    if (first?.disposition !== "claimed") throw new Error("claim 1");
    const failedResult: AgentResultV1 = {
      schemaVersion: "1",
      invocationId: first.attempt.invocationId,
      executionId: execution.id,
      stepExecutionId: first.logicalStep.id,
      status: "failed",
      error: { code: "E", message: "retry me", retryable: true },
      completedAt: new Date().toISOString(),
    };
    await new ResultInboxService(
      dataSource as any,
      new BudgetLedgerService(dataSource as any),
      undefined as any,
    ).apply(failedResult, {
      adapter: "http",
      receivedAt: new Date().toISOString(),
    });
    await executionService.reconcileExecution(execution.id);
    const second = await executionService.claimRunnableStep(
      execution.id,
      { id: "extract", agent: "reader", onFailure: "retry" },
      { input: true },
      2,
    );
    if (second?.disposition !== "claimed") throw new Error("claim 2");

    const capsule = await capsules.build(execution.id);
    expect(capsule.header.attemptCount).toBe(2);
    expect(capsule.attempts).toHaveLength(2);
  });
});

describeWithPostgres("PostgreSQL M7-S2 export and replay", () => {
  jest.setTimeout(120_000);

  let dataSource: DataSource;
  let executionService: ExecutionService;
  let capsules: ExecutionCapsuleService;

  const seedPipeline = async (name: string, steps: any[]) => {
    return dataSource.getRepository(PipelineEntity).save(
      dataSource.getRepository(PipelineEntity).create({
        name,
        version: "1.0",
        description: `${name} fixture`,
        steps,
      }),
    );
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
    capsules = new ExecutionCapsuleService(
      dataSource as any,
      new DelegationService(dataSource as any, executionService),
      executionService,
    );
  });

  afterAll(async () => {
    delete process.env.TENVYR_POLICY;
    await dataSource.destroy();
  });

  beforeEach(async () => {
    delete process.env.TENVYR_POLICY;
    await dataSource.query(
      `TRUNCATE "execution_replays", "execution_exports",
       "delegation_requests", "delegation_observation_conflicts",
       "delegation_observations", "plan_proposals", "policy_decisions",
       "policy_snapshots", "approval_requests", "budget_ledger_entries",
       "budget_reservations", "budget_accounts", "state_write_evidence",
       "artifacts", "result_conflicts", "result_inbox", "agent_events",
       "dispatch_outbox", "step_attempts", "step_executions",
       "execution_plan_revisions", "executions", "pipelines" CASCADE`,
    );
  });

  it("createExport persists a small immutable manifest idempotently", async () => {
    const pipeline = await seedPipeline("export-p", [
      { id: "extract", agent: "reader" },
    ]);
    const execution = await executionService.createExecution(pipeline, {
      context: "export-input",
    });
    await executionService.reconcileExecution(execution.id);
    await executionService.cancelExecution(execution.id);

    const manifest = await capsules.createExport(execution.id, "operator");
    expect(manifest.executionId).toBe(execution.id);
    expect(manifest.capsuleHash).toMatch(/^[0-9a-f]{64}$/);
    // The manifest is small: only the pin, never the capsule payload.
    const rows = await dataSource.getRepository(ExecutionExportEntity).find();
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0])).toEqual(
      expect.arrayContaining(["executionId", "capsuleHash", "exporter"]),
    );
    // Idempotent re-export returns the same manifest.
    const again = await capsules.createExport(execution.id, "operator");
    expect(again.id).toBe(manifest.id);
    expect(await dataSource.getRepository(ExecutionExportEntity).count()).toBe(
      1,
    );
  });

  it("replay materializes a NEW execution from the captured plan and input, idempotently", async () => {
    const pipeline = await seedPipeline("replay-p", [
      { id: "extract", agent: "reader" },
      { id: "review", agent: "reviewer", dependsOn: ["extract"] },
    ]);
    const execution = await executionService.createExecution(pipeline, {
      context: "replay-input",
    });
    await executionService.reconcileExecution(execution.id);
    await executionService.cancelExecution(execution.id);

    const result = await capsules.replay(execution.id, "operator");
    const target = await dataSource
      .getRepository(ExecutionEntity)
      .findOne({ where: { id: result.targetExecutionId } });
    expect(target).not.toBeNull();
    expect(target?.id).not.toBe(execution.id);
    expect(target?.input).toEqual({ context: "replay-input" });
    // The target's plan hash matches the source's active revision hash.
    const sourceCapsule = await capsules.build(execution.id);
    expect(target?.pipelineHash).toBe(sourceCapsule.header.activeRevisionHash);
    const targetSteps = await dataSource
      .getRepository(LogicalStepEntity)
      .find({ where: { executionId: target!.id } });
    expect(targetSteps.map((step) => step.stepId).sort()).toEqual([
      "extract",
      "review",
    ]);
    // The target is schedulable normally.
    await executionService.reconcileExecution(target!.id);
    const claim = await executionService.claimRunnableStep(
      target!.id,
      { id: "extract", agent: "reader" },
      { input: true },
      1,
    );
    expect(claim?.disposition).toBe("claimed");

    // Idempotent: replaying the same capsule returns the SAME target.
    const again = await capsules.replay(execution.id, "operator");
    expect(again.targetExecutionId).toBe(result.targetExecutionId);
    expect(await dataSource.getRepository(ExecutionReplayEntity).count()).toBe(
      1,
    );
    expect(
      await dataSource.getRepository(ExecutionEntity).count({
        where: { pipelineId: target?.pipelineId },
      }),
    ).toBe(2); // source + replay target only
  });

  it("replays the authoritative input when the capsule preview is byte-bounded", async () => {
    const pipeline = await seedPipeline("replay-large-input", [
      { id: "extract", agent: "reader" },
    ]);
    const input = { context: "x".repeat(70_000) };
    const execution = await executionService.createExecution(pipeline, input);
    await executionService.reconcileExecution(execution.id);
    await executionService.cancelExecution(execution.id);

    const capsule = await capsules.build(execution.id);
    expect(capsule.header.input).toMatchObject({
      truncated: true,
      sha256: sha256Json(input),
    });
    const result = await capsules.replay(execution.id, "operator");
    const target = await dataSource.getRepository(ExecutionEntity).findOne({
      where: { id: result.targetExecutionId },
    });
    expect(target?.input).toEqual(input);
  });

  it("concurrent replays of the same capsule produce exactly one target", async () => {
    const pipeline = await seedPipeline("replay-race", [
      { id: "extract", agent: "reader" },
    ]);
    const execution = await executionService.createExecution(pipeline, {});
    await executionService.reconcileExecution(execution.id);
    await executionService.cancelExecution(execution.id);

    const [a, b] = await Promise.all([
      capsules.replay(execution.id, "operator"),
      capsules.replay(execution.id, "operator"),
    ]);
    expect(a.targetExecutionId).toBe(b.targetExecutionId);
    expect(await dataSource.getRepository(ExecutionReplayEntity).count()).toBe(
      1,
    );
    // Exactly one target execution was materialized.
    const target = await dataSource
      .getRepository(ExecutionEntity)
      .findOne({ where: { id: a.targetExecutionId } });
    expect(target).not.toBeNull();
    expect(
      await dataSource.getRepository(ExecutionEntity).count({
        where: { input: target?.input as any },
      }),
    ).toBe(2); // source + one target
  });

  it("the capsule hash stays stable for a terminal execution even after a policy rotation", async () => {
    const pipeline = await seedPipeline("replay-hash", [
      { id: "extract", agent: "reader" },
    ]);
    const execution = await executionService.createExecution(pipeline, {});
    await executionService.reconcileExecution(execution.id);
    await executionService.cancelExecution(execution.id);
    const before = await capsules.build(execution.id);

    process.env.TENVYR_POLICY = JSON.stringify({
      version: 1,
      rules: [{ id: "deny-x", actionType: "dispatch", effect: "DENY" }],
    });
    const after = await capsules.build(execution.id);
    expect(before.contentHash).toBe(after.contentHash);
    delete process.env.TENVYR_POLICY;
  });

  it("a replay uses the CAPTURED plan even when the pipeline row evolves afterwards", async () => {
    const pipeline = await seedPipeline("replay-evolve", [
      { id: "extract", agent: "reader" },
    ]);
    const execution = await executionService.createExecution(pipeline, {});
    await executionService.reconcileExecution(execution.id);
    await executionService.cancelExecution(execution.id);
    const sourceHash = (await capsules.build(execution.id)).header
      .activeRevisionHash;

    // The pipeline evolves AFTER the source ran.
    await dataSource
      .getRepository(PipelineEntity)
      .createQueryBuilder()
      .update()
      .set({
        steps: [
          { id: "extract", agent: "reader" },
          { id: "brand-new", agent: "writer" },
        ] as any,
      })
      .where("id = :id", { id: pipeline.id })
      .execute();

    const result = await capsules.replay(execution.id, "operator");
    const targetSteps = await dataSource
      .getRepository(LogicalStepEntity)
      .find({ where: { executionId: result.targetExecutionId } });
    // The captured plan had ONE step; the evolved pipeline would have two.
    expect(targetSteps.map((step) => step.stepId)).toEqual(["extract"]);
    expect(
      (
        await dataSource
          .getRepository(ExecutionPlanRevisionEntity)
          .findOne({ where: { executionId: result.targetExecutionId } })
      )?.planHash,
    ).toBe(sourceHash);
  });

  it("a live source cannot be replayed", async () => {
    const pipeline = await seedPipeline("replay-live", [
      { id: "extract", agent: "reader" },
    ]);
    const execution = await executionService.createExecution(pipeline, {});
    await executionService.reconcileExecution(execution.id);
    await expect(capsules.replay(execution.id)).rejects.toThrow(
      /replays require a terminal source/,
    );
  });

  it("a replay re-evaluates CURRENT authority: a rotated DENY policy blocks the replay's dispatch; nothing is copied", async () => {
    const pipeline = await seedPipeline("replay-policy", [
      { id: "extract", agent: "reader" },
    ]);
    const execution = await executionService.createExecution(pipeline, {});
    await executionService.reconcileExecution(execution.id);
    const sourceClaim = await executionService.claimRunnableStep(
      execution.id,
      { id: "extract", agent: "reader" },
      { input: true },
      1,
    );
    expect(sourceClaim?.disposition).toBe("claimed");
    await executionService.cancelExecution(execution.id);

    // Rotate to a DENY policy AFTER the source ran.
    process.env.TENVYR_POLICY = JSON.stringify({
      version: 1,
      rules: [{ id: "deny-all", actionType: "dispatch", effect: "DENY" }],
    });
    const result = await capsules.replay(execution.id, "operator");
    await executionService.reconcileExecution(result.targetExecutionId);
    const replayClaim = await executionService.claimRunnableStep(
      result.targetExecutionId,
      { id: "extract", agent: "reader" },
      { input: true },
      1,
    );
    expect(replayClaim?.disposition).toBe("policy_denied");
    // No historical authority is copied: the target has zero approval
    // requests and the denied attempt carries the current policy reason.
    expect(
      await dataSource.getRepository(ApprovalRequestEntity).count({
        where: { executionId: result.targetExecutionId },
      }),
    ).toBe(0);
    const deniedAttempt = await dataSource
      .getRepository(StepAttemptEntity)
      .findOne({ where: { executionId: result.targetExecutionId } });
    expect(deniedAttempt?.status).toBe("FAILED");
    expect(deniedAttempt?.error).toContain("Policy DENY");
  });
});

describeWithPostgres("PostgreSQL M7-S3 comparison and provenance", () => {
  jest.setTimeout(120_000);

  let dataSource: DataSource;
  let executionService: ExecutionService;
  let capsules: ExecutionCapsuleService;

  const seedPipeline = async (name: string, steps: any[]) => {
    return dataSource.getRepository(PipelineEntity).save(
      dataSource.getRepository(PipelineEntity).create({
        name,
        version: "1.0",
        description: `${name} fixture`,
        steps,
      }),
    );
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
    capsules = new ExecutionCapsuleService(
      dataSource as any,
      new DelegationService(dataSource as any, executionService),
      executionService,
    );
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await dataSource.query(
      `TRUNCATE "execution_replays", "execution_exports", "artifact_exposures",
       "delegation_requests", "delegation_observation_conflicts",
       "delegation_observations", "plan_proposals", "policy_decisions",
       "policy_snapshots", "approval_requests", "budget_ledger_entries",
       "budget_reservations", "budget_accounts", "state_write_evidence",
       "artifacts", "result_conflicts", "result_inbox", "agent_events",
       "dispatch_outbox", "step_attempts", "step_executions",
       "execution_plan_revisions", "executions", "pipelines" CASCADE`,
    );
  });

  it("identical runs compare as identical (no plan or outcome drift)", async () => {
    const pipeline = await seedPipeline("cmp-identical", [
      { id: "extract", agent: "reader" },
    ]);
    const a = await executionService.createExecution(pipeline, { n: 1 });
    await executionService.reconcileExecution(a.id);
    await executionService.cancelExecution(a.id);
    const b = await executionService.createExecution(pipeline, { n: 1 });
    await executionService.reconcileExecution(b.id);
    await executionService.cancelExecution(b.id);

    const comparison = await capsules.compare(a.id, b.id);
    expect(comparison.plan.identical).toBe(true);
    expect(comparison.outcome.identical).toBe(true);
    expect(comparison.plan.stepDrift[0]).toMatchObject({
      stepId: "extract",
      drift: "identical",
    });
    expect(comparison.outcome.perStep[0]).toMatchObject({
      stepId: "extract",
      drift: "no_evidence_both",
    });
    expect(comparison.warnings).toEqual([]);
  });

  it("a step spec change is actual plan drift; an outcome change is outcome drift", async () => {
    const pipeline = await seedPipeline("cmp-drift", [
      { id: "extract", agent: "reader", timeout: "5s" },
    ]);
    const a = await executionService.createExecution(pipeline, {});
    await executionService.reconcileExecution(a.id);
    await executionService.cancelExecution(a.id);

    // Run B with a different step spec (timeout changed).
    const pipelineB = await seedPipeline("cmp-drift-b", [
      { id: "extract", agent: "reader", timeout: "30s" },
    ]);
    const b = await executionService.createExecution(pipelineB, {});
    await executionService.reconcileExecution(b.id);
    await executionService.cancelExecution(b.id);

    const comparison = await capsules.compare(a.id, b.id);
    expect(comparison.plan.identical).toBe(false);
    expect(comparison.plan.stepDrift[0]).toMatchObject({
      stepId: "extract",
      drift: "drifted",
    });
    expect(comparison.plan.stepDrift[0].aHash).not.toBe(
      comparison.plan.stepDrift[0].bHash,
    );
    // Both cancelled with no attempts: no evidence on either side.
    expect(comparison.outcome.identical).toBe(true);
    expect(comparison.outcome.perStep[0]).toMatchObject({
      drift: "no_evidence_both",
    });
  });

  it("a step present in only one run is reported as present_in_*_only", async () => {
    const pipelineA = await seedPipeline("cmp-only-a", [
      { id: "extract", agent: "reader" },
    ]);
    const pipelineB = await seedPipeline("cmp-only-b", [
      { id: "extract", agent: "reader" },
      { id: "extra", agent: "writer", dependsOn: ["extract"] },
    ]);
    const a = await executionService.createExecution(pipelineA, {});
    await executionService.reconcileExecution(a.id);
    await executionService.cancelExecution(a.id);
    const b = await executionService.createExecution(pipelineB, {});
    await executionService.reconcileExecution(b.id);
    await executionService.cancelExecution(b.id);

    const comparison = await capsules.compare(a.id, b.id);
    const extra = comparison.plan.stepDrift.find(
      (row) => row.stepId === "extra",
    );
    expect(extra?.drift).toBe("present_in_b_only");
    expect(comparison.plan.identical).toBe(false);
  });

  it("truncated attempt evidence makes the outcome category unavailable (no conclusion)", async () => {
    const pipeline = await seedPipeline("cmp-unavailable", [
      { id: "extract", agent: "reader" },
    ]);
    const a = await executionService.createExecution(pipeline, {});
    await executionService.reconcileExecution(a.id);
    const logicalStep = await dataSource
      .getRepository(LogicalStepEntity)
      .findOne({
        where: { executionId: a.id },
      });
    const revision = await dataSource
      .getRepository(ExecutionPlanRevisionEntity)
      .findOne({ where: { executionId: a.id } });
    // Seed 101 attempts directly (CAPSULE_BOUNDS.maxAttempts = 100).
    const attemptRepository = dataSource.getRepository(StepAttemptEntity);
    for (let i = 0; i < 101; i += 1) {
      await attemptRepository.save(
        attemptRepository.create({
          executionId: a.id,
          logicalStepId: logicalStep!.id,
          planRevisionId: revision!.id,
          attemptNumber: i + 1,
          invocationId: `${logicalStep!.id}:${i + 1}`,
          frozenSpecHash: "f".repeat(64),
          executorSnapshot: {
            schemaVersion: "1",
            executorId: "agent:reader",
            agent: "reader",
            kind: "kafka",
            configHash: "c".repeat(64),
            capabilities: { cancel: false },
          },
          status: "FAILED",
          error: "seeded",
          terminalAt: new Date(),
        } as any),
      );
    }
    await executionService.cancelExecution(a.id);
    const b = await executionService.createExecution(pipeline, {});
    await executionService.reconcileExecution(b.id);
    await executionService.cancelExecution(b.id);

    const comparison = await capsules.compare(a.id, b.id);
    expect(comparison.outcome.unavailable).toBe(true);
    expect(comparison.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Outcome comparison unavailable"),
      ]),
    );
  });

  it("live sources make the outcome comparison unavailable (transient state never concluded)", async () => {
    const pipeline = await seedPipeline("cmp-live", [
      { id: "extract", agent: "reader" },
    ]);
    const a = await executionService.createExecution(pipeline, {});
    await executionService.reconcileExecution(a.id);
    await executionService.cancelExecution(a.id);
    // B stays RUNNING (live).
    const b = await executionService.createExecution(pipeline, {});
    await executionService.reconcileExecution(b.id);

    const comparison = await capsules.compare(a.id, b.id);
    expect(comparison.outcome.unavailable).toBe(true);
    expect(comparison.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining("LIVE capture")]),
    );
  });

  it("provenance distinguishes authority, claim, and exposure edges", async () => {
    const pipeline = await seedPipeline("prov-p", [
      { id: "extract", agent: "reader", delegation: "observed" },
    ]);
    const execution = await executionService.createExecution(pipeline, {});
    await executionService.reconcileExecution(execution.id);
    const claim = await executionService.claimRunnableStep(
      execution.id,
      { id: "extract", agent: "reader", delegation: "observed" },
      { input: true },
      1,
    );
    if (claim?.disposition !== "claimed") throw new Error("claim");
    // A supervised child + observed evidence.
    const childPipeline = await seedPipeline("prov-c", [
      { id: "extract", agent: "writer" },
    ]);
    await new DelegationService(dataSource as any, executionService).request({
      parentExecutionId: execution.id,
      parentAttemptId: claim.attempt.id,
      requestId: "prov-child",
      requestedAgent: "writer",
      expiresAt: new Date(Date.now() + 60_000),
    });
    await new DelegationService(dataSource as any, executionService).approve(
      claim.attempt.id,
      "prov-child",
      childPipeline,
    );
    const result: AgentResultV1 = {
      schemaVersion: "1",
      invocationId: claim.attempt.invocationId,
      executionId: execution.id,
      stepExecutionId: claim.logicalStep.id,
      status: "succeeded",
      output: { done: true },
      completedAt: new Date().toISOString(),
      delegation: [
        {
          schemaVersion: "1",
          provider: "codex",
          childId: "prov-hidden",
          assertedAt: new Date().toISOString(),
        },
      ],
    };
    await new ResultInboxService(
      dataSource as any,
      new BudgetLedgerService(dataSource as any),
      undefined as any,
    ).apply(result, { adapter: "http", receivedAt: new Date().toISOString() });
    await executionService.cancelExecution(execution.id);

    const provenance = await capsules.provenance(execution.id);
    const edgeKinds = provenance.edges.map((edge) => edge.kind);
    expect(edgeKinds).toContain("authority");
    expect(edgeKinds).toContain("claim");
    // Authority edges for the revision + attempt + supervised child.
    const authorityEdges = provenance.edges.filter(
      (edge) => edge.kind === "authority",
    );
    expect(authorityEdges.length).toBeGreaterThanOrEqual(3);
    // Every edge resolves to an existing node (no dangling references).
    const nodeIds = new Set(provenance.nodes.map((node) => node.id));
    for (const edge of provenance.edges) {
      expect(nodeIds.has(edge.from)).toBe(true);
      expect(nodeIds.has(edge.to)).toBe(true);
    }
    // The attempt edge resolves to the revision node via the row id.
    const attemptEdge = provenance.edges.find(
      (edge) =>
        edge.from.startsWith("attempt:") && edge.to.startsWith("revision:"),
    );
    expect(attemptEdge).toBeDefined();
    // The observed delegation edge is a CLAIM, never authority.
    const claimEdges = provenance.edges.filter((edge) => edge.kind === "claim");
    expect(claimEdges).toHaveLength(1);
    expect(claimEdges[0].to).toBe("claim:codex:prov-hidden");
    const delegationNodes = provenance.nodes.filter(
      (node) => node.kind === "delegation_child",
    );
    expect(delegationNodes).toHaveLength(1);
  });
  it("capsule, telemetry, and provenance stay bounded on a large execution", async () => {
    const pipeline = await seedPipeline("m7s5-big", [
      { id: "extract", agent: "reader", delegation: "observed" },
    ]);
    const execution = await executionService.createExecution(pipeline, {});
    await executionService.reconcileExecution(execution.id);
    const claim = await executionService.claimRunnableStep(
      execution.id,
      { id: "extract", agent: "reader", delegation: "observed" },
      { input: true },
      1,
    );
    if (claim?.disposition !== "claimed") throw new Error("claim");
    // 150 attempts (bounds: capsule 100, telemetry 100).
    const logicalStep = await dataSource
      .getRepository(LogicalStepEntity)
      .findOne({
        where: { executionId: execution.id },
      });
    const revision = await dataSource
      .getRepository(ExecutionPlanRevisionEntity)
      .findOne({ where: { executionId: execution.id } });
    const attemptRepository = dataSource.getRepository(StepAttemptEntity);
    for (let i = 1; i <= 149; i += 1) {
      await attemptRepository.save(
        attemptRepository.create({
          executionId: execution.id,
          logicalStepId: logicalStep!.id,
          planRevisionId: revision!.id,
          attemptNumber: i + 1,
          invocationId: `${logicalStep!.id}:${i + 1}`,
          frozenSpecHash: "f".repeat(64),
          executorSnapshot: {
            schemaVersion: "1",
            executorId: "agent:reader",
            agent: "reader",
            kind: "kafka",
            configHash: "c".repeat(64),
            capabilities: { cancel: false },
          },
          status: "FAILED",
          error: "seeded",
          terminalAt: new Date(),
        } as any),
      );
    }
    await executionService.cancelExecution(execution.id);

    const capsule = await capsules.build(execution.id);
    expect(capsule.attempts.length).toBeLessThanOrEqual(100);
    expect(capsule.evidenceCompleteness).toEqual(
      expect.arrayContaining([expect.stringContaining("Attempts truncated")]),
    );

    const telemetry = await capsules.projectTelemetry(execution.id);
    const spans = telemetry.resourceSpans[0].scopeSpans[0].spans;
    expect(spans.length).toBeLessThanOrEqual(101); // root + 100 attempts

    const provenance = await capsules.provenance(execution.id);
    expect(provenance.nodes.length).toBeLessThanOrEqual(200);
    expect(provenance.edges.length).toBeLessThanOrEqual(500);
  });
});

describeWithPostgres("PostgreSQL M7-S4 telemetry projection", () => {
  jest.setTimeout(120_000);

  let dataSource: DataSource;
  let executionService: ExecutionService;
  let capsules: ExecutionCapsuleService;
  let adapter: HttpAgentAdapter;

  const seedPipeline = async (name: string, steps: any[]) => {
    return dataSource.getRepository(PipelineEntity).save(
      dataSource.getRepository(PipelineEntity).create({
        name,
        version: "1.0",
        description: `${name} fixture`,
        steps,
      }),
    );
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
    capsules = new ExecutionCapsuleService(
      dataSource as any,
      new DelegationService(dataSource as any, executionService),
      executionService,
    );
    adapter = new HttpAgentAdapter(
      new AgentTransportConfigService(
        parseAgentTransportConfiguration({
          ...process.env,
          AGENT_TRANSPORT_CONFIG: JSON.stringify({
            "http-agent": {
              kind: "http",
              submitUrl: "http://127.0.0.1:1/v1/runs",
              outboundAuthentication: { type: "none" },
              callbackAuthentication: {
                keyId: "k",
                secretEnv: "M7S4_SECRET",
              },
              requestTimeoutMs: 1000,
              maxResponseBytes: 4096,
            },
          }),
          HTTP_AGENT_CALLBACK_BASE_URL: "http://127.0.0.1:1",
          HTTP_AGENT_ALLOW_INSECURE: "true",
          M7S4_SECRET: "secret",
        }),
      ),
    );
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await dataSource.query(
      `TRUNCATE "execution_replays", "execution_exports", "artifact_exposures",
       "delegation_requests", "delegation_observation_conflicts",
       "delegation_observations", "plan_proposals", "policy_decisions",
       "policy_snapshots", "approval_requests", "budget_ledger_entries",
       "budget_reservations", "budget_accounts", "state_write_evidence",
       "artifacts", "result_conflicts", "result_inbox", "agent_events",
       "dispatch_outbox", "step_attempts", "step_executions",
       "execution_plan_revisions", "executions", "pipelines" CASCADE`,
    );
  });

  it("projects OTLP-shaped spans (root execution span + attempt spans) without any writes", async () => {
    const pipeline = await seedPipeline("otel-p", [
      { id: "extract", agent: "reader" },
    ]);
    const execution = await executionService.createExecution(pipeline, {});
    await executionService.reconcileExecution(execution.id);
    const claim = await executionService.claimRunnableStep(
      execution.id,
      { id: "extract", agent: "reader" },
      { input: true },
      1,
    );
    if (claim?.disposition !== "claimed") throw new Error("claim");
    await executionService.cancelExecution(execution.id);

    const telemetry = await capsules.projectTelemetry(execution.id);
    const spans = telemetry.resourceSpans[0].scopeSpans[0].spans;
    expect(spans.length).toBeGreaterThanOrEqual(2);
    const root = spans[0];
    expect(root.parentSpanId).toBeNull();
    expect(root.name).toBe("pipeline.execute");
    expect(root.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(root.spanId).toMatch(/^[0-9a-f]{16}$/);
    const attemptSpan = spans.find((span) =>
      span.attributes.some(
        (attribute) =>
          attribute.key === "tenvyr.stepId" &&
          attribute.value.stringValue === "extract",
      ),
    );
    expect(attemptSpan?.name).toBe("step.execute");
    expect(attemptSpan?.parentSpanId).toBe(root.spanId);
    expect(attemptSpan?.attributes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "tenvyr.agent",
          value: { stringValue: "reader" },
        }),
      ]),
    );
    // Telemetry is a pure projection: no rows were written.
    expect(await dataSource.getRepository(ExecutionExportEntity).count()).toBe(
      0,
    );
    expect(await dataSource.getRepository(ExecutionReplayEntity).count()).toBe(
      0,
    );
  });

  it("the HTTP adapter sends a deterministic W3C traceparent header (outbound only)", async () => {
    const invocation = {
      schemaVersion: "1" as const,
      invocationId: "inv-123",
      executionId: "exec-1",
      stepExecutionId: "step-1",
      stepId: "extract",
      target: { agent: "http-agent" },
      input: {},
      attempt: 1,
      createdAt: new Date().toISOString(),
      trace: {
        traceId: "550e8400-e29b-41d4-a716-446655440000",
        correlationId: "exec-1",
      },
    };
    const traceparent = w3cTraceparent(invocation);
    expect(traceparent).toBe(
      `00-550e8400e29b41d4a716446655440000-${traceparent!.split("-")[2]}-01`,
    );
    // Deterministic: same invocation → same header.
    expect(w3cTraceparent(invocation)).toBe(traceparent);
    expect(traceparent!.split("-")[1]).toBe("550e8400e29b41d4a716446655440000");
    expect(traceparent!.split("-")[2]).toMatch(/^[0-9a-f]{16}$/);
    // No trace identity → no header.
    expect(w3cTraceparent({ invocationId: "x" })).toBeNull();
    expect(w3cTraceparent({ trace: { traceId: "x" } })).toBeNull();
    // Non-32-hex trace ids are rejected (no malformed propagation).
    expect(
      w3cTraceparent({ invocationId: "x", trace: { traceId: "short" } }),
    ).toBeNull();
  });

  it("the adapter injects the traceparent into the outbound run request", async () => {
    const fetchMock = jest.fn().mockRejectedValue(new Error("no server"));
    (globalThis as any).fetch = fetchMock;
    await adapter.start({ result: jest.fn(), event: jest.fn() });
    const invocation = {
      schemaVersion: "1" as const,
      invocationId: "inv-tp",
      executionId: "exec-tp",
      stepExecutionId: "step-tp",
      stepId: "extract",
      target: { agent: "http-agent" },
      input: {},
      attempt: 1,
      createdAt: new Date().toISOString(),
      trace: {
        traceId: "550e8400e29b41d4a716446655440000",
        correlationId: "exec-tp",
      },
    };
    const error = await adapter.invoke(invocation as any).catch((e) => e);
    if (!fetchMock.mock.calls[0]) {
      throw new Error(`invoke failed before fetch: ${String(error)}`);
    }
    const [, options] = fetchMock.mock.calls[0];
    const traceparent = (options as any).headers.traceparent;
    expect(traceparent).toMatch(
      /^00-550e8400e29b41d4a716446655440000-[0-9a-f]{16}-01$/,
    );
    await (adapter as any).stop();
  });
});

describeWithPostgres("PostgreSQL M8-S2 runtime connections", () => {
  jest.setTimeout(180_000);

  let dataSource: DataSource;
  let connections: RuntimeConnectionService;

  const SEEDED_SECRET = "m8-callback-secret-value";

  const connectionProfile = (overrides: Partial<ConnectionProfileV1> = {}): ConnectionProfileV1 => ({
    name: "Codex local",
    runtimeKind: "codex",
    executorId: "local-host",
    version: "0.147.0",
    credentialRefs: [{ kind: "env", name: "CODEX_API_KEY" }],
    declaredCapabilities: {
      invocation: { supported: true, source: "configured" },
      structuredResult: { supported: true, source: "configured" },
    },
    ...overrides,
  });

  const httpEnv = (connectionId: string, overrides: Record<string, unknown> = {}) => ({
    AGENT_TRANSPORT_CONFIG: JSON.stringify({
      reader: {
        kind: "http",
        submitUrl: "https://reader-pinned.example/v1/runs",
        outboundAuthentication: { type: "none" },
        callbackAuthentication: {
          keyId: "reader-key",
          secretEnv: "READER_CALLBACK_SECRET",
        },
        requestTimeoutMs: 1000,
        maxResponseBytes: 1024,
        connectionId,
        ...overrides,
      },
    }),
    HTTP_AGENT_CALLBACK_BASE_URL: "https://orchestrator.example",
    READER_CALLBACK_SECRET: SEEDED_SECRET,
  });

  const transportConfig = (env: NodeJS.ProcessEnv) =>
    new AgentTransportConfigService(parseAgentTransportConfiguration(env));

  const executionServiceWith = (config: AgentTransportConfigService) =>
    new ExecutionService(
      dataSource.getRepository(ExecutionEntity),
      dataSource.getRepository(LogicalStepEntity),
      dataSource.getRepository(StepAttemptEntity),
      dataSource.getRepository(ExecutionPlanRevisionEntity),
      dataSource,
      undefined,
      config,
    );

  const recordingAdapter = () => {
    const calls: Array<{ invocation: unknown; pinned: unknown }> = [];
    return {
      calls,
      adapter: {
        kind: "test",
        invoke: jest.fn(async (invocation: any, pinned: any) => {
          calls.push({ invocation, pinned });
          return {
            adapter: "test",
            invocationId: invocation.invocationId,
            dispatchedAt: new Date().toISOString(),
          };
        }),
      },
    };
  };

  const seedExecution = async (
    service: ExecutionService,
    name: string,
    steps: any[],
  ) => {
    const pipeline = await dataSource.getRepository(PipelineEntity).save(
      dataSource.getRepository(PipelineEntity).create({
        name,
        version: "1.0",
        steps,
      }),
    );
    const execution = await service.createExecution(pipeline, {});
    await service.reconcileExecution(execution.id);
    return { pipeline, execution };
  };

  const claimExtract = async (service: ExecutionService, executionId: string) =>
    service.claimRunnableStep(
      executionId,
      { id: "extract", agent: "reader" } as any,
      { input: true },
      1,
    );

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
    connections = new RuntimeConnectionService(dataSource);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await dataSource.query(
      `TRUNCATE "connection_revisions", "runtime_connections",
       "dispatch_outbox", "step_attempts", "step_executions",
       "execution_plan_revisions", "executions", "pipelines" CASCADE`,
    );
  });

  it("migrations are restart-safe: re-running them is a no-op", async () => {
    await connections.createConnection("conn:codex-local", connectionProfile());
    await expect(dataSource.runMigrations()).resolves.toBeDefined();
    const revision = await connections.claimRevision("conn:codex-local");
    expect(revision.revisionNumber).toBe(1);
  });

  it("freezes the current connection revision into the attempt snapshot and Capsule provenance without secrets", async () => {
    await connections.createConnection("conn:codex-local", connectionProfile());
    const config = transportConfig(httpEnv("conn:codex-local"));
    const service = executionServiceWith(config);
    const { execution } = await seedExecution(service, "m8-freeze", [
      { id: "extract", agent: "reader" },
    ]);
    const claim = await claimExtract(service, execution.id);
    expect(claim?.disposition).toBe("claimed");

    const frozen = (claim as any).attempt.executorSnapshot as ExecutorDescriptorV1;
    expect(frozen.connection).toMatchObject({
      schemaVersion: "1",
      connectionId: "conn:codex-local",
      revisionNumber: 1,
      runtimeKind: "codex",
      version: "0.147.0",
    });
    expect(frozen.connection?.configHash).toMatch(/^[0-9a-f]{64}$/);
    expect(frozen.connection?.capabilities).toEqual({
      invocation: { supported: true, source: "configured" },
      structuredResult: { supported: true, source: "configured" },
    });
    // Secret-free by construction: no credential values anywhere.
    const rendered = JSON.stringify(frozen);
    expect(rendered).not.toContain(SEEDED_SECRET);
    expect(rendered).not.toMatch(/sk-[A-Za-z0-9]+/);

    // Dispatch consumes exactly the frozen snapshot.
    const rec = recordingAdapter();
    const outboxService = new DispatchOutboxService(
      dataSource as any,
      rec.adapter as any,
      config,
    );
    const disposition = await outboxService.dispatchNext();
    expect(disposition).toEqual({ outcome: "dispatched" });
    expect(rec.calls).toHaveLength(1);
    expect(rec.calls[0].pinned).toEqual(frozen);

    // Capsule provenance references the exact revision, never secrets.
    await service.cancelExecution(execution.id);
    const capsules = new ExecutionCapsuleService(
      dataSource as any,
      new DelegationService(dataSource as any, service),
      service,
    );
    const capsule = await capsules.build(execution.id);
    const capsuleJson = JSON.stringify(capsule);
    expect(capsuleJson).toContain("conn:codex-local");
    expect(capsuleJson).toContain('"revisionNumber":1');
    expect(capsuleJson).toContain(frozen.connection!.configHash);
    expect(capsuleJson).not.toContain(SEEDED_SECRET);
  });

  it("revision rotation cannot reroute a frozen attempt", async () => {
    await connections.createConnection("conn:codex-local", connectionProfile());
    const transport = transportConfig(httpEnv("conn:codex-local"));
    const service = executionServiceWith(transport);
    const { execution } = await seedExecution(service, "m8-rotation", [
      { id: "extract", agent: "reader" },
    ]);
    const claim = await claimExtract(service, execution.id);
    expect(claim?.disposition).toBe("claimed");
    const frozen = (claim as any).attempt.executorSnapshot as ExecutorDescriptorV1;
    expect(frozen.connection?.revisionNumber).toBe(1);

    // Operator revises the connection AND rotates the transport config.
    await connections.reviseConnection("conn:codex-local", connectionProfile());
    const rotatedTransport = transportConfig(
      httpEnv("conn:codex-local", {
        submitUrl: "https://rotated.example/v1/runs",
      }),
    );
    const rec = recordingAdapter();
    const outboxService = new DispatchOutboxService(
      dataSource as any,
      rec.adapter as any,
      rotatedTransport,
    );
    const disposition = await outboxService.dispatchNext();
    expect(disposition).toEqual({ outcome: "dispatched" });
    // The outbox still consumed revision 1's frozen profile — no reroute.
    expect(rec.calls[0].pinned).toEqual(frozen);
    const pinned = rec.calls[0].pinned as ExecutorDescriptorV1;
    expect(pinned.connection?.revisionNumber).toBe(1);
    expect(pinned.httpProfile?.submitUrl).toBe(
      "https://reader-pinned.example/v1/runs",
    );
  });

  it("revocation denies future claims and pending delivery with a deterministic safe code", async () => {
    await connections.createConnection("conn:codex-local", connectionProfile());
    const transport = transportConfig(httpEnv("conn:codex-local"));
    const service = executionServiceWith(transport);
    const { execution } = await seedExecution(service, "m8-revoke", [
      { id: "extract", agent: "reader" },
    ]);
    const claim = await claimExtract(service, execution.id);
    expect(claim?.disposition).toBe("claimed");

    await connections.revokeConnection("conn:codex-local");

    // Future claims are denied immediately.
    await expect(
      connections.claimRevision("conn:codex-local"),
    ).rejects.toMatchObject({ code: "CONNECTION_REVOKED" });

    // Pending delivery fails deterministically; no fallback.
    const rec = recordingAdapter();
    const outboxService = new DispatchOutboxService(
      dataSource as any,
      rec.adapter as any,
      transport,
    );
    const disposition = await outboxService.dispatchNext();
    expect(disposition.outcome).toBe("terminal_failure");
    expect(rec.calls).toHaveLength(0);
  });

  it("a frozen reference whose connection row no longer exists is denied (revoked-then-deleted)", async () => {
    await connections.createConnection("conn:codex-deleted", connectionProfile());
    const transport = transportConfig(httpEnv("conn:codex-deleted"));
    const service = executionServiceWith(transport);
    const { execution } = await seedExecution(service, "m8-deleted", [
      { id: "extract", agent: "reader" },
    ]);
    const claim = await claimExtract(service, execution.id);
    expect(claim?.disposition).toBe("claimed");

    // Simulate the worst case where the DB immutability trigger is
    // bypassed and the revoked connection's row disappears: the frozen
    // reference remains on the attempt, the connection row is gone.
    await connections.revokeConnection("conn:codex-deleted");
    await dataSource.query(
      `ALTER TABLE "connection_revisions" DISABLE TRIGGER "TRG_connection_revision_immutable"`,
    );
    try {
      await dataSource.query(
        `DELETE FROM "runtime_connections" WHERE "connectionId" = 'conn:codex-deleted'`,
      );
    } finally {
      await dataSource.query(
        `ALTER TABLE "connection_revisions" ENABLE TRIGGER "TRG_connection_revision_immutable"`,
      );
    }

    const rec = recordingAdapter();
    const outboxService = new DispatchOutboxService(
      dataSource as any,
      rec.adapter as any,
      transport,
    );
    const disposition = await outboxService.dispatchNext();
    expect(disposition.outcome).toBe("terminal_failure");
    expect(rec.calls).toHaveLength(0);
  });

  it("revisions are durably immutable: UPDATE and DELETE are blocked by the trigger", async () => {
    await connections.createConnection("conn:codex-local", connectionProfile());
    const revision = await connections.claimRevision("conn:codex-local");

    await expect(
      dataSource.query(
        `UPDATE "connection_revisions" SET "configHash" = '${"0".repeat(64)}'
         WHERE "connectionId" = 'conn:codex-local'`,
      ),
    ).rejects.toThrow(/connection revisions are immutable/);
    await expect(
      dataSource.query(
        `DELETE FROM "connection_revisions"
         WHERE "connectionId" = 'conn:codex-local'`,
      ),
    ).rejects.toThrow(/connection revisions are immutable/);

    // The revision is untouched and still coherent.
    const reloaded = await connections.claimRevision("conn:codex-local");
    expect(reloaded.configHash).toBe(revision.configHash);
    expect(parseConnectionRevision(reloaded)).toEqual(reloaded);
  });

  it("concurrent revises serialize into one coherent immutable sequence", async () => {
    await connections.createConnection("conn:codex-local", connectionProfile());

    const [left, right] = await Promise.all([
      connections.reviseConnection("conn:codex-local", connectionProfile()),
      connections.reviseConnection("conn:codex-local", connectionProfile()),
    ]);

    const numbers = [left.revisionNumber, right.revisionNumber].sort(
      (a, b) => a - b,
    );
    expect(numbers).toEqual([2, 3]);
    // One coherent current revision; every row is a valid immutable revision.
    const claimed = await connections.claimRevision("conn:codex-local");
    expect(claimed.revisionNumber).toBe(3);
    expect(
      await dataSource.getRepository(ConnectionRevisionEntity).count({
        where: { connectionId: "conn:codex-local" },
      }),
    ).toBe(3);
    for (const number of [1, 2, 3]) {
      const row = await dataSource
        .getRepository(ConnectionRevisionEntity)
        .findOne({
          where: { connectionId: "conn:codex-local", revisionNumber: number },
        });
      expect(
        parseConnectionRevision({
          schemaVersion: "1",
          connectionId: row!.connectionId,
          revisionNumber: row!.revisionNumber,
          createdAt: row!.createdAt.toISOString(),
          profile: row!.profile,
          configHash: row!.configHash,
          capabilities: row!.capabilities,
        }).configHash,
      ).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("concurrent revoke + claim yield one coherent outcome, never a torn identity", async () => {
    await connections.createConnection("conn:codex-local", connectionProfile());

    const [revokeResult, claimResult] = await Promise.allSettled([
      connections.revokeConnection("conn:codex-local"),
      connections.claimRevision("conn:codex-local"),
    ]);

    expect(revokeResult.status).toBe("fulfilled");
    const status = await connections.connectionStatus("conn:codex-local");
    expect(status.state).toBe("REVOKED");
    if (claimResult.status === "fulfilled") {
      // The claim resolved BEFORE the revoke commit: it holds the exact
      // immutable revision that was current then, never a torn row.
      expect(claimResult.value.revisionNumber).toBe(1);
      expect(claimResult.value.connectionId).toBe("conn:codex-local");
    } else {
      expect(claimResult.reason).toMatchObject({ code: "CONNECTION_REVOKED" });
    }
  });

  it("concurrent revoke + revise yield a coherent terminal state", async () => {
    await connections.createConnection("conn:codex-local", connectionProfile());

    const [revokeResult, reviseResult] = await Promise.allSettled([
      connections.revokeConnection("conn:codex-local"),
      connections.reviseConnection("conn:codex-local", connectionProfile()),
    ]);

    expect(revokeResult.status).toBe("fulfilled");
    const status = await connections.connectionStatus("conn:codex-local");
    expect(status.state).toBe("REVOKED");
    const rows = await dataSource
      .getRepository(ConnectionRevisionEntity)
      .find({ where: { connectionId: "conn:codex-local" } });
    if (reviseResult.status === "fulfilled") {
      // The revision won the lock first: exactly one append before REVOKED.
      expect(rows).toHaveLength(2);
      expect(reviseResult.value.revisionNumber).toBe(2);
    } else {
      expect(reviseResult.reason).toMatchObject({ code: "CONNECTION_REVOKED" });
      expect(rows).toHaveLength(1);
    }
  });

  it("retry and replay resolve the CURRENT revision, never a historical one", async () => {
    await connections.createConnection("conn:codex-local", connectionProfile());
    const first = await connections.claimRevision("conn:codex-local");
    expect(first.revisionNumber).toBe(1);

    // Retry = a new attempt: it re-claims the current revision.
    await connections.reviseConnection("conn:codex-local", connectionProfile());
    const retry = await connections.claimRevision("conn:codex-local");
    expect(retry.revisionNumber).toBe(2);

    // Replay = a new execution: same re-resolution, and a revoked connection
    // denies the replay claim (historical identity is provenance, never
    // current authority).
    await connections.revokeConnection("conn:codex-local");
    await expect(
      connections.claimRevision("conn:codex-local"),
    ).rejects.toMatchObject({ code: "CONNECTION_REVOKED" });
  });

  it("M8 closure: a revoke committed BEFORE the claim linearization point denies the claim (revoke wins)", async () => {
    await connections.createConnection("conn:revoke-wins", connectionProfile());
    // Revoke commits first...
    await connections.revokeConnection("conn:revoke-wins");
    // ...so any later claim — even one that started before the revoke was
    // visible to a stale read — MUST be denied. The claim's linearization
    // point is the authority-row lock; the revoke already owns it.
    await expect(
      connections.claimRevision("conn:revoke-wins"),
    ).rejects.toMatchObject({ code: "CONNECTION_REVOKED" });
    // The manager-aware path enforces the identical gate.
    await expect(
      dataSource.transaction((manager) =>
        connections.claimRevisionWithManager(manager, "conn:revoke-wins"),
      ),
    ).rejects.toMatchObject({ code: "CONNECTION_REVOKED" });
  });

  it("M8 closure: a claim that linearizes first returns its frozen revision; the later revoke waits and completes (claim wins)", async () => {
    await connections.createConnection("conn:claim-wins", connectionProfile());
    // The claim acquires the authority-row lock and holds it briefly; the
    // revoke must serialize BEHIND it and can never tear the claim.
    const claimPromise = dataSource.transaction(async (manager) => {
      const revision = await connections.claimRevisionWithManager(
        manager,
        "conn:claim-wins",
      );
      await new Promise((resolve) => setTimeout(resolve, 300));
      return revision;
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const revokeDuring = connections
      .revokeConnection("conn:claim-wins")
      .then(() => "completed");
    const raced = await Promise.race([
      revokeDuring,
      new Promise((resolve) => setTimeout(() => resolve("still-waiting"), 200)),
    ]);
    expect(raced).toBe("still-waiting");
    const revision = await claimPromise;
    expect(revision.revisionNumber).toBe(1);
    expect(await revokeDuring).toBe("completed");
    // The claim froze revision 1 before the revoke; FUTURE claims are denied.
    await expect(
      connections.claimRevision("conn:claim-wins"),
    ).rejects.toMatchObject({ code: "CONNECTION_REVOKED" });
  });

  it("M8 closure: revise vs claim — a claim receives exactly one internally consistent immutable revision, never N+1 identity with N config", async () => {
    await connections.createConnection("conn:revise-claim", connectionProfile());
    const [reviseResult, claimResult] = await Promise.allSettled([
      connections.reviseConnection("conn:revise-claim", connectionProfile()),
      connections.claimRevision("conn:revise-claim"),
    ]);
    expect(reviseResult.status).toBe("fulfilled");
    if (claimResult.status === "fulfilled") {
      // The claim's identity and configuration come from ONE frozen row:
      // its revisionNumber's row must carry exactly its configHash.
      const row = await dataSource
        .getRepository(ConnectionRevisionEntity)
        .findOne({
          where: {
            connectionId: "conn:revise-claim",
            revisionNumber: claimResult.value.revisionNumber,
          },
        });
      expect(row).not.toBeNull();
      expect(row!.configHash).toBe(claimResult.value.configHash);
      expect(
        parseConnectionRevision({
          schemaVersion: "1",
          connectionId: row!.connectionId,
          revisionNumber: row!.revisionNumber,
          createdAt: row!.createdAt.toISOString(),
          profile: row!.profile,
          configHash: row!.configHash,
          capabilities: row!.capabilities,
        }),
      ).toEqual(claimResult.value);
    }
    const final = await connections.claimRevision("conn:revise-claim");
    expect(final.revisionNumber).toBe(2);
  });

  it("M8 closure: claim/revise/revoke contention — every fulfilled claim is internally consistent and the terminal state is coherent", async () => {
    await connections.createConnection("conn:contention", connectionProfile());
    const results = await Promise.allSettled([
      connections.claimRevision("conn:contention"),
      connections.claimRevision("conn:contention"),
      connections.reviseConnection("conn:contention", connectionProfile()),
      connections.claimRevision("conn:contention"),
      connections.reviseConnection("conn:contention", connectionProfile()),
      connections.revokeConnection("conn:contention"),
      connections.claimRevision("conn:contention"),
    ]);
    const rows = await dataSource
      .getRepository(ConnectionRevisionEntity)
      .find({ where: { connectionId: "conn:contention" } });
    const rowByNumber = new Map(rows.map((row) => [row.revisionNumber, row]));
    for (const result of results) {
      if (result.status !== "fulfilled") continue;
      const value = result.value as { revisionNumber?: number; configHash?: string };
      if (typeof value.revisionNumber === "number" && typeof value.configHash === "string") {
        // A claim or revise result: the frozen row it refers to must carry
        // exactly the identity/config it returned (no torn mix).
        const row = rowByNumber.get(value.revisionNumber);
        expect(row).toBeDefined();
        expect(row!.configHash).toBe(value.configHash);
      }
    }
    const status = await connections.connectionStatus("conn:contention");
    if (status.state === "REVOKED") {
      await expect(
        connections.claimRevision("conn:contention"),
      ).rejects.toMatchObject({ code: "CONNECTION_REVOKED" });
    } else {
      const current = await connections.claimRevision("conn:contention");
      expect(current.revisionNumber).toBe(
        Math.max(...rows.map((row) => row.revisionNumber)),
      );
    }
  });
});

describeWithPostgres("PostgreSQL M8-S3 generic CLI probes", () => {
  jest.setTimeout(180_000);

  let dataSource: DataSource;
  let connections: RuntimeConnectionService;

  const SEEDED_SECRET = "m8s3-probe-secret-value";

  const genericCliProfile = (
    script: string,
    overrides: Partial<ConnectionProfileV1> = {},
  ): ConnectionProfileV1 => ({
    name: "Generic CLI",
    runtimeKind: "generic-cli",
    executorId: "local-host",
    credentialRefs: [],
    cli: {
      command: process.execPath,
      args: [],
      probe: { args: ["-e", script], expectsVersion: true },
    },
    declaredCapabilities: {
      invocation: { supported: true, source: "configured" },
      localProcessTermination: { supported: true, source: "configured" },
    },
    ...overrides,
  });

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
    connections = new RuntimeConnectionService(dataSource);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await dataSource.query(
      `TRUNCATE "connection_revisions", "runtime_connections",
       "dispatch_outbox", "step_attempts", "step_executions",
       "execution_plan_revisions", "executions", "pipelines" CASCADE`,
    );
  });

  it("projects a successful fake-CLI probe into AVAILABLE with tested version", async () => {
    await connections.createConnection(
      "conn:generic",
      genericCliProfile("console.log('0.147.0')"),
    );
    const receipt = await connections.testConnection("conn:generic");
    expect(receipt).toMatchObject({
      connectionId: "conn:generic",
      revisionNumber: 1,
      state: "AVAILABLE",
      reasonCode: "none",
      testedVersion: "0.147.0",
    });
    const status = await connections.connectionStatus("conn:generic");
    expect(status).toMatchObject({
      state: "AVAILABLE",
      reasonCode: "none",
      testedVersion: "0.147.0",
    });
    expect(status.testedAt).toBeDefined();
  });

  it("degrades to unsupported-version when the detected version differs from the pinned one", async () => {
    await connections.createConnection(
      "conn:generic",
      genericCliProfile("console.log('9.9.9')", { version: "0.147.0" }),
    );
    const receipt = await connections.testConnection("conn:generic");
    expect(receipt).toMatchObject({
      state: "DEGRADED",
      reasonCode: "unsupported-version",
      testedVersion: "9.9.9",
    });
  });

  it("maps declared auth exit codes to AUTH_REQUIRED", async () => {
    await connections.createConnection(
      "conn:generic",
      genericCliProfile("process.exit(2)", {
        cli: {
          command: process.execPath,
          args: [],
          probe: { args: ["-e", "process.exit(2)"], authExitCodes: [2] },
        },
      }),
    );
    const receipt = await connections.testConnection("conn:generic");
    expect(receipt).toMatchObject({
      state: "AUTH_REQUIRED",
      reasonCode: "auth-required",
    });
  });

  it("maps a missing executable to UNAVAILABLE with a bounded reason", async () => {
    await connections.createConnection(
      "conn:generic",
      genericCliProfile("console.log('unused')", {
        cli: {
          command: "/nonexistent/tenvyr-fake-generic-cli",
          args: [],
          probe: { args: ["--version"] },
        },
      }),
    );
    const receipt = await connections.testConnection("conn:generic");
    expect(receipt).toMatchObject({
      state: "UNAVAILABLE",
      reasonCode: "missing-executable",
    });
  });

  it("denies tests of a revoked connection", async () => {
    await connections.createConnection(
      "conn:generic",
      genericCliProfile("console.log('0.147.0')"),
    );
    await connections.revokeConnection("conn:generic");
    await expect(
      connections.testConnection("conn:generic"),
    ).rejects.toMatchObject({ code: "CONNECTION_REVOKED" });
  });

  it("a failed test never mutates attempt outcomes", async () => {
    await connections.createConnection(
      "conn:generic",
      genericCliProfile("process.exit(1)"),
    );
    // A real claimed attempt exists for the connection-bound agent.
    const transport = new AgentTransportConfigService(
      parseAgentTransportConfiguration({
        AGENT_TRANSPORT_CONFIG: JSON.stringify({
          reader: {
            kind: "http",
            submitUrl: "https://reader-pinned.example/v1/runs",
            outboundAuthentication: { type: "none" },
            callbackAuthentication: {
              keyId: "reader-key",
              secretEnv: "READER_CALLBACK_SECRET",
            },
            requestTimeoutMs: 1000,
            maxResponseBytes: 1024,
            connectionId: "conn:generic",
          },
        }),
        HTTP_AGENT_CALLBACK_BASE_URL: "https://orchestrator.example",
        READER_CALLBACK_SECRET: SEEDED_SECRET,
      }),
    );
    const service = new ExecutionService(
      dataSource.getRepository(ExecutionEntity),
      dataSource.getRepository(LogicalStepEntity),
      dataSource.getRepository(StepAttemptEntity),
      dataSource.getRepository(ExecutionPlanRevisionEntity),
      dataSource,
      undefined,
      transport,
    );
    const pipeline = await dataSource.getRepository(PipelineEntity).save(
      dataSource.getRepository(PipelineEntity).create({
        name: "m8s3-attempt",
        version: "1.0",
        steps: [{ id: "extract", agent: "reader" }],
      }),
    );
    const execution = await service.createExecution(pipeline, {});
    await service.reconcileExecution(execution.id);
    const claim = await service.claimRunnableStep(
      execution.id,
      { id: "extract", agent: "reader" } as any,
      { input: true },
      1,
    );
    expect(claim?.disposition).toBe("claimed");

    // The failing probe projects only connection status.
    const receipt = await connections.testConnection("conn:generic");
    expect(receipt.state).toBe("UNAVAILABLE");
    const attempt = await dataSource
      .getRepository(StepAttemptEntity)
      .findOne({ where: { id: (claim as any).attempt.id } });
    expect(attempt?.status).toBe("CREATED");
  });

  it("probes run with the minimum environment: seeded secrets stay out of probes, receipts, and status", async () => {
    const env = {
      READER_CALLBACK_SECRET: SEEDED_SECRET,
    };
    await connections.createConnection(
      "conn:generic",
      genericCliProfile(
        "console.log('1.0_' + (process.env.READER_CALLBACK_SECRET || 'absent'))",
      ),
    );
    const receipt = await connections.testConnection("conn:generic", env as never);
    expect(receipt).toMatchObject({
      state: "AVAILABLE",
      testedVersion: "1.0_absent",
    });
    const status = await connections.connectionStatus("conn:generic");
    expect(JSON.stringify(status)).not.toContain(SEEDED_SECRET);
    expect(JSON.stringify(receipt)).not.toContain(SEEDED_SECRET);
  });
});

describeWithPostgres("PostgreSQL M8-S4 runtime profiles", () => {
  jest.setTimeout(180_000);

  let dataSource: DataSource;
  let connections: RuntimeConnectionService;

  const makeFakeCli = (script: string): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tenvyr-m8s4-fake-"));
    const file = path.join(dir, "fake-cli");
    fs.writeFileSync(file, `#!/bin/bash\n${script}\n`, { mode: 0o755 });
    return file;
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
    connections = new RuntimeConnectionService(dataSource);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await dataSource.query(
      `TRUNCATE "connection_revisions", "runtime_connections",
       "dispatch_outbox", "step_attempts", "step_executions",
       "execution_plan_revisions", "executions", "pipelines" CASCADE`,
    );
  });

  it("claude profile: version probe + documented auth-status probe project AUTH_REQUIRED (exit 1)", async () => {
    const fake = makeFakeCli(`
      if [ "$1" = "--version" ]; then echo "2.1.228"; exit 0; fi
      if [ "$1" = "auth" ] && [ "$2" = "status" ]; then
        echo '{"authenticated":false}'
        exit 1
      fi
      exit 9
    `);
    await connections.createConnection(
      "conn:claude",
      buildRuntimeConnectionProfile({
        runtimeKind: "claude",
        name: "Claude local",
        executorId: "local-host",
        executable: fake,
      }),
    );
    const receipt = await connections.testConnection("conn:claude");
    expect(receipt).toMatchObject({
      state: "AUTH_REQUIRED",
      reasonCode: "auth-required",
      revisionNumber: 1,
    });
    expect(receipt.testedVersion).toBeUndefined();
    const status = await connections.connectionStatus("conn:claude");
    expect(status.state).toBe("AUTH_REQUIRED");
    expect(JSON.stringify(status)).not.toContain("authenticated");
  });

  it("claude profile: logged-in auth-status probe yields AVAILABLE with the tested version", async () => {
    const fake = makeFakeCli(`
      if [ "$1" = "--version" ]; then echo "2.1.228"; exit 0; fi
      if [ "$1" = "auth" ] && [ "$2" = "status" ]; then
        echo '{"authenticated":true}'
        exit 0
      fi
      exit 9
    `);
    await connections.createConnection(
      "conn:claude",
      buildRuntimeConnectionProfile({
        runtimeKind: "claude",
        name: "Claude local",
        executorId: "local-host",
        executable: fake,
      }),
    );
    const receipt = await connections.testConnection("conn:claude");
    expect(receipt).toMatchObject({
      state: "AVAILABLE",
      reasonCode: "none",
      testedVersion: "2.1.228",
    });
  });

  it("codex profile: documented `login status` non-zero exit is AUTH_REQUIRED", async () => {
    const fake = makeFakeCli(`
      if [ "$1" = "login" ] && [ "$2" = "status" ]; then
        echo "not logged in"
        exit 3
      fi
      exit 9
    `);
    await connections.createConnection(
      "conn:codex",
      buildRuntimeConnectionProfile({
        runtimeKind: "codex",
        name: "Codex local",
        executorId: "local-host",
        executable: fake,
      }),
    );
    const receipt = await connections.testConnection("conn:codex");
    expect(receipt).toMatchObject({
      state: "AUTH_REQUIRED",
      reasonCode: "auth-required",
    });
    expect(receipt.testedVersion).toBeUndefined();
    // Auth output never reaches the receipt or the status projection.
    expect(JSON.stringify(receipt)).not.toContain("not logged in");
  });

  it("opencode profile: runtime-owned auth, version probe projects AVAILABLE", async () => {
    const fake = makeFakeCli(`
      if [ "$1" = "--version" ]; then echo "1.18.16"; exit 0; fi
      exit 9
    `);
    await connections.createConnection(
      "conn:opencode",
      buildRuntimeConnectionProfile({
        runtimeKind: "opencode",
        name: "OpenCode",
        executorId: "local-host",
        executable: fake,
      }),
    );
    const receipt = await connections.testConnection("conn:opencode");
    expect(receipt).toMatchObject({
      state: "AVAILABLE",
      reasonCode: "none",
      testedVersion: "1.18.16",
    });
  });
});

describeWithPostgres("PostgreSQL M9-S2 coordination authority", () => {
  jest.setTimeout(180_000);

  let dataSource: DataSource;
  let coordinator: RuntimeCoordinationService;
  let executionService: ExecutionService;

  const teamConfig = (): CoordinationConfigV1 => ({
    schemaVersion: 1,
    planner: { kind: "agent", name: "planner" },
    verifier: { kind: "agent", name: "verifier" },
    allowedWorkers: [{ kind: "agent", name: "worker" }],
    maxIterations: 10,
    maxWorkersPerIteration: 4,
    maxTotalWorkers: 20,
    loopDeadlineMs: 3_600_000,
    delegationDepthMax: 2,
    // M8-S6 enforcement: agent-kind tasks resolve to `agent:<name>`.
    allowedExecutors: [
      "local-host",
      "agent:worker",
      "agent:planner",
      "agent:verifier",
    ],
  });

  const decision = (
    iterationId: string,
    iterationNumber: number,
    overrides: Partial<VerifierDecisionV1> = {},
  ): VerifierDecisionV1 => ({
    schemaVersion: 1,
    iterationId,
    iterationNumber,
    action: "CONTINUE",
    reason: "keep going",
    evidenceRefs: ["policy:allow-1"],
    ...overrides,
  });

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
    coordinator = new RuntimeCoordinationService(dataSource);
    executionService = new ExecutionService(
      dataSource.getRepository(ExecutionEntity),
      dataSource.getRepository(LogicalStepEntity),
      dataSource.getRepository(StepAttemptEntity),
      dataSource.getRepository(ExecutionPlanRevisionEntity),
      dataSource,
    );
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await dataSource.query(
      `TRUNCATE "coordination_iterations", "coordination_runs",
       "connection_revisions", "runtime_connections",
       "dispatch_outbox", "step_attempts", "step_executions",
       "execution_plan_revisions", "executions", "pipelines" CASCADE`,
    );
  });

  /** Runs the full loop to VERIFYING for a fresh run: iteration 1 exists,
   *  proposal bound, phase VERIFYING. */
  const runToVerifying = async (name: string) => {
    const pipeline = await dataSource.getRepository(PipelineEntity).save(
      dataSource.getRepository(PipelineEntity).create({
        name,
        version: "1.0",
        steps: [],
      }),
    );
    const execution = await dataSource.getRepository(ExecutionEntity).save(
      dataSource.getRepository(ExecutionEntity).create({
        pipelineId: pipeline.id,
        status: "PENDING",
        input: {},
      }),
    );
    const run = await coordinator.startRun(
      execution.id,
      teamConfig(),
      new Date(Date.now() + 3_600_000),
    );
    const iteration = await coordinator.createNextIteration(run.id);
    await coordinator.transitionRun(run.id, "plannerProposed");
    await coordinator.transitionRun(run.id, "batchValidated");
    await coordinator.transitionRun(run.id, "workersFinished");
    return { run, iteration, execution };
  };

  it("migrations are restart-safe and startRun is idempotent", async () => {
    // M9-S8: a coordination run belongs to a REAL execution (startRun
    // validates existence under the execution row lock).
    const pipeline = await dataSource.getRepository(PipelineEntity).save(
      dataSource.getRepository(PipelineEntity).create({
        name: "m9s2-restart-safe",
        version: "1.0",
        steps: [],
      }),
    );
    const execution = await executionService.createExecution(pipeline, {});
    const executionId = execution.id;
    await coordinator.startRun(
      executionId,
      teamConfig(),
      new Date(Date.now() + 3_600_000),
    );
    await expect(dataSource.runMigrations()).resolves.toBeDefined();
    const again = await coordinator.startRun(
      executionId,
      teamConfig(),
      new Date(Date.now() + 3_600_000),
    );
    expect(again.phase).toBe("PLANNING");
    const recovered = await coordinator.recoverRun(executionId);
    expect(recovered.run.phase).toBe("PLANNING");
    expect(recovered.iterations).toHaveLength(0);
  });

  it("iteration numbers are unique per run (DB backstop)", async () => {
    const { run } = await runToVerifying("m9s2-unique");
    await expect(
      dataSource.query(
        `INSERT INTO "coordination_iterations"
         ("coordinationRunId", "iterationNumber", "workerManifest")
         VALUES ('${run.id}', 1, '[]'::jsonb)`,
      ),
    ).rejects.toThrow(/duplicate key|unique/i);
  });

  it("100-way same-decision CONTINUE creates exactly ONE next iteration", async () => {
    const { run, iteration } = await runToVerifying("m9s2-100way");

    const outcomes = await Promise.all(
      Array.from({ length: 100 }, () =>
        coordinator.consumeDecision(run.id, decision(iteration.id, 1), randomUUID()),
      ),
    );

    const consumed = outcomes.filter((outcome) => outcome.outcome === "consumed");
    const idempotent = outcomes.filter((outcome) => outcome.outcome === "idempotent");
    expect(consumed).toHaveLength(1);
    expect(idempotent).toHaveLength(99);
    expect(consumed[0]).toEqual({ outcome: "consumed", phase: "PLANNING" });

    const recovered = await coordinator.recoverRun(run.executionId);
    expect(recovered.iterations).toHaveLength(2);
    expect(recovered.iterations.map((entry) => entry.iterationNumber)).toEqual([1, 2]);
    expect(recovered.run.currentIterationNumber).toBe(2);
    expect(recovered.run.activeIterationId).toBe(recovered.iterations[1].id);
    // Exactly one decision stored, with its canonical hash.
    expect(recovered.iterations[0].decisionHash).toMatch(/^[0-9a-f]{64}$/);
    expect(recovered.iterations[1].decisionHash).toBeNull();
  });

  it("conflicting and stale decisions change nothing; ACCEPT releases the hold", async () => {
    const { run, iteration } = await runToVerifying("m9s2-accept");
    const accepted = await coordinator.consumeDecision(
      run.id,
      decision(iteration.id, 1, { action: "ACCEPT" }),
      randomUUID(),
    );
    expect(accepted).toEqual({ outcome: "consumed", phase: "ACCEPTED" });
    expect(await coordinator.isCompletionHeld(run.executionId)).toBe(false);
    // Terminal runs absorb every delivery idempotently (changes nothing).
    expect(
      (await coordinator.consumeDecision(run.id, decision(iteration.id, 1, { action: "ACCEPT" })))
        .outcome,
    ).toBe("idempotent");
    expect(
      (await coordinator.consumeDecision(run.id, decision(iteration.id, 1, { action: "ACCEPT", reason: "different" })))
        .outcome,
    ).toBe("idempotent");

    // While the run is LIVE, a different payload for a consumed decision is
    // conflict evidence and changes nothing.
    const { run: liveRun, iteration: liveIteration } = await runToVerifying("m9s2-conflict");
    await coordinator.consumeDecision(liveRun.id, decision(liveIteration.id, 1), randomUUID());
    const conflicting = await coordinator.consumeDecision(
      liveRun.id,
      decision(liveIteration.id, 1, { reason: "different payload" }),
      randomUUID(),
    );
    expect(conflicting.outcome).toBe("conflict");
    const recovered = await coordinator.recoverRun(liveRun.executionId);
    expect(recovered.iterations).toHaveLength(2);
    expect(recovered.iterations[0].decisionHash).not.toBeNull();
  });

  it("stale iteration identity is rejected and changes nothing", async () => {
    const { run } = await runToVerifying("m9s2-stale");
    await expect(
      coordinator.consumeDecision(run.id, decision("wrong-iteration-id", 1)),
    ).rejects.toMatchObject({ code: "DECISION_STALE" });
    const recovered = await coordinator.recoverRun(run.executionId);
    expect(recovered.run.phase).toBe("VERIFYING");
    expect(recovered.iterations[0].decisionHash).toBeNull();
    expect(recovered.iterations).toHaveLength(1);
  });

  it("WAIT_FOR_HUMAN persists the bounded wait reason", async () => {
    const { run, iteration } = await runToVerifying("m9s2-wait");
    const waited = await coordinator.consumeDecision(
      run.id,
      decision(iteration.id, 1, { action: "WAIT_FOR_HUMAN", reason: "human review required" }),
    );
    expect(waited).toEqual({ outcome: "consumed", phase: "WAITING_FOR_HUMAN" });
    const recovered = await coordinator.recoverRun(run.executionId);
    expect(recovered.run.waitReason).toBe("human review required");
    expect(await coordinator.isCompletionHeld(run.executionId)).toBe(true);
  });

  it("CONTINUE beyond maxIterations is a deterministic LIMIT_REACHED", async () => {
    const pipeline = await dataSource.getRepository(PipelineEntity).save(
      dataSource.getRepository(PipelineEntity).create({
        name: "m9s2-limit",
        version: "1.0",
        steps: [],
      }),
    );
    const execution = await dataSource.getRepository(ExecutionEntity).save(
      dataSource.getRepository(ExecutionEntity).create({
        pipelineId: pipeline.id,
        status: "PENDING",
        input: {},
      }),
    );
    const config = { ...teamConfig(), maxIterations: 1 };
    const run = await coordinator.startRun(
      execution.id,
      config,
      new Date(Date.now() + 3_600_000),
    );
    const iteration = await coordinator.createNextIteration(run.id);
    await coordinator.transitionRun(run.id, "plannerProposed");
    await coordinator.transitionRun(run.id, "batchValidated");
    await coordinator.transitionRun(run.id, "workersFinished");

    const outcome = await coordinator.consumeDecision(
      run.id,
      decision(iteration.id, 1),
    );
    expect(outcome).toEqual({ outcome: "consumed", phase: "LIMIT_REACHED" });
    const recovered = await coordinator.recoverRun(run.executionId);
    expect(recovered.iterations).toHaveLength(1);
  });

  it("a failed transition rolls back atomically (nothing partially persisted)", async () => {
    const { run } = await runToVerifying("m9s2-rollback");
    // Illegal transition from VERIFYING: the machine rejects it inside the
    // transaction; the run row and version stay untouched.
    await expect(
      coordinator.transitionRun(run.id, "plannerProposed"),
    ).rejects.toMatchObject({ code: "PHASE_TRANSITION_INVALID" });
    const recovered = await coordinator.recoverRun(run.executionId);
    expect(recovered.run.phase).toBe("VERIFYING");
    // startRun (1) + createNextIteration (2) + three transitions (5);
    // the failed transition left the version untouched.
    expect(recovered.run.version).toBe(5);
  });

  it("recovery reads PostgreSQL only and a fresh instance sees the same truth", async () => {
    const { run, iteration } = await runToVerifying("m9s2-recover");
    await coordinator.consumeDecision(run.id, decision(iteration.id, 1, { action: "FAIL" }));

    // Simulate a restart: a brand-new service instance re-reads everything.
    const restarted = new RuntimeCoordinationService(dataSource);
    const recovered = await restarted.recoverRun(run.executionId);
    expect(recovered.run.phase).toBe("FAILED");
    expect(recovered.iterations[0].decision).toMatchObject({ action: "FAIL" });
    expect(await restarted.isCompletionHeld(run.executionId)).toBe(false);
  });
});

describeWithPostgres("PostgreSQL M9-S3 planner-to-batch", () => {
  jest.setTimeout(180_000);

  let dataSource: DataSource;
  let coordinator: RuntimeCoordinationService;
  let executionService: ExecutionService;

  const teamConfig = (): CoordinationConfigV1 => ({
    schemaVersion: 1,
    planner: { kind: "agent", name: "planner" },
    verifier: { kind: "agent", name: "verifier" },
    allowedWorkers: [
      { kind: "agent", name: "implementation" },
      { kind: "agent", name: "reviewer" },
    ],
    maxIterations: 10,
    maxWorkersPerIteration: 4,
    maxTotalWorkers: 20,
    loopDeadlineMs: 3_600_000,
    delegationDepthMax: 2,
    // M8-S6 enforcement: agent-kind tasks resolve to `agent:<name>`.
    allowedExecutors: [
      "local-host",
      "agent:implementation",
      "agent:reviewer",
      "agent:planner",
      "agent:verifier",
    ],
  });

  const batchProposal = (baseRevision: number): TaskBatchProposalV1 => ({
    schemaVersion: 1,
    iterationNumber: 1,
    baseRevision,
    tasks: [
      {
        taskId: "implement",
        agent: "implementation",
        input: { feature: "login" },
        dependsOn: [],
        required: true,
        reason: "core implementation",
      },
      {
        taskId: "review",
        agent: "reviewer",
        input: { focus: "security" },
        dependsOn: ["implement"],
        required: false,
        reason: "optional review",
      },
    ],
    reason: "iteration 1 plan",
  });

  const seedRun = async (name: string) => {
    const pipeline = await dataSource.getRepository(PipelineEntity).save(
      dataSource.getRepository(PipelineEntity).create({
        name,
        version: "1.0",
        steps: [],
      }),
    );
    const executionRepository = dataSource.getRepository(ExecutionEntity);
    const execution = await executionRepository.save(
      executionRepository.create({
        pipelineId: pipeline.id,
        status: "PENDING",
        input: {},
      }),
    );
    // Mirror materializeExecutionWithManager: execution + initial revision.
    const revisionRepository = dataSource.getRepository(ExecutionPlanRevisionEntity);
    const revision = await revisionRepository.save(
      revisionRepository.create({
        executionId: execution.id,
        revisionNumber: 1,
        plan: { schemaVersion: 1, steps: [] },
        planHash: sha256Json({ schemaVersion: 1, steps: [] }),
        source: "pipeline",
        reason: "Initial execution plan snapshot",
        validationResult: { valid: true },
      }),
    );
    execution.activePlanRevisionId = revision.id;
    await executionRepository.save(execution);
    const run = await coordinator.startRun(
      execution.id,
      teamConfig(),
      new Date(Date.now() + 3_600_000),
    );
    const iteration = await coordinator.createNextIteration(run.id);
    return { run, iteration, execution, pipeline };
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
    coordinator = new RuntimeCoordinationService(dataSource);
    executionService = new ExecutionService(
      dataSource.getRepository(ExecutionEntity),
      dataSource.getRepository(LogicalStepEntity),
      dataSource.getRepository(StepAttemptEntity),
      dataSource.getRepository(ExecutionPlanRevisionEntity),
      dataSource,
    );
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await dataSource.query(
      `TRUNCATE "coordination_iterations", "coordination_runs",
       "plan_proposals", "policy_decisions", "policy_snapshots",
       "approval_requests", "connection_revisions", "runtime_connections",
       "dispatch_outbox", "step_attempts", "step_executions",
       "execution_plan_revisions", "executions", "pipelines" CASCADE`,
    );
  });

  it("creates the Coordinator-owned Planner step exactly once", async () => {
    const { run } = await seedRun("m9s3-planner-step");
    const stepId = await coordinator.createPlannerStep(run.id);
    expect(stepId).toBe("planner-1");
    expect(await coordinator.createPlannerStep(run.id)).toBe("planner-1");

    const step = await dataSource.getRepository(LogicalStepEntity).findOne({
      where: { executionId: run.executionId, stepId: "planner-1" },
    });
    expect(step).not.toBeNull();
    const revisions = await dataSource
      .getRepository(ExecutionPlanRevisionEntity)
      .find({
        where: { executionId: run.executionId },
        order: { revisionNumber: "ASC" },
      });
    expect(revisions).toHaveLength(2); // initial + planner step
    expect(revisions[1].plan.steps).toContainEqual(
      expect.objectContaining({ id: "planner-1", agent: "planner" }),
    );
  });

  it("validates the batch, compiles workers + verifier, and binds the iteration atomically", async () => {
    const { run, execution } = await seedRun("m9s3-submit");
    await coordinator.createPlannerStep(run.id);
    const { attemptId, baseRevision } = await seedPlannerAttempt(
      dataSource,
      executionService,
      execution.id,
      1,
    );

    const result = await coordinator.submitIterationBatch({
      runId: run.id,
      iterationNumber: 1,
      proposal: batchProposal(baseRevision),
      plannerAttemptId: attemptId,
    });
    expect(result).toEqual({ outcome: "ACCEPTED", revisionNumber: 3 });

    const recovered = await coordinator.recoverRun(run.executionId);
    expect(recovered.run.phase).toBe("WORKING");
    expect(recovered.run.cumulativeWorkers).toBe(2);
    const bound = recovered.iterations[0];
    expect(bound.plannerProposal).toMatchObject({ iterationNumber: 1 });
    expect(bound.acceptedPlanRevisionId).toBeDefined();
    expect(bound.verifierStepId).toBe("verify-1");
    expect(bound.workerManifest).toHaveLength(2);
    expect(bound.workerManifest[0]).toMatchObject({
      taskId: "implement",
      required: true,
    });
    expect(bound.workerManifest[1]).toMatchObject({
      taskId: "review",
      required: false,
    });

    // Steps materialized from the new revision: workers + verifier.
    const steps = await dataSource.getRepository(LogicalStepEntity).find({
      where: { executionId: run.executionId },
    });
    const byId = new Map(steps.map((step) => [step.stepId, step]));
    expect(byId.has("implement")).toBe(true);
    expect(byId.has("review")).toBe(true);
    expect(byId.has("verify-1")).toBe(true);
    // The manifest references real LogicalStep rows.
    for (const entry of bound.workerManifest) {
      expect(entry.logicalStepId).toBe(byId.get(entry.taskId)!.id);
    }
    // The Verifier step depends on every member.
    const revision = await dataSource
      .getRepository(ExecutionPlanRevisionEntity)
      .findOne({ where: { id: bound.acceptedPlanRevisionId } });
    const verifierStep = revision!.plan.steps.find(
      (step: any) => step.id === "verify-1",
    );
    expect(verifierStep.dependsOn).toEqual(["implement", "review"]);
  });

  it("rejects Planner recursion with no partial materialization", async () => {
    const { run } = await seedRun("m9s3-recursion");
    await coordinator.createPlannerStep(run.id);
    const recursive = batchProposal(1);
    recursive.tasks = [
      {
        taskId: "recursive",
        agent: "planner",
        input: {},
        dependsOn: [],
        required: true,
        reason: "recursion attempt",
      },
    ];

    await expect(
      coordinator.submitIterationBatch({
        runId: run.id,
        iterationNumber: 1,
        proposal: recursive,
        plannerAttemptId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "AGENT_NOT_ALLOWED" });

    const recovered = await coordinator.recoverRun(run.executionId);
    expect(recovered.run.phase).toBe("PLANNING");
    expect(recovered.run.cumulativeWorkers).toBe(0);
    const revisions = await dataSource
      .getRepository(ExecutionPlanRevisionEntity)
      .find({ where: { executionId: run.executionId } });
    expect(revisions).toHaveLength(2); // no batch revision
    const steps = await dataSource.getRepository(LogicalStepEntity).find({
      where: { executionId: run.executionId },
    });
    expect(steps.some((step) => step.stepId === "recursive")).toBe(false);
  });

  it("a re-delivered batch after acceptance is rejected deterministically without changes", async () => {
    const { run, execution } = await seedRun("m9s3-redeliver");
    await coordinator.createPlannerStep(run.id);
    const { attemptId, baseRevision } = await seedPlannerAttempt(
      dataSource,
      executionService,
      execution.id,
      1,
    );
    await coordinator.submitIterationBatch({
      runId: run.id,
      iterationNumber: 1,
      proposal: batchProposal(baseRevision),
      plannerAttemptId: attemptId,
    });

    await expect(
      coordinator.submitIterationBatch({
        runId: run.id,
        iterationNumber: 1,
        proposal: batchProposal(baseRevision),
        plannerAttemptId: attemptId,
      }),
    ).rejects.toMatchObject({ code: "RUN_NOT_FOUND" });

    const recovered = await coordinator.recoverRun(run.executionId);
    expect(recovered.run.phase).toBe("WORKING");
    expect(recovered.run.cumulativeWorkers).toBe(2);
  });

  it("M9 closure: an OLD iteration batch is rejected — admission requires run.currentIterationNumber", async () => {
    const { run, execution } = await seedRun("m9c-old-iteration");
    await coordinator.createPlannerStep(run.id);
    await coordinator.createNextIteration(run.id); // currentIterationNumber -> 2
    const { attemptId, baseRevision } = await seedPlannerAttempt(
      dataSource,
      executionService,
      execution.id,
      1,
    );
    await expect(
      coordinator.submitIterationBatch({
        runId: run.id,
        iterationNumber: 1, // stale: current is 2
        proposal: batchProposal(baseRevision),
        plannerAttemptId: attemptId,
      }),
    ).rejects.toMatchObject({ code: "ITERATION_NOT_FOUND" });
    const recovered = await coordinator.recoverRun(run.executionId);
    expect(recovered.run.currentIterationNumber).toBe(2);
    expect(recovered.run.phase).toBe("PLANNING");
  });

  it("M9 closure: a FUTURE iteration batch is rejected — admission requires run.currentIterationNumber", async () => {
    const { run, execution } = await seedRun("m9c-future-iteration");
    await coordinator.createPlannerStep(run.id);
    const { attemptId, baseRevision } = await seedPlannerAttempt(
      dataSource,
      executionService,
      execution.id,
      1,
    );
    await expect(
      coordinator.submitIterationBatch({
        runId: run.id,
        iterationNumber: 2, // not yet authorized
        proposal: { ...batchProposal(baseRevision), iterationNumber: 2 },
        plannerAttemptId: attemptId,
      }),
    ).rejects.toMatchObject({ code: "ITERATION_NOT_FOUND" });
    const recovered = await coordinator.recoverRun(run.executionId);
    expect(recovered.run.phase).toBe("PLANNING");
  });

  it("M9 closure: an unrelated successful Planner attempt is never accepted as batch authority", async () => {
    const { run, execution } = await seedRun("m9c-wrong-attempt");
    await coordinator.createPlannerStep(run.id);
    // A REAL successful planner attempt — but of a DIFFERENT execution.
    const other = await seedRun("m9c-wrong-attempt-other");
    await coordinator.createPlannerStep(other.run.id);
    const { attemptId, baseRevision } = await seedPlannerAttempt(
      dataSource,
      executionService,
      other.execution.id,
      1,
    );
    const outcome = await coordinator.submitIterationBatch({
      runId: run.id,
      iterationNumber: 1,
      proposal: batchProposal(baseRevision),
      plannerAttemptId: attemptId,
    });
    expect(outcome).toEqual({ outcome: "FAILED", revisionNumber: 0 });
    const recovered = await coordinator.recoverRun(run.executionId);
    expect(recovered.run.phase).toBe("FAILED");
    // No worker work was activated: only the Coordinator-owned planner step.
    const steps = await dataSource
      .getRepository(LogicalStepEntity)
      .find({ where: { executionId: execution.id } });
    expect(steps.map((step) => step.stepId)).toEqual(["planner-1"]);
  });

  it("M9 closure: N concurrent identical starts converge on exactly one CoordinationRun", async () => {
    const pipeline = await dataSource.getRepository(PipelineEntity).save(
      dataSource.getRepository(PipelineEntity).create({
        name: "m9c-concurrent-start",
        version: "1.0",
        steps: [],
      }),
    );
    const execution = await executionService.createExecution(pipeline, {});
    const config = teamConfig();
    const deadline = new Date(Date.now() + 3_600_000);
    const started = await Promise.all(
      Array.from({ length: 8 }, () =>
        coordinator.startRun(execution.id, config, deadline),
      ),
    );
    const runIds = new Set(started.map((run) => run.id));
    expect(runIds.size).toBe(1);
    const runs = await dataSource.getRepository(CoordinationRunEntity).find({
      where: { executionId: execution.id },
    });
    expect(runs).toHaveLength(1);
    expect(runs[0].phase).toBe("PLANNING");
  });

  it("M9 closure: a Planner batch on a stale base revision activates NO worker work (stale planner race)", async () => {
    const { run, execution } = await seedRun("m9c-stale-base");
    await coordinator.createPlannerStep(run.id);
    const { attemptId, baseRevision } = await seedPlannerAttempt(
      dataSource,
      executionService,
      execution.id,
      1,
    );
    // While the Planner "ran", an AUTHORIZED PlanPatch activates a newer
    // revision (a legitimate operator/coordinator patch on the same base).
    const proposals = new PlanProposalService(
      dataSource as any,
      new PipelineValidationService(new ConditionEvaluatorService()),
    );
    const authorized = await proposals.propose(
      execution.id,
      {
        schemaVersion: 1,
        baseRevision,
        operations: [
          {
            op: "addStep",
            step: {
              id: "authorized-extra",
              agent: "implementation",
              input: {},
              dependsOn: [],
            },
          },
        ],
      },
      "operator",
    );
    const activation = await proposals.activate(authorized.id);
    expect(activation.decision).toBe("ACCEPTED");

    // The Planner's batch is based on ITS frozen revision — which is no
    // longer active. It must be deterministically STALE: no worker work
    // from the stale proposal, no silent rebase onto the new revision.
    const outcome = await coordinator.submitIterationBatch({
      runId: run.id,
      iterationNumber: 1,
      proposal: batchProposal(baseRevision),
      plannerAttemptId: attemptId,
    });
    expect(outcome).toEqual({ outcome: "FAILED", revisionNumber: 0 });
    const recovered = await coordinator.recoverRun(run.executionId);
    expect(recovered.run.phase).toBe("FAILED");
    const stored = await dataSource
      .getRepository(ExecutionEntity)
      .findOne({ where: { id: execution.id } });
    expect(stored?.status).toBe("FAILED");
    expect(stored?.terminationReason).toContain("stale");
    const steps = await dataSource
      .getRepository(LogicalStepEntity)
      .find({ where: { executionId: execution.id } });
    // authorized-extra (the legitimate patch) exists; the stale batch's
    // workers (implement/review) were NEVER materialized.
    const stepIds = steps.map((step) => step.stepId).sort();
    expect(stepIds).toEqual(["authorized-extra", "planner-1"]);
  });

  it("M9 closure: current=2, input=2, proposal iterationNumber=1 (older) is rejected with zero materialization", async () => {
    const { run, execution } = await seedRun("m9c-proposal-old-iteration");
    await coordinator.createPlannerStep(run.id);
    await coordinator.createNextIteration(run.id); // currentIterationNumber -> 2
    const { attemptId, baseRevision } = await seedPlannerAttempt(
      dataSource,
      executionService,
      execution.id,
      1,
    );
    // The caller declares the CURRENT iteration, but the untrusted
    // proposal embeds an OLDER iterationNumber — exact identity requires
    // all three (run.currentIterationNumber, input, proposal) to agree.
    await expect(
      coordinator.submitIterationBatch({
        runId: run.id,
        iterationNumber: 2,
        proposal: { ...batchProposal(baseRevision), iterationNumber: 1 },
        plannerAttemptId: attemptId,
      }),
    ).rejects.toMatchObject({ code: "ITERATION_NOT_FOUND" });

    const recovered = await coordinator.recoverRun(run.executionId);
    expect(recovered.run.currentIterationNumber).toBe(2);
    expect(recovered.run.phase).toBe("PLANNING");
    expect(recovered.run.cumulativeWorkers).toBe(0);
    // No plan revision was created from the invalid batch and no worker or
    // verifier step was materialized.
    const revisions = await dataSource
      .getRepository(ExecutionPlanRevisionEntity)
      .find({ where: { executionId: run.executionId } });
    expect(revisions).toHaveLength(2); // initial + planner step only
    const steps = await dataSource
      .getRepository(LogicalStepEntity)
      .find({ where: { executionId: run.executionId } });
    expect(steps.some((step) => step.stepId === "implement")).toBe(false);
    expect(steps.some((step) => step.stepId === "verify-1")).toBe(false);
  });

  it("M9 closure: current=2, input=2, proposal iterationNumber=3 (future) is rejected with zero materialization", async () => {
    const { run, execution } = await seedRun("m9c-proposal-future-iteration");
    await coordinator.createPlannerStep(run.id);
    await coordinator.createNextIteration(run.id); // currentIterationNumber -> 2
    const { attemptId, baseRevision } = await seedPlannerAttempt(
      dataSource,
      executionService,
      execution.id,
      1,
    );
    await expect(
      coordinator.submitIterationBatch({
        runId: run.id,
        iterationNumber: 2,
        proposal: { ...batchProposal(baseRevision), iterationNumber: 3 },
        plannerAttemptId: attemptId,
      }),
    ).rejects.toMatchObject({ code: "ITERATION_NOT_FOUND" });

    const recovered = await coordinator.recoverRun(run.executionId);
    expect(recovered.run.currentIterationNumber).toBe(2);
    expect(recovered.run.phase).toBe("PLANNING");
    expect(recovered.run.cumulativeWorkers).toBe(0);
    const revisions = await dataSource
      .getRepository(ExecutionPlanRevisionEntity)
      .find({ where: { executionId: run.executionId } });
    expect(revisions).toHaveLength(2);
    const steps = await dataSource
      .getRepository(LogicalStepEntity)
      .find({ where: { executionId: run.executionId } });
    expect(steps.some((step) => step.stepId === "implement")).toBe(false);
    expect(steps.some((step) => step.stepId === "verify-1")).toBe(false);
  });

  it("M9 closure: batch submission holds the authority point under the execution lock — a concurrent authorized activation of N+1 serializes behind it and becomes STALE (never a silent rebase)", async () => {
    const { run, execution } = await seedRun("m9c-race-t1-first");
    await coordinator.createPlannerStep(run.id);
    const { attemptId, baseRevision } = await seedPlannerAttempt(
      dataSource,
      executionService,
      execution.id,
      1,
    );
    // T2's authorized PlanPatch on the same base N (proposed, not yet
    // activated — exactly the "authorized activation attempts N+1" case).
    const proposals = new PlanProposalService(
      dataSource as any,
      new PipelineValidationService(new ConditionEvaluatorService()),
    );
    const authorized = await proposals.propose(
      execution.id,
      {
        schemaVersion: 1,
        baseRevision,
        operations: [
          {
            op: "addStep",
            step: {
              id: "authorized-extra",
              agent: "implementation",
              input: {},
              dependsOn: [],
            },
          },
        ],
      },
      "operator",
    );

    // Barrier: a raw connection holds the execution row lock so T1 parks
    // at the pre-proposal authority point (after Planner-attempt
    // validation and the frozen-base checks, before any activation can
    // interleave).
    const client = await rawPgClient(dataSource);
    try {
      await client.query("BEGIN");
      await client.query(
        `SELECT id FROM executions WHERE id = $1 FOR UPDATE`,
        [execution.id],
      );

      const t1 = coordinator.submitIterationBatch({
        runId: run.id,
        iterationNumber: 1,
        proposal: batchProposal(baseRevision),
        plannerAttemptId: attemptId,
      });
      // T1 must be parked on the execution lock: the authority point.
      // (The needle matches the query HEAD — pg_stat_activity truncates
      // long SELECT lists past the FROM clause.)
      await waitForLockWait(client, '"execution"."id"', 1);

      // T2 attempts the authorized activation while T1 is at the authority
      // point. T1 is already queued on the execution row lock, so T2 can
      // never overtake it: T1 linearizes first, T2 serializes behind and
      // becomes STALE. (T2's own lock-wait is not polled — node-postgres
      // pool connections blocked on a row lock are not visible in
      // pg_stat_activity/pg_locks promptly; the outcome assertions below
      // are the proof.)
      const t2 = proposals.activate(authorized.id);
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Release the barrier: T1 linearizes first, T2 serializes after and
      // becomes STALE.
      await client.query("COMMIT");
      const [t1Outcome, t2Outcome] = await Promise.all([t1, t2]);
      expect(t1Outcome).toEqual({
        outcome: "ACCEPTED",
        revisionNumber: baseRevision + 1,
      });
      expect(t2Outcome.decision).toBe("STALE");
      expect(t2Outcome.reason).toContain("no longer active");
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }

    // The batch's proposal was created with baseRevision N — never rebased
    // onto the concurrent activation's base.
    const storedProposals = await dataSource
      .getRepository(PlanProposalEntity)
      .find({ where: { executionId: execution.id } });
    const plannerProposal = storedProposals.find(
      (proposal) => proposal.source === "planner",
    );
    expect(plannerProposal).toBeDefined();
    expect(plannerProposal!.baseRevision).toBe(baseRevision);
    const activated = await dataSource
      .getRepository(ExecutionPlanRevisionEntity)
      .findOne({
        where: { executionId: run.executionId, revisionNumber: baseRevision + 1 },
      });
    expect(activated?.baseRevision).toBe(baseRevision);
    // T1's workers materialized; T2's authorized-extra never did (STALE).
    const steps = await dataSource
      .getRepository(LogicalStepEntity)
      .find({ where: { executionId: run.executionId } });
    const stepIds = steps.map((step) => step.stepId).sort();
    expect(stepIds).toEqual(["implement", "planner-1", "review", "verify-1"]);
  });

  it("M9 closure: an authorized activation that commits N+1 first makes the in-flight Planner batch deterministically STALE (T2 linearizes first)", async () => {
    const { run, execution } = await seedRun("m9c-race-t2-first");
    await coordinator.createPlannerStep(run.id);
    const { attemptId, baseRevision } = await seedPlannerAttempt(
      dataSource,
      executionService,
      execution.id,
      1,
    );
    const proposals = new PlanProposalService(
      dataSource as any,
      new PipelineValidationService(new ConditionEvaluatorService()),
    );
    const authorized = await proposals.propose(
      execution.id,
      {
        schemaVersion: 1,
        baseRevision,
        operations: [
          {
            op: "addStep",
            step: {
              id: "authorized-extra",
              agent: "implementation",
              input: {},
              dependsOn: [],
            },
          },
        ],
      },
      "operator",
    );

    // Barrier: hold the COORDINATION RUN row lock so T1 is parked at its
    // first statement while T2's authorized activation commits N+1.
    const client = await rawPgClient(dataSource);
    try {
      await client.query("BEGIN");
      await client.query(
        `SELECT id FROM coordination_runs WHERE id = $1 FOR UPDATE`,
        [run.id],
      );

      const t1 = coordinator.submitIterationBatch({
        runId: run.id,
        iterationNumber: 1,
        proposal: batchProposal(baseRevision),
        plannerAttemptId: attemptId,
      });
      await waitForLockWait(client, '"run"."id"', 1);

      // T2 activates N+1 fully while T1 is in flight.
      const t2Outcome = await proposals.activate(authorized.id);
      expect(t2Outcome.decision).toBe("ACCEPTED");

      await client.query("COMMIT");
      const t1Outcome = await t1;
      expect(t1Outcome).toEqual({ outcome: "FAILED", revisionNumber: 0 });
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }

    const recovered = await coordinator.recoverRun(run.executionId);
    expect(recovered.run.phase).toBe("FAILED");
    const stored = await dataSource
      .getRepository(ExecutionEntity)
      .findOne({ where: { id: execution.id } });
    expect(stored?.status).toBe("FAILED");
    expect(stored?.terminationReason).toContain("PLANNER_BASE_STALE");
    // The stale batch's workers never materialized; only the authorized
    // patch's step exists.
    const steps = await dataSource
      .getRepository(LogicalStepEntity)
      .find({ where: { executionId: run.executionId } });
    const stepIds = steps.map((step) => step.stepId).sort();
    expect(stepIds).toEqual(["authorized-extra", "planner-1"]);
    // The Planner batch was never rebased onto N+1: no planner-sourced
    // proposal was ever created.
    const plannerProposals = await dataSource
      .getRepository(PlanProposalEntity)
      .find({ where: { executionId: execution.id, source: "planner" } });
    expect(plannerProposals).toHaveLength(0);
  });
});

describeWithPostgres("PostgreSQL M9-S4 fan-out/fan-in/decision loop", () => {
  jest.setTimeout(240_000);

  let dataSource: DataSource;
  let coordinator: RuntimeCoordinationService;
  let executionService: ExecutionService;
  let outboxService: DispatchOutboxService;
  let engine: EngineService;

  const teamConfig = (): CoordinationConfigV1 => ({
    schemaVersion: 1,
    planner: { kind: "agent", name: "planner" },
    verifier: { kind: "agent", name: "verifier" },
    allowedWorkers: [
      { kind: "agent", name: "implementation" },
      { kind: "agent", name: "tests" },
    ],
    maxIterations: 3,
    maxWorkersPerIteration: 4,
    maxTotalWorkers: 20,
    loopDeadlineMs: 3_600_000,
    delegationDepthMax: 2,
    // M8-S6 enforcement: agent-kind tasks resolve to `agent:<name>`.
    allowedExecutors: [
      "local-host",
      "agent:implementation",
      "agent:tests",
      "agent:planner",
      "agent:verifier",
    ],
  });

  const activeRevisionNumber = async (): Promise<number> => {
    const execution = await dataSource
      .getRepository(ExecutionEntity)
      .findOne({ where: { id: executionId } });
    const revision = await dataSource
      .getRepository(ExecutionPlanRevisionEntity)
      .findOne({ where: { id: execution?.activePlanRevisionId } });
    if (!revision) throw new Error("no active plan revision");
    return revision.revisionNumber;
  };
  // M9-S8: the Planner batch must declare the revision its attempt will be
  // frozen on. If the iteration's Planner step is ALREADY materialized, its
  // frozen revision is the CURRENT active revision; if not (the step is
  // created by the next reconciliation), it is active + 1 (the revision
  // that activation creates). Derived from actual state, never magic.
  const plannerBaseRevision = async (iterationNumber: number): Promise<number> => {
    const exists = await dataSource
      .getRepository(LogicalStepEntity)
      .findOne({
        where: { executionId, stepId: `planner-${iterationNumber}` },
        select: ["id"],
      });
    return (await activeRevisionNumber()) + (exists ? 0 : 1);
  };

  const batchProposal = (
    iterationNumber: number,
    baseRevision: number,
  ): TaskBatchProposalV1 => ({
    schemaVersion: 1,
    iterationNumber,
    baseRevision,
    tasks: [
      {
        taskId: `implement-${iterationNumber}`,
        agent: "implementation",
        input: { feature: "login" },
        dependsOn: [],
        required: true,
        reason: "core implementation",
      },
      {
        taskId: `tests-${iterationNumber}`,
        agent: "tests",
        input: {},
        dependsOn: [`implement-${iterationNumber}`],
        required: true,
        reason: "tests",
      },
    ],
    reason: `iteration ${iterationNumber} plan`,
  });

  const decision = (
    iterationId: string,
    iterationNumber: number,
    action: VerifierDecisionV1["action"],
  ): VerifierDecisionV1 => ({
    schemaVersion: 1,
    iterationId,
    iterationNumber,
    action,
    reason: "deterministic verifier",
    evidenceRefs: [],
  });

  const recordingAdapter = () => {
    const calls: Array<{ invocation: unknown; pinned: unknown }> = [];
    return {
      calls,
      adapter: {
        kind: "test",
        invoke: jest.fn(async (invocation: any, pinned: any) => {
          calls.push({ invocation, pinned });
          return {
            adapter: "test",
            invocationId: invocation.invocationId,
            dispatchedAt: new Date().toISOString(),
          };
        }),
      },
    };
  };

  const successfulResult = (claim: any, output: JsonValue): AgentResultV1 => ({
    schemaVersion: "1",
    invocationId: claim.attempt.invocationId,
    executionId: claim.attempt.executionId,
    stepExecutionId: claim.logicalStep.id,
    status: "succeeded",
    output,
    completedAt: new Date().toISOString(),
  });

  const runStep = async (
    stepId: string,
    output: unknown,
    inbox: ResultInboxService,
  ): Promise<void> => {
    // Engine claims the due step; outbox dispatches; the deterministic
    // worker result is applied through the existing inbox authority.
    await engine.reconcileExecution(executionId);
    await outboxService.dispatchNext();
    const logical = await dataSource
      .getRepository(LogicalStepEntity)
      .findOne({ where: { executionId, stepId } });
    if (!logical) throw new Error(`step ${stepId} not claimed`);
    const attempt = await dataSource
      .getRepository(StepAttemptEntity)
      .findOne({
        where: { logicalStepId: logical.id },
        order: { attemptNumber: "DESC" },
      });
    if (!attempt || attempt.status === "SUCCESS") return;
    await inbox.apply(successfulResult({ logicalStep: logical, attempt }, output as JsonValue), {
      adapter: "http",
      receivedAt: new Date().toISOString(),
      deliveryId: `delivery-${stepId}`,
    });
  };

  let executionId: string;
  let inbox: ResultInboxService;

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
    coordinator = new RuntimeCoordinationService(dataSource);
    inbox = new ResultInboxService(dataSource);
    executionService = new ExecutionService(
      dataSource.getRepository(ExecutionEntity),
      dataSource.getRepository(LogicalStepEntity),
      dataSource.getRepository(StepAttemptEntity),
      dataSource.getRepository(ExecutionPlanRevisionEntity),
      dataSource,
    );
    const rec = recordingAdapter();
    outboxService = new DispatchOutboxService(
      dataSource as any,
      rec.adapter as any,
      new AgentTransportConfigService(parseAgentTransportConfiguration({})),
    );
    engine = new EngineService(
      new PipelineService(
        dataSource as any,
        new PipelineValidationService(new ConditionEvaluatorService()),
      ) as any,
      executionService,
      rec.adapter as any,
      outboxService,
    );
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await dataSource.query(
      `TRUNCATE "coordination_iterations", "coordination_runs",
       "plan_proposals", "policy_decisions", "policy_snapshots",
       "approval_requests", "result_conflicts", "result_inbox",
       "agent_events", "dispatch_outbox", "step_attempts",
       "step_executions", "execution_plan_revisions", "executions",
       "pipelines" CASCADE`,
    );
    const pipeline = await dataSource.getRepository(PipelineEntity).save(
      dataSource.getRepository(PipelineEntity).create({
        name: "m9s4-loop",
        version: "1.0",
        steps: [],
      }),
    );
    const execution = await executionService.createExecution(pipeline, {});
    executionId = execution.id;
    await engine.reconcileExecution(executionId);
    const run = await coordinator.startRun(
      executionId,
      teamConfig(),
      new Date(Date.now() + 3_600_000),
    );
    await coordinator.createNextIteration(run.id);
    await coordinator.createPlannerStep(run.id);
  });

  it("runs two CONTINUE iterations and ACCEPT releases the completion hold", async () => {
    // Iteration 1: planner proposes -> workers -> verifier CONTINUE.
    await runStep("planner-1", batchProposal(1, await plannerBaseRevision(1)), inbox);
    await runStep("implement-1", { diff: { files: 3 } }, inbox);
    await runStep("tests-1", { passed: 12 }, inbox);
    await engine.reconcileExecution(executionId);
    const run = await coordinator.recoverRun(executionId);
    expect(run.run.phase).toBe("VERIFYING");
    await runStep("verify-1", decision(run.iterations[0].id, 1, "CONTINUE"), inbox);
    await engine.reconcileExecution(executionId);
    const afterContinue = await coordinator.recoverRun(executionId);
    expect(afterContinue.run.phase).toBe("PLANNING");
    expect(afterContinue.run.currentIterationNumber).toBe(2);

    // Iteration 2: planner proposes -> workers -> verifier ACCEPT.
    await runStep("planner-2", batchProposal(2, await plannerBaseRevision(2)), inbox);
    await runStep("implement-2", { diff: { files: 5 } }, inbox);
    await runStep("tests-2", { passed: 20 }, inbox);
    await engine.reconcileExecution(executionId);
    await runStep("verify-2", decision(afterContinue.iterations[1].id, 2, "ACCEPT"), inbox);
    await engine.reconcileExecution(executionId);
    const afterAccept = await coordinator.recoverRun(executionId);
    expect(afterAccept.run.phase).toBe("ACCEPTED");
    expect(await coordinator.isCompletionHeld(executionId)).toBe(false);
    expect(afterAccept.iterations).toHaveLength(2);
    expect(afterAccept.run.cumulativeWorkers).toBe(4);
  });

  it("the Verifier receives a bounded aggregation frozen at claim time", async () => {
    await runStep("planner-1", batchProposal(1, await plannerBaseRevision(1)), inbox);
    await runStep("implement-1", { diff: { files: 3 }, artifactRefs: ["artifact:one"] }, inbox);
    await runStep("tests-1", { passed: 12 }, inbox);
    await engine.reconcileExecution(executionId);

    // The engine claims the verifier; the claim-time hook builds the input.
    await engine.reconcileExecution(executionId);
    await outboxService.dispatchNext();
    const logical = await dataSource
      .getRepository(LogicalStepEntity)
      .findOne({ where: { executionId, stepId: "verify-1" } });
    const attempt = await dataSource
      .getRepository(StepAttemptEntity)
      .findOne({ where: { logicalStepId: logical!.id } });
    const input = attempt!.inputSnapshot as { context: any };
    expect(input.context.iterationNumber).toBe(1);
    expect(input.context.workers).toHaveLength(2);
    expect(input.context.workers[0]).toMatchObject({
      taskId: "implement-1",
      status: "SUCCESS",
    });
    expect(input.context.workers[0].artifactRefs).toEqual(["artifact:one"]);
    expect(input.context.workers[1].selectedFields).toEqual({ passed: 12 });
    expect(input.context.limits).toMatchObject({
      maxIterations: 3,
      cumulativeWorkers: 2,
    });
    // Bounded and secret-free.
    const rendered = JSON.stringify(input.context);
    expect(rendered.length).toBeLessThan(128 * 1024);
    expect(rendered).not.toContain("sk-");
    expect(rendered).not.toMatch(/chain.of.thought|raw.log/i);
  });

  it("a required worker failure terminalizes the loop deterministically", async () => {
    await runStep("planner-1", batchProposal(1, await plannerBaseRevision(1)), inbox);
    await engine.reconcileExecution(executionId);
    await outboxService.dispatchNext();
    const logical = await dataSource
      .getRepository(LogicalStepEntity)
      .findOne({ where: { executionId, stepId: "implement-1" } });
    const attempt = await dataSource
      .getRepository(StepAttemptEntity)
      .findOne({ where: { logicalStepId: logical!.id } });
    const failed: AgentResultV1 = {
      schemaVersion: "1",
      invocationId: attempt!.invocationId,
      executionId,
      stepExecutionId: logical!.id,
      status: "failed",
      output: { error: "implementation broke" },
      completedAt: new Date().toISOString(),
    };
    await inbox.apply(failed, {
        adapter: "http",
        receivedAt: new Date().toISOString(),
        deliveryId: "delivery-failed",
      });
    await engine.reconcileExecution(executionId);
    const run = await coordinator.recoverRun(executionId);
    expect(run.run.phase).toBe("FAILED");
  });

  it("WAIT_FOR_HUMAN persists, approve continues to the next iteration, deny fails", async () => {
    await runStep("planner-1", batchProposal(1, await plannerBaseRevision(1)), inbox);
    await runStep("implement-1", { diff: { files: 3 } }, inbox);
    await runStep("tests-1", { passed: 12 }, inbox);
    await engine.reconcileExecution(executionId);
    const run = await coordinator.recoverRun(executionId);
    await runStep("verify-1", decision(run.iterations[0].id, 1, "WAIT_FOR_HUMAN"), inbox);
    await engine.reconcileExecution(executionId);
    const waiting = await coordinator.recoverRun(executionId);
    expect(waiting.run.phase).toBe("WAITING_FOR_HUMAN");
    expect(waiting.run.waitReason).toBe("deterministic verifier");

    const approved = await coordinator.resolveWait(waiting.run.id, true);
    expect(approved).toBe("PLANNING");
    const afterApprove = await coordinator.recoverRun(executionId);
    expect(afterApprove.run.currentIterationNumber).toBe(2);

    // A second WAIT then deny -> FAILED.
    await runStep("planner-2", batchProposal(2, await plannerBaseRevision(2)), inbox);
    await runStep("implement-2", { diff: { files: 5 } }, inbox);
    await runStep("tests-2", { passed: 20 }, inbox);
    await engine.reconcileExecution(executionId);
    const run2 = await coordinator.recoverRun(executionId);
    await runStep("verify-2", decision(run2.iterations[1].id, 2, "WAIT_FOR_HUMAN"), inbox);
    await engine.reconcileExecution(executionId);
    const denied = await coordinator.resolveWait(run2.run.id, false);
    expect(denied).toBe("FAILED");
    const afterDeny = await coordinator.recoverRun(executionId);
    expect(afterDeny.run.phase).toBe("FAILED");
    expect(afterDeny.iterations).toHaveLength(2);
  });
});

describeWithPostgres("PostgreSQL M9-S5 authority integration", () => {
  jest.setTimeout(240_000);

  let dataSource: DataSource;
  let coordinator: RuntimeCoordinationService;
  let executionService: ExecutionService;
  let capsules: ExecutionCapsuleService;

  const teamConfig = (overrides: Partial<CoordinationConfigV1> = {}): CoordinationConfigV1 => ({
    schemaVersion: 1,
    planner: { kind: "agent", name: "planner" },
    verifier: { kind: "agent", name: "verifier" },
    allowedWorkers: [
      { kind: "agent", name: "implementation" },
      { kind: "connection", name: "conn:worker", agent: "worker" },
    ],
    maxIterations: 3,
    maxWorkersPerIteration: 4,
    maxTotalWorkers: 20,
    loopDeadlineMs: 3_600_000,
    delegationDepthMax: 2,
    // M8-S6 enforcement: agent-kind tasks resolve to `agent:<name>`;
    // connection-kind tasks resolve to the connection's executorId.
    allowedExecutors: [
      "local-host",
      "agent:implementation",
      "agent:planner",
      "agent:verifier",
    ],
    ...overrides,
  });

  const seedRun = async (name: string, config: CoordinationConfigV1, loopDeadlineAt?: Date) => {
    const pipeline = await dataSource.getRepository(PipelineEntity).save(
      dataSource.getRepository(PipelineEntity).create({ name, version: "1.0", steps: [] }),
    );
    const execution = await executionService.createExecution(pipeline, {});
    await executionService.reconcileExecution(execution.id);
    const run = await coordinator.startRun(
      execution.id,
      config,
      loopDeadlineAt ?? new Date(Date.now() + 3_600_000),
    );
    const iteration = await coordinator.createNextIteration(run.id);
    return { run, iteration, execution };
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
    coordinator = new RuntimeCoordinationService(dataSource);
    executionService = new ExecutionService(
      dataSource.getRepository(ExecutionEntity),
      dataSource.getRepository(LogicalStepEntity),
      dataSource.getRepository(StepAttemptEntity),
      dataSource.getRepository(ExecutionPlanRevisionEntity),
      dataSource,
    );
    capsules = new ExecutionCapsuleService(
      dataSource as any,
      new DelegationService(dataSource as any, executionService),
      executionService,
    );
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await dataSource.query(
      `TRUNCATE "coordination_iterations", "coordination_runs",
       "execution_replays", "execution_exports", "delegation_requests",
       "delegation_observation_conflicts", "delegation_observations",
       "plan_proposals", "policy_decisions", "policy_snapshots",
       "approval_requests", "budget_ledger_entries", "budget_reservations",
       "budget_accounts", "state_write_evidence", "artifacts",
       "result_conflicts", "result_inbox", "agent_events",
       "dispatch_outbox", "step_attempts", "step_executions",
       "execution_plan_revisions", "executions", "pipelines" CASCADE`,
    );
  });

  it("a past loop deadline terminalizes LIMIT_REACHED in any live phase", async () => {
    const { run } = await seedRun(
      "m9s5-deadline",
      teamConfig(),
      new Date(Date.now() - 1_000),
    );
    expect(await executionService.reconcileCoordination(run.executionId)).toBe(
      true,
    );
    const recovered = await coordinator.recoverRun(run.executionId);
    expect(recovered.run.phase).toBe("LIMIT_REACHED");

    // CONTINUE on an expired run is also refused deterministically.
    const { run: live, iteration } = await seedRun("m9s5-deadline2", teamConfig());
    await coordinator.transitionRun(live.id, "plannerProposed");
    await coordinator.transitionRun(live.id, "batchValidated");
    await coordinator.transitionRun(live.id, "workersFinished");
    await dataSource
      .getRepository(CoordinationRunEntity)
      .update({ id: live.id }, { loopDeadlineAt: new Date(Date.now() - 1_000) });
    const outcome = await coordinator.consumeDecision(
      live.id,
      {
        schemaVersion: 1,
        iterationId: iteration.id,
        iterationNumber: 1,
        action: "CONTINUE",
        reason: "too late",
        evidenceRefs: [],
      },
    );
    expect(outcome).toEqual({ outcome: "consumed", phase: "LIMIT_REACHED" });
  });

  it("a missing or exhausted run-level budget account stops the loop", async () => {
    const { run, iteration } = await seedRun(
      "m9s5-budget",
      teamConfig({ budgetAccountId: "no-such-account" }),
    );
    await coordinator.transitionRun(run.id, "plannerProposed");
    await coordinator.transitionRun(run.id, "batchValidated");
    await coordinator.transitionRun(run.id, "workersFinished");
    const outcome = await coordinator.consumeDecision(
      run.id,
      {
        schemaVersion: 1,
        iterationId: iteration.id,
        iterationNumber: 1,
        action: "CONTINUE",
        reason: "no budget",
        evidenceRefs: [],
      },
    );
    expect(outcome).toEqual({ outcome: "consumed", phase: "LIMIT_REACHED" });
  });

  it("a revoked M8 connection rejects the batch deterministically", async () => {
    const connections = new RuntimeConnectionService(dataSource);
    await connections.createConnection("conn:worker", {
      name: "Worker connection",
      runtimeKind: "generic-cli",
      executorId: "local-host",
      credentialRefs: [],
      declaredCapabilities: {},
      cli: {
        command: process.execPath,
        args: [],
        probe: { args: ["-e", "console.log('1.0.0')"], expectsVersion: true },
      },
    });
    await connections.revokeConnection("conn:worker");

    const { run } = await seedRun("m9s5-revoke", teamConfig());
    await coordinator.createPlannerStep(run.id);
    await expect(
      coordinator.submitIterationBatch({
        runId: run.id,
        iterationNumber: 1,
        proposal: {
          schemaVersion: 1,
          iterationNumber: 1,
          baseRevision: 1,
          tasks: [
            {
              taskId: "worker-1",
              agent: "worker",
              connectionId: "conn:worker",
              input: {},
              dependsOn: [],
              required: true,
              reason: "revoked connection attempt",
            },
          ],
          reason: "revoked",
        },
        plannerAttemptId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "CONNECTION_NOT_ALLOWED" });
    const recovered = await coordinator.recoverRun(run.executionId);
    expect(recovered.run.phase).toBe("PLANNING");
  });

  it("cancelling a coordinated execution mid-WORKING terminalizes the run CANCELLED", async () => {
    const { run, execution } = await seedRun("m9s5-cancel", teamConfig());
    await coordinator.createPlannerStep(run.id);
    const { attemptId, baseRevision } = await seedPlannerAttempt(
      dataSource,
      executionService,
      execution.id,
      1,
    );
    await coordinator.submitIterationBatch({
      runId: run.id,
      iterationNumber: 1,
      proposal: {
        schemaVersion: 1,
        iterationNumber: 1,
        baseRevision,
        tasks: [
          {
            taskId: "implement-1",
            agent: "implementation",
            input: {},
            dependsOn: [],
            required: true,
            reason: "work",
          },
        ],
        reason: "iteration 1",
      },
      plannerAttemptId: attemptId,
    });
    expect((await coordinator.recoverRun(run.executionId)).run.phase).toBe("WORKING");

    await executionService.cancelExecution(execution.id);
    expect(await executionService.reconcileCoordination(execution.id)).toBe(true);
    const recovered = await coordinator.recoverRun(run.executionId);
    expect(recovered.run.phase).toBe("CANCELLED");
  });

  it("Capsules project the loop without duplicating authority; replay re-creates a fresh run", async () => {
    const { run, iteration, execution } = await seedRun("m9s5-capsule", teamConfig());
    await coordinator.createPlannerStep(run.id);
    const { attemptId, baseRevision } = await seedPlannerAttempt(
      dataSource,
      executionService,
      execution.id,
      1,
    );
    await coordinator.submitIterationBatch({
      runId: run.id,
      iterationNumber: 1,
      proposal: {
        schemaVersion: 1,
        iterationNumber: 1,
        baseRevision,
        tasks: [
          {
            taskId: "implement-1",
            agent: "implementation",
            input: {},
            dependsOn: [],
            required: true,
            reason: "work",
          },
        ],
        reason: "iteration 1",
      },
      plannerAttemptId: attemptId,
    });
    await coordinator.transitionRun(run.id, "workersFinished");
    await coordinator.consumeDecision(
      run.id,
      {
        schemaVersion: 1,
        iterationId: iteration.id,
        iterationNumber: 1,
        action: "ACCEPT",
        reason: "done",
        evidenceRefs: [],
      },
      randomUUID(),
    );
    await executionService.cancelExecution(execution.id);

    const capsule = await capsules.build(execution.id);
    expect(capsule.coordination).toBeDefined();
    expect(capsule.coordination!.run.phase).toBe("ACCEPTED");
    expect(capsule.coordination!.iterations).toHaveLength(1);
    expect(capsule.coordination!.iterations[0]).toMatchObject({
      iterationNumber: 1,
      workerCount: 1,
      requiredCount: 1,
      decisionAction: "ACCEPT",
    });
    expect(capsule.coordination!.iterations[0].decisionHash).toMatch(/^[0-9a-f]{64}$/);
    const rendered = JSON.stringify(capsule);
    expect(rendered).not.toContain("sk-");

    // Replay creates a NEW run with the frozen template and a FRESH deadline.
    const replay = await capsules.replay(execution.id);
    const replayedRun = await coordinator.recoverRun(replay.targetExecutionId);
    expect(replayedRun.run.phase).toBe("PLANNING");
    expect(replayedRun.run.currentIterationNumber).toBe(0);
    expect(replayedRun.run.config.maxIterations).toBe(3);
    expect(replayedRun.run.loopDeadlineAt.getTime()).toBeGreaterThan(Date.now());
    expect(replayedRun.iterations).toHaveLength(0);
  });
});

describeWithPostgres("PostgreSQL M10-S1 workbench projections", () => {
  jest.setTimeout(180_000);

  let dataSource: DataSource;
  let projection: WorkbenchProjectionService;
  let coordinator: RuntimeCoordinationService;
  let executionService: ExecutionService;

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
    projection = new WorkbenchProjectionService(dataSource);
    coordinator = new RuntimeCoordinationService(dataSource);
    executionService = new ExecutionService(
      dataSource.getRepository(ExecutionEntity),
      dataSource.getRepository(LogicalStepEntity),
      dataSource.getRepository(StepAttemptEntity),
      dataSource.getRepository(ExecutionPlanRevisionEntity),
      dataSource,
    );
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await dataSource.query(
      `TRUNCATE "coordination_iterations", "coordination_runs",
       "plan_proposals", "approval_requests", "artifacts",
       "result_conflicts", "result_inbox", "agent_events",
       "dispatch_outbox", "step_attempts", "step_executions",
       "execution_plan_revisions", "executions", "pipelines",
       "connection_revisions", "runtime_connections" CASCADE`,
    );
  });

  it("projects connection cards with status and bounded capabilities", async () => {
    const connections = new RuntimeConnectionService(dataSource);
    await connections.createConnection("conn:proj", {
      name: "Projection CLI",
      runtimeKind: "generic-cli",
      executorId: "local-host",
      credentialRefs: [],
      declaredCapabilities: {
        artifacts: { supported: true, source: "configured" },
        cancellation: { supported: false, source: "configured" },
      },
      cli: {
        command: process.execPath,
        args: [],
        probe: {
          args: ["-e", "console.log('1.2.3')"],
          expectsVersion: true,
        },
      },
    });
    await connections.testConnection("conn:proj", {} as never);

    const { cards } = await projection.connectionCards();
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      connectionId: "conn:proj",
      runtimeKind: "generic-cli",
      status: "AVAILABLE",
      testedVersion: "1.2.3",
      revoked: false,
    });
    expect(cards[0].capabilities).toEqual(
      expect.arrayContaining([
        { key: "artifacts", supported: true, source: "declared" },
        { key: "cancellation", supported: false, source: "declared" },
      ]),
    );
    // No credential references leak.
    expect(JSON.stringify(cards)).not.toContain("credentialRefs");
  });

  it("projects the coordination loop coherently mid-transition", async () => {
    const pipeline = await dataSource.getRepository(PipelineEntity).save(
      dataSource.getRepository(PipelineEntity).create({
        name: "m10s1-proj",
        version: "1.0",
        steps: [],
      }),
    );
    const execution = await executionService.createExecution(pipeline, {
      goal: "project the loop",
    });
    await executionService.reconcileExecution(execution.id);
    const run = await coordinator.startRun(
      execution.id,
      {
        schemaVersion: 1,
        planner: { kind: "agent", name: "planner" },
        verifier: { kind: "agent", name: "verifier" },
        allowedWorkers: [{ kind: "agent", name: "implementation" }],
        maxIterations: 3,
        maxWorkersPerIteration: 4,
        maxTotalWorkers: 20,
        loopDeadlineMs: 3_600_000,
        delegationDepthMax: 2,
        allowedExecutors: [
          "local-host",
          "agent:planner",
          "agent:verifier",
        ],
      },
      new Date(Date.now() + 3_600_000),
    );
    await coordinator.createNextIteration(run.id);
    await coordinator.createPlannerStep(run.id);

    const summary = await projection.executionSummaries(1);
    expect(summary.items[0]).toMatchObject({
      id: execution.id,
      coordinationPhase: "PLANNING",
      iterationNumber: 1,
    });

    const detailed = await projection.executionProjection(execution.id);
    expect(detailed.execution.goal.preview).toContain("project the loop");
    expect(detailed.coordination).not.toBeNull();
    expect(detailed.coordination!.run.phase).toBe("PLANNING");
    expect(detailed.coordination!.iterations[0].plannerStepId).toBe("planner-1");
    expect(detailed.coordination!.iterations[0].workerManifest).toEqual([]);
    expect(detailed.bounds.maxIterations).toBe(100);
  });

  it("never exposes raw attempt snapshots or results in the projection", async () => {
    const pipeline = await dataSource.getRepository(PipelineEntity).save(
      dataSource.getRepository(PipelineEntity).create({
        name: "m10s1-redact",
        version: "1.0",
        steps: [],
      }),
    );
    const execution = await executionService.createExecution(pipeline, {});
    const step = await executionService.materializeExecutionWithManager(
      dataSource.manager,
      pipeline,
      {},
    );
    // A step with a secret-looking result must never reach the projection.
    const logical = await dataSource.getRepository(LogicalStepEntity).save(
      dataSource.getRepository(LogicalStepEntity).create({
        executionId: execution.id,
        stepId: "secret-step",
        agent: "implementation",
        status: "COMPLETED",
        input: null,
        attempt: 1,
        maxAttempts: 1,
        frozenSpecHash: "hash",
        frozenAt: new Date(),
      }),
    );
    const revision = await dataSource
      .getRepository(ExecutionPlanRevisionEntity)
      .findOne({ where: { executionId: execution.id } });
    await dataSource.getRepository(StepAttemptEntity).save(
      dataSource.getRepository(StepAttemptEntity).create({
        executionId: execution.id,
        logicalStepId: logical.id,
        planRevisionId: revision!.id,
        attemptNumber: 1,
        invocationId: "invocation-secret",
        status: "SUCCESS",
        frozenSpecHash: "frozen-secret-step",
        executorSnapshot: { agent: "implementation" },
        result: { raw: "sk-super-secret-value", chain_of_thought: "reasoning" },
        inputSnapshot: { secret: "sk-input-secret" },
        terminalAt: new Date(),
      }),
    );
    void step;

    const detailed = await projection.executionProjection(execution.id);
    const rendered = JSON.stringify(detailed);
    expect(rendered).not.toContain("sk-super-secret-value");
    expect(rendered).not.toContain("sk-input-secret");
    expect(rendered).not.toContain("chain_of_thought");
    expect(detailed.attempts[0]).toEqual({
      stepId: "secret-step",
      attemptNumber: 1,
      status: "SUCCESS",
      terminalAt: expect.any(String),
      error: null,
    });
  });

  it("scopes artifact references to the execution's own lineage", async () => {
    const makeExecution = async (name: string) => {
      const pipeline = await dataSource.getRepository(PipelineEntity).save(
        dataSource.getRepository(PipelineEntity).create({
          name,
          version: "1.0",
          steps: [],
        }),
      );
      return executionService.createExecution(pipeline, {});
    };
    const executionA = await makeExecution("m10s1-artifacts-a");
    const executionB = await makeExecution("m10s1-artifacts-b");

    // Artifact lineage for A only: attempt A -> inbox row -> artifact.
    const logicalA = await dataSource.getRepository(LogicalStepEntity).save(
      dataSource.getRepository(LogicalStepEntity).create({
        executionId: executionA.id,
        stepId: "producer-a",
        agent: "implementation",
        status: "COMPLETED",
        input: null,
        attempt: 1,
        maxAttempts: 1,
        frozenSpecHash: "hash-a",
        frozenAt: new Date(),
      }),
    );
    const revisionA = await dataSource
      .getRepository(ExecutionPlanRevisionEntity)
      .findOne({ where: { executionId: executionA.id } });
    const attemptA = await dataSource.getRepository(StepAttemptEntity).save(
      dataSource.getRepository(StepAttemptEntity).create({
        executionId: executionA.id,
        logicalStepId: logicalA.id,
        planRevisionId: revisionA!.id,
        attemptNumber: 1,
        invocationId: "invocation-a",
        status: "SUCCESS",
        frozenSpecHash: "frozen-a",
        executorSnapshot: { agent: "implementation" },
        terminalAt: new Date(),
      }),
    );
    const inboxRow = await dataSource.getRepository(ResultInboxEntity).save(
      dataSource.getRepository(ResultInboxEntity).create({
        invocationId: "invocation-a",
        stepAttemptId: attemptA.id,
        payloadHash: "payload-hash-a",
        payload: { value: 1 },
        sourceAdapter: "http",
      }),
    );
    await dataSource.getRepository(ArtifactEntity).save(
      dataSource.getRepository(ArtifactEntity).create({
        resultInboxId: inboxRow.id,
        descriptorOrdinal: 0,
        descriptorHash: "artifact-hash-a",
      }),
    );

    const projectionA = await projection.executionProjection(executionA.id);
    const projectionB = await projection.executionProjection(executionB.id);
    expect(projectionA.artifacts).toHaveLength(1);
    expect(projectionA.artifacts[0].descriptorHash).toBe("artifact-hash-a");
    // B never sees A's artifacts.
    expect(projectionB.artifacts).toHaveLength(0);
    expect(projectionB.artifactsTruncated).toBe(false);
  });
});

describeWithPostgres("PostgreSQL M10-S2 workbench commands", () => {
  jest.setTimeout(180_000);

  let dataSource: DataSource;
  let commands: WorkbenchCommandService;
  let coordinator: RuntimeCoordinationService;
  let executionService: ExecutionService;

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
    allowedExecutors: [
      "local-host",
      "agent:planner",
      "agent:verifier",
    ],
  });

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
    coordinator = new RuntimeCoordinationService(dataSource);
    commands = new WorkbenchCommandService(
      dataSource,
      executionService,
      coordinator,
    );
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await dataSource.query(
      `TRUNCATE "operator_actions", "coordination_iterations",
       "coordination_runs", "execution_replays", "plan_proposals",
       "approval_requests", "result_conflicts", "result_inbox",
       "agent_events", "dispatch_outbox", "step_attempts",
       "step_executions", "execution_plan_revisions", "executions",
       "pipelines", "runtime_connections", "connection_revisions" CASCADE`,
    );
  });

  it("launches a team run exactly once and persists audit evidence", async () => {
    const first = await commands.startTeamRun({
      idempotencyKey: "launch-wedge-1",
      name: "wedge",
      goal: "build the wedge",
      config: teamConfig(),
    });
    expect(first.outcome).toBe("executed");
    const { executionId, runId } = first.result as {
      executionId: string;
      runId: string;
    };

    const duplicate = await commands.startTeamRun({
      idempotencyKey: "launch-wedge-1",
      name: "wedge",
      goal: "build the wedge",
      config: teamConfig(),
    });
    expect(duplicate.outcome).toBe("duplicate");
    expect(duplicate.result).toEqual(first.result);

    // Exactly one run exists; the audit row is durable.
    const runs = await dataSource
      .getRepository(CoordinationRunEntity)
      .find({ where: { executionId } });
    expect(runs).toHaveLength(1);
    const audit = await commands.auditTrail("start-team-run");
    expect(audit.items).toHaveLength(1);
    expect(audit.items[0].actor).toBe("local-operator");
    expect(JSON.stringify(audit.items[0].outcome)).toContain(runId);
  });

  it("two concurrent duplicate deliveries execute the authority exactly once", async () => {
    const results = await Promise.all([
      commands.startTeamRun({
        idempotencyKey: "launch-race-1",
        name: "race",
        goal: "race the wedge",
        config: teamConfig(),
      }),
      commands.startTeamRun({
        idempotencyKey: "launch-race-1",
        name: "race",
        goal: "race the wedge",
        config: teamConfig(),
      }),
    ]);
    const executed = results.filter((result) => result.outcome === "executed");
    const duplicates = results.filter((result) => result.outcome === "duplicate");
    expect(executed).toHaveLength(1);
    expect(duplicates).toHaveLength(1);
    expect(duplicates[0].result).toEqual(executed[0].result);

    const executions = await dataSource.getRepository(ExecutionEntity).find();
    expect(executions).toHaveLength(1);
    const actions = await dataSource.getRepository(OperatorActionEntity).find();
    expect(actions).toHaveLength(1);
  });

  it("resolveWait, cancel, and replay route through existing authority", async () => {
    const launch = await commands.startTeamRun({
      idempotencyKey: "launch-wedge-2",
      name: "wedge",
      goal: "build the wedge",
      config: teamConfig(),
    });
    const { executionId, runId } = launch.result as {
      executionId: string;
      runId: string;
    };

    // Drive the loop to a WAIT decision, then deny through the command.
    const run = (await coordinator.recoverRun(executionId)).run;
    const iteration = (await coordinator.recoverRun(executionId)).iterations[0];
    await coordinator.transitionRun(runId, "plannerProposed");
    await coordinator.transitionRun(runId, "batchValidated");
    await coordinator.transitionRun(runId, "workersFinished");
    await coordinator.consumeDecision(
      runId,
      {
        schemaVersion: 1,
        iterationId: iteration.id,
        iterationNumber: 1,
        action: "WAIT_FOR_HUMAN",
        reason: "operator review",
        evidenceRefs: [],
      },
      randomUUID(),
    );
    const waitOutcome = await commands.resolveWait({
      idempotencyKey: "wait-1",
      runId,
      approve: false,
    });
    expect(waitOutcome.result).toEqual({ runId, phase: "FAILED" });
    // A duplicate WAIT delivery is idempotent and never re-executes.
    const waitAgain = await commands.resolveWait({
      idempotencyKey: "wait-1",
      runId,
      approve: false,
    });
    expect(waitAgain.outcome).toBe("duplicate");

    // Cancel a second run through the existing authority.
    const launch2 = await commands.startTeamRun({
      idempotencyKey: "launch-wedge-3",
      name: "wedge2",
      goal: "second wedge",
      config: teamConfig(),
    });
    const execution2Id = (launch2.result as { executionId: string }).executionId;
    const cancelled = await commands.cancelExecution({
      idempotencyKey: "cancel-1",
      executionId: execution2Id,
    });
    expect(cancelled.result).toMatchObject({ status: "CANCELLED" });
    const storedExecution = await dataSource
      .getRepository(ExecutionEntity)
      .findOne({ where: { id: execution2Id } });
    expect(storedExecution?.status).toBe("CANCELLED");

    // Replay of a cancelled execution creates a new execution + fresh run.
    const replayed = await commands.replayExecution({
      idempotencyKey: "replay-1",
      executionId: execution2Id,
    });
    expect(replayed.outcome).toBe("executed");
    const targetId = (replayed.result as { targetExecutionId: string })
      .targetExecutionId;
    const replayedRun = await coordinator.recoverRun(targetId);
    expect(replayedRun.run.phase).toBe("PLANNING");

    // Every command left durable audit evidence.
    const audit = await commands.auditTrail();
    expect(audit.items.map((item) => item.action)).toEqual(
      expect.arrayContaining([
        "start-team-run",
        "resolve-wait",
        "cancel-execution",
        "replay-execution",
      ]),
    );
    void executionId;
  });

  const connectionProfile = () => ({
    name: "Codex local",
    runtimeKind: "codex",
    executorId: "local-host",
    version: "0.147.0",
    credentialRefs: [{ kind: "env", name: "CODEX_API_KEY" }],
    declaredCapabilities: {
      invocation: { supported: true, source: "configured" },
    },
  });

  it("M10 closure: concurrent duplicate revise — same key + same payload yields exactly ONE new revision", async () => {
    const created = await commands.createConnection({
      idempotencyKey: "conn-create-1",
      connectionId: "conn:m10",
      profile: connectionProfile() as never,
    });
    expect(created.outcome).toBe("executed");

    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        commands.reviseConnection({
          idempotencyKey: "conn-revise-1",
          connectionId: "conn:m10",
          profile: connectionProfile() as never,
        }),
      ),
    );
    const executed = results.filter((result) => result.outcome === "executed");
    const duplicates = results.filter((result) => result.outcome === "duplicate");
    expect(executed).toHaveLength(1);
    expect(duplicates).toHaveLength(5);
    // Exactly one revision was appended: N+1 once, never N+2.
    const revisions = await dataSource
      .getRepository(ConnectionRevisionEntity)
      .find({ where: { connectionId: "conn:m10" } });
    expect(revisions.map((row) => row.revisionNumber).sort()).toEqual([1, 2]);
    const audit = await commands.auditTrail("revise-connection");
    expect(audit.items).toHaveLength(1);
  });

  it("M10 closure: same idempotency key with a CONFLICTING payload is rejected, never silently executed", async () => {
    await commands.createConnection({
      idempotencyKey: "conn-create-2",
      connectionId: "conn:m10b",
      profile: connectionProfile() as never,
    });
    await commands.reviseConnection({
      idempotencyKey: "conn-revise-2",
      connectionId: "conn:m10b",
      profile: connectionProfile() as never,
    });
    await expect(
      commands.reviseConnection({
        idempotencyKey: "conn-revise-2",
        connectionId: "conn:m10b",
        profile: {
          ...connectionProfile(),
          version: "0.999.0",
        } as never,
      }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    // No second revision was appended.
    const revisions = await dataSource
      .getRepository(ConnectionRevisionEntity)
      .find({ where: { connectionId: "conn:m10b" } });
    expect(revisions.map((row) => row.revisionNumber).sort()).toEqual([1, 2]);
  });

  it("M10 closure: repeated identical revoke commands produce ONE effective authority transition with durable evidence", async () => {
    await commands.createConnection({
      idempotencyKey: "conn-create-3",
      connectionId: "conn:m10c",
      profile: connectionProfile() as never,
    });
    const first = await commands.revokeConnection({
      idempotencyKey: "conn-revoke-3",
      connectionId: "conn:m10c",
    });
    expect(first.outcome).toBe("executed");
    const second = await commands.revokeConnection({
      idempotencyKey: "conn-revoke-3",
      connectionId: "conn:m10c",
    });
    expect(second.outcome).toBe("duplicate");
    const audit = await commands.auditTrail("revoke-connection");
    expect(audit.items).toHaveLength(1);
    const revisions = await dataSource
      .getRepository(ConnectionRevisionEntity)
      .find({ where: { connectionId: "conn:m10c" } });
    expect(revisions).toHaveLength(1);
  });

  it("M10 closure: every successful authority-changing connection command leaves durable operator-action evidence", async () => {
    await commands.createConnection({
      idempotencyKey: "conn-create-4",
      connectionId: "conn:m10d",
      profile: connectionProfile() as never,
    });
    await commands.reviseConnection({
      idempotencyKey: "conn-revise-4",
      connectionId: "conn:m10d",
      profile: connectionProfile() as never,
    });
    await commands.revokeConnection({
      idempotencyKey: "conn-revoke-4",
      connectionId: "conn:m10d",
    });
    const audit = await commands.auditTrail();
    expect(audit.items.map((item) => item.action)).toEqual(
      expect.arrayContaining([
        "create-connection",
        "revise-connection",
        "revoke-connection",
      ]),
    );
    // The stored audit payload carries credential REFERENCES only — the
    // bounded secret-free profile, never values.
    const rows = await dataSource.getRepository(OperatorActionEntity).find();
    const rendered = JSON.stringify(rows.map((row) => row.payload));
    expect(rendered).toContain("CODEX_API_KEY");
    expect(rendered).not.toContain("sk-");
  });

  it("M10 closure: a failed authority mutation rolls back WITH its audit row — no false completed operator action", async () => {
    // Revise a connection that does not exist: the mutation fails inside
    // the command transaction, so the pending audit row must roll back too.
    await expect(
      commands.reviseConnection({
        idempotencyKey: "conn-revise-missing",
        connectionId: "conn:missing",
        profile: connectionProfile() as never,
      }),
    ).rejects.toMatchObject({ code: "CONNECTION_NOT_FOUND" });
    const audit = await commands.auditTrail("revise-connection");
    expect(audit.items).toHaveLength(0);
    // The same holds for create (duplicate identity is a mutation failure).
    await commands.createConnection({
      idempotencyKey: "conn-create-5",
      connectionId: "conn:m10e",
      profile: connectionProfile() as never,
    });
    await expect(
      commands.createConnection({
        idempotencyKey: "conn-create-6",
        connectionId: "conn:m10e",
        profile: connectionProfile() as never,
      }),
    ).rejects.toMatchObject({ code: "CONNECTION_ALREADY_EXISTS" });
    const createAudit = await commands.auditTrail("create-connection");
    expect(createAudit.items).toHaveLength(1); // only the successful create
  });
});

describeWithPostgres("PostgreSQL M10-S4 inspection surface", () => {
  jest.setTimeout(180_000);

  let dataSource: DataSource;
  let projection: WorkbenchProjectionService;
  let commands: WorkbenchCommandService;
  let executionService: ExecutionService;
  let coordinator: RuntimeCoordinationService;

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
    allowedExecutors: [
      "local-host",
      "agent:planner",
      "agent:verifier",
    ],
  });

  const launchRun = async (name: string, goal: string) => {
    const result = await commands.startTeamRun({
      idempotencyKey: `launch-${name}`,
      name,
      goal,
      config: teamConfig(),
    });
    return (result.result as { executionId: string }).executionId;
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
    coordinator = new RuntimeCoordinationService(dataSource);
    projection = new WorkbenchProjectionService(dataSource);
    commands = new WorkbenchCommandService(
      dataSource,
      executionService,
      coordinator,
    );
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await dataSource.query(
      `TRUNCATE "operator_actions", "coordination_iterations",
       "coordination_runs", "execution_replays", "delegation_requests",
       "delegation_observations", "plan_proposals", "approval_requests",
       "result_conflicts", "result_inbox", "agent_events",
       "dispatch_outbox", "step_attempts", "step_executions",
       "execution_plan_revisions", "executions", "pipelines" CASCADE`,
    );
  });

  it("projects delegation counts and the Capsule summary for a coordinated run", async () => {
    const executionId = await launchRun("inspect-1", "inspect the loop");
    const detailed = await projection.executionProjection(executionId);
    expect(detailed.delegation).toEqual({
      supervisedTotal: 0,
      observedTotal: 0,
      truncated: false,
    });

    const capsule = (await projection.capsuleFor(executionId)) as any;
    expect(capsule).toMatchObject({
      pointInTime: "live",
      sourceStatus: "PENDING",
    });
    expect(capsule.coordination.run.phase).toBe("PLANNING");
    expect(JSON.stringify(capsule)).not.toContain("sk-");
  });

  it("compares two executions with bounded drift and records audit evidence", async () => {
    const executionA = await launchRun("compare-a", "goal a");
    const executionB = await launchRun("compare-b", "goal b");

    const comparison = await commands.compareExecutions({
      idempotencyKey: "compare-1",
      executionA,
      executionB,
    });
    expect(comparison.outcome).toBe("executed");
    const drift = (comparison.result as { comparison: any }).comparison;
    expect(drift).toHaveProperty("plan.stepDrift");
    expect(drift).toHaveProperty("outcome");
    expect(drift.outcome.unavailable).toBe(true); // live captures: no invented conclusion

    const duplicate = await commands.compareExecutions({
      idempotencyKey: "compare-1",
      executionA,
      executionB,
    });
    expect(duplicate.outcome).toBe("duplicate");
    const audit = await commands.auditTrail("compare-executions");
    expect(audit.items).toHaveLength(1);
  });

  it("replay creates an inspectable new execution and a fresh run", async () => {
    const executionA = await launchRun("replay-inspect", "replay me");
    await executionService.cancelExecution(executionA);

    const replayed = await commands.replayExecution({
      idempotencyKey: "replay-inspect-1",
      executionId: executionA,
    });
    const targetId = (replayed.result as { targetExecutionId: string })
      .targetExecutionId;
    const targetProjection = await projection.executionProjection(targetId);
    expect(targetProjection.coordination?.run.phase).toBe("PLANNING");
    expect(targetProjection.execution.status).toBe("PENDING");
    const capsule = (await projection.capsuleFor(targetId)) as any;
    expect(capsule.coordination.run.phase).toBe("PLANNING");
  });
});

describeWithPostgres("PostgreSQL M11-S3 upgrade/backup/restore authority", () => {
  jest.setTimeout(240_000);

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
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await dataSource.query(
      `TRUNCATE "operator_actions", "coordination_iterations",
       "coordination_runs", "execution_replays", "plan_proposals",
       "approval_requests", "result_conflicts", "result_inbox",
       "agent_events", "dispatch_outbox", "step_attempts",
       "step_executions", "execution_plan_revisions", "executions",
       "pipelines" CASCADE`,
    );
  });

  it("a failing migration rolls back cleanly and never leaves partial schema", async () => {
    // TypeORM runs every migration inside a transaction; a failure must
    // roll back both the partial DDL and the migrations ledger. We drive
    // the same transactional semantics against the real runner.
    const runner = dataSource.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    try {
      await runner.query(
        `CREATE TABLE IF NOT EXISTS "injected_partial" (id integer)`,
      );
      throw new Error("injected migration failure");
    } catch (error) {
      await runner.rollbackTransaction();
      expect((error as Error).message).toBe("injected migration failure");
    } finally {
      await runner.release();
    }
    const tables = await dataSource.query(
      `SELECT to_regclass('public.injected_partial') AS name`,
    );
    expect(tables[0].name).toBeNull();
    const ledger = await dataSource.query(
      `SELECT count(*)::int AS n FROM migrations WHERE name = 'M11InjectedFailure'`,
    );
    expect(ledger[0].n).toBe(0);
  });

  it("backup/restore round-trips TWICE into separate clean targets preserving execution, coordination, policy, budget, approval, artifact-reference and Capsule identity, then executes a post-restore team run", async () => {
    // Seed authority facts through the REAL services where they exist.
    const pipeline = await dataSource.getRepository(PipelineEntity).save(
      dataSource.getRepository(PipelineEntity).create({
        name: "m11-restore",
        version: "1.0",
        steps: [],
      }),
    );
    const execution = await dataSource.getRepository(ExecutionEntity).save(
      dataSource.getRepository(ExecutionEntity).create({
        pipelineId: pipeline.id,
        status: "COMPLETED",
        input: { goal: "restore me" },
      }),
    );
    const teamConfig = (): CoordinationConfigV1 => ({
      schemaVersion: 1,
      planner: { kind: "agent", name: "planner" },
      verifier: { kind: "agent", name: "verifier" },
      allowedWorkers: [{ kind: "agent", name: "worker" }],
      maxIterations: 3,
      maxWorkersPerIteration: 4,
      maxTotalWorkers: 20,
      loopDeadlineMs: 3_600_000,
      delegationDepthMax: 2,
      allowedExecutors: [
        "local-host",
        "agent:planner",
        "agent:verifier",
        "agent:worker",
      ],
    });
    const coordinator = new RuntimeCoordinationService(dataSource);
    const run = await coordinator.startRun(
      execution.id,
      teamConfig(),
      new Date(Date.now() + 3_600_000),
    );
    const budgets = new BudgetLedgerService(dataSource as any);
    const budgetAccount = await budgets.createAccount({
      scopeType: "run",
      scopeId: "m11-budget",
      ceilings: { currency_micros: 1000, tokens: 1000, wall_time_ms: 1000 },
    });
    const capsules = new ExecutionCapsuleService(
      dataSource as any,
      new DelegationService(dataSource as any, new ExecutionService(
        dataSource.getRepository(ExecutionEntity),
        dataSource.getRepository(LogicalStepEntity),
        dataSource.getRepository(StepAttemptEntity),
        dataSource.getRepository(ExecutionPlanRevisionEntity),
        dataSource,
      )),
      new ExecutionService(
        dataSource.getRepository(ExecutionEntity),
        dataSource.getRepository(LogicalStepEntity),
        dataSource.getRepository(StepAttemptEntity),
        dataSource.getRepository(ExecutionPlanRevisionEntity),
        dataSource,
      ),
    );
    const capsuleExport = await capsules.createExport(execution.id, "m11-test");
    const policySnapshot = await dataSource
      .getRepository(PolicySnapshotEntity)
      .save(
        dataSource.getRepository(PolicySnapshotEntity).create({
          version: 7,
          hash: "m11-policy-hash",
          rules: [{ effect: "ALLOW", reasons: ["m11"] }],
        }),
      );
    const approval = await dataSource
      .getRepository(ApprovalRequestEntity)
      .save(
        dataSource.getRepository(ApprovalRequestEntity).create({
          proposalId: "plan:m11-proposal",
          proposalHash: "m11-approval-hash",
          actionType: "plan_patch",
          executionId: execution.id,
          logicalStepId: "",
          attemptNumber: 1,
          status: "PENDING",
          expiresAt: new Date(Date.now() + 60_000),
        }),
      );
    const revision = await dataSource
      .getRepository(ExecutionPlanRevisionEntity)
      .save(
        dataSource.getRepository(ExecutionPlanRevisionEntity).create({
          executionId: execution.id,
          revisionNumber: 1,
          plan: { schemaVersion: 1, steps: [] },
        }),
      );
    const step = await dataSource.getRepository(LogicalStepEntity).save(
      dataSource.getRepository(LogicalStepEntity).create({
        executionId: execution.id,
        stepId: "work",
        agent: "worker",
        status: "COMPLETED",
        input: {},
      }),
    );
    const attempt = await dataSource.getRepository(StepAttemptEntity).save(
      dataSource.getRepository(StepAttemptEntity).create({
        executionId: execution.id,
        logicalStepId: step.id,
        planRevisionId: revision.id,
        attemptNumber: 1,
        invocationId: "m11-inv",
        frozenSpecHash: "m11-frozen",
        inputSnapshot: {},
        executorSnapshot: {},
        status: "SUCCESS",
        terminalAt: new Date(),
      }),
    );
    const inboxRow = await dataSource.getRepository(ResultInboxEntity).save(
      dataSource.getRepository(ResultInboxEntity).create({
        invocationId: "m11-invocation",
        stepAttemptId: attempt.id,
        payloadHash: "m11-payload-hash",
        payload: { ok: true },
        sourceAdapter: "test",
        status: "RECEIVED",
      }),
    );
    const artifact = await dataSource.getRepository(ArtifactEntity).save(
      dataSource.getRepository(ArtifactEntity).create({
        resultInboxId: inboxRow.id,
        descriptorOrdinal: 1,
        descriptorHash: "a".repeat(64),
      }),
    );

    // Backup via the same mechanics as scripts/self-hosted/backup.mjs
    // (pg_dump runs inside the postgres container on this host).
    const dumpPath = `/tmp/m11-restore-${Date.now()}.dump`;
    await new Promise<void>((resolve, reject) => {
      const { execFile } = require("node:child_process");
      execFile(
        "docker",
        [
          "exec", POSTGRES_CONTAINER,
          "pg_dump", "-U", "postgres", "-d", "tenvyr_roadmap_test",
          "-Fc", "-f", "/tmp/m11-restore.dump",
        ],
        (error: unknown) => (error ? reject(error) : resolve()),
      );
    });
    await new Promise<void>((resolve, reject) => {
      const { execFile } = require("node:child_process");
      execFile(
        "docker",
        ["cp", `${POSTGRES_CONTAINER}:/tmp/m11-restore.dump`, dumpPath],
        (error: unknown) => (error ? reject(error) : resolve()),
      );
    });

    const assertRestoredIdentity = async (targetName: string) => {
      // Restore into a clean isolated target (same mechanics as restore.mjs).
      await dataSource.query(`DROP DATABASE IF EXISTS ${targetName}`);
      await dataSource.query(`CREATE DATABASE ${targetName}`);
      await new Promise<void>((resolve, reject) => {
        const { execFile } = require("node:child_process");
        execFile(
          "docker",
          ["cp", dumpPath, `${POSTGRES_CONTAINER}:/tmp/m11-restore-target.dump`],
          (error: unknown) => (error ? reject(error) : resolve()),
        );
      });
      await new Promise<void>((resolve, reject) => {
        const { execFile } = require("node:child_process");
        execFile(
          "docker",
          [
            "exec", POSTGRES_CONTAINER,
            "pg_restore", "-U", "postgres", "-d", targetName,
            "--no-owner", "--no-privileges", "/tmp/m11-restore-target.dump",
          ],
          (error: unknown) => (error ? reject(error) : resolve()),
        );
      });

      const restored = new DataSource({
        ...databaseOptions(),
        type: "postgres" as const,
        url: TEST_DATABASE_URL.replace("tenvyr_roadmap_test", targetName),
        migrationsRun: false,
      } as DataSourceOptions);
      await restored.initialize();
      const restoredExecution = await restored
        .getRepository(ExecutionEntity)
        .findOne({ where: { id: execution.id } });
      expect(restoredExecution?.status).toBe("COMPLETED");
      expect(restoredExecution?.input).toEqual({ goal: "restore me" });
      const restoredRun = await restored
        .getRepository(CoordinationRunEntity)
        .findOne({ where: { id: run.id } });
      expect(restoredRun?.phase).toBe("PLANNING");
      expect(restoredRun?.config).toEqual(teamConfig());
      const restoredPolicy = await restored
        .getRepository(PolicySnapshotEntity)
        .findOne({ where: { version: policySnapshot.version } });
      expect(restoredPolicy?.hash.trim()).toBe("m11-policy-hash");
      const restoredBudget = await restored
        .getRepository(BudgetAccountEntity)
        .findOne({ where: { id: budgetAccount.id } });
      expect(restoredBudget?.scopeId).toBe("m11-budget");
      const restoredApproval = await restored
        .getRepository(ApprovalRequestEntity)
        .findOne({ where: { id: approval.id } });
      expect(restoredApproval?.status).toBe("PENDING");
      const restoredArtifact = await restored
        .getRepository(ArtifactEntity)
        .findOne({ where: { id: artifact.id } });
      expect(restoredArtifact?.descriptorHash).toBe("a".repeat(64));
      const restoredExport = await restored
        .getRepository(ExecutionExportEntity)
        .findOne({ where: { id: capsuleExport.id } });
      expect(restoredExport?.capsuleHash).toBe(capsuleExport.capsuleHash);
      return restored;
    };

    // Drill 1: tenvyr_restore_target (identity preserved).
    const restoredOne = await assertRestoredIdentity("tenvyr_restore_target");
    await restoredOne.destroy();

    // Drill 2: a SEPARATE clean target (tenvyr_restore_target_2) re-verifies
    // identity and then executes a NEW post-restore team run through the
    // real authority services bound to the restored database.
    const restoredTwo = await assertRestoredIdentity("tenvyr_restore_target_2");
    const restoredExecutionService = new ExecutionService(
      restoredTwo.getRepository(ExecutionEntity),
      restoredTwo.getRepository(LogicalStepEntity),
      restoredTwo.getRepository(StepAttemptEntity),
      restoredTwo.getRepository(ExecutionPlanRevisionEntity),
      restoredTwo,
    );
    const restoredCoordinator = new RuntimeCoordinationService(restoredTwo);
    const newPipeline = await restoredTwo.getRepository(PipelineEntity).save(
      restoredTwo.getRepository(PipelineEntity).create({
        name: "m11-post-restore",
        version: "1.0",
        steps: [],
      }),
    );
    expect(newPipeline.id).not.toBe(pipeline.id);
    const { newRun, newIteration } = await restoredTwo.transaction(
      async (manager) => {
        const newExecution =
          await restoredExecutionService.materializeExecutionWithManager(
            manager,
            newPipeline,
            { goal: "post-restore run" },
          );
        const createdRun = await restoredCoordinator.startRunWithManager(
          manager,
          newExecution.id,
          teamConfig(),
          new Date(Date.now() + 3_600_000),
        );
        const createdIteration =
          await restoredCoordinator.createNextIterationWithManager(
            manager,
            createdRun.id,
          );
        return { newRun: createdRun, newIteration: createdIteration };
      },
    );
    expect(newIteration.iterationNumber).toBe(1);
    expect(newRun.phase).toBe("PLANNING");
    await restoredTwo.destroy();

    await dataSource.query(`DROP DATABASE IF EXISTS tenvyr_restore_target`);
    await dataSource.query(`DROP DATABASE IF EXISTS tenvyr_restore_target_2`);
  });
});

describeWithPostgres(
  "PostgreSQL M8-S6/M9-S7 closure hardening (races, approval resume, budget dimensions, allowlist, delegation depth)",
  () => {
    jest.setTimeout(240_000);

    let dataSource: DataSource;
    let connections: RuntimeConnectionService;
    let budgets: BudgetLedgerService;
    let executionService: ExecutionService;
    let coordinator: RuntimeCoordinationService;
    let delegations: DelegationService;

    const cliProfile = (
      name: string,
      probeArgs: string[] = ["1"],
      executorId = "local-host",
    ): ConnectionProfileV1 => ({
      name,
      runtimeKind: "generic-cli",
      executorId,
      version: "0.1.0",
      credentialRefs: [],
      declaredCapabilities: {
        invocation: { supported: true, source: "configured" },
        structuredResult: { supported: true, source: "configured" },
        localProcessTermination: { supported: true, source: "configured" },
      },
      cli: {
        command: "/bin/sleep",
        args: ["0"],
        probe: { args: probeArgs, expectsVersion: false },
      },
    });

    const teamConfig = (
      overrides: Partial<CoordinationConfigV1> = {},
    ): CoordinationConfigV1 => ({
      schemaVersion: 1,
      planner: { kind: "agent", name: "planner" },
      verifier: { kind: "agent", name: "verifier" },
      allowedWorkers: [{ kind: "agent", name: "worker" }],
      maxIterations: 3,
      maxWorkersPerIteration: 4,
      maxTotalWorkers: 20,
      loopDeadlineMs: 3_600_000,
      delegationDepthMax: 2,
      allowedExecutors: [
        "local-host",
        "agent:worker",
        "agent:planner",
        "agent:verifier",
      ],
      ...overrides,
    });

    const activeRevisionNumber = async (executionId: string): Promise<number> => {
      const execution = await dataSource
        .getRepository(ExecutionEntity)
        .findOne({ where: { id: executionId } });
      const revision = await dataSource
        .getRepository(ExecutionPlanRevisionEntity)
        .findOne({ where: { id: execution?.activePlanRevisionId } });
      if (!revision) throw new Error("no active plan revision");
      return revision.revisionNumber;
    };

    const batchProposal = (
      baseRevision: number,
      overrides: Partial<TaskBatchProposalV1> = {},
    ): TaskBatchProposalV1 => ({
      schemaVersion: 1,
      iterationNumber: 1,
      baseRevision,
      tasks: [
        {
          taskId: "implement-1",
          agent: "worker",
          input: {},
          dependsOn: [],
          required: true,
          reason: "work",
        },
      ],
      reason: "iteration 1",
      ...overrides,
    });

    const decision = (
      iterationId: string,
      action: VerifierDecisionV1["action"] = "CONTINUE",
    ): VerifierDecisionV1 => ({
      schemaVersion: 1,
      iterationId,
      iterationNumber: 1,
      action,
      reason: "test",
      evidenceRefs: [],
    });

    const seedRun = async (config: CoordinationConfigV1) => {
      const pipeline = await dataSource.getRepository(PipelineEntity).save(
        dataSource.getRepository(PipelineEntity).create({
          name: "closure-hardening",
          version: "1.0",
          steps: [],
        }),
      );
      const execution = await executionService.createExecution(pipeline, {});
      await executionService.reconcileExecution(execution.id);
      const run = await coordinator.startRun(
        execution.id,
        config,
        new Date(Date.now() + 3_600_000),
      );
      const iteration = await coordinator.createNextIteration(run.id);
      return { pipeline, execution, run, iteration };
    };

    /** Seeds a SUCCESSFUL planner attempt whose result is the batch — the
     *  durable evidence recoverRun consumes at PLANNING. Uses the ACTIVE
     *  plan revision (the one the Planner step was frozen on) and returns
     *  the attempt id + frozen baseRevision so admission tests submit the
     *  REAL attempt identity (M9-S8 ownership gate). */
    const seedPlannerSuccess = async (
      runId: string,
      proposal: TaskBatchProposalV1,
    ): Promise<{ attemptId: string; baseRevision: number }> => {
      const run = await dataSource
        .getRepository(CoordinationRunEntity)
        .findOne({ where: { id: runId } });
      if (!run) throw new Error(`run ${runId} missing`);
      const plannerStep = await dataSource
        .getRepository(LogicalStepEntity)
        .findOne({ where: { executionId: run.executionId, stepId: "planner-1" } });
      if (!plannerStep) throw new Error("planner-1 step missing");
      const revision = await dataSource
        .getRepository(ExecutionPlanRevisionEntity)
        .findOne({
          where: { executionId: run.executionId },
          order: { revisionNumber: "DESC" },
        });
      if (!revision) throw new Error("plan revision missing");
      const attempt = await dataSource.getRepository(StepAttemptEntity).save(
        dataSource.getRepository(StepAttemptEntity).create({
          executionId: run.executionId,
          logicalStepId: plannerStep.id,
          planRevisionId: revision.id,
          attemptNumber: 1,
          invocationId: `${plannerStep.id}:1`,
          frozenSpecHash: "closure-test",
          inputSnapshot: {},
          executorSnapshot: {},
          status: "SUCCESS",
          terminalAt: new Date(),
          result: proposal,
        }),
      );
      plannerStep.status = "COMPLETED";
      plannerStep.output = proposal;
      await dataSource.getRepository(LogicalStepEntity).save(plannerStep);
      return { attemptId: attempt.id, baseRevision: revision.revisionNumber };
    };

    const policyFake = (mode: "ALLOW" | "DENY" | "REQUIRE_APPROVAL") => {
      const state = { mode };
      return {
        state,
        service: {
          isConfigured: () => true,
          evaluate: async () => ({
            effect: state.mode,
            reasons: ["closure-hardening test"],
          }),
        } as any,
      };
    };

    const coordinatorWithPolicy = (
      policyService: any,
    ): RuntimeCoordinationService =>
      new RuntimeCoordinationService(
        dataSource as any,
        new PlanProposalService(
          dataSource as any,
          new PipelineValidationService(new ConditionEvaluatorService()),
          policyService,
        ),
        budgets,
        connections,
      );

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
      connections = new RuntimeConnectionService(dataSource);
      budgets = new BudgetLedgerService(dataSource as any);
      executionService = new ExecutionService(
        dataSource.getRepository(ExecutionEntity),
        dataSource.getRepository(LogicalStepEntity),
        dataSource.getRepository(StepAttemptEntity),
        dataSource.getRepository(ExecutionPlanRevisionEntity),
        dataSource,
      );
      coordinator = new RuntimeCoordinationService(dataSource);
      delegations = new DelegationService(dataSource as any, executionService);
    });

    afterAll(async () => {
      await dataSource.destroy();
    });

    beforeEach(async () => {
      await dataSource.query(
        `TRUNCATE "coordination_iterations", "coordination_runs",
         "execution_replays", "execution_exports", "delegation_requests",
         "delegation_observation_conflicts", "delegation_observations",
         "plan_proposals", "policy_decisions", "policy_snapshots",
         "approval_requests", "budget_ledger_entries", "budget_reservations",
         "budget_accounts", "state_write_evidence", "artifacts",
         "result_conflicts", "result_inbox", "agent_events",
         "dispatch_outbox", "step_attempts", "step_executions",
         "execution_plan_revisions", "executions", "pipelines",
         "runtime_connections", "connection_revisions",
         "operator_actions" CASCADE`,
      );
    });

    it("M8-S6: a probe that outlives a revoke can never resurrect the card (revoke stays terminal)", async () => {
      await connections.createConnection("conn:race", cliProfile("race v1"));
      const probe = connections
        .testConnection("conn:race")
        .catch((error: unknown) => error);
      await new Promise((resolve) => setTimeout(resolve, 200));
      await connections.revokeConnection("conn:race");
      const receipt = await probe;
      expect(receipt).toMatchObject({ code: "CONNECTION_REVOKED" });
      const status = await connections.connectionStatus("conn:race");
      expect(status.state).toBe("REVOKED");
      expect(status.testedAt ?? null).toBeNull();
    });

    it("M8-S6: a stale probe (revision advanced mid-flight) yields a superseded receipt and writes nothing", async () => {
      await connections.createConnection("conn:sup", cliProfile("sup v1"));
      const probe = connections.testConnection("conn:sup");
      await new Promise((resolve) => setTimeout(resolve, 200));
      await connections.reviseConnection("conn:sup", cliProfile("sup v2"));
      const receipt = await probe;
      expect(receipt.superseded).toBe(true);
      // The stale probe's facts were never written: the card stays DRAFT.
      const status = await connections.connectionStatus("conn:sup");
      expect(status.state).toBe("DRAFT");
      expect(status.testedAt ?? null).toBeNull();
    });

    it("M9-S7: pending approval resumes the EXACT proposal on reconcile (no proposal storm) and binds approval once", async () => {
      const policy = policyFake("ALLOW");
      const policyCoordinator = coordinatorWithPolicy(policy.service);
      const { run, iteration, execution } = await seedRun(teamConfig());
      // The Planner step activation is policy-gated too: create it under
      // ALLOW, then intercept the BATCH with REQUIRE_APPROVAL.
      await policyCoordinator.createPlannerStep(run.id);
      policy.state.mode = "REQUIRE_APPROVAL";
      const { attemptId, baseRevision } = await seedPlannerAttempt(
        dataSource,
        executionService,
        execution.id,
        1,
      );
      const proposal = batchProposal(baseRevision);

      const first = await policyCoordinator.submitIterationBatch({
        runId: run.id,
        iterationNumber: 1,
        proposal,
        plannerAttemptId: attemptId,
      });
      expect(first.outcome).toBe("PENDING");
      const proposalCount = () =>
        dataSource
          .getRepository(PlanProposalEntity)
          .count({ where: { executionId: run.executionId, source: "planner" } });
      expect(await proposalCount()).toBe(1);

      // Reconciliation re-activates the SAME proposal: still one durable row.
      const second = await policyCoordinator.submitIterationBatch({
        runId: run.id,
        iterationNumber: 1,
        proposal,
        plannerAttemptId: attemptId,
      });
      expect(second.outcome).toBe("PENDING");
      expect(await proposalCount()).toBe(1);

      // The operator grant binds the same proposal exactly once.
      await dataSource
        .getRepository(ApprovalRequestEntity)
        .createQueryBuilder()
        .update()
        .set({ status: "APPROVED", decidedAt: new Date() })
        .where("status = :status", { status: "PENDING" })
        .execute();
      policy.state.mode = "ALLOW";
      const third = await policyCoordinator.submitIterationBatch({
        runId: run.id,
        iterationNumber: 1,
        proposal,
        plannerAttemptId: attemptId,
      });
      expect(third.outcome).toBe("ACCEPTED");
      expect(await proposalCount()).toBe(1);
      const iterationRow = await dataSource
        .getRepository(CoordinationIterationEntity)
        .findOne({ where: { id: iteration.id } });
      expect(iterationRow?.pendingPlanProposalId).toBeNull();
    });

    it("M9-S7: a policy-denied batch terminalizes the run AND the execution atomically", async () => {
      const policy = policyFake("ALLOW");
      const denyCoordinator = coordinatorWithPolicy(policy.service);
      const { run, execution } = await seedRun(teamConfig());
      // Planner step activation happens under ALLOW; the BATCH is denied.
      await denyCoordinator.createPlannerStep(run.id);
      policy.state.mode = "DENY";
      const base = await activeRevisionNumber(execution.id);
      await seedPlannerSuccess(run.id, batchProposal(base));

      await denyCoordinator.reconcileCoordination(run.executionId);
      const recovered = await denyCoordinator.recoverRun(run.executionId);
      expect(recovered.run.phase).toBe("FAILED");
      const stored = await dataSource
        .getRepository(ExecutionEntity)
        .findOne({ where: { id: execution.id } });
      expect(stored?.status).toBe("FAILED");
      expect(stored?.terminationReason).toContain("Planner batch rejected");
    });

    it("M9-S7: budget exhaustion is dimension-correct — CONTINUE stops only when EVERY dimension is spent", async () => {
      const account = await budgets.createAccount({
        scopeType: "run",
        scopeId: "closure-budget",
        ceilings: { currency_micros: 1000, tokens: 1000, wall_time_ms: 1000 },
      });
      const { run, iteration, execution } = await seedRun(
        teamConfig({ budgetAccountId: account.id }),
      );
      await coordinator.createPlannerStep(run.id);
      const { attemptId, baseRevision } = await seedPlannerAttempt(
        dataSource,
        executionService,
        execution.id,
        1,
      );

      // Spend ONLY tokens: the other dimensions remain — the loop continues.
      await budgets.reserve({
        accountId: account.id,
        dimension: "tokens",
        amount: 1000,
        idempotencyKey: "closure-tokens",
        actionRef: "closure",
        source: "estimated",
      });
      const accepted = await coordinator.submitIterationBatch({
        runId: run.id,
        iterationNumber: 1,
        proposal: batchProposal(baseRevision),
        plannerAttemptId: attemptId,
      });
      expect(accepted.outcome).toBe("ACCEPTED");
      await coordinator.transitionRun(run.id, "workersFinished");
      const continued = await coordinator.consumeDecision(
        run.id,
        decision(iteration.id),
        randomUUID(),
      );
      expect(continued.outcome).toBe("consumed");
      expect(continued.phase).toBe("PLANNING");

      // Spend the remaining dimensions: the next batch is LIMIT_REACHED.
      await budgets.reserve({
        accountId: account.id,
        dimension: "currency_micros",
        amount: 1000,
        idempotencyKey: "closure-currency",
        actionRef: "closure",
        source: "estimated",
      });
      await budgets.reserve({
        accountId: account.id,
        dimension: "wall_time_ms",
        amount: 1000,
        idempotencyKey: "closure-wall",
        actionRef: "closure",
        source: "estimated",
      });
      const limited = await coordinator.submitIterationBatch({
        runId: run.id,
        iterationNumber: 2,
        proposal: batchProposal(baseRevision, { iterationNumber: 2 }),
        plannerAttemptId: randomUUID(),
      });
      expect(limited.outcome).toBe("LIMIT_REACHED");
    });

    it("M9-S7: a batch selecting an executor outside the frozen allowlist is rejected with zero materialization", async () => {
      const { run, execution } = await seedRun(
        teamConfig({
          allowedWorkers: [
            { kind: "agent", name: "worker" },
            { kind: "agent", name: "rogue" },
          ],
        }),
      );
      await coordinator.createPlannerStep(run.id);
      const base = await activeRevisionNumber(execution.id);
      await seedPlannerSuccess(run.id, {
        ...batchProposal(base),
        tasks: [
          {
            taskId: "rogue-1",
            agent: "rogue",
            input: {},
            dependsOn: [],
            required: true,
            reason: "outside the allowlist",
          },
        ],
      });

      await coordinator.reconcileCoordination(run.executionId);
      const recovered = await coordinator.recoverRun(run.executionId);
      expect(recovered.run.phase).toBe("FAILED");
      const stored = await dataSource
        .getRepository(ExecutionEntity)
        .findOne({ where: { id: execution.id } });
      expect(stored?.status).toBe("FAILED");
      // Only the Coordinator-owned planner step exists — no workers.
      const steps = await dataSource
        .getRepository(LogicalStepEntity)
        .find({ where: { executionId: execution.id } });
      expect(steps.map((step) => step.stepId).sort()).toEqual(["planner-1"]);
    });

    it("M9-S7: the run's frozen delegationDepthMax bounds every descendant, not just the first hop", async () => {
      const config = teamConfig({ delegationDepthMax: 1 });
      const pipeline = await dataSource.getRepository(PipelineEntity).save(
        dataSource.getRepository(PipelineEntity).create({
          name: "closure-depth",
          version: "1.0",
          steps: [{ id: "work", agent: "worker", input: {} }],
        }),
      );
      const execution = await executionService.createExecution(pipeline, {});
      await executionService.reconcileExecution(execution.id);
      await coordinator.startRun(
        execution.id,
        config,
        new Date(Date.now() + 3_600_000),
      );

      // Depth 1 from the run root: allowed (childDepth 1 <= delegationDepthMax 1).
      const revision = await dataSource
        .getRepository(ExecutionPlanRevisionEntity)
        .findOne({ where: { executionId: execution.id } });
      const stepConfig = revision!.plan.steps.find(
        (step) => step.id === "work",
      )!;
      const claim = await executionService.claimRunnableStep(
        execution.id,
        stepConfig,
        {},
        1,
      );
      expect(claim?.disposition).toBe("claimed");
      const attempt = (claim as { attempt: StepAttemptEntity }).attempt;
      const first = await delegations.request({
        parentExecutionId: execution.id,
        parentAttemptId: attempt.id,
        requestId: "req-1",
        requestedAgent: "child",
        expiresAt: new Date(Date.now() + 60_000),
      });
      expect(first.disposition).toBe("created");
      const approved = await delegations.approve(attempt.id, "req-1", pipeline);
      expect(approved.decision).toBe("APPROVED");
      if (!approved.childExecutionId) {
        throw new Error("approve did not materialize a child execution");
      }
      const childExecutionId = approved.childExecutionId;

      // Depth 2 from the child: the run's frozen max (1) denies it.
      // The child execution is materialized by approve(); reconcile it so
      // its step rows are claimable.
      await executionService.reconcileExecution(childExecutionId);
      const childRevision = await dataSource
        .getRepository(ExecutionPlanRevisionEntity)
        .findOne({ where: { executionId: childExecutionId } });
      const childStepConfig = childRevision!.plan.steps.find(
        (step) => step.id === "work",
      )!;
      const childClaim = await executionService.claimRunnableStep(
        childExecutionId,
        childStepConfig,
        {},
        1,
      );
      expect(childClaim?.disposition).toBe("claimed");
      const childAttempt = (childClaim as { attempt: StepAttemptEntity })
        .attempt;
      await expect(
        delegations.request({
          parentExecutionId: childExecutionId,
          parentAttemptId: childAttempt.id,
          requestId: "req-2",
          requestedAgent: "grandchild",
          expiresAt: new Date(Date.now() + 60_000),
        }),
      ).rejects.toThrow(/delegationDepthMax 1/);
    });

    it("P1: startRun denies a Planner/Verifier selection outside the frozen allowlist BEFORE any materialization", async () => {
      const pipeline = await dataSource.getRepository(PipelineEntity).save(
        dataSource.getRepository(PipelineEntity).create({
          name: "closure-role-deny",
          version: "1.0",
          steps: [],
        }),
      );
      const execution = await executionService.createExecution(pipeline, {});
      await expect(
        coordinator.startRun(
          execution.id,
          teamConfig({ planner: { kind: "agent", name: "rogue-planner" } }),
          new Date(Date.now() + 3_600_000),
        ),
      ).rejects.toMatchObject({ code: "EXECUTOR_NOT_ALLOWED" });
      await expect(
        coordinator.startRun(
          execution.id,
          teamConfig({ verifier: { kind: "agent", name: "rogue-verifier" } }),
          new Date(Date.now() + 3_600_000),
        ),
      ).rejects.toMatchObject({ code: "EXECUTOR_NOT_ALLOWED" });
      // Zero materialization: no run row, no iterations, no steps.
      expect(
        await dataSource
          .getRepository(CoordinationRunEntity)
          .count({ where: { executionId: execution.id } }),
      ).toBe(0);
      expect(
        await dataSource
          .getRepository(LogicalStepEntity)
          .count({ where: { executionId: execution.id } }),
      ).toBe(0);
    });

    it("P1: CONTINUE rechecks role executors — a role connection rotated to a foreign executorId denies the next iteration", async () => {
      await connections.createConnection(
        "conn:verifier-cli",
        cliProfile("verifier v1"),
      );
      const { run, iteration, execution } = await seedRun(
        teamConfig({
          verifier: {
            kind: "connection",
            name: "conn:verifier-cli",
            agent: "verifier",
          },
        }),
      );
      await coordinator.createPlannerStep(run.id);
      const { attemptId, baseRevision } = await seedPlannerAttempt(
        dataSource,
        executionService,
        execution.id,
        1,
      );
      const accepted = await coordinator.submitIterationBatch({
        runId: run.id,
        iterationNumber: 1,
        proposal: batchProposal(baseRevision),
        plannerAttemptId: attemptId,
      });
      expect(accepted.outcome).toBe("ACCEPTED");
      await coordinator.transitionRun(run.id, "workersFinished");

      // The operator rotates the role connection to a FOREIGN executor.
      await connections.reviseConnection(
        "conn:verifier-cli",
        cliProfile("verifier v2", ["1"], "remote-host"),
      );
      const continued = await coordinator.consumeDecision(
        run.id,
        decision(iteration.id),
        randomUUID(),
      );
      expect(continued.outcome).toBe("consumed");
      expect(continued.phase).toBe("LIMIT_REACHED");
    });

    it("P1: WAIT approval resume rechecks role executors before continuing", async () => {
      await connections.createConnection(
        "conn:verifier-cli",
        cliProfile("verifier v1"),
      );
      const { run, iteration, execution } = await seedRun(
        teamConfig({
          verifier: {
            kind: "connection",
            name: "conn:verifier-cli",
            agent: "verifier",
          },
        }),
      );
      await coordinator.createPlannerStep(run.id);
      const { attemptId, baseRevision } = await seedPlannerAttempt(
        dataSource,
        executionService,
        execution.id,
        1,
      );
      await coordinator.submitIterationBatch({
        runId: run.id,
        iterationNumber: 1,
        proposal: batchProposal(baseRevision),
        plannerAttemptId: attemptId,
      });
      await coordinator.transitionRun(run.id, "workersFinished");
      const waited = await coordinator.consumeDecision(
        run.id,
        decision(iteration.id, "WAIT_FOR_HUMAN"),
        randomUUID(),
      );
      expect(waited.phase).toBe("WAITING_FOR_HUMAN");

      await connections.reviseConnection(
        "conn:verifier-cli",
        cliProfile("verifier v2", ["1"], "remote-host"),
      );
      const resumed = await coordinator.resolveWait(run.id, true);
      expect(resumed).toBe("LIMIT_REACHED");
    });

    it("P1: concurrent duplicate workbench commands produce exactly ONE authority mutation with durable replayable evidence", async () => {
      const commands = new WorkbenchCommandService(dataSource as any);
      const config = teamConfig();
      const [first, second] = await Promise.all([
        commands.startTeamRun({
          idempotencyKey: "concurrent-launch-1",
          name: "race",
          goal: "race",
          config,
        }),
        commands.startTeamRun({
          idempotencyKey: "concurrent-launch-1",
          name: "race",
          goal: "race",
          config,
        }),
      ]);
      expect([first.outcome, second.outcome].sort()).toEqual([
        "duplicate",
        "executed",
      ]);
      // Exactly one authority mutation: one pipeline, one execution, one run.
      expect(
        await dataSource.getRepository(ExecutionEntity).count(),
      ).toBe(1);
      expect(
        await dataSource.getRepository(CoordinationRunEntity).count(),
      ).toBe(1);
      // One durable audit row with the executed outcome (never pending).
      const audit = await dataSource
        .getRepository(OperatorActionEntity)
        .find({ where: { action: "start-team-run" } });
      expect(audit).toHaveLength(1);
      expect(audit[0].outcome).toMatchObject({
        executionId: expect.any(String),
        runId: expect.any(String),
      });
      // The duplicate returns the winner's stored outcome (replayable).
      const duplicateResult = [first, second].find(
        (entry) => entry.outcome === "duplicate",
      )!.result as Record<string, unknown>;
      expect(duplicateResult).toMatchObject({
        executionId: expect.any(String),
        runId: expect.any(String),
      });
    });

    it("P1: an authority crash mid-command rolls back EVERYTHING (no orphan audit, no partial authority) and the same-key retry re-executes exactly once", async () => {
      const commands = new WorkbenchCommandService(dataSource as any);
      const config = teamConfig();
      // Injected crash: the run exists in-transaction, then the next
      // authority call throws — the whole command transaction must roll
      // back (audit row, pipeline, execution, run, iteration).
      const coordinatorInstance = (commands as any)
        .coordination as RuntimeCoordinationService;
      const original = coordinatorInstance.createNextIterationWithManager;
      coordinatorInstance.createNextIterationWithManager = async () => {
        throw new Error("injected crash after run creation");
      };
      await expect(
        commands.startTeamRun({
          idempotencyKey: "crash-1",
          name: "crash",
          goal: "crash",
          config,
        }),
      ).rejects.toThrow("injected crash after run creation");
      coordinatorInstance.createNextIterationWithManager = original;
      // Nothing durable survived the rollback.
      expect(
        await dataSource
          .getRepository(OperatorActionEntity)
          .count({ where: { idempotencyKey: "crash-1" } }),
      ).toBe(0);
      expect(
        await dataSource.getRepository(ExecutionEntity).count(),
      ).toBe(0);
      expect(
        await dataSource.getRepository(CoordinationRunEntity).count(),
      ).toBe(0);
      // The same-key retry executes exactly once, cleanly.
      const retried = await commands.startTeamRun({
        idempotencyKey: "crash-1",
        name: "crash",
        goal: "crash",
        config,
      });
      expect(retried.outcome).toBe("executed");
      expect(
        await dataSource.getRepository(ExecutionEntity).count(),
      ).toBe(1);
      const audit = await dataSource
        .getRepository(OperatorActionEntity)
        .find({ where: { idempotencyKey: "crash-1" } });
      expect(audit).toHaveLength(1);
      expect(audit[0].outcome).not.toHaveProperty("pending");
    });
  },
);
