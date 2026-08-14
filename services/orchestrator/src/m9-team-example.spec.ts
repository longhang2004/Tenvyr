import { DataSource, type DataSourceOptions } from "typeorm";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import type { AddressInfo } from "net";
import { createTenvyrWorker, defineAgent, type TenvyrWorker } from "@tenvyr/worker";
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
import { ExecutionCapsuleService } from "./services/execution-capsule.service";
import { DelegationService } from "./services/delegation.service";
import { PipelineService } from "./services/pipeline.service";
import { PipelineValidationService } from "./services/pipeline-validation.service";
import { ConditionEvaluatorService } from "./services/condition-evaluator.service";
import { AgentTransportConfigService, parseAgentTransportConfiguration } from "./agent-adapters/agent-transport-config.service";
import { HttpAgentAdapter } from "./agent-adapters/http-agent.adapter";
import { HttpAgentCallbackController } from "./agent-adapters/http-agent-callback.controller";
import type { CoordinationConfigV1 } from "./domain/coordination";

/**
 * M9-S6: the deterministic team example — a real Planner/Worker/Verifier
 * team executed through the CURRENT HTTP Worker transport end to end.
 *
 * The deterministic worker agents are built on the reviewed @tenvyr/worker
 * SDK: planner proposes the batch for its iteration, implementation returns
 * bounded output, verifier reads the bounded aggregation and returns
 * CONTINUE for iteration 1 and ACCEPT for iteration 2. The engine, outbox,
 * signed callbacks, result inbox, and the Coordinator loop all run for
 * real against PostgreSQL.
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

const availablePort = (): Promise<number> =>
  new Promise((resolve) => {
    const server = require("node:net").createServer();
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      server.close(() => resolve(port));
    });
  });

const teamConfig = (): CoordinationConfigV1 => ({
  schemaVersion: 1,
  planner: { kind: "agent", name: "team-planner" },
  verifier: { kind: "agent", name: "team-verifier" },
  allowedWorkers: [
    { kind: "agent", name: "team-implementation" },
    { kind: "agent", name: "team-tests" },
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
    "agent:team-planner",
    "agent:team-verifier",
    "agent:team-implementation",
    "agent:team-tests",
  ],
});

describeWithPostgres("M9 deterministic team example (real HTTP Worker loop)", () => {
  jest.setTimeout(240_000);

  let dataSource: DataSource;
  let workers: TenvyrWorker[];
  let app: INestApplication;
  let adapter: HttpAgentAdapter;
  let inbox: ResultInboxService;
  let executionService: ExecutionService;
  let coordinator: RuntimeCoordinationService;
  let engine: EngineService;
  let outboxService: DispatchOutboxService;
  let capsules: ExecutionCapsuleService;
  let executionId: string;

  const httpAgent = (host: string, port: number) => ({
    kind: "http",
    submitUrl: `http://${host}:${port}/v1/runs`,
    outboundAuthentication: { type: "bearer", tokenEnv: "TEAM_WORKER_TOKEN" },
    callbackAuthentication: { keyId: "team-v1", secretEnv: "TEAM_CALLBACK_SECRET" },
    requestTimeoutMs: 5000,
    maxResponseBytes: 64 * 1024,
    delegationModes: ["opaque"],
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

    const callbackPort = await availablePort();
    const callbackOrigin = `http://127.0.0.1:${callbackPort}`;

    // Deterministic team agents on the reviewed worker SDK — one worker
    // instance per role (the SDK is one agent per worker by design).
    const agentConfigs = {
      "team-planner": {
        name: "team-planner",
        execute: async (context: any, input: { iterationNumber: number; planRevision?: number }) => {
          const iterationNumber = input.iterationNumber ?? 1;
          return context.success({
            output: {
              schemaVersion: 1,
              iterationNumber,
              // M9-S8: echo the Coordinator-provided frozen plan revision —
              // admission verifies it against the attempt's frozen revision.
              baseRevision: input.planRevision ?? 1,
              tasks: [
                {
                  taskId: `implement-${iterationNumber}`,
                  agent: "team-implementation",
                  input: { feature: "login" },
                  dependsOn: [],
                  required: true,
                  reason: "core implementation",
                },
                {
                  taskId: `tests-${iterationNumber}`,
                  agent: "team-tests",
                  input: {},
                  dependsOn: [`implement-${iterationNumber}`],
                  required: true,
                  reason: "tests",
                },
              ],
              reason: `iteration ${iterationNumber} plan`,
            },
          });
        },
      },
      "team-implementation": {
        name: "team-implementation",
        execute: async (context: any) =>
          context.success({ output: { diff: { files: 3 } } }),
      },
      "team-tests": {
        name: "team-tests",
        execute: async (context: any) =>
          context.success({ output: { passed: 12 } }),
      },
      "team-verifier": {
        name: "team-verifier",
        execute: async (
          context: any,
          input: { context: { iterationId: string; iterationNumber: number } },
        ) => {
          const iterationNumber = input.context?.iterationNumber ?? 1;
          const action = iterationNumber === 1 ? "CONTINUE" : "ACCEPT";
          return context.success({
            output: {
              schemaVersion: 1,
              // The Verifier echoes the iteration identity from its frozen
              // context — the Coordinator rejects mismatched identity.
              iterationId: input.context?.iterationId ?? "placeholder",
              iterationNumber,
              action,
              reason: `deterministic verifier on iteration ${iterationNumber}`,
              evidenceRefs: [],
            },
          });
        },
      },
    } as const;

    const workerAddresses = new Map<string, { host: string; port: number }>();
    const roleWorkers: TenvyrWorker[] = [];
    for (const [agentName, definition] of Object.entries(agentConfigs)) {
      const roleWorker = createTenvyrWorker({
        agent: defineAgent(definition as any) as any,
        authentication: { bearerToken: "team-worker-token" },
        callbackAuthentication: {
          keys: { "team-v1": "team-callback-secret" },
        },
        callbackPolicy: {
          allowedOrigins: [callbackOrigin],
          allowInsecureHttp: true,
        },
        callbackDelivery: {
          maxAttempts: 2,
          initialDelayMs: 1,
          maxDelayMs: 2,
          jitterRatio: 0,
          requestTimeoutMs: 1000,
        },
      });
      const address = await roleWorker.start({ host: "127.0.0.1", port: 0 });
      workerAddresses.set(agentName, address);
      roleWorkers.push(roleWorker);
    }
    workers = roleWorkers;

    const agentsEnv: Record<string, unknown> = {};
    for (const [agentName, address] of workerAddresses) {
      agentsEnv[agentName] = httpAgent(address.host, address.port);
    }
    const config = new AgentTransportConfigService(
      parseAgentTransportConfiguration({
        AGENT_TRANSPORT_CONFIG: JSON.stringify(agentsEnv),
        HTTP_AGENT_CALLBACK_BASE_URL: callbackOrigin,
        HTTP_AGENT_ALLOW_INSECURE: "true",
        TEAM_WORKER_TOKEN: "team-worker-token",
        TEAM_CALLBACK_SECRET: "team-callback-secret",
      }),
    );
    // The worker callbacks need the callback origin allowlisted too.
    (config as any).configuration.callbackAllowedOrigins = [callbackOrigin];

    const module = await Test.createTestingModule({
      controllers: [HttpAgentCallbackController],
      providers: [
        { provide: AgentTransportConfigService, useValue: config },
        HttpAgentAdapter,
      ],
    }).compile();
    app = module.createNestApplication({ rawBody: true });
    await app.listen(callbackPort, "127.0.0.1");
    adapter = module.get(HttpAgentAdapter);

    inbox = new ResultInboxService(dataSource);
    await adapter.start({
      result: async ({ result, transport }) => {
        await inbox.apply(result, transport);
      },
      event: async () => undefined,
    });

    executionService = new ExecutionService(
      dataSource.getRepository(ExecutionEntity),
      dataSource.getRepository(LogicalStepEntity),
      dataSource.getRepository(StepAttemptEntity),
      dataSource.getRepository(ExecutionPlanRevisionEntity),
      dataSource,
      undefined,
      config,
    );
    coordinator = new RuntimeCoordinationService(dataSource);
    outboxService = new DispatchOutboxService(dataSource as any, adapter, config);
    engine = new EngineService(
      new PipelineService(
        dataSource as any,
        new PipelineValidationService(new ConditionEvaluatorService()),
      ) as any,
      executionService,
      adapter,
      outboxService,
    );
    capsules = new ExecutionCapsuleService(
      dataSource as any,
      new DelegationService(dataSource as any, executionService),
      executionService,
    );
  });

  afterAll(async () => {
    await adapter.stop();
    await app.close();
    for (const roleWorker of workers) {
      await roleWorker.stop();
    }
    await dataSource.destroy();
  });

  it("runs the team to ACCEPT through the real HTTP Worker transport", async () => {
    const pipeline = await dataSource.getRepository(PipelineEntity).save(
      dataSource.getRepository(PipelineEntity).create({
        name: "m9-team-example",
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

    // Drive the loop: reconcile (claims + Coordinator decisions) and
    // dispatch through the real transport until the run terminalizes.
    const terminal = async () =>
      (await coordinator.recoverRun(executionId)).run.phase === "ACCEPTED";
    for (let pass = 0; pass < 60 && !(await terminal()); pass++) {
      await engine.reconcileExecution(executionId);
      await outboxService.dispatchNext();
      if (pass % 10 === 0) {
        const state = await coordinator.recoverRun(executionId);
        const steps = await dataSource.getRepository(LogicalStepEntity).find({
          where: { executionId },
          order: { stepId: "ASC" },
        });
        // eslint-disable-next-line no-console
        console.log(
          "PASS",
          pass,
          "phase",
          state.run.phase,
          "steps",
          steps.map((s) => `${s.stepId}:${s.status}`).join(","),
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    await engine.reconcileExecution(executionId);

    const recovered = await coordinator.recoverRun(executionId);
    expect(recovered.run.phase).toBe("ACCEPTED");
    expect(recovered.run.currentIterationNumber).toBe(2);
    expect(recovered.run.cumulativeWorkers).toBe(4);
    expect(recovered.iterations).toHaveLength(2);
    expect(recovered.iterations[0].decision?.action).toBe("CONTINUE");
    expect(recovered.iterations[1].decision?.action).toBe("ACCEPT");

    // The completion hold released: the execution completed.
    const executionRow = await dataSource
      .getRepository(ExecutionEntity)
      .findOne({ where: { id: executionId } });
    expect(executionRow?.status).toBe("COMPLETED");
    expect(await coordinator.isCompletionHeld(executionId)).toBe(false);

    // One Capsule explains the loop.
    const capsule = await capsules.build(executionId);
    expect(capsule.coordination?.run.phase).toBe("ACCEPTED");
    expect(capsule.coordination?.iterations).toHaveLength(2);
    expect(capsule.coordination?.iterations[0].workerCount).toBe(2);
  });
});
