import { DataSource, In, type DataSourceOptions } from "typeorm";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import type { AddressInfo } from "net";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { databaseOptions } from "./database/database.provider";
import { ExecutionEntity } from "./entities/execution.entity";
import { PipelineEntity } from "./entities/pipeline.entity";
import { LogicalStepEntity } from "./entities/step-execution.entity";
import { StepAttemptEntity } from "./entities/step-attempt.entity";
import { ExecutionPlanRevisionEntity } from "./entities/execution-plan-revision.entity";
import { DispatchOutboxEntity } from "./entities/dispatch-outbox.entity";
import { WorkspaceExecutionEntity } from "./entities/workspace-execution.entity";
import { HandoffEntity } from "./entities/handoff.entity";
import { CoordinationRunEntity } from "./entities/coordination-run.entity";
import { CoordinationIterationEntity } from "./entities/coordination-iteration.entity";
import { PlanProposalEntity } from "./entities/plan-proposal.entity";
import { RuntimeConnectionEntity } from "./entities/runtime-connection.entity";
import { ConnectionRevisionEntity } from "./entities/connection-revision.entity";
import { parseHandoffBundle } from "./domain/handoff";
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
import { WorkbenchCommandService } from "./services/workbench-command.service";
import { WorkbenchProjectionService } from "./services/workbench-projection.service";
import { WorkspaceExecutionService } from "./services/workspace-execution.service";
import { AttentionService } from "./services/attention.service";
import type { CoordinationConfigV1 } from "./domain/coordination";
import {
  startHostWorkers,
  type HostConfig,
} from "../../local-executor-host/src/main";

/**
 * PP1 Slice A dogfood — Pivot Invariant 1: workspace selection controls the
 * REAL execution location of every local coding-runtime child.
 *
 * Real disposable git repository A + REAL local executor host with three
 * deterministic fake coding-runtime children (Planner/Worker/Verifier, each
 * declaring requireExecutionWorkspace). A Team Run with
 * executionIsolation=git-worktree allocates Tenvyr-owned execution
 * workspace B (an isolated git worktree); every child spawns with cwd == B,
 * the Worker mutates B, source A stays byte-identical, planner-authored
 * input can never override cwd, and traversal/workspace-less invocations
 * fail closed BEFORE spawn. Capsule + Workbench preserve the execution
 * workspace identity and lifecycle. No provider credentials.
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

/** Real disposable git repository with one committed file. */
function initGitRepo(root: string): string {
  fs.mkdirSync(root, { recursive: true });
  const run = (args: string[]) =>
    spawnSync("git", args, {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Tenvyr PP1 Dogfood",
        GIT_AUTHOR_EMAIL: "pp1@tenvyr.local",
        GIT_COMMITTER_NAME: "Tenvyr PP1 Dogfood",
        GIT_COMMITTER_EMAIL: "pp1@tenvyr.local",
      },
    });
  fs.writeFileSync(path.join(root, "README.md"), "# PP1 source repo\n", "utf8");
  run(["init", "-b", "main"]);
  run(["add", "README.md"]);
  run(["commit", "-m", "initial"]);
  return run(["rev-parse", "HEAD"]).stdout.trim();
}

describeWithPostgres("PP1 Slice A: workspace execution + git-worktree isolation (real host, fake runtimes)", () => {
  jest.setTimeout(300_000);

  let fixtureDir: string;
  let sourceRepo: string;
  let sourceHeadSha: string;
  let evidenceDir: string;
  let executionRoot: string;
  let dataSource: DataSource;
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
  let workspaceExecutions: WorkspaceExecutionService;
  let attention: AttentionService;
  let sourceExecutionId = "";
  let hostWorkers: Awaited<ReturnType<typeof startHostWorkers>> = [];

  const fakePlannerChild = (evidenceFile: string): string => `
const fs = require("node:fs");
const path = require("node:path");
let raw = "";
process.stdin.on("data", (c) => (raw += c));
process.stdin.on("end", () => {
  const invocation = JSON.parse(raw);
  const input = invocation.input || {};
  if (typeof input.goal !== "string" || !input.goal) {
    process.stderr.write("Assertion failed: goal missing or empty\\n");
    process.exit(1);
  }
  if (input.role !== "planner") {
    process.stderr.write("Assertion failed: role is not planner\\n");
    process.exit(1);
  }
  if (input.outputContract?.schema !== "TaskBatchProposalV1") {
    process.stderr.write("Assertion failed: planner outputContract missing\\n");
    process.exit(1);
  }
  fs.appendFileSync(
    "${evidenceFile}",
    JSON.stringify({ invocationId: invocation.invocationId, role: "planner", argv: process.argv, cwd: process.cwd(), input }) + "\\n",
  );
  const n = input.iterationNumber || 1;
  const isContinuation = !!input.handoff;
  if (isContinuation) {
    if (!input.handoff.sourceRuntimeProvenance?.some((p) => p.connectionId === "conn:codex")) {
      process.stderr.write("Assertion failed: provenance does not contain conn:codex\\n");
      process.exit(1);
    }
  }
  const workerConn = isContinuation ? "conn:opencode" : "conn:codex";
  const modelId = isContinuation ? "claude-3-5-sonnet" : "gpt-4o";
  const payloadObj = {
    schemaVersion: 1,
    iterationNumber: n,
    baseRevision: input.planRevision || 1,
    tasks: [
      {
        taskId: "worker-task-" + n,
        agent: isContinuation ? "conn__opencode" : "conn__codex",
        connectionId: workerConn,
        modelId,
        input: { module: "core", cwd: "/etc" },
        dependsOn: [],
        required: true,
        reason: "worker iteration " + n,
      },
    ],
    reason: "plan iteration " + n,
  };
  process.stdout.write(JSON.stringify(payloadObj));
});
`;

  const fakeVerifierChild = (evidenceFile: string): string => `
const fs = require("node:fs");
const path = require("node:path");
let raw = "";
process.stdin.on("data", (c) => (raw += c));
process.stdin.on("end", () => {
  const invocation = JSON.parse(raw);
  const input = invocation.input || {};
  if (typeof input.goal !== "string" || !input.goal) {
    process.stderr.write("Assertion failed: goal missing or empty\\n");
    process.exit(1);
  }
  if (input.role !== "verifier") {
    process.stderr.write("Assertion failed: role is not verifier\\n");
    process.exit(1);
  }
  if (input.outputContract?.schema !== "VerifierDecisionV1" || !input.context) {
    process.stderr.write("Assertion failed: verifier outputContract or context missing\\n");
    process.exit(1);
  }
  fs.appendFileSync(
    "${evidenceFile}",
    JSON.stringify({ invocationId: invocation.invocationId, role: "verifier", argv: process.argv, cwd: process.cwd(), input }) + "\\n",
  );
  const n = input.iterationNumber || input.context?.iterationNumber || 1;
  const isOpencode = (input.context?.workers || []).some((w) => (w.selectedFields || {}).runtime === "opencode");
  const action = isOpencode ? "ACCEPT" : (n === 1 ? "CONTINUE" : "ACCEPT");
  const payloadObj = {
    schemaVersion: 1,
    iterationId: input.context?.iterationId || "iter-placeholder",
    iterationNumber: n,
    action,
    reason: "verifier pass " + n + " -> " + action,
    evidenceRefs: [],
  };
  process.stdout.write(JSON.stringify(payloadObj));
});
`;

  const fakeCodexWorkerChild = (evidenceFile: string): string => `
const fs = require("node:fs");
const path = require("node:path");
let raw = "";
process.stdin.on("data", (c) => (raw += c));
process.stdin.on("end", () => {
  const invocation = JSON.parse(raw);
  const input = invocation.input || {};
  if (typeof input.goal !== "string" || !input.goal) {
    process.stderr.write("Assertion failed: goal missing or empty\\n");
    process.exit(1);
  }
  if (input.role !== "worker") {
    process.stderr.write("Assertion failed: role is not worker\\n");
    process.exit(1);
  }
  if (!input.taskId || !input.executionWorkspace) {
    process.stderr.write("Assertion failed: worker taskId or executionWorkspace missing\\n");
    process.exit(1);
  }
  if (!process.argv.includes("--model") || !process.argv.includes("gpt-4o")) {
    process.stderr.write("Assertion failed: codex model argv missing (--model gpt-4o)\\n");
    process.exit(1);
  }
  fs.appendFileSync(
    "${evidenceFile}",
    JSON.stringify({ invocationId: invocation.invocationId, role: "worker", argv: process.argv, cwd: process.cwd(), input }) + "\\n",
  );
  fs.writeFileSync(path.join(process.cwd(), "pp1-worker-marker-" + invocation.invocationId.slice(0, 8) + ".txt"), "codex worker executed here\\n");
  const payloadObj = { built: true, cwd: process.cwd(), runtime: "codex" };

  process.stdout.write(JSON.stringify({ type: "thread.started", threadId: "th_codex" }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "turn.started", turnId: "t_1" }) + "\\n");
  process.stdout.write(JSON.stringify({
    type: "item.completed",
    item: {
      id: "msg_1",
      type: "agent_message",
      text: JSON.stringify(payloadObj),
    },
  }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "turn.completed", usage: { inputTokens: 50, outputTokens: 50 } }) + "\\n");
});
`;

  const fakeOpenCodeWorkerChild = (evidenceFile: string): string => `
const fs = require("node:fs");
const path = require("node:path");
let raw = "";
process.stdin.on("data", (c) => (raw += c));
process.stdin.on("end", () => {
  const invocation = JSON.parse(raw);
  const input = invocation.input || {};
  if (typeof input.goal !== "string" || !input.goal) {
    process.stderr.write("Assertion failed: goal missing or empty\\n");
    process.exit(1);
  }
  if (input.role !== "worker") {
    process.stderr.write("Assertion failed: role is not worker\\n");
    process.exit(1);
  }
  if (!input.taskId || !input.executionWorkspace) {
    process.stderr.write("Assertion failed: worker taskId or executionWorkspace missing\\n");
    process.exit(1);
  }
  if (!process.argv.includes("--model") || !process.argv.includes("claude-3-5-sonnet")) {
    process.stderr.write("Assertion failed: opencode model argv missing (--model claude-3-5-sonnet)\\n");
    process.exit(1);
  }
  fs.appendFileSync(
    "${evidenceFile}",
    JSON.stringify({ invocationId: invocation.invocationId, role: "worker", argv: process.argv, cwd: process.cwd(), input }) + "\\n",
  );
  fs.writeFileSync(path.join(process.cwd(), "pp1-continue-marker-" + invocation.invocationId.slice(0, 8) + ".txt"), "opencode worker executed here\\n");
  const payloadObj = { built: true, cwd: process.cwd(), runtime: "opencode" };

  process.stdout.write(JSON.stringify({ type: "step_start", timestamp: 1700000000, sessionID: "s_1" }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "tool_use", timestamp: 1700000001, sessionID: "s_1", tool: "bash" }) + "\\n");
  process.stdout.write(JSON.stringify({
    type: "text",
    timestamp: 1700000002,
    sessionID: "s_1",
    part: {
      type: "text",
      text: JSON.stringify(payloadObj),
    },
  }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "step_finish", timestamp: 1700000003, sessionID: "s_1" }) + "\\n");
});
`;

  const continuationConfig = (): CoordinationConfigV1 => ({
    schemaVersion: 1,
    planner: { kind: "connection", name: "conn:planner", agent: "conn__planner" },
    verifier: { kind: "connection", name: "conn:verifier", agent: "conn__verifier" },
    allowedWorkers: [{ kind: "connection", name: "conn:opencode", agent: "conn__opencode" }],
    allowedTargets: [
      { connectionId: "conn:opencode", modelId: "claude-3-5-sonnet" },
    ],
    maxIterations: 3,
    maxWorkersPerIteration: 2,
    maxTotalWorkers: 8,
    loopDeadlineMs: 3_600_000,
    delegationDepthMax: 2,
    allowedExecutors: [
      "local-host",
      "conn:planner",
      "conn__planner",
      "conn:verifier",
      "conn__verifier",
      "conn:opencode",
      "conn__opencode",
    ],
  });

  const teamConfig = (): CoordinationConfigV1 => ({
    schemaVersion: 1,
    planner: { kind: "connection", name: "conn:planner", agent: "conn__planner" },
    verifier: { kind: "connection", name: "conn:verifier", agent: "conn__verifier" },
    allowedWorkers: [{ kind: "connection", name: "conn:codex", agent: "conn__codex" }],
    allowedTargets: [
      { connectionId: "conn:codex", modelId: "gpt-4o" },
    ],
    maxIterations: 3,
    maxWorkersPerIteration: 2,
    maxTotalWorkers: 8,
    loopDeadlineMs: 3_600_000,
    delegationDepthMax: 2,
    allowedExecutors: [
      "local-host",
      "conn:planner",
      "conn__planner",
      "conn:verifier",
      "conn__verifier",
      "conn:codex",
      "conn__codex",
    ],
  });

  beforeAll(async () => {
    try {
      assertDisposableTarget(TEST_DATABASE_URL);
      fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "tenvyr-pp1-dogfood-"));
      sourceRepo = path.join(fixtureDir, "source");
      sourceHeadSha = initGitRepo(sourceRepo);
      sourceRepo = fs.realpathSync(sourceRepo);
      evidenceDir = path.join(fixtureDir, "evidence");
      fs.mkdirSync(evidenceDir, { recursive: true });
      executionRoot = path.join(fixtureDir, "execution-workspaces");
      process.env.TENVYR_WORKSPACE_ROOT = executionRoot;

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

      const dynamicHostPort = await availablePort();
      const hostBearerToken = "ephemeral-host-bearer-token";
      const callbackSecret = "ephemeral-callback-secret";

      process.env.EXECUTOR_HOST_BEARER_TOKEN = hostBearerToken;
      process.env.HTTP_AGENT_BEARER_TOKEN = hostBearerToken;
      process.env.HTTP_AGENT_CALLBACK_SECRET = callbackSecret;
      process.env.LOOPBACK_CALLBACK_SECRET = callbackSecret;
      process.env.LOCAL_EXECUTOR_HOST_URL = `http://127.0.0.1:${dynamicHostPort}/v1/runs`;
      process.env.EXECUTOR_HOST_URL = `http://127.0.0.1:${dynamicHostPort}/v1/runs`;
      process.env.HTTP_AGENT_CALLBACK_BASE_URL = callbackOrigin;
      process.env.HTTP_AGENT_ALLOW_INSECURE = "true";

      const scripts: Record<string, string> = {};
      scripts.planner = writeScript(
        evidenceDir,
        "planner.js",
        fakePlannerChild(path.join(evidenceDir, "planner.jsonl")),
      );
      scripts.verifier = writeScript(
        evidenceDir,
        "verifier.js",
        fakeVerifierChild(path.join(evidenceDir, "verifier.jsonl")),
      );
      scripts.codex = writeScript(
        evidenceDir,
        "codex.js",
        fakeCodexWorkerChild(path.join(evidenceDir, "codex.jsonl")),
      );
      scripts.opencode = writeScript(
        evidenceDir,
        "opencode.js",
        fakeOpenCodeWorkerChild(path.join(evidenceDir, "opencode.jsonl")),
      );

      const connService = new RuntimeConnectionService(dataSource);
      await connService.createConnection("conn:planner", {
        name: "Planner Runtime",
        runtimeKind: "generic-cli",
        executorId: "local-host",
        credentialRefs: [],
        declaredCapabilities: {
          invocation: { supported: true, source: "configured" },
        },
        cli: {
          command: process.execPath,
          args: [scripts.planner],
          probe: { args: ["--version"] },
        },
      });
      await dataSource.getRepository(RuntimeConnectionEntity).update(
        { connectionId: "conn:planner" },
        { statusState: "AVAILABLE", statusReasonCode: "none" },
      );

      await connService.createConnection("conn:verifier", {
        name: "Verifier Runtime",
        runtimeKind: "generic-cli",
        executorId: "local-host",
        credentialRefs: [],
        declaredCapabilities: {
          invocation: { supported: true, source: "configured" },
        },
        cli: {
          command: process.execPath,
          args: [scripts.verifier],
          probe: { args: ["--version"] },
        },
      });
      await dataSource.getRepository(RuntimeConnectionEntity).update(
        { connectionId: "conn:verifier" },
        { statusState: "AVAILABLE", statusReasonCode: "none" },
      );

      await connService.createConnection("conn:codex", {
        name: "Codex Runtime",
        runtimeKind: "codex",
        executorId: "local-host",
        credentialRefs: [],
        declaredCapabilities: {
          invocation: { supported: true, source: "configured" },
        },
        cli: {
          command: process.execPath,
          args: [scripts.codex],
          modelArgvPrefix: ["--model"],
          probe: { args: ["--version"] },
        },
      });
      await dataSource.getRepository(RuntimeConnectionEntity).update(
        { connectionId: "conn:codex" },
        { statusState: "AVAILABLE", statusReasonCode: "none" },
      );

      await connService.createConnection("conn:opencode", {
        name: "OpenCode Runtime",
        runtimeKind: "opencode",
        executorId: "local-host",
        credentialRefs: [],
        declaredCapabilities: {
          invocation: { supported: true, source: "configured" },
        },
        cli: {
          command: process.execPath,
          args: [scripts.opencode],
          modelArgvPrefix: ["--model"],
          probe: { args: ["--version"] },
        },
      });
      await dataSource.getRepository(RuntimeConnectionEntity).update(
        { connectionId: "conn:opencode" },
        { statusState: "AVAILABLE", statusReasonCode: "none" },
      );

      const hostConfig: HostConfig = {
        agents: [], // Pure Dynamic Bridge: NO static agents!
        allowedRoot: fixtureDir,
        stateDir: path.join(fixtureDir, "state"),
        callbackAllowedOrigins: [callbackOrigin],
        callbackKeys: {
          "host-callback-v1": callbackSecret,
          "host-v1": callbackSecret,
        },
        callbackAllowInsecure: true,
        port: dynamicHostPort,
        bearerTokenEnv: "EXECUTOR_HOST_BEARER_TOKEN",
      };

      hostWorkers = await startHostWorkers(hostConfig);

      const config = new AgentTransportConfigService(
        parseAgentTransportConfiguration({
          // NO AGENT_TRANSPORT_CONFIG!
          HTTP_AGENT_CALLBACK_BASE_URL: callbackOrigin,
          HTTP_AGENT_ALLOW_INSECURE: "true",
          EXECUTOR_HOST_BEARER_TOKEN: hostBearerToken,
          HTTP_AGENT_CALLBACK_SECRET: callbackSecret,
          LOCAL_EXECUTOR_HOST_URL: `http://127.0.0.1:${dynamicHostPort}/v1/runs`,
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
    workspaceExecutions = new WorkspaceExecutionService(dataSource);
    attention = new AttentionService(dataSource);
    const mockProviderDiscovery = {
      discoverRuntimeProviders: async (connId: string) => ({
        connectionId: connId,
        revisionNumber: 1,
        runtimeKind: "generic-cli",
        providers: [],
      }),
    } as any;
    commands = new WorkbenchCommandService(
      dataSource as any,
      executionService,
      coordinator,
      capsules,
      undefined,
      undefined,
      undefined,
      mockProviderDiscovery,
      workspaceExecutions,
    );
    projection = new WorkbenchProjectionService(dataSource as any);
    } catch (err) {
      console.error("beforeAll failed:", err);
      throw err;
    }
  });

  afterAll(async () => {
    delete process.env.TENVYR_WORKSPACE_ROOT;
    delete process.env.HOST_TOKEN_1;
    delete process.env.TEAM_CALLBACK_SECRET;
    await adapter?.stop();
    await app?.close();
    for (const worker of hostWorkers) {
      await worker.stop();
    }
    await dataSource?.destroy();
    try {
      fs.rmSync(fixtureDir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  });

  const runToTerminal = async (executionId: string) => {
    const terminal = async () => {
      const execution = await dataSource
        .getRepository(ExecutionEntity)
        .findOne({ where: { id: executionId } });
      return execution
        ? ["COMPLETED", "FAILED", "CANCELLED"].includes(execution.status)
        : true;
    };
    for (let pass = 0; pass < 80 && !(await terminal()); pass += 1) {
      await engine.reconcileExecution(executionId);
      await outboxService.dispatchNext();
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
    await engine.reconcileExecution(executionId);
  };

  it("binds every runtime child to the isolated execution worktree and proves the pivot invariants end-to-end", async () => {
    // 1. Launch the Team Run with git-worktree isolation over source A.
    const launched = await commands.startTeamRun({
      idempotencyKey: "pp1-slice-a-run-1",
      name: "pp1-isolation",
      goal: "Isolated team run over the source workspace.",
      config: teamConfig(),
      workspace: { path: sourceRepo },
      executionIsolation: "git-worktree",
    });
    const executionId = String(launched.result.executionId);
    sourceExecutionId = executionId;
    const runId = String(launched.result.runId);
    const executionWorkspace = launched.result.executionWorkspace as {
      workspaceExecutionId: string;
      mode: string;
      path: string;
      baseHeadSha: string | null;
    };
    expect(executionWorkspace.mode).toBe("git-worktree");
    expect(executionWorkspace.baseHeadSha).toBe(sourceHeadSha);
    const B = executionWorkspace.path;
    expect(B).not.toBe(sourceRepo);
    expect(fs.existsSync(path.join(B, "README.md"))).toBe(true);

    // The durable lease row exists: source identity, base, exclusive owner.
    const lease = await dataSource
      .getRepository(WorkspaceExecutionEntity)
      .findOneOrFail({ where: { id: executionWorkspace.workspaceExecutionId } });
    expect(lease.mode).toBe("git-worktree");
    expect(lease.sourcePath).toBe(sourceRepo);
    expect(lease.baseHeadSha).toBe(sourceHeadSha);
    expect(lease.ownerRunId).toBe(runId);
    expect(lease.state).toBe("IN_USE");

    const accepted = async () =>
      (await coordinator.recoverRun(executionId)).run.phase === "ACCEPTED";
    for (let pass = 0; pass < 100 && !(await accepted()); pass += 1) {
      await engine.reconcileExecution(executionId);
      await outboxService.dispatchNext();
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    const recovered = await coordinator.recoverRun(executionId);
    expect(recovered.run.phase).toBe("ACCEPTED");
    expect(recovered.run.currentIterationNumber).toBe(2);

    // 3. Every child executed with cwd == B (planner-authored cwd fields in
    //    task input could NOT override Tenvyr authority).
    const readEvidence = (name: string): Array<Record<string, unknown>> =>
      fs
        .readFileSync(path.join(evidenceDir, name), "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    const plannerEvidence = readEvidence("planner.jsonl");
    const codexEvidence = readEvidence("codex.jsonl");
    const verifierEvidence = readEvidence("verifier.jsonl");
    expect(plannerEvidence.length).toBeGreaterThanOrEqual(1);
    expect(codexEvidence.length).toBe(2); // one worker per iteration
    expect(verifierEvidence.length).toBe(2);
    for (const entry of [...plannerEvidence, ...codexEvidence, ...verifierEvidence]) {
      expect(entry.cwd).toBe(B);
      expect((entry.input as Record<string, unknown>).goal).toContain("Isolated team run");
    }
    for (const entry of codexEvidence) {
      const input = (entry.input as Record<string, unknown>).taskInput as Record<string, unknown>;
      expect(input?.cwd).toBe("/etc");
    }

    // 4. The Worker mutation landed in B; source A stayed unchanged.
    const markers = fs
      .readdirSync(B)
      .filter((name) => name.startsWith("pp1-worker-marker-"));
    expect(markers.length).toBe(2);
    expect(
      fs.readdirSync(sourceRepo).some((name) => name.startsWith("pp1-worker-marker-")),
    ).toBe(false);
    const sourceStatus = spawnSync(
      "git",
      ["status", "--porcelain"],
      { cwd: sourceRepo, encoding: "utf8" },
    );
    expect(sourceStatus.stdout.trim()).toBe("");
    const sourceHead = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: sourceRepo,
      encoding: "utf8",
    });
    expect(sourceHead.stdout.trim()).toBe(sourceHeadSha);

    // 5. Every dispatched invocation carried the reserved Tenvyr member.
    const attempts = await dataSource
      .getRepository(StepAttemptEntity)
      .find({ where: { executionId } });
    const outbox = await dataSource
      .getRepository(DispatchOutboxEntity)
      .find({ where: { stepAttemptId: In(attempts.map((a) => a.id)) } });
    expect(outbox.length).toBeGreaterThanOrEqual(4);
    for (const row of outbox) {
      const invocation = row.invocation as {
        metadata?: { tenvyr?: { executionWorkspace?: { path?: string; mode?: string } } };
      };
      const member = invocation.metadata?.tenvyr?.executionWorkspace;
      expect(member?.path).toBe(B);
      expect(member?.mode).toBe("git-worktree");
    }

    // 6. Terminal lifecycle: engine moves the lease to PRESERVED upon terminal completion
    //    without requiring manual background reconciliation.
    const preserved = await dataSource
      .getRepository(WorkspaceExecutionEntity)
      .findOneOrFail({ where: { id: lease.id } });
    expect(preserved.state).toBe("PRESERVED");
    expect(preserved.hasUncommittedWork).toBe(true);

    // Verify model target argv reached Codex runtime CLI:
    expect(codexEvidence[0].argv).toEqual(
      expect.arrayContaining(["--model", "gpt-4o"]),
    );

    // 7. Capsule + Workbench preserve the execution workspace identity.
    const capsule = await capsules.build(executionId);
    const capsuleWorkspace = (capsule.coordination as any).run.executionWorkspace;
    expect(capsuleWorkspace.path).toBe(B);
    expect(capsuleWorkspace.mode).toBe("git-worktree");
    expect(capsuleWorkspace.baseHeadSha).toBe(sourceHeadSha);
    expect(capsuleWorkspace.state).toBe("PRESERVED");
    expect(capsuleWorkspace.hasUncommittedWork).toBe(true);

    const projected = await projection.executionProjection(executionId);
    const projectedWorkspace = (projected.coordination as any).run.executionWorkspace;
    expect(projectedWorkspace.path).toBe(B);
    expect(projectedWorkspace.mode).toBe("git-worktree");
    expect(projectedWorkspace.state).toBe("PRESERVED");

    // 8. PP1 Slice B: the preserved dirty worktree surfaces as ONE
    //    deterministic WORKSPACE_REQUIRES_ATTENTION item (read projection).
    const attentionView = await attention.attention();
    const workspaceItems = attentionView.items.filter(
      (item) => item.kind === "WORKSPACE_REQUIRES_ATTENTION",
    );
    expect(workspaceItems).toHaveLength(1);
    expect(workspaceItems[0].workspaceExecutionId).toBe(lease.id);
    expect(workspaceItems[0].actionRoute).toBe(`/runs/${executionId}`);
    // Polling repeatedly does not duplicate items.
    const again = await attention.attention();
    expect(
      again.items.filter((item) => item.kind === "WORKSPACE_REQUIRES_ATTENTION"),
    ).toHaveLength(1);
  }, 300_000);

  it("fails closed: workspace-less invocations and path traversal never spawn", async () => {
    // (a) A non-coordinated pipeline claim carries NO execution-workspace
    // member; dynamic executor host requires one → refusal before spawn.
    const pipeline = await dataSource.getRepository(PipelineEntity).save(
      dataSource.getRepository(PipelineEntity).create({
        name: "pp1-plain",
        version: "1.0",
        steps: [{ id: "plain", agent: "conn__planner" }] as any[],
      }),
    );
    const execution = await executionService.createExecution(pipeline, {
      goal: "plain",
    });
    await runToTerminal(execution.id);
    const plainAttempt = await dataSource
      .getRepository(StepAttemptEntity)
      .findOneOrFail({ where: { executionId: execution.id } });
    expect(plainAttempt.status).toBe("FAILED");
    expect(plainAttempt.error).toContain(
      "EXECUTOR_HOST_CONNECTION_REQUIRED",
    );

    // (b) A tampered reserved member escaping the allowed root is refused
    // BEFORE spawn: claim the Planner (outbox row created), forge the
    // member's path, then dispatch.
    const launched = await commands.startTeamRun({
      idempotencyKey: "pp1-slice-a-run-2",
      name: "pp1-tamper",
      goal: "Traversal must fail closed.",
      config: teamConfig(),
      workspace: { path: sourceRepo },
      executionIsolation: "git-worktree",
    });
    const tamperedExecutionId = String(launched.result.executionId);
    await executionService.reconcileExecution(tamperedExecutionId);
    await executionService.reconcileCoordination(tamperedExecutionId);
    await executionService.reconcileExecution(tamperedExecutionId);
    const tamperedExecution = await dataSource
      .getRepository(ExecutionEntity)
      .findOneOrFail({ where: { id: tamperedExecutionId } });
    const revision = await dataSource
      .getRepository(ExecutionPlanRevisionEntity)
      .findOneOrFail({ where: { id: tamperedExecution.activePlanRevisionId } });
    const plannerStep = (revision.plan.steps as Array<{ id: string; agent: string }>).find(
      (step) => step.id.startsWith("planner-"),
    )!;
    const claim = await executionService.claimRunnableStep(
      tamperedExecutionId,
      plannerStep as never,
      { iterationNumber: 1, planRevision: 1 },
      1,
    );
    expect(claim?.disposition).toBe("claimed");
    const claimedAttempt = (claim as { attempt: StepAttemptEntity }).attempt;
    const outbox = await dataSource
      .getRepository(DispatchOutboxEntity)
      .findOneOrFail({ where: { stepAttemptId: claimedAttempt.id } });
    // An EXISTING directory outside the allowlisted root (path traversal).
    const forgedPath = path.dirname(fixtureDir);
    expect(fs.existsSync(forgedPath)).toBe(true);
    const invocation = outbox.invocation as unknown as {
      metadata: { tenvyr: { executionWorkspace: { path: string } } };
    };
    expect(invocation.metadata.tenvyr.executionWorkspace.path).not.toBe(
      forgedPath,
    );
    invocation.metadata.tenvyr.executionWorkspace.path = forgedPath;
    await dataSource.getRepository(DispatchOutboxEntity).update(outbox.id, {
      invocation: invocation as unknown as Record<string, unknown>,
    });
    await outboxService.dispatchNext();
    await new Promise((resolve) => setTimeout(resolve, 500));
    const refusedAttempt = await dataSource
      .getRepository(StepAttemptEntity)
      .findOneOrFail({ where: { id: claimedAttempt.id } });
    expect(refusedAttempt.status).toBe("FAILED");
    expect(refusedAttempt.error).toContain(
      "EXECUTOR_HOST_WORKSPACE_PATH_INVALID",
    );
    expect(refusedAttempt.error).toContain("outside the allowlisted root");
  }, 300_000);

  it("handoff vertical: terminal run -> HandoffBundle -> continuation on a DIFFERENT runtime -> exclusive worktree transfer -> truthful lineage", async () => {
    const source = sourceExecutionId;
    expect(source).not.toBe("");
    const sourceRun = await dataSource
      .getRepository(CoordinationRunEntity)
      .findOneOrFail({ where: { executionId: source } });
    const sourceLease = await dataSource
      .getRepository(WorkspaceExecutionEntity)
      .findOneOrFail({ where: { ownerRunId: sourceRun.id } });
    const B = sourceLease.executionPath!;
    const run1MarkersBefore = fs
      .readdirSync(B)
      .filter((name) => name.startsWith("pp1-worker-marker-"));
    expect(run1MarkersBefore.length).toBe(2);

    // (a) Non-terminal sources fail closed BEFORE any authority mutation.
    const liveRun = await commands.startTeamRun({
      idempotencyKey: "pp1-slice-a-live",
      name: "pp1-live",
      goal: "Live run for the non-terminal refusal.",
      config: teamConfig(),
      workspace: { path: sourceRepo },
      executionIsolation: "git-worktree",
    });
    const liveExecutionId = String(liveRun.result.executionId);
    await expect(
      commands.continueRun({
        idempotencyKey: "pp1-continue-live",
        sourceExecutionId: liveExecutionId,
        config: continuationConfig(),
      }),
    ).rejects.toMatchObject({ code: "SOURCE_NOT_TERMINAL" });
    void liveExecutionId;

    // (b) Continue the TERMINAL run on the OTHER runtime connection (conn:opencode).
    const continued = await commands.continueRun({
      idempotencyKey: "pp1-continue-1",
      sourceExecutionId: source,
      config: continuationConfig(),
    });
    const destinationExecutionId = String(continued.result.executionId);
    const destinationRunId = String(continued.result.runId);
    const bundleHash = String(continued.result.bundleHash);
    expect(bundleHash).toMatch(/^[0-9a-f]{64}$/);
    expect(destinationExecutionId).not.toBe(source);

    // The handoff lineage row is durable + strictly parsed.
    const handoff = await dataSource
      .getRepository(HandoffEntity)
      .findOneOrFail({ where: { sourceExecutionId: source } });
    expect(handoff.destinationExecutionId).toBe(destinationExecutionId);
    expect(handoff.bundleHash).toBe(bundleHash);
    const bundle = parseHandoffBundle(handoff.bundle);
    expect(bundle.goal).toContain("Isolated team run");
    expect(bundle.verifierDecision?.action).toBe("ACCEPT");
    expect(bundle.executionWorkspace?.path).toBe(B);
    expect(bundle.sourceRuntimeProvenance.some((p) => p.connectionId === "conn:codex")).toBe(
      true,
    );

    // Exclusive ownership: the source lease keeps its identity as
    // TRANSFERRED; the destination owns a NEW lease on the SAME worktree.
    const transferredSource = await dataSource
      .getRepository(WorkspaceExecutionEntity)
      .findOneOrFail({ where: { id: sourceLease.id } });
    expect(transferredSource.state).toBe("TRANSFERRED");
    const destinationLease = await dataSource
      .getRepository(WorkspaceExecutionEntity)
      .findOneOrFail({ where: { ownerRunId: destinationRunId } });
    expect(destinationLease.executionPath).toBe(B);
    expect(destinationLease.mode).toBe("git-worktree");

    // (c) Drive the continuation to ACCEPTED through conn:opencode.
    const accepted = async () =>
      (await coordinator.recoverRun(destinationExecutionId)).run.phase ===
      "ACCEPTED";
    for (let pass = 0; pass < 100 && !(await accepted()); pass += 1) {
      await engine.reconcileExecution(destinationExecutionId);
      await outboxService.dispatchNext();
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    expect(
      (await coordinator.recoverRun(destinationExecutionId)).run.phase,
    ).toBe("ACCEPTED");

    // The continuation worker executed in the SAME preserved worktree.
    const opencodeEvidence = fs
      .readFileSync(path.join(evidenceDir, "opencode.jsonl"), "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const opencodeWorkers = opencodeEvidence.filter((e) => e.role === "worker");
    expect(opencodeWorkers.length).toBe(1);
    for (const entry of opencodeWorkers) {
      expect(entry.cwd).toBe(B);
      expect((entry.input as any).goal).toContain("Isolated team run");
      expect((entry.input as any).role).toBe("worker");
    }
    // Verify model target argv reached OpenCode runtime CLI:
    expect(opencodeWorkers[0].argv).toEqual(
      expect.arrayContaining(["--model", "claude-3-5-sonnet"]),
    );
    const continueMarkers = fs
      .readdirSync(B)
      .filter((name) => name.startsWith("pp1-continue-marker-"));
    expect(continueMarkers.length).toBe(1);
    // Run 1's uncommitted work was PRESERVED through the transfer.
    for (const marker of run1MarkersBefore) {
      expect(fs.existsSync(path.join(B, marker))).toBe(true);
    }
    // Source repo A is still untouched.
    const sourceStatus = spawnSync("git", ["status", "--porcelain"], {
      cwd: sourceRepo,
      encoding: "utf8",
    });
    expect(sourceStatus.stdout.trim()).toBe("");

    // (d) Truthful lineage: source Capsule unchanged (still shows its
    //     TRANSFERRED lease), destination Capsule records the handoff.
    const sourceCapsule = await capsules.build(source);
    expect(
      (sourceCapsule.coordination as any).run.executionWorkspace.state,
    ).toBe("TRANSFERRED");
    const destinationCapsule = await capsules.build(destinationExecutionId);
    expect(
      (destinationCapsule.coordination as any).run.handoff.sourceExecutionId,
    ).toBe(source);
    expect(
      (destinationCapsule.coordination as any).run.handoff.bundleHash,
    ).toBe(bundleHash);
    expect(
      (destinationCapsule.coordination as any).run.executionWorkspace.path,
    ).toBe(B);
  }, 300_000);
});

function writeScript(dir: string, name: string, content: string): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, content, "utf8");
  return file;
}