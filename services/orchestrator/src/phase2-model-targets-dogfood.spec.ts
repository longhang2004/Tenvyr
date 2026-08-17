import { DataSource, type DataSourceOptions } from "typeorm";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import type { AddressInfo } from "net";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
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
import { RuntimeConnectionService } from "./services/runtime-connection.service";
import { ExecutionCapsuleService } from "./services/execution-capsule.service";
import { DelegationService } from "./services/delegation.service";
import { PipelineService } from "./services/pipeline.service";
import { PipelineValidationService } from "./services/pipeline-validation.service";
import { ConditionEvaluatorService } from "./services/condition-evaluator.service";
import {
  AgentTransportConfigService,
  parseAgentTransportConfiguration,
} from "./agent-adapters/agent-transport-config.service";
import { HttpAgentAdapter } from "./agent-adapters/http-agent.adapter";
import { HttpAgentCallbackController } from "./agent-adapters/http-agent-callback.controller";
import type { ConnectionProfileV1 } from "./executors/runtime-connection";
import type { CoordinationConfigV1 } from "./domain/coordination";
import {
  startHostWorkers,
  type HostConfig,
} from "../../local-executor-host/src/main";

/**
 * P2 dogfood: model selection is EXECUTION PROVENANCE.
 *
 * The operator freezes distinct Runtime Targets per role:
 *   Planner  conn:planner-cli + claude-sonnet-5
 *   Workers  conn:worker-a   + opencode-go/deepseek-v4-flash
 *            conn:worker-b   + gpt-5.5
 *   Verifier conn:verifier-cli + gpt-5.5
 *
 * Every attempt must carry its EXACT requested model through the REAL
 * local executor host: frozen descriptor -> invocation -> fixed argv
 * composition (--model <id>) -> child evidence. A retry keeps the model;
 * a later catalog/source change never rewrites historical attempts; an
 * unauthorized Planner model is DENIED with zero materialization.
 */
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithPostgres = TEST_DATABASE_URL ? describe : describe.skip;

const assertDisposableTarget = (url: string | undefined): void => {
  if (!url) return;
  const database = decodeURIComponent(
    new URL(url).pathname.replace(/^\/+/, "").replace(/\/+$/, ""),
  );
  if (
    !database ||
    database.toLowerCase() === configuredDatabaseName.toLowerCase()
  ) {
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

const NODE = process.execPath;

const FROZEN_TARGETS = {
  planner: { connectionId: "conn:planner-cli", modelId: "claude-sonnet-5" },
  verifier: { connectionId: "conn:verifier-cli", modelId: "gpt-5.5" },
  workerA: {
    connectionId: "conn:worker-a",
    modelId: "opencode-go/deepseek-v4-flash",
  },
  workerB: { connectionId: "conn:worker-b", modelId: "gpt-5.5" },
} as const;

const cliConnection = (
  connectionId: string,
  name: string,
  scriptPath: string,
): ConnectionProfileV1 => ({
  name,
  runtimeKind: "generic-cli",
  executorId: "local-host",
  version: "0.1.0",
  credentialRefs: [],
  declaredCapabilities: {
    invocation: { supported: true, source: "configured" },
    structuredResult: { supported: true, source: "configured" },
    localProcessTermination: { supported: true, source: "configured" },
  },
  cli: {
    command: NODE,
    args: [scriptPath],
    cwd: path.dirname(scriptPath),
    envAllowlist: {
      FAKE_MARKER: "HOST_FAKE_MARKER",
      EVIDENCE_DIR: "HOST_EVIDENCE_DIR",
    },
    probe: { args: ["-e", "console.log(1)"], expectsVersion: false },
  },
});

describeWithPostgres(
  "P2 model targets: frozen requested models per role through the REAL local executor host",
  () => {
    jest.setTimeout(300_000);

    let dataSource: DataSource;
    let adapter: HttpAgentAdapter;
    let inbox: ResultInboxService;
    let executionService!: ExecutionService;
    let coordinator: RuntimeCoordinationService;
    let connections: RuntimeConnectionService;
    let engine!: EngineService;
    let outboxService!: DispatchOutboxService;
    let capsules!: ExecutionCapsuleService;
    let transportApp: INestApplication | null = null;

    let fixtureDir: string;
    let evidenceDir: string;
    let plannerOkScript: string;
    let plannerBadModelScript: string;
    let verifierScript: string;
    let workerAScript: string;
    let workerBScript: string;
    let flakyScript: string;
    let counterFile: string;

    let hostWorkers: Awaited<ReturnType<typeof startHostWorkers>> = [];
    let callbackOrigin = "";
    const hostAddresses = new Map<string, { host: string; port: number }>();

    /** Fake Planner emitting tasks with explicit modelIds (allowed targets).
     *  Task ids are suffixed with the iteration number so each iteration's
     *  PlanPatch is a distinct step set. */
    const fakePlanner = (
      evidenceFile: string,
      tasks: Array<{
        taskId: string;
        agent: string;
        connectionId: string;
        modelId: string;
        retry?: number;
      }>,
    ): string => `
const fs = require("node:fs");
let raw = "";
process.stdin.on("data", (c) => (raw += c));
process.stdin.on("end", () => {
  const invocation = JSON.parse(raw);
  const n = invocation.input?.iterationNumber ?? 1;
  const baseRevision = invocation.input?.planRevision ?? 1;
  fs.appendFileSync(
    "${evidenceFile}",
    JSON.stringify({ invocationId: invocation.invocationId, role: "planner", argv: process.argv.slice(1) }) + "\\n",
  );
  process.stdout.write(JSON.stringify({
    schemaVersion: 1,
    iterationNumber: n,
    baseRevision,
    tasks: ${JSON.stringify(tasks)}.map((t) => ({ ...t, taskId: t.taskId + "-" + n, input: {}, dependsOn: [], required: true, retry: t.retry ?? 0, reason: "deterministic" })),
    reason: "iteration " + n + " plan",
  }));
});
`;

    /** Fake Planner emitting an UNAUTHORIZED model for worker-a. */
    const fakePlannerBadModel = (evidenceFile: string): string => `
const fs = require("node:fs");
let raw = "";
process.stdin.on("data", (c) => (raw += c));
process.stdin.on("end", () => {
  const invocation = JSON.parse(raw);
  const n = invocation.input?.iterationNumber ?? 1;
  const baseRevision = invocation.input?.planRevision ?? 1;
  fs.appendFileSync(
    "${evidenceFile}",
    JSON.stringify({ invocationId: invocation.invocationId, role: "planner", argv: process.argv.slice(1) }) + "\\n",
  );
  process.stdout.write(JSON.stringify({
    schemaVersion: 1,
    iterationNumber: n,
    baseRevision,
    tasks: [
      { taskId: "build-" + n, agent: "cli-worker-a", connectionId: "conn:worker-a", modelId: "not-allowed-model", input: {}, dependsOn: [], required: true, reason: "hostile" },
    ],
    reason: "hostile iteration " + n,
  }));
});
`;

    const fakeVerifier = (evidenceFile: string): string => `
const fs = require("node:fs");
let raw = "";
process.stdin.on("data", (c) => (raw += c));
process.stdin.on("end", () => {
  const invocation = JSON.parse(raw);
  const ctx = invocation.input?.context ?? {};
  const n = ctx.iterationNumber ?? 1;
  fs.appendFileSync(
    "${evidenceFile}",
    JSON.stringify({ invocationId: invocation.invocationId, role: "verifier", argv: process.argv.slice(1) }) + "\\n",
  );
  process.stdout.write(JSON.stringify({
    schemaVersion: 1,
    iterationId: ctx.iterationId ?? "placeholder",
    iterationNumber: n,
    action: n === 1 ? "CONTINUE" : "ACCEPT",
    reason: "deterministic verifier iteration " + n,
    evidenceRefs: [],
  }));
});
`;

    const fakeWorker = (
      evidenceFile: string,
      role: string,
      payload: string,
    ): string => `
const fs = require("node:fs");
let raw = "";
process.stdin.on("data", (c) => (raw += c));
process.stdin.on("end", () => {
  const invocation = JSON.parse(raw);
  fs.appendFileSync(
    "${evidenceFile}",
    JSON.stringify({ invocationId: invocation.invocationId, role: "${role}", argv: process.argv.slice(1), input: invocation.input ?? null }) + "\\n",
  );
  process.stdout.write(JSON.stringify(${payload}));
});
`;

    /** Flaky worker: fails once, then succeeds — the retry must reuse the
     *  SAME frozen model. */
    const fakeFlaky = (evidenceFile: string): string => `
const fs = require("node:fs");
let raw = "";
process.stdin.on("data", (c) => (raw += c));
process.stdin.on("end", () => {
  const invocation = JSON.parse(raw);
  let count = 0;
  try { count = Number(fs.readFileSync("${counterFile}", "utf8")); } catch {}
  fs.writeFileSync("${counterFile}", String(count + 1));
  if (count === 0) {
    console.error("first invocation fails deterministically");
    process.exit(1);
  }
  fs.appendFileSync(
    "${evidenceFile}",
    JSON.stringify({ invocationId: invocation.invocationId, role: "flaky", argv: process.argv.slice(1) }) + "\\n",
  );
  process.stdout.write(JSON.stringify({ built: true, attempt: count + 1 }));
});
`;

    const writeScript = (dir: string, name: string, body: string): string => {
      const target = path.join(dir, name);
      fs.writeFileSync(target, body);
      return target;
    };

    const httpAgent = (host: string, port: number) => ({
      kind: "http",
      submitUrl: `http://${host}:${port}/v1/runs`,
      outboundAuthentication: { type: "bearer", tokenEnv: "TEAM_WORKER_TOKEN" },
      callbackAuthentication: {
        keyId: "host-v1",
        secretEnv: "TEAM_CALLBACK_SECRET",
      },
      requestTimeoutMs: 10_000,
      maxResponseBytes: 64 * 1024,
      delegationModes: ["opaque"],
    });

    const hostAgentConfig = (
      agent: string,
      scriptPath: string,
      connectionId: string,
      configHash: string,
      overrides: Partial<NonNullable<HostConfig["agents"]>[number]> = {},
    ): NonNullable<HostConfig["agents"]>[number] => ({
      agent,
      command: NODE,
      args: [scriptPath],
      cwd: fs.realpathSync(fixtureDir),
      env: {
        FAKE_MARKER: "HOST_FAKE_MARKER",
        EVIDENCE_DIR: "HOST_EVIDENCE_DIR",
      },
      secrets: {},
      wallTimeMs: 30_000,
      maxStdoutBytes: 256 * 1024,
      maxStderrBytes: 64 * 1024,
      port: 0,
      bearerTokenEnv: "HOST_WORKER_TOKEN",
      connectionId,
      configHash,
      structuredResult: true,
      // P2: the agent's FIXED model-argument prefix (operator config).
      modelArgvPrefix: ["--model"],
      ...overrides,
    });

    const startHost = async (
      profiles: NonNullable<HostConfig["agents"]>[number][],
    ): Promise<typeof hostWorkers> => {
      const config: HostConfig = {
        agents: profiles,
        allowedRoot: fixtureDir,
        stateDir: path.join(fixtureDir, "host-state"),
        callbackAllowedOrigins: [callbackOrigin],
        callbackKeys: { "host-v1": "host-callback-secret" },
        callbackAllowInsecure: true,
      };
      fs.mkdirSync(config.stateDir, { recursive: true });
      const started = await startHostWorkers(config);
      for (const entry of started) {
        hostAddresses.set(entry.agent, entry.address);
      }
      return started;
    };

    const revisionHash = async (connectionId: string): Promise<string> => {
      const revision = await connections.claimRevision(connectionId);
      return revision.configHash;
    };

    const createConnections = async (): Promise<void> => {
      await connections.createConnection(
        "conn:planner-cli",
        cliConnection("conn:planner-cli", "Planner CLI", plannerOkScript),
      );
      await connections.createConnection(
        "conn:verifier-cli",
        cliConnection("conn:verifier-cli", "Verifier CLI", verifierScript),
      );
      await connections.createConnection(
        "conn:worker-a",
        cliConnection("conn:worker-a", "Worker A CLI", workerAScript),
      );
      await connections.createConnection(
        "conn:worker-b",
        cliConnection("conn:worker-b", "Worker B CLI", workerBScript),
      );
    };

    const p2Config = (
      overrides: Partial<CoordinationConfigV1> = {},
    ): CoordinationConfigV1 => ({
      schemaVersion: 1,
      planner: {
        kind: "connection",
        name: "conn:planner-cli",
        agent: "cli-planner",
      },
      verifier: {
        kind: "connection",
        name: "conn:verifier-cli",
        agent: "cli-verifier",
      },
      allowedWorkers: [
        {
          kind: "connection",
          name: "conn:worker-a",
          agent: "cli-worker-a",
        },
        {
          kind: "connection",
          name: "conn:worker-b",
          agent: "cli-worker-b",
        },
      ],
      plannerTarget: FROZEN_TARGETS.planner,
      verifierTarget: FROZEN_TARGETS.verifier,
      allowedTargets: [FROZEN_TARGETS.workerA, FROZEN_TARGETS.workerB],
      maxIterations: 3,
      maxWorkersPerIteration: 4,
      maxTotalWorkers: 20,
      loopDeadlineMs: 3_600_000,
      delegationDepthMax: 2,
      allowedExecutors: ["local-host"],
      ...overrides,
    });

    const seedRun = async (name: string, config?: CoordinationConfigV1) => {
      const pipeline = await dataSource.getRepository(PipelineEntity).save(
        dataSource.getRepository(PipelineEntity).create({
          name,
          version: "1.0",
          steps: [],
        }),
      );
      const execution = await executionService.createExecution(pipeline, {});
      await engine.reconcileExecution(execution.id);
      const run = await coordinator.startRun(
        execution.id,
        config ?? p2Config(),
        new Date(Date.now() + 3_600_000),
      );
      await coordinator.createNextIteration(run.id);
      return { pipeline, execution, run };
    };

    const driveToTerminal = async (executionId: string, passes = 80) => {
      const terminal = async () => {
        const phase = (await coordinator.recoverRun(executionId)).run.phase;
        return ["ACCEPTED", "FAILED", "CANCELLED", "LIMIT_REACHED"].includes(
          phase,
        );
      };
      for (let pass = 0; pass < passes && !(await terminal()); pass++) {
        await engine.reconcileExecution(executionId);
        await outboxService.dispatchNext();
        await new Promise((resolve) => setTimeout(resolve, 120));
      }
      await engine.reconcileExecution(executionId);
    };

    const evidenceLines = (role: string): Array<Record<string, unknown>> => {
      const file = path.join(evidenceDir, `${role}.jsonl`);
      if (!fs.existsSync(file)) return [];
      return fs
        .readFileSync(file, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    };

    const wireTransport = async (callbackPort: number): Promise<void> => {
      callbackOrigin = `http://127.0.0.1:${callbackPort}`;
      const agentsEnv: Record<string, unknown> = {};
      for (const [agentName, address] of hostAddresses) {
        agentsEnv[agentName] = httpAgent(address.host, address.port);
      }
      const config = new AgentTransportConfigService(
        parseAgentTransportConfiguration({
          AGENT_TRANSPORT_CONFIG: JSON.stringify(agentsEnv),
          HTTP_AGENT_CALLBACK_BASE_URL: callbackOrigin,
          HTTP_AGENT_ALLOW_INSECURE: "true",
          TEAM_WORKER_TOKEN: "team-worker-token",
          TEAM_CALLBACK_SECRET: "host-callback-secret",
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
      transportApp = module.createNestApplication({ rawBody: true });
      await transportApp.listen(callbackPort, "127.0.0.1");
      adapter = module.get(HttpAgentAdapter);
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
      capsules = new ExecutionCapsuleService(
        dataSource as any,
        new DelegationService(dataSource as any, executionService),
        executionService,
      );
      outboxService = new DispatchOutboxService(
        dataSource as any,
        adapter,
        config,
      );
      engine = new EngineService(
        new PipelineService(
          dataSource as any,
          new PipelineValidationService(new ConditionEvaluatorService()),
        ) as any,
        executionService,
        adapter,
        outboxService,
      );
    };

    const closeTransport = async (): Promise<void> => {
      if (adapter) {
        await adapter.stop().catch(() => undefined);
      }
      if (transportApp) {
        await transportApp.close().catch(() => undefined);
        transportApp = null;
      }
    };

    beforeAll(async () => {
      assertDisposableTarget(TEST_DATABASE_URL);
      dataSource = new DataSource({
        ...databaseOptions(),
        type: "postgres" as const,
        url: TEST_DATABASE_URL,
      } as DataSourceOptions);
      await dataSource.initialize();
      await dataSource.query(
        `DROP SCHEMA public CASCADE; CREATE SCHEMA public;`,
      );
      await dataSource.runMigrations();

      fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "tenvyr-p2-host-"));
      evidenceDir = path.join(fixtureDir, "evidence");
      fs.mkdirSync(evidenceDir, { recursive: true });
      process.env.HOST_FAKE_MARKER = "identity-marker-1";
      process.env.HOST_EVIDENCE_DIR = evidenceDir;
      process.env.HOST_WORKER_TOKEN = "team-worker-token";
      counterFile = path.join(fixtureDir, "flaky-counter");
      plannerOkScript = writeScript(
        fixtureDir,
        "planner-ok.js",
        fakePlanner(path.join(evidenceDir, "planner.jsonl"), [
          {
            taskId: "build",
            agent: "cli-worker-a",
            connectionId: "conn:worker-a",
            modelId: FROZEN_TARGETS.workerA.modelId,
          },
          {
            taskId: "test",
            agent: "cli-worker-b",
            connectionId: "conn:worker-b",
            modelId: FROZEN_TARGETS.workerB.modelId,
          },
        ]),
      );
      plannerBadModelScript = writeScript(
        fixtureDir,
        "planner-bad.js",
        fakePlannerBadModel(path.join(evidenceDir, "planner.jsonl")),
      );
      verifierScript = writeScript(
        fixtureDir,
        "verifier.js",
        fakeVerifier(path.join(evidenceDir, "verifier.jsonl")),
      );
      workerAScript = writeScript(
        fixtureDir,
        "worker-a.js",
        fakeWorker(
          path.join(evidenceDir, "worker-a.jsonl"),
          "worker-a",
          `{ built: true, module: invocation.input?.module ?? "" }`,
        ),
      );
      workerBScript = writeScript(
        fixtureDir,
        "worker-b.js",
        fakeWorker(
          path.join(evidenceDir, "worker-b.jsonl"),
          "worker-b",
          `{ passed: 12 }`,
        ),
      );
      flakyScript = writeScript(
        fixtureDir,
        "flaky.js",
        fakeFlaky(path.join(evidenceDir, "flaky.jsonl")),
      );

      inbox = new ResultInboxService(dataSource);
      connections = new RuntimeConnectionService(dataSource);
      coordinator = new RuntimeCoordinationService(dataSource);
    });

    afterAll(async () => {
      await closeTransport();
      for (const entry of hostWorkers) {
        await entry.stop().catch(() => undefined);
      }
      await dataSource?.destroy();
      fs.rmSync(fixtureDir, { recursive: true, force: true });
    });

    beforeEach(async () => {
      await closeTransport();
      for (const entry of hostWorkers) {
        await entry.stop().catch(() => undefined);
      }
      hostWorkers = [];
      hostAddresses.clear();
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
         "runtime_connections", "connection_revisions", "model_sources" CASCADE`,
      );
      for (const file of fs.readdirSync(evidenceDir)) {
        fs.rmSync(path.join(evidenceDir, file), { force: true });
      }
      fs.rmSync(counterFile, { force: true });
    });

    it("freezes EXACT requested models per role: descriptor, invocation argv, retry, iteration 2, and Capsule", async () => {
      await createConnections();
      const callbackPort = await availablePort();
      callbackOrigin = `http://127.0.0.1:${callbackPort}`;
      hostWorkers = await startHost([
        hostAgentConfig(
          "cli-planner",
          plannerOkScript,
          "conn:planner-cli",
          await revisionHash("conn:planner-cli"),
        ),
        hostAgentConfig(
          "cli-verifier",
          verifierScript,
          "conn:verifier-cli",
          await revisionHash("conn:verifier-cli"),
        ),
        hostAgentConfig(
          "cli-worker-a",
          workerAScript,
          "conn:worker-a",
          await revisionHash("conn:worker-a"),
        ),
        hostAgentConfig(
          "cli-worker-b",
          workerBScript,
          "conn:worker-b",
          await revisionHash("conn:worker-b"),
        ),
      ]);
      await wireTransport(callbackPort);

      const { execution } = await seedRun("p2-exact-models");
      await driveToTerminal(execution.id);
      const recovered = await coordinator.recoverRun(execution.id);
      expect(recovered.run.phase).toBe("ACCEPTED");
      expect(recovered.run.currentIterationNumber).toBe(2);
      expect(recovered.run.cumulativeWorkers).toBe(4);

      // 1) The children SAW the exact composed argv: [...fixedArgs,
      // "--model", <requested>] — per role, per iteration, every attempt.
      for (const line of evidenceLines("planner")) {
        expect(line.argv).toEqual([
          plannerOkScript,
          "--model",
          FROZEN_TARGETS.planner.modelId,
        ]);
      }
      for (const line of evidenceLines("verifier")) {
        expect(line.argv).toEqual([
          verifierScript,
          "--model",
          FROZEN_TARGETS.verifier.modelId,
        ]);
      }
      for (const line of evidenceLines("worker-a")) {
        expect(line.argv).toEqual([
          workerAScript,
          "--model",
          FROZEN_TARGETS.workerA.modelId,
        ]);
      }
      for (const line of evidenceLines("worker-b")) {
        expect(line.argv).toEqual([
          workerBScript,
          "--model",
          FROZEN_TARGETS.workerB.modelId,
        ]);
      }
      expect(evidenceLines("worker-a")).toHaveLength(2);
      expect(evidenceLines("worker-b")).toHaveLength(2);
      expect(evidenceLines("planner")).toHaveLength(2);
      expect(evidenceLines("verifier")).toHaveLength(2);

      // 2) Frozen provenance on every attempt: requestedModelId exactly the
      // operator-frozen target — including iteration 2.
      const attempts = await dataSource.getRepository(StepAttemptEntity).find({
        where: { executionId: execution.id },
      });
      const steps = await dataSource.getRepository(LogicalStepEntity).find({
        where: { executionId: execution.id },
      });
      const logicalById = new Map(steps.map((step) => [step.id, step]));
      const expectedByStep = new Map<string, string>([
        ["planner-1", FROZEN_TARGETS.planner.modelId],
        ["planner-2", FROZEN_TARGETS.planner.modelId],
        ["verify-1", FROZEN_TARGETS.verifier.modelId],
        ["verify-2", FROZEN_TARGETS.verifier.modelId],
        ["build-1", FROZEN_TARGETS.workerA.modelId],
        ["build-2", FROZEN_TARGETS.workerA.modelId],
        ["test-1", FROZEN_TARGETS.workerB.modelId],
        ["test-2", FROZEN_TARGETS.workerB.modelId],
      ]);
      const seen = new Set<string>();
      for (const attempt of attempts) {
        const step = logicalById.get(attempt.logicalStepId);
        if (!step) continue;
        const expected = expectedByStep.get(step.stepId);
        if (expected === undefined) continue;
        seen.add(step.stepId);
        expect((attempt.executorSnapshot as any)?.requestedModelId).toBe(
          expected,
        );
      }
      expect(seen.size).toBe(8);

      // 3) Capsule provenance shows the requested model per role.
      const capsule = await capsules.build(execution.id);
      const capsuleAttempts = (capsule as any).attempts as Array<{
        stepId: string;
        executorSnapshot: { requestedModelId?: string };
      }>;
      const capsuleByStep = new Map(
        capsuleAttempts.map((attempt) => [attempt.stepId, attempt]),
      );
      expect(
        capsuleByStep.get("planner-1")?.executorSnapshot.requestedModelId,
      ).toBe(FROZEN_TARGETS.planner.modelId);
      expect(
        capsuleByStep.get("build-1")?.executorSnapshot.requestedModelId,
      ).toBe(FROZEN_TARGETS.workerA.modelId);
      expect(
        capsuleByStep.get("test-2")?.executorSnapshot.requestedModelId,
      ).toBe(FROZEN_TARGETS.workerB.modelId);
      expect(
        capsuleByStep.get("verify-1")?.executorSnapshot.requestedModelId,
      ).toBe(FROZEN_TARGETS.verifier.modelId);
      // No observed model was ever fabricated.
      const json = JSON.stringify(capsule);
      expect(json).not.toContain("observedModelId");
    });

    it("Planner proposing an unauthorized model is DENIED: zero worker materialization, no spawn", async () => {
      await connections.createConnection(
        "conn:planner-cli",
        cliConnection(
          "conn:planner-cli",
          "Planner CLI (hostile)",
          plannerBadModelScript,
        ),
      );
      await connections.createConnection(
        "conn:verifier-cli",
        cliConnection("conn:verifier-cli", "Verifier CLI", verifierScript),
      );
      await connections.createConnection(
        "conn:worker-a",
        cliConnection("conn:worker-a", "Worker A CLI", workerAScript),
      );
      const callbackPort = await availablePort();
      callbackOrigin = `http://127.0.0.1:${callbackPort}`;
      hostWorkers = await startHost([
        hostAgentConfig(
          "cli-planner",
          plannerBadModelScript,
          "conn:planner-cli",
          await revisionHash("conn:planner-cli"),
        ),
        hostAgentConfig(
          "cli-verifier",
          verifierScript,
          "conn:verifier-cli",
          await revisionHash("conn:verifier-cli"),
        ),
        hostAgentConfig(
          "cli-worker-a",
          workerAScript,
          "conn:worker-a",
          await revisionHash("conn:worker-a"),
        ),
      ]);
      await wireTransport(callbackPort);

      const { execution } = await seedRun("p2-unauthorized-model", p2Config());
      await driveToTerminal(execution.id, 30);
      const recovered = await coordinator.recoverRun(execution.id);
      expect(["FAILED", "PLANNING"]).toContain(recovered.run.phase);

      // The planner ran once; its hostile batch was rejected at admission
      // (MODEL_NOT_ALLOWED) — the worker host agent NEVER spawned.
      expect(evidenceLines("planner")).toHaveLength(1);
      expect(evidenceLines("worker-a")).toHaveLength(0);
      if (recovered.run.phase === "FAILED") {
        const steps = await dataSource.getRepository(LogicalStepEntity).find({
          where: { executionId: execution.id },
        });
        expect(steps.map((step) => step.stepId).sort()).toEqual(["planner-1"]);
      }
    });

    it("model disappears after run start (catalog/source change): historical frozen execution configuration is unchanged", async () => {
      await createConnections();
      const callbackPort = await availablePort();
      callbackOrigin = `http://127.0.0.1:${callbackPort}`;
      hostWorkers = await startHost([
        hostAgentConfig(
          "cli-planner",
          plannerOkScript,
          "conn:planner-cli",
          await revisionHash("conn:planner-cli"),
        ),
        hostAgentConfig(
          "cli-verifier",
          verifierScript,
          "conn:verifier-cli",
          await revisionHash("conn:verifier-cli"),
        ),
        hostAgentConfig(
          "cli-worker-a",
          workerAScript,
          "conn:worker-a",
          await revisionHash("conn:worker-a"),
        ),
        hostAgentConfig(
          "cli-worker-b",
          workerBScript,
          "conn:worker-b",
          await revisionHash("conn:worker-b"),
        ),
      ]);
      await wireTransport(callbackPort);

      const { execution } = await seedRun("p2-history-frozen");

      // Drive until iteration 1's workers have executed (evidence lines are
      // the deterministic signal), then STOP driving.
      for (
        let pass = 0;
        pass < 60 && evidenceLines("worker-a").length === 0;
        pass++
      ) {
        await engine.reconcileExecution(execution.id);
        await outboxService.dispatchNext();
        await new Promise((resolve) => setTimeout(resolve, 120));
      }
      expect(evidenceLines("worker-a").length).toBeGreaterThanOrEqual(1);
      expect(evidenceLines("worker-b").length).toBeGreaterThanOrEqual(1);

      // The operator's model source catalog changes mid-run: the source is
      // deleted and its catalog can never be re-discovered. The FROZEN
      // run configuration (allowedTargets/step metadata) is unaffected.
      await dataSource.query(`DELETE FROM "model_sources"`);

      // The rest of the loop (iteration 2 included) executes with the exact
      // same frozen models.
      await driveToTerminal(execution.id, 60);
      const recovered = await coordinator.recoverRun(execution.id);
      expect(recovered.run.phase).toBe("ACCEPTED");

      const attempts = await dataSource.getRepository(StepAttemptEntity).find({
        where: { executionId: execution.id },
      });
      const steps = await dataSource.getRepository(LogicalStepEntity).find({
        where: { executionId: execution.id },
      });
      const logicalById = new Map(steps.map((step) => [step.id, step]));
      const modelsByStep = new Map<string, string>();
      for (const attempt of attempts) {
        const step = logicalById.get(attempt.logicalStepId);
        if (!step) continue;
        const requested = (attempt.executorSnapshot as any)?.requestedModelId;
        if (typeof requested === "string") {
          modelsByStep.set(step.stepId, requested);
        }
      }
      // Same model across both iterations, per step, forever.
      expect(modelsByStep.get("planner-1")).toBe(
        FROZEN_TARGETS.planner.modelId,
      );
      expect(modelsByStep.get("planner-2")).toBe(
        FROZEN_TARGETS.planner.modelId,
      );
      expect(modelsByStep.get("build-1")).toBe(FROZEN_TARGETS.workerA.modelId);
      expect(modelsByStep.get("build-2")).toBe(FROZEN_TARGETS.workerA.modelId);
      expect(modelsByStep.get("test-1")).toBe(FROZEN_TARGETS.workerB.modelId);
      expect(modelsByStep.get("test-2")).toBe(FROZEN_TARGETS.workerB.modelId);
      expect(modelsByStep.get("verify-1")).toBe(
        FROZEN_TARGETS.verifier.modelId,
      );
      expect(modelsByStep.get("verify-2")).toBe(
        FROZEN_TARGETS.verifier.modelId,
      );
    });

    it("retry reuses the SAME frozen model: a flaky worker's second attempt is not silently re-modeled", async () => {
      await connections.createConnection(
        "conn:planner-cli",
        cliConnection("conn:planner-cli", "Planner CLI", plannerOkScript),
      );
      await connections.createConnection(
        "conn:verifier-cli",
        cliConnection("conn:verifier-cli", "Verifier CLI", verifierScript),
      );
      await connections.createConnection(
        "conn:worker-a",
        cliConnection("conn:worker-a", "Flaky CLI", flakyScript),
      );
      const retryPlanner = writeScript(
        fixtureDir,
        "planner-retry.js",
        fakePlanner(path.join(evidenceDir, "planner.jsonl"), [
          {
            taskId: "flaky",
            agent: "cli-worker-a",
            connectionId: "conn:worker-a",
            modelId: FROZEN_TARGETS.workerA.modelId,
            retry: 1,
          },
        ]),
      );
      await connections.reviseConnection(
        "conn:planner-cli",
        cliConnection("conn:planner-cli", "Planner CLI v2", retryPlanner),
      );
      const callbackPort = await availablePort();
      callbackOrigin = `http://127.0.0.1:${callbackPort}`;
      hostWorkers = await startHost([
        hostAgentConfig(
          "cli-planner",
          retryPlanner,
          "conn:planner-cli",
          await revisionHash("conn:planner-cli"),
        ),
        hostAgentConfig(
          "cli-verifier",
          verifierScript,
          "conn:verifier-cli",
          await revisionHash("conn:verifier-cli"),
        ),
        hostAgentConfig(
          "cli-worker-a",
          flakyScript,
          "conn:worker-a",
          await revisionHash("conn:worker-a"),
        ),
      ]);
      await wireTransport(callbackPort);

      const { execution } = await seedRun("p2-retry-model", p2Config());
      await driveToTerminal(execution.id, 40);
      const recovered = await coordinator.recoverRun(execution.id);
      expect(recovered.run.phase).toBe("ACCEPTED");

      const steps = await dataSource.getRepository(LogicalStepEntity).find({
        where: { executionId: execution.id },
      });
      const flakyStep = steps.find((step) => step.stepId === "flaky-1")!;
      const attempts = await dataSource.getRepository(StepAttemptEntity).find({
        where: { logicalStepId: flakyStep.id },
        order: { attemptNumber: "ASC" },
      });
      expect(attempts).toHaveLength(2);
      expect(attempts[0].status).toBe("FAILED");
      expect(attempts[1].status).toBe("SUCCESS");
      // The retried attempt froze and executed the SAME requested model.
      expect((attempts[0].executorSnapshot as any)?.requestedModelId).toBe(
        FROZEN_TARGETS.workerA.modelId,
      );
      expect((attempts[1].executorSnapshot as any)?.requestedModelId).toBe(
        FROZEN_TARGETS.workerA.modelId,
      );
      expect(evidenceLines("flaky")).toHaveLength(2);
      for (const line of evidenceLines("flaky")) {
        expect(line.argv).toEqual([
          flakyScript,
          "--model",
          FROZEN_TARGETS.workerA.modelId,
        ]);
      }
    });
  },
);
