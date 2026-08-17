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
import { ConnectionRevisionEntity } from "./entities/connection-revision.entity";
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
import { AgentTransportConfigService, parseAgentTransportConfiguration } from "./agent-adapters/agent-transport-config.service";
import { HttpAgentAdapter } from "./agent-adapters/http-agent.adapter";
import { HttpAgentCallbackController } from "./agent-adapters/http-agent-callback.controller";
import type { ConnectionProfileV1 } from "./executors/runtime-connection";
import type { CoordinationConfigV1 } from "./domain/coordination";
import {
  startHostWorkers,
  type HostConfig,
} from "../../local-executor-host/src/main";

/**
 * M8-S6: CLI Runtime Connections executed through the REAL Local Executor
 * Host (services/local-executor-host): the host spawns DISTINCT
 * deterministic fake child programs (one per role) as real child processes
 * with the host's FIXED operator configuration, and the immutable
 * connection revision is authoritative for what runs.
 *
 * The fake children record exact command/argv/cwd/environment identity to
 * evidence files, and emit role payloads (Planner batch, Verifier decision,
 * Worker results) as structured JSON on stdout — parsed by the host and
 * delivered through the reviewed worker SDK's signed callbacks.
 *
 * Proven here: typed selection -> frozen revision -> host binding validation
 * -> exact child execution (identity evidence), structured results, signed
 * callback flow, Capsule provenance, fail-closed mismatch denial (stale
 * host binding never spawns), rotation (operator rebind executes the NEW
 * revision; the old frozen attempt never reroutes), revocation at batch
 * admission, and step retry of a flaky child.
 *
 * The static AGENT_TRANSPORT_CONFIG deliberately carries NO connectionId —
 * every attempt's frozen executor snapshot must therefore carry the
 * connection identity of the TASK that selected it.
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

let portOffset = 41000 + Math.floor(Math.random() * 5000);
const availablePort = async (): Promise<number> => {
  for (let i = 0; i < 100; i++) {
    const candidate = portOffset++;
    const ok = await new Promise<boolean>((resolve) => {
      const server = require("node:net").createServer();
      server.once("error", () => resolve(false));
      server.listen(candidate, "127.0.0.1", () => {
        server.close(() => resolve(true));
      });
    });
    if (ok) return candidate;
  }
  return 0;
};

const NODE = process.execPath;

/** A connection profile for a CLI runtime pinned to ONE fixed child program
 *  (the node executable + one fake-child script). The profile's
 *  command/argv/cwd/envAllowlist mirror EXACTLY what the host agent is
 *  operator-configured to run — the revision hash binds the two. */
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
    envAllowlist: { FAKE_MARKER: "HOST_FAKE_MARKER", EVIDENCE_DIR: "HOST_EVIDENCE_DIR" },
    probe: { args: ["-e", "console.log(1)"], expectsVersion: false },
  },
});

const teamConfig = (): CoordinationConfigV1 => ({
  schemaVersion: 1,
  planner: { kind: "connection", name: "conn:planner-cli", agent: "cli-planner" },
  verifier: { kind: "connection", name: "conn:verifier-cli", agent: "cli-verifier" },
  allowedWorkers: [
    { kind: "connection", name: "conn:worker-a", agent: "cli-worker-a" },
    { kind: "connection", name: "conn:worker-b", agent: "cli-worker-b" },
  ],
  maxIterations: 3,
  maxWorkersPerIteration: 4,
  maxTotalWorkers: 20,
  loopDeadlineMs: 3_600_000,
  delegationDepthMax: 2,
  allowedExecutors: ["local-host"],
});

describeWithPostgres(
  "M8-S6 CLI connections: typed selection -> frozen revision -> REAL local executor host child execution",
  () => {
    jest.setTimeout(240_000);

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
    let plannerScript: string;
    let verifierScript: string;
    let workerAScript: string;
    let workerBScript: string;
    let plannerRetryScript: string;
    let workerFlakyScript: string;
    let workerAV2Script: string;

    let hostWorkers: Awaited<ReturnType<typeof startHostWorkers>> = [];
    let callbackOrigin = "";
    const hostAddresses = new Map<string, { host: string; port: number }>();

    /** Fake child programs: each records exact argv/cwd/env identity to an
     *  evidence file and emits its role payload as structured JSON. */
    const fakePlanner = (evidenceFile: string): string => `
const fs = require("node:fs");
let raw = "";
process.stdin.on("data", (c) => (raw += c));
process.stdin.on("end", () => {
  const invocation = JSON.parse(raw);
  const n = invocation.input?.iterationNumber ?? 1;
  const baseRevision = invocation.input?.planRevision ?? 1;
  fs.appendFileSync(
    "${evidenceFile}",
    JSON.stringify({ invocationId: invocation.invocationId, role: "planner", argv: process.argv.slice(1), cwd: process.cwd(), marker: process.env.FAKE_MARKER }) + "\\n",
  );
  process.stdout.write(JSON.stringify({
    schemaVersion: 1,
    iterationNumber: n,
    baseRevision,
    tasks: [
      { taskId: "build-" + n, agent: "cli-worker-a", connectionId: "conn:worker-a", input: { module: "core" }, dependsOn: [], required: true, reason: "core build" },
      { taskId: "test-" + n, agent: "cli-worker-b", connectionId: "conn:worker-b", input: {}, dependsOn: ["build-" + n], required: true, reason: "tests" },
    ],
    reason: "iteration " + n + " plan",
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
    JSON.stringify({ invocationId: invocation.invocationId, role: "verifier", argv: process.argv.slice(1), cwd: process.cwd(), marker: process.env.FAKE_MARKER }) + "\\n",
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

    const fakeWorker = (evidenceFile: string, payload: string): string => `
const fs = require("node:fs");
let raw = "";
process.stdin.on("data", (c) => (raw += c));
process.stdin.on("end", () => {
  const invocation = JSON.parse(raw);
  fs.appendFileSync(
    "${evidenceFile}",
    JSON.stringify({ invocationId: invocation.invocationId, role: "${path.basename(evidenceFile, ".jsonl")}", argv: process.argv.slice(1), cwd: process.cwd(), marker: process.env.FAKE_MARKER, input: invocation.input ?? null }) + "\\n",
  );
  process.stdout.write(JSON.stringify(${payload}));
});
`;

    const fakeFlaky = (evidenceFile: string, counterFile: string): string => `
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
    JSON.stringify({ invocationId: invocation.invocationId, role: "flaky", argv: process.argv.slice(1), cwd: process.cwd(), marker: process.env.FAKE_MARKER }) + "\\n",
  );
  process.stdout.write(JSON.stringify({ built: true, attempt: count + 1 }));
});
`;

    const fakePlannerRetry = (evidenceFile: string): string => `
const fs = require("node:fs");
let raw = "";
process.stdin.on("data", (c) => (raw += c));
process.stdin.on("end", () => {
  const invocation = JSON.parse(raw);
  const n = invocation.input?.iterationNumber ?? 1;
  const baseRevision = invocation.input?.planRevision ?? 1;
  fs.appendFileSync(
    "${evidenceFile}",
    JSON.stringify({ invocationId: invocation.invocationId, role: "planner-retry", argv: process.argv.slice(1), cwd: process.cwd(), marker: process.env.FAKE_MARKER }) + "\\n",
  );
  process.stdout.write(JSON.stringify({
    schemaVersion: 1,
    iterationNumber: n,
    baseRevision,
    tasks: [
      { taskId: "flaky-" + n, agent: "cli-worker-c", connectionId: "conn:worker-c", input: {}, dependsOn: [], required: true, retry: 1, reason: "flaky once" },
    ],
    reason: "iteration " + n + " plan",
  }));
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
      callbackAuthentication: { keyId: "host-v1", secretEnv: "TEAM_CALLBACK_SECRET" },
      requestTimeoutMs: 10_000,
      maxResponseBytes: 64 * 1024,
      delegationModes: ["opaque"],
    });

    const hostAgentConfig = (
      agent: string,
      scriptPath: string,
      connectionId: string,
      configHash: string,
    ): NonNullable<HostConfig["agents"]>[number] => ({
      agent,
      command: NODE,
      args: [scriptPath],
      // parseHostConfig realpaths the cwd (allowedRoot check); mirror that
      // so the child's process.cwd() equals the frozen profile cwd.
      cwd: fs.realpathSync(fixtureDir),
      env: { FAKE_MARKER: "HOST_FAKE_MARKER", EVIDENCE_DIR: "HOST_EVIDENCE_DIR" },
      secrets: {},
      wallTimeMs: 30_000,
      maxStdoutBytes: 256 * 1024,
      maxStderrBytes: 64 * 1024,
      port: 0,
      bearerTokenEnv: "HOST_WORKER_TOKEN",
      connectionId,
      configHash,
      structuredResult: true,
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
        cliConnection("conn:planner-cli", "Planner CLI", plannerScript),
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

    const seedRun = async (name: string) => {
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
        teamConfig(),
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

    /** Per-test transport: callback app + adapter + engine + outbox, wired
     *  to the CURRENT host addresses. The signed callback path is the real
     *  HttpAgentCallbackController with HMAC verification. */
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
      // The execution service freezes the agent's routing profile at claim
      // time — it must be built per test against the CURRENT host wiring.
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
      await dataSource.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
      await dataSource.runMigrations();

      // Real fake-child fixture: one deterministic program per role.
      fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "tenvyr-m8-host-"));
      evidenceDir = path.join(fixtureDir, "evidence");
      fs.mkdirSync(evidenceDir, { recursive: true });
      // Host environment references resolved by the REAL host at spawn time.
      process.env.HOST_FAKE_MARKER = "identity-marker-1";
      process.env.HOST_EVIDENCE_DIR = evidenceDir;
      process.env.HOST_WORKER_TOKEN = "team-worker-token";
      const counterFile = path.join(fixtureDir, "flaky-counter");
      plannerScript = writeScript(fixtureDir, "planner.js", fakePlanner(path.join(evidenceDir, "planner.jsonl")));
      verifierScript = writeScript(fixtureDir, "verifier.js", fakeVerifier(path.join(evidenceDir, "verifier.jsonl")));
      workerAScript = writeScript(fixtureDir, "worker-a.js", fakeWorker(path.join(evidenceDir, "worker-a.jsonl"), `{ built: true, module: invocation.input?.taskInput?.module ?? invocation.input?.module ?? "" }`));
      workerBScript = writeScript(fixtureDir, "worker-b.js", fakeWorker(path.join(evidenceDir, "worker-b.jsonl"), `{ passed: 12 }`));
      plannerRetryScript = writeScript(fixtureDir, "planner-retry.js", fakePlannerRetry(path.join(evidenceDir, "planner-retry.jsonl")));
      workerFlakyScript = writeScript(fixtureDir, "worker-flaky.js", fakeFlaky(path.join(evidenceDir, "worker-flaky.jsonl"), counterFile));
      workerAV2Script = writeScript(fixtureDir, "worker-a-v2.js", fakeWorker(path.join(evidenceDir, "worker-a-v2.jsonl"), `{ built: true, module: (invocation.input?.taskInput?.module ?? invocation.input?.module ?? "") + "-v2" }`));

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
         "runtime_connections", "connection_revisions" CASCADE`,
      );
      for (const file of fs.readdirSync(evidenceDir)) {
        fs.rmSync(path.join(evidenceDir, file), { force: true });
      }
      fs.rmSync(path.join(fixtureDir, "flaky-counter"), { force: true });
    });

    it("executes distinct frozen fake child programs through the REAL local executor host with exact identity, structured results, signed callbacks, and Capsule provenance", async () => {
      await createConnections();
      const callbackPort = await availablePort();
      callbackOrigin = `http://127.0.0.1:${callbackPort}`;
      hostWorkers = await startHost([
        hostAgentConfig("cli-planner", plannerScript, "conn:planner-cli", await revisionHash("conn:planner-cli")),
        hostAgentConfig("cli-verifier", verifierScript, "conn:verifier-cli", await revisionHash("conn:verifier-cli")),
        hostAgentConfig("cli-worker-a", workerAScript, "conn:worker-a", await revisionHash("conn:worker-a")),
        hostAgentConfig("cli-worker-b", workerBScript, "conn:worker-b", await revisionHash("conn:worker-b")),
      ]);
      await wireTransport(callbackPort);

      const { execution } = await seedRun("m8-real-host");
      await driveToTerminal(execution.id);
      const recovered = await coordinator.recoverRun(execution.id);
      expect(recovered.run.phase).toBe("ACCEPTED");
      expect(recovered.run.currentIterationNumber).toBe(2);
      expect(recovered.run.cumulativeWorkers).toBe(4);

      // Exact identity of what the host ACTUALLY executed — the frozen
      // command/argv/cwd/env references, recorded by the children. Every
      // role ran ITS OWN program: argv = the frozen script per role, cwd and
      // env marker identical across roles.
      const roleScripts = new Map([
        ["planner", plannerScript],
        ["verifier", verifierScript],
        ["worker-a", workerAScript],
        ["worker-b", workerBScript],
      ]);
      const plannerEvidence = evidenceLines("planner");
      expect(plannerEvidence).toHaveLength(2);
      const verifierEvidence = evidenceLines("verifier");
      expect(verifierEvidence).toHaveLength(2);
      const workerAEvidence = evidenceLines("worker-a");
      expect(workerAEvidence).toHaveLength(2);
      expect((workerAEvidence[0].input as any).taskInput ?? workerAEvidence[0].input).toEqual({ module: "core" });
      expect((workerAEvidence[1].input as any).taskInput ?? workerAEvidence[1].input).toEqual({ module: "core" });
      expect(evidenceLines("worker-b")).toHaveLength(2);
      for (const [role, script] of roleScripts) {
        for (const line of evidenceLines(role)) {
          expect(line.argv).toEqual([script]);
          expect(line.cwd).toBe(fs.realpathSync(fixtureDir));
          expect(line.marker).toBe("identity-marker-1");
        }
      }
      // Distinct programs: each role's evidence file only ever holds its own
      // role entries.
      for (const line of [...plannerEvidence, ...verifierEvidence]) {
        expect(line.role).not.toBe("worker");
      }

      // Structured results: worker outputs are the parsed JSON, not stdout
      // wrappers.
      const attempts = await dataSource.getRepository(StepAttemptEntity).find({
        where: { executionId: execution.id },
      });
      const byStep = new Map<string, StepAttemptEntity>();
      const steps = await dataSource.getRepository(LogicalStepEntity).find({
        where: { executionId: execution.id },
      });
      const logicalById = new Map(steps.map((step) => [step.id, step]));
      for (const attempt of attempts) {
        const step = logicalById.get(attempt.logicalStepId);
        if (step) byStep.set(step.stepId, attempt);
      }
      expect((byStep.get("build-1")?.result as any)?.module).toBe("core");
      expect((byStep.get("build-2")?.result as any)?.module).toBe("core");
      expect((byStep.get("test-1")?.result as any)?.passed).toBe(12);
      expect((byStep.get("test-2")?.result as any)?.passed).toBe(12);
      expect((byStep.get("verify-2")?.result as any)?.action).toBe("ACCEPT");

      // Frozen identity on every attempt: connection reference + local CLI
      // profile, secret-free.
      const snapshot = (stepId: string) => {
        const attempt = byStep.get(stepId);
        if (!attempt) throw new Error(`missing attempt for step ${stepId}`);
        return (attempt.executorSnapshot ?? {}) as {
          connection?: { connectionId: string; revisionNumber: number; configHash: string };
          localProfile?: { command: string; args: string[]; cwd?: string; envAllowlist?: Record<string, string> };
        };
      };
      const planner = snapshot("planner-1");
      expect(planner.connection?.connectionId).toBe("conn:planner-cli");
      expect(planner.connection?.revisionNumber).toBe(1);
      expect(planner.localProfile).toMatchObject({
        command: NODE,
        args: [plannerScript],
        cwd: fixtureDir,
      });
      expect(planner.localProfile?.envAllowlist).toEqual({
        FAKE_MARKER: "HOST_FAKE_MARKER",
        EVIDENCE_DIR: "HOST_EVIDENCE_DIR",
      });
      expect(snapshot("verify-1").connection?.connectionId).toBe("conn:verifier-cli");
      expect(snapshot("build-1").connection?.connectionId).toBe("conn:worker-a");
      expect(snapshot("build-1").localProfile?.args).toEqual([workerAScript]);
      expect(snapshot("test-1").connection?.connectionId).toBe("conn:worker-b");
      expect(snapshot("test-1").localProfile?.args).toEqual([workerBScript]);
      const identities = ["planner-1", "verify-1", "build-1", "test-1"].map(
        (stepId) => snapshot(stepId).connection?.connectionId,
      );
      expect(new Set(identities).size).toBe(4);

      // Capsule provenance references the exact frozen revisions.
      const capsule = await capsules.build(execution.id);
      const capsuleAttempts = (capsule as any).attempts as Array<{
        stepId: string;
        executorSnapshot: {
          connection?: { connectionId: string; revisionNumber: number };
          localProfile?: { command: string; args: string[] };
        };
      }>;
      const capsuleByStep = new Map(
        capsuleAttempts.map((attempt) => [attempt.stepId, attempt]),
      );
      expect(capsuleByStep.get("planner-1")?.executorSnapshot.connection).toMatchObject({
        connectionId: "conn:planner-cli",
        revisionNumber: 1,
      });
      expect(capsuleByStep.get("build-1")?.executorSnapshot.localProfile?.args).toEqual([
        workerAScript,
      ]);
      expect(JSON.stringify(capsule)).not.toContain("sk-");
      expect(JSON.stringify(capsule)).not.toContain("identity-marker-1");
    });

    it("fails closed when the host's binding is stale: a frozen revision the host is not configured for NEVER spawns", async () => {
      await createConnections();
      const callbackPort = await availablePort();
      callbackOrigin = `http://127.0.0.1:${callbackPort}`;
      // Host binds worker-a to revision 1...
      hostWorkers = await startHost([
        hostAgentConfig("cli-planner", plannerScript, "conn:planner-cli", await revisionHash("conn:planner-cli")),
        hostAgentConfig("cli-verifier", verifierScript, "conn:verifier-cli", await revisionHash("conn:verifier-cli")),
        hostAgentConfig("cli-worker-a", workerAScript, "conn:worker-a", await revisionHash("conn:worker-a")),
        hostAgentConfig("cli-worker-b", workerBScript, "conn:worker-b", await revisionHash("conn:worker-b")),
      ]);
      await wireTransport(callbackPort);

      // ...but the operator rotates the connection to a NEW program.
      await connections.reviseConnection(
        "conn:worker-a",
        cliConnection("conn:worker-a", "Worker A CLI v2", workerAV2Script),
      );

      const { execution } = await seedRun("m8-stale-binding");
      await driveToTerminal(execution.id, 40);
      const recovered = await coordinator.recoverRun(execution.id);
      expect(recovered.run.phase).toBe("FAILED");

      // The mismatch is deterministic and recorded on the attempt.
      const attempts = await dataSource.getRepository(StepAttemptEntity).find({
        where: { executionId: execution.id },
      });
      const failureErrors = attempts
        .map((attempt) => attempt.error ?? attempt.terminationReason ?? "")
        .join(" ");
      expect(failureErrors).toContain("EXECUTOR_HOST_CONNECTION_MISMATCH");
      expect(failureErrors).toContain("configured for hash");

      // Fail closed means NEVER SPAWNED: the v2 child left no evidence and
      // the v1 child was not re-run either.
      expect(evidenceLines("worker-a-v2")).toHaveLength(0);
      expect(evidenceLines("worker-a")).toHaveLength(0);
      // The batch was admitted (the connection is claimable); the worker-a
      // ATTEMPT failed deterministically at the host without ever spawning.
      const steps = await dataSource.getRepository(LogicalStepEntity).find({
        where: { executionId: execution.id },
      });
      const stepIds = steps.map((step) => step.stepId).sort();
      expect(stepIds).toContain("build-1");
      const workerAStep = steps.find((step) => step.stepId === "build-1")!;
      expect(workerAStep.status).toBe("FAILED");
      const workerAAttempts = await dataSource
        .getRepository(StepAttemptEntity)
        .find({ where: { logicalStepId: workerAStep.id } });
      expect(workerAAttempts).toHaveLength(1);
      expect(workerAAttempts[0].status).toBe("FAILED");
      expect(workerAAttempts[0].error).toContain("EXECUTOR_HOST_CONNECTION_MISMATCH");
    });

    it("rotation: operator rebinds host + connection to a new revision — new attempts execute the NEW frozen program, the old attempt never reroutes", async () => {
      await createConnections();
      const callbackPort = await availablePort();
      callbackOrigin = `http://127.0.0.1:${callbackPort}`;
      hostWorkers = await startHost([
        hostAgentConfig("cli-planner", plannerScript, "conn:planner-cli", await revisionHash("conn:planner-cli")),
        hostAgentConfig("cli-verifier", verifierScript, "conn:verifier-cli", await revisionHash("conn:verifier-cli")),
        hostAgentConfig("cli-worker-a", workerAScript, "conn:worker-a", await revisionHash("conn:worker-a")),
        hostAgentConfig("cli-worker-b", workerBScript, "conn:worker-b", await revisionHash("conn:worker-b")),
      ]);
      await wireTransport(callbackPort);

      const { execution: firstExecution } = await seedRun("m8-rotation-1");
      await driveToTerminal(firstExecution.id);
      expect((await coordinator.recoverRun(firstExecution.id)).run.phase).toBe("ACCEPTED");
      expect(evidenceLines("worker-a")).toHaveLength(2);
      const firstRunAttempts = await dataSource.getRepository(StepAttemptEntity).find({
        where: { executionId: firstExecution.id },
      });
      expect((firstRunAttempts[0].executorSnapshot as any)?.connection?.revisionNumber).toBe(1);

      // Operator rotates the connection AND rebinds the host agent to the
      // new revision (the deployment-time pairing the config hash enforces).
      await connections.reviseConnection(
        "conn:worker-a",
        cliConnection("conn:worker-a", "Worker A CLI v2", workerAV2Script),
      );
      const v2Hash = await revisionHash("conn:worker-a");
      const revisions = await dataSource
        .getRepository(ConnectionRevisionEntity)
        .find({
          where: { connectionId: "conn:worker-a" },
          order: { revisionNumber: "ASC" },
        });
      expect(revisions.map((revision) => revision.revisionNumber)).toEqual([1, 2]);
      expect(v2Hash).not.toBe(revisions[0].configHash);

      const oldWorkerA = hostWorkers.find((entry) => entry.agent === "cli-worker-a")!;
      const oldPort = oldWorkerA.address.port;
      await oldWorkerA.stop();
      hostWorkers = hostWorkers.filter((entry) => entry.agent !== "cli-worker-a");
      hostWorkers = [
        ...hostWorkers,
        ...(await startHost([
          // Rebind on the SAME port so the already-wired transport stays
          // valid — only the binding (hash) and the executed program change.
          { ...hostAgentConfig("cli-worker-a", workerAV2Script, "conn:worker-a", v2Hash), port: oldPort },
        ])),
      ];

      const { execution: secondExecution } = await seedRun("m8-rotation-2");
      await driveToTerminal(secondExecution.id);
      expect((await coordinator.recoverRun(secondExecution.id)).run.phase).toBe("ACCEPTED");

      // The NEW revision executed the NEW program...
      const v2Evidence = evidenceLines("worker-a-v2");
      expect(v2Evidence).toHaveLength(2);
      expect(v2Evidence[0].argv).toEqual([workerAV2Script]);
      const attempts = await dataSource.getRepository(StepAttemptEntity).find({
        where: { executionId: secondExecution.id },
      });
      const steps = await dataSource.getRepository(LogicalStepEntity).find({
        where: { executionId: secondExecution.id },
      });
      const logicalById = new Map(steps.map((step) => [step.id, step]));
      const buildAttempts = attempts.filter((attempt) => {
        const step = logicalById.get(attempt.logicalStepId);
        return step?.stepId === "build-1" || step?.stepId === "build-2";
      });
      expect(buildAttempts).toHaveLength(2);
      for (const attempt of buildAttempts) {
        expect((attempt.executorSnapshot as any).connection?.revisionNumber).toBe(2);
      }
      expect((buildAttempts[0].result as any)?.module).toBe("core-v2");

      // ...and the FIRST run's frozen attempts still reference revision 1.
      const firstRunSteps = await dataSource.getRepository(LogicalStepEntity).find({
        where: { executionId: firstExecution.id },
      });
      const firstLogicalById = new Map(firstRunSteps.map((step) => [step.id, step]));
      for (const attempt of firstRunAttempts) {
        const step = firstLogicalById.get(attempt.logicalStepId);
        if (step?.stepId === "build-1" || step?.stepId === "build-2") {
          expect((attempt.executorSnapshot as any).connection?.revisionNumber).toBe(1);
        }
      }
    });

    it("a revoked worker connection denies a new team run at batch admission (zero partial materialization)", async () => {
      await createConnections();
      const callbackPort = await availablePort();
      callbackOrigin = `http://127.0.0.1:${callbackPort}`;
      hostWorkers = await startHost([
        hostAgentConfig("cli-planner", plannerScript, "conn:planner-cli", await revisionHash("conn:planner-cli")),
        hostAgentConfig("cli-verifier", verifierScript, "conn:verifier-cli", await revisionHash("conn:verifier-cli")),
        hostAgentConfig("cli-worker-a", workerAScript, "conn:worker-a", await revisionHash("conn:worker-a")),
        hostAgentConfig("cli-worker-b", workerBScript, "conn:worker-b", await revisionHash("conn:worker-b")),
      ]);
      await wireTransport(callbackPort);
      await connections.revokeConnection("conn:worker-b");

      const { execution } = await seedRun("m8-revoked");
      await driveToTerminal(execution.id, 30);
      const recovered = await coordinator.recoverRun(execution.id);
      expect(["FAILED", "PLANNING"]).toContain(recovered.run.phase);
      if (recovered.run.phase === "FAILED") {
        const steps = await dataSource.getRepository(LogicalStepEntity).find({
          where: { executionId: execution.id },
        });
        expect(steps.map((step) => step.stepId).sort()).toEqual(["planner-1"]);
      }
      // The planner ran exactly once (it produced the batch that was
      // rejected at admission); the revoked worker's host agent never ran.
      expect(evidenceLines("planner")).toHaveLength(1);
      expect(evidenceLines("worker-b")).toHaveLength(0);
    });

    it("retry: a flaky child that fails once completes via the frozen step retry policy with a structured result", async () => {
      await connections.createConnection(
        "conn:planner-cli",
        cliConnection("conn:planner-cli", "Planner CLI", plannerRetryScript),
      );
      await connections.createConnection(
        "conn:verifier-cli",
        cliConnection("conn:verifier-cli", "Verifier CLI", verifierScript),
      );
      await connections.createConnection(
        "conn:worker-c",
        cliConnection("conn:worker-c", "Flaky CLI", workerFlakyScript),
      );
      const retryConfig: CoordinationConfigV1 = {
        ...teamConfig(),
        planner: { kind: "connection", name: "conn:planner-cli", agent: "cli-planner" },
        verifier: { kind: "connection", name: "conn:verifier-cli", agent: "cli-verifier" },
        allowedWorkers: [
          { kind: "connection", name: "conn:worker-c", agent: "cli-worker-c" },
        ],
        allowedExecutors: ["local-host"],
      };
      const callbackPort = await availablePort();
      callbackOrigin = `http://127.0.0.1:${callbackPort}`;
      hostWorkers = await startHost([
        hostAgentConfig("cli-planner", plannerRetryScript, "conn:planner-cli", await revisionHash("conn:planner-cli")),
        hostAgentConfig("cli-verifier", verifierScript, "conn:verifier-cli", await revisionHash("conn:verifier-cli")),
        hostAgentConfig("cli-worker-c", workerFlakyScript, "conn:worker-c", await revisionHash("conn:worker-c")),
      ]);
      await wireTransport(callbackPort);

      const pipeline = await dataSource.getRepository(PipelineEntity).save(
        dataSource.getRepository(PipelineEntity).create({
          name: "m8-retry",
          version: "1.0",
          steps: [],
        }),
      );
      const execution = await executionService.createExecution(pipeline, {});
      await engine.reconcileExecution(execution.id);
      const run = await coordinator.startRun(
        execution.id,
        retryConfig,
        new Date(Date.now() + 3_600_000),
      );
      await coordinator.createNextIteration(run.id);
      await driveToTerminal(execution.id);
      const recovered = await coordinator.recoverRun(execution.id);
      expect(recovered.run.phase).toBe("ACCEPTED");
      expect(recovered.run.currentIterationNumber).toBe(2);

      // The flaky step ran TWICE: attempt 1 failed deterministically, the
      // frozen retry policy claimed attempt 2, which succeeded.
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
      expect(attempts[0].error).toContain("EXECUTOR_HOST_PROCESS_FAILED");
      expect(attempts[1].status).toBe("SUCCESS");
      expect((attempts[1].result as any)?.built).toBe(true);
      expect(evidenceLines("worker-flaky")).toHaveLength(2);
    });
  },
);
