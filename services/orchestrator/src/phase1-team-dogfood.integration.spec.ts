import { DataSource, type DataSourceOptions } from "typeorm";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import type { AddressInfo } from "net";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTenvyrWorker, defineAgent, type TenvyrWorker } from "@tenvyr/worker";
import { databaseOptions } from "./database/database.provider";
import { ExecutionEntity } from "./entities/execution.entity";
import { PipelineEntity } from "./entities/pipeline.entity";
import { LogicalStepEntity } from "./entities/step-execution.entity";
import { StepAttemptEntity } from "./entities/step-attempt.entity";
import { ExecutionPlanRevisionEntity } from "./entities/execution-plan-revision.entity";
import { CoordinationRunEntity } from "./entities/coordination-run.entity";
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
import { WorkbenchCommandService } from "./services/workbench-command.service";
import { WorkbenchProjectionService } from "./services/workbench-projection.service";
import type { CoordinationConfigV1 } from "./domain/coordination";

/**
 * Product Phase 1 deterministic dogfood: the REAL supervised coding team
 * path through the Workbench command surface —
 *
 *   workspace (real git repository) -> start-team-run (workbench command)
 *     -> Planner proposes -> workers (workspace-injected inputs) -> fan-in
 *     -> Verifier (bounded context incl. workspace) -> CONTINUE
 *     -> automatic iteration 2 -> ACCEPT
 *
 * Deterministic agents on the @tenvyr/worker SDK (no paid credentials, no
 * live runtimes). The frozen workspace snapshot is asserted in the worker
 * step inputs, the Verifier context, the Capsule, and the Workbench
 * projection.
 */
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithPostgres = TEST_DATABASE_URL ? describe : describe.skip;

const configuredDatabaseName = String(databaseOptions().database);

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

const availablePort = (): Promise<number> =>
  new Promise((resolve) => {
    const server = require("node:net").createServer();
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      server.close(() => resolve(port));
    });
  });

/** Creates a real disposable git repository (deterministic identity when
 *  git is available); falls back to a plain directory when it is not. */
function createWorkspaceFixture(): { path: string; isGit: boolean } {
  const dir = mkdtempSync(join(tmpdir(), "tenvyr-dogfood-workspace-"));
  writeFileSync(join(dir, "README.md"), "# Dogfood workspace\n", "utf8");
  const probe = spawnSync("git", ["--version"], { encoding: "utf8" });
  if (probe.status !== 0) {
    return { path: dir, isGit: false };
  }
  const run = (args: string[]) =>
    spawnSync("git", args, { cwd: dir, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "Tenvyr Dogfood", GIT_AUTHOR_EMAIL: "dogfood@tenvyr.local", GIT_COMMITTER_NAME: "Tenvyr Dogfood", GIT_COMMITTER_EMAIL: "dogfood@tenvyr.local" } });
  run(["init", "-b", "main"]);
  run(["add", "README.md"]);
  const commit = run(["commit", "-m", "initial"]);
  if (commit.status !== 0) {
    return { path: dir, isGit: false };
  }
  return { path: dir, isGit: true };
}

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
  allowedExecutors: [
    "local-host",
    "agent:team-planner",
    "agent:team-verifier",
    "agent:team-implementation",
    "agent:team-tests",
  ],
});

describeWithPostgres("Product Phase 1: supervised coding team dogfood (workspace -> CONTINUE -> ACCEPT)", () => {
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
  let commands: WorkbenchCommandService;
  let projection: WorkbenchProjectionService;
  const workspace = createWorkspaceFixture();
  /** The workspace service canonicalizes the path (realpath) — the frozen
   *  snapshot always names the canonical path. */
  const canonicalWorkspacePath = realpathSync(workspace.path);
  const receivedWorkspacePaths: string[] = [];

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

    const agentConfigs = {
      "team-planner": {
        name: "team-planner",
        execute: async (context: any, input: { iterationNumber: number; planRevision?: number }) => {
          const iterationNumber = input.iterationNumber ?? 1;
          return context.success({
            output: {
              schemaVersion: 1,
              iterationNumber,
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
        execute: async (context: any, input: { workspace?: { path?: string } }) => {
          // The worker receives the FROZEN workspace snapshot in its input
          // envelope — record the path for the assertions.
          receivedWorkspacePaths.push(input.workspace?.path ?? "MISSING");
          return context.success({
            output: {
              diff: { files: 3 },
              workspacePath: input.workspace?.path ?? null,
            },
          });
        },
      },
      "team-tests": {
        name: "team-tests",
        execute: async (context: any, input: { workspace?: { path?: string } }) => {
          receivedWorkspacePaths.push(input.workspace?.path ?? "MISSING");
          return context.success({
            output: { passed: 12, workspacePath: input.workspace?.path ?? null },
          });
        },
      },
      "team-verifier": {
        name: "team-verifier",
        execute: async (
          context: any,
          input: {
            context: {
              iterationId: string;
              iterationNumber: number;
              workspace?: { path?: string };
            };
          },
        ) => {
          const iterationNumber = input.context?.iterationNumber ?? 1;
          const action = iterationNumber === 1 ? "CONTINUE" : "ACCEPT";
          return context.success({
            output: {
              schemaVersion: 1,
              iterationId: input.context?.iterationId ?? "placeholder",
              iterationNumber,
              action,
              reason: `deterministic verifier on iteration ${iterationNumber}`,
              evidenceRefs: [],
              // Bounded echo of the frozen workspace identity the verifier
              // saw in its context.
              workspacePath: input.context?.workspace?.path ?? null,
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
    commands = new WorkbenchCommandService(
      dataSource as any,
      executionService,
      coordinator,
      capsules,
      undefined,
      undefined,
    );
    projection = new WorkbenchProjectionService(dataSource as any);
  });

  afterAll(async () => {
    await adapter.stop();
    await app.close();
    for (const roleWorker of workers) {
      await roleWorker.stop();
    }
    await dataSource.destroy();
    try {
      rmSync(workspace.path, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  });

  it("launches the team run with a frozen workspace, CONTINUEs automatically, and ACCEPTs with the workspace in every bounded surface", async () => {
    // 1. Launch through the REAL Workbench command path: workspace path +
    //    acceptance evidence + agent team.
    const launched = await commands.startTeamRun({
      idempotencyKey: "phase1-dogfood-start",
      name: "phase1-dogfood",
      goal: "Inspect the workspace, fix the selected issue, and run verification until accepted.",
      config: teamConfig(),
      workspace: { path: workspace.path },
      acceptanceEvidence: {
        testCommand: "pnpm test",
        buildCommand: "pnpm build",
        requiredArtifacts: ["dist/index.js"],
      },
    });
    const executionId = String(launched.result.executionId);
    expect(launched.result.workspace).toBe(canonicalWorkspacePath);

    // 2. Drive the real loop: reconcile + dispatch until ACCEPTED.
    const terminal = async () =>
      (await coordinator.recoverRun(executionId)).run.phase === "ACCEPTED";
    for (let pass = 0; pass < 90 && !(await terminal()); pass += 1) {
      await engine.reconcileExecution(executionId);
      await outboxService.dispatchNext();
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    await engine.reconcileExecution(executionId);
    const recovered = await coordinator.recoverRun(executionId);
    expect(recovered.run.phase).toBe("ACCEPTED");
    expect(recovered.run.currentIterationNumber).toBe(2);
    expect(recovered.iterations[0].decision?.action).toBe("CONTINUE");
    expect(recovered.iterations[1].decision?.action).toBe("ACCEPT");

    // 3. The frozen workspace snapshot on the run.
    const runRow = await dataSource
      .getRepository(CoordinationRunEntity)
      .findOne({ where: { executionId } });
    expect(runRow?.workspace?.path).toBe(canonicalWorkspacePath);
    if (workspace.isGit) {
      expect(runRow?.workspace?.repoRoot).toBe(canonicalWorkspacePath);
      expect(runRow?.workspace?.headSha).toMatch(/^[0-9a-f]{40}$/);
      expect(runRow?.workspace?.dirty).toBe(false);
      expect(runRow?.workspace?.branch).toBe("main");
    } else {
      expect(runRow?.workspace?.repoRoot).toBeNull();
    }
    expect(runRow?.acceptanceEvidence?.testCommand).toBe("pnpm test");
    expect(runRow?.acceptanceEvidence?.requiredArtifacts).toEqual(["dist/index.js"]);

    // 4. Workers received the workspace snapshot in their input envelopes.
    const workerEchos = receivedWorkspacePaths.filter(
      (path) => path !== "MISSING",
    );
    expect(workerEchos.length).toBeGreaterThanOrEqual(4); // 2 workers x 2 iterations
    expect(workerEchos.every((path) => path === canonicalWorkspacePath)).toBe(true);

    // 5. The Verifier saw the workspace in its bounded context.
    const verifierAttempts = await dataSource
      .getRepository(StepAttemptEntity)
      .createQueryBuilder("attempt")
      .where('attempt."executionId" = :executionId', { executionId })
      .andWhere('attempt."status" = :status', { status: "SUCCESS" })
      .orderBy('attempt."createdAt"', "ASC")
      .getMany();
    const verifierOutputs = verifierAttempts
      .map((attempt) => (attempt.result as any) as any)
      .filter((output) => output && output.schemaVersion === 1 && output.action);
    expect(verifierOutputs.length).toBe(2);
    for (const output of verifierOutputs) {
      expect(output.workspacePath).toBe(canonicalWorkspacePath);
    }

    // 6. The Capsule carries the frozen workspace + acceptance evidence.
    const capsule = await capsules.build(executionId);
    expect((capsule.coordination as any)?.run.workspace?.path).toBe(canonicalWorkspacePath);
    expect((capsule.coordination as any)?.run.acceptanceEvidence?.testCommand).toBe("pnpm test");

    // 7. The Workbench projection carries the same bounded facts.
    const projected = await projection.executionProjection(executionId);
    expect((projected.coordination as any)?.run.workspace?.path).toBe(canonicalWorkspacePath);
    expect((projected.coordination as any)?.run.acceptanceEvidence?.buildCommand).toBe("pnpm build");
  }, 180_000);
});
