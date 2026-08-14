import { DataSource, type DataSourceOptions } from "typeorm";
import { databaseOptions } from "./database/database.provider";
import { ExecutionEntity } from "./entities/execution.entity";
import { PipelineEntity } from "./entities/pipeline.entity";
import { LogicalStepEntity } from "./entities/step-execution.entity";
import { StepAttemptEntity } from "./entities/step-attempt.entity";
import { ExecutionPlanRevisionEntity } from "./entities/execution-plan-revision.entity";
import { ExecutionService } from "./services/execution.service";
import { EngineService } from "./services/engine.service";
import { DispatchOutboxService } from "./services/dispatch-outbox.service";
import { ResultInboxService } from "./services/result-inbox.service";
import { RuntimeCoordinationService } from "./services/runtime-coordination.service";
import { WorkbenchCommandService } from "./services/workbench-command.service";
import { WorkbenchProjectionService } from "./services/workbench-projection.service";
import { ExecutionCapsuleService } from "./services/execution-capsule.service";
import { DelegationService } from "./services/delegation.service";
import { AgentTransportConfigService, parseAgentTransportConfiguration } from "./agent-adapters/agent-transport-config.service";
import type { AgentResultV1, JsonValue } from "@tenvyr/contracts";
import type { CoordinationConfigV1 } from "./domain/coordination";

/**
 * M10-S5: the deterministic OFFLINE workbench demo. Clearly labeled mock
 * runtime profiles; at least two iterations including one Worker failure
 * and one approval boundary; ends with a Capsule. The whole wedge runs
 * through the REAL command surface (start-team-run, resolve-wait) and the
 * existing engine/outbox/inbox machinery against PostgreSQL.
 */
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithPostgres = TEST_DATABASE_URL ? describe : describe.skip;

const assertDisposableTarget = (url: string | undefined): void => {
  if (!url) return;
  const database = decodeURIComponent(
    new URL(url).pathname.replace(/^\/+/, "").replace(/\/+$/, ""),
  );
  if (!database || database.toLowerCase() === configuredDatabaseName.toLowerCase()) {
    throw new Error(
      "TEST_DATABASE_URL must name a disposable database, never the configured one",
    );
  }
};

const configuredDatabaseName = String(databaseOptions().database);

const teamConfig = (): CoordinationConfigV1 => ({
  schemaVersion: 1,
  planner: { kind: "agent", name: "demo-planner" },
  verifier: { kind: "agent", name: "demo-verifier" },
  allowedWorkers: [
    { kind: "agent", name: "demo-implementation" },
    { kind: "agent", name: "demo-review" },
  ],
  maxIterations: 3,
  maxWorkersPerIteration: 4,
  maxTotalWorkers: 20,
  loopDeadlineMs: 3_600_000,
  delegationDepthMax: 2,
  // M8-S6 enforcement: agent-kind tasks resolve to `agent:<name>`; the
  // Planner/Verifier role selections are allowlisted the same way.
  allowedExecutors: [
    "local-host",
    "agent:demo-planner",
    "agent:demo-verifier",
    "agent:demo-implementation",
    "agent:demo-review",
  ],
});

describeWithPostgres("M10 deterministic offline workbench demo", () => {
  jest.setTimeout(240_000);

  let dataSource: DataSource;
  let commands: WorkbenchCommandService;
  let coordinator: RuntimeCoordinationService;
  let executionService: ExecutionService;
  let engine: EngineService;
  let outboxService: DispatchOutboxService;
  let inbox: ResultInboxService;
  let projection: WorkbenchProjectionService;
  let capsules: ExecutionCapsuleService;
  let executionId: string;

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
    const config = new AgentTransportConfigService(
      parseAgentTransportConfiguration({}),
    );
    const recordingAdapter = {
      kind: "test",
      invoke: jest.fn(async (invocation: any) => ({
        adapter: "test",
        invocationId: invocation.invocationId,
        dispatchedAt: new Date().toISOString(),
      })),
    };
    outboxService = new DispatchOutboxService(
      dataSource as any,
      recordingAdapter as any,
      config,
    );
    engine = new EngineService(
      undefined as any,
      executionService,
      recordingAdapter as any,
      outboxService,
    );
    inbox = new ResultInboxService(dataSource);
    commands = new WorkbenchCommandService(dataSource, executionService, coordinator);
    projection = new WorkbenchProjectionService(dataSource);
    capsules = new ExecutionCapsuleService(
      dataSource as any,
      new DelegationService(dataSource as any, executionService),
      executionService,
    );
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  /** Deterministic "mock runtime" step completion through the real inbox. */
  const completeStep = async (stepId: string, output: JsonValue) => {
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
    const result: AgentResultV1 = {
      schemaVersion: "1",
      invocationId: attempt.invocationId,
      executionId,
      stepExecutionId: logical.id,
      status: "succeeded",
      output,
      completedAt: new Date().toISOString(),
    };
    await inbox.apply(result, {
      adapter: "http",
      receivedAt: new Date().toISOString(),
      deliveryId: `delivery-${stepId}`,
    });
  };

  const failStep = async (stepId: string) => {
    await engine.reconcileExecution(executionId);
    await outboxService.dispatchNext();
    const logical = await dataSource
      .getRepository(LogicalStepEntity)
      .findOne({ where: { executionId, stepId } });
    const attempt = await dataSource
      .getRepository(StepAttemptEntity)
      .findOne({
        where: { logicalStepId: logical!.id },
        order: { attemptNumber: "DESC" },
      });
    const result: AgentResultV1 = {
      schemaVersion: "1",
      invocationId: attempt!.invocationId,
      executionId,
      stepExecutionId: logical!.id,
      status: "failed",
      output: { error: "mock review found no spec" },
      completedAt: new Date().toISOString(),
    };
    await inbox.apply(result, {
      adapter: "http",
      receivedAt: new Date().toISOString(),
      deliveryId: `delivery-fail-${stepId}`,
    });
  };

  const plannerProposal = (
    iterationNumber: number,
    // M9-S8: the Planner batch must declare the revision its attempt was
    // frozen on. In this fixed demo flow the sequence is deterministic:
    // initial revision 1 -> planner-1 activates revision 2 -> batch-1
    // activates revision 3 -> planner-2 activates revision 4.
    baseRevision: number,
  ): JsonValue =>
    ({
      schemaVersion: 1,
      iterationNumber,
      baseRevision,
      tasks: [
        {
          taskId: `implement-${iterationNumber}`,
          agent: "demo-implementation",
          input: { feature: "login" },
          dependsOn: [],
          required: true,
          reason: "core implementation",
        },
        {
          taskId: `review-${iterationNumber}`,
          agent: "demo-review",
          input: {},
          dependsOn: [`implement-${iterationNumber}`],
          required: false,
          reason: "optional review",
        },
      ],
      reason: `iteration ${iterationNumber} plan`,
    }) as unknown as JsonValue;

  const verifierDecision = (
    iterationId: string,
    iterationNumber: number,
    action: "CONTINUE" | "ACCEPT" | "WAIT_FOR_HUMAN",
  ): JsonValue =>
    ({
      schemaVersion: 1,
      iterationId,
      iterationNumber,
      action,
      reason: "deterministic demo verifier",
      evidenceRefs: [],
    }) as unknown as JsonValue;

  it("runs the whole wedge: launch -> failure -> WAIT -> approval -> accept -> Capsule", async () => {
    // 1. Launch through the real command surface.
    const launch = await commands.startTeamRun({
      idempotencyKey: "demo-launch-1",
      name: "offline-wedge",
      goal: "build the offline wedge",
      config: teamConfig(),
    });
    expect(launch.outcome).toBe("executed");
    executionId = (launch.result as { executionId: string }).executionId;

    // 2. Iteration 1: implementer succeeds, reviewer FAILS (evidence).
    await completeStep("planner-1", plannerProposal(1, 2));
    await completeStep("implement-1", { diff: { files: 3 } });
    await failStep("review-1");
    await engine.reconcileExecution(executionId);
    let state = await coordinator.recoverRun(executionId);
    expect(state.run.phase).toBe("VERIFYING");

    // 3. The Verifier sees the failure evidence and requests human approval.
    await completeStep(
      "verify-1",
      verifierDecision(state.iterations[0].id, 1, "WAIT_FOR_HUMAN"),
    );
    await engine.reconcileExecution(executionId);
    state = await coordinator.recoverRun(executionId);
    expect(state.run.phase).toBe("WAITING_FOR_HUMAN");

    // 4. The operator approves through the real command surface.
    const approval = await commands.resolveWait({
      idempotencyKey: "demo-approve-1",
      runId: state.run.id,
      approve: true,
    });
    expect(approval.result).toEqual({ runId: state.run.id, phase: "PLANNING" });

    // 5. Iteration 2: clean run, Verifier accepts.
    await completeStep("planner-2", plannerProposal(2, 4));
    await completeStep("implement-2", { diff: { files: 5 } });
    await completeStep("review-2", { passed: 8 });
    await engine.reconcileExecution(executionId);
    state = await coordinator.recoverRun(executionId);
    await completeStep(
      "verify-2",
      verifierDecision(state.iterations[1].id, 2, "ACCEPT"),
    );
    await engine.reconcileExecution(executionId);
    state = await coordinator.recoverRun(executionId);
    expect(state.run.phase).toBe("ACCEPTED");
    expect(state.run.currentIterationNumber).toBe(2);
    expect(state.run.cumulativeWorkers).toBe(4);

    // 6. The Capsule explains the whole wedge, failure evidence included.
    const capsule = await capsules.build(executionId);
    expect(capsule.coordination?.run.phase).toBe("ACCEPTED");
    expect(capsule.coordination?.iterations).toHaveLength(2);
    expect(capsule.coordination?.iterations[0].decisionAction).toBe(
      "WAIT_FOR_HUMAN",
    );
    expect(capsule.coordination?.iterations[1].decisionAction).toBe("ACCEPT");

    // 7. The workbench projection + audit trail reflect the demo.
    const detailed = await projection.executionProjection(executionId);
    expect(detailed.coordination?.run.phase).toBe("ACCEPTED");
    const audit = await commands.auditTrail();
    expect(audit.items.map((item) => item.action)).toEqual(
      expect.arrayContaining(["start-team-run", "resolve-wait"]),
    );
    // The demo never leaked a secret.
    expect(JSON.stringify(capsule)).not.toContain("sk-");
  });
});
