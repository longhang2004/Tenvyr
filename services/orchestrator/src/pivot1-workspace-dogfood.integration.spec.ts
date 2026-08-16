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
import { parseHandoffBundle } from "./domain/handoff";
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

  /** Fake children record cwd + write a marker into their cwd (Worker only)
   *  and emit role payloads as structured JSON on stdout. */
  const fakeChild = (
    role: "planner" | "worker" | "verifier",
    evidenceFile: string,
    markerName = "pp1-worker-marker-",
  ): string => {
    const markerWrite =
      role === "worker"
        ? `fs.writeFileSync(path.join(process.cwd(), "${markerName}" + invocation.invocationId.slice(0, 8) + ".txt"), "worker executed here\\n");`
        : "";
    const payload =
      role === "planner"
        ? `JSON.stringify({ schemaVersion: 1, iterationNumber: n, baseRevision: invocation.input?.planRevision ?? 1, tasks: [ { taskId: "impl-" + n, agent: (process.env.FAKE_WORKER_AGENT || "cli-worker"), input: { module: "core", cwd: "/etc", evilCwd: "/tmp" }, dependsOn: [], required: true, reason: "core" } ], reason: "iteration " + n })`
        : role === "worker"
          ? `JSON.stringify({ built: true, cwd: process.cwd() })`
          : `JSON.stringify({ schemaVersion: 1, iterationId: ctx.iterationId ?? "placeholder", iterationNumber: n, action: n === 1 ? "CONTINUE" : "ACCEPT", reason: "deterministic", evidenceRefs: [] })`;
    const ctxLine =
      role === "verifier" ? `const ctx = invocation.input?.context ?? {};` : "";
    const nLine =
      role === "planner"
        ? `const n = invocation.input?.iterationNumber ?? 1;`
        : `const n = ${role === "verifier" ? "ctx.iterationNumber ?? 1" : "invocation.input?.iterationNumber ?? 1"};`;
    return `
const fs = require("node:fs");
const path = require("node:path");
let raw = "";
process.stdin.on("data", (c) => (raw += c));
process.stdin.on("end", () => {
  const invocation = JSON.parse(raw);
  ${ctxLine}
  ${nLine}
  fs.appendFileSync(
    "${evidenceFile}",
    JSON.stringify({ invocationId: invocation.invocationId, role: "${role}", cwd: process.cwd(), input: invocation.input ?? null }) + "\\n",
  );
  ${markerWrite}
  process.stdout.write(${payload});
});
`;
  };

  /** Continuation config: same Planner/Verifier, but workers run on the
   *  DIFFERENT fake runtime connection (cli-worker-b). */
  const continuationConfig = (): CoordinationConfigV1 => ({
    schemaVersion: 1,
    planner: { kind: "agent", name: "cli-planner" },
    verifier: { kind: "agent", name: "cli-verifier" },
    allowedWorkers: [{ kind: "agent", name: "cli-worker-b" }],
    maxIterations: 3,
    maxWorkersPerIteration: 2,
    maxTotalWorkers: 8,
    loopDeadlineMs: 3_600_000,
    delegationDepthMax: 2,
    allowedExecutors: [
      "local-host",
      "agent:cli-planner",
      "agent:cli-verifier",
      "agent:cli-worker-b",
    ],
  });

  const teamConfig = (): CoordinationConfigV1 => ({
    schemaVersion: 1,
    planner: { kind: "agent", name: "cli-planner" },
    verifier: { kind: "agent", name: "cli-verifier" },
    allowedWorkers: [{ kind: "agent", name: "cli-worker" }],
    maxIterations: 3,
    maxWorkersPerIteration: 2,
    maxTotalWorkers: 8,
    loopDeadlineMs: 3_600_000,
    delegationDepthMax: 2,
    allowedExecutors: [
      "local-host",
      "agent:cli-planner",
      "agent:cli-verifier",
      "agent:cli-worker",
    ],
  });

  beforeAll(async () => {
    assertDisposableTarget(TEST_DATABASE_URL);
    fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "tenvyr-pp1-dogfood-"));
    sourceRepo = path.join(fixtureDir, "source");
    sourceHeadSha = initGitRepo(sourceRepo);
    // The workspace snapshot canonicalizes paths (resolveWorkspacePath);
    // mirror that so path equality assertions compare canonical forms.
    sourceRepo = fs.realpathSync(sourceRepo);
    evidenceDir = path.join(fixtureDir, "evidence");
    fs.mkdirSync(evidenceDir, { recursive: true });
    executionRoot = path.join(fixtureDir, "execution-workspaces");
    process.env.TENVYR_WORKSPACE_ROOT = executionRoot;
    // The REAL host resolves each agent's bearer token from the host
    // environment (HOST_TOKEN_1 references the orchestrator-side token).
    process.env.HOST_TOKEN_1 = "host-token";

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

    // REAL local executor host: one worker per role, each with a distinct
    // fake child + requireExecutionWorkspace (fail closed without one).
    const rolePorts = {
      planner: await availablePort(),
      worker: await availablePort(),
      verifier: await availablePort(),
    };
    const scripts: Record<string, string> = {};
    const agents: HostConfig["agents"] = [];
    const hostAgentConfig = (
      agent: string,
      script: string,
      port: number,
    ): HostConfig["agents"][number] => ({
      agent,
      command: process.execPath,
      args: [script],
      cwd: fixtureDir,
      env:
        agent === "cli-planner"
          ? { FAKE_WORKER_AGENT: "FAKE_WORKER_AGENT" }
          : {},
      secrets: {},
      wallTimeMs: 60_000,
      maxStdoutBytes: 65_536,
      maxStderrBytes: 65_536,
      port,
      bearerTokenEnv: "HOST_TOKEN_1",
      structuredResult: true,
      requireExecutionWorkspace: true,
    });
    scripts.planner = writeScript(
      evidenceDir,
      "planner.js",
      fakeChild("planner", path.join(evidenceDir, "planner.jsonl")),
    );
    scripts.worker = writeScript(
      evidenceDir,
      "worker.js",
      fakeChild("worker", path.join(evidenceDir, "worker.jsonl")),
    );
    scripts.verifier = writeScript(
      evidenceDir,
      "verifier.js",
      fakeChild("verifier", path.join(evidenceDir, "verifier.jsonl")),
    );
    // A SECOND fake runtime connection (cli-worker-b) for the handoff
    // continuation vertical — a different child + marker prefix.
    const workerBPort = await availablePort();
    scripts.workerB = writeScript(
      evidenceDir,
      "worker-b.js",
      fakeChild(
        "worker",
        path.join(evidenceDir, "worker-b.jsonl"),
        "pp1-continue-marker-",
      ),
    );
    agents.push(
      hostAgentConfig("cli-planner", scripts.planner, rolePorts.planner),
      hostAgentConfig("cli-worker", scripts.worker, rolePorts.worker),
      hostAgentConfig("cli-verifier", scripts.verifier, rolePorts.verifier),
      hostAgentConfig("cli-worker-b", scripts.workerB, workerBPort),
    );
    // The planner child chooses its worker from the HOST environment
    // (operator-controlled allowlist, never task input).
    process.env.FAKE_WORKER_AGENT = "cli-worker";
    const hostConfig: HostConfig = {
      agents,
      allowedRoot: fixtureDir,
      stateDir: path.join(fixtureDir, "state"),
      callbackAllowedOrigins: [callbackOrigin],
      callbackKeys: { "host-v1": "host-callback-secret" },
      callbackAllowInsecure: true,
    };
    process.env.TEAM_CALLBACK_SECRET = "host-callback-secret";
    hostWorkers = await startHostWorkers(hostConfig);
    const addresses = hostWorkers.map((w) => w.address);

    const agentsEnv: Record<string, unknown> = {
      "cli-planner": httpAgent(addresses[0].host, addresses[0].port),
      "cli-worker": httpAgent(addresses[1].host, addresses[1].port),
      "cli-verifier": httpAgent(addresses[2].host, addresses[2].port),
      "cli-worker-b": httpAgent(addresses[3].host, addresses[3].port),
    };
    const config = new AgentTransportConfigService(
      parseAgentTransportConfiguration({
        AGENT_TRANSPORT_CONFIG: JSON.stringify(agentsEnv),
        HTTP_AGENT_CALLBACK_BASE_URL: callbackOrigin,
        HTTP_AGENT_ALLOW_INSECURE: "true",
        HOST_TOKEN_1: "host-token",
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
    commands = new WorkbenchCommandService(
      dataSource as any,
      executionService,
      coordinator,
      capsules,
      undefined,
      undefined,
      undefined,
      undefined,
      workspaceExecutions,
    );
    projection = new WorkbenchProjectionService(dataSource as any);
  });

  afterAll(async () => {
    delete process.env.TENVYR_WORKSPACE_ROOT;
    delete process.env.HOST_TOKEN_1;
    delete process.env.TEAM_CALLBACK_SECRET;
    delete process.env.FAKE_WORKER_AGENT;
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

    // 2. Drive the real loop: Planner -> Worker -> Verifier -> CONTINUE ->
    //    iteration 2 -> ACCEPT through the REAL host children.
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
    const plannerCwds = readEvidence("planner.jsonl").map((e) => e.cwd);
    const workerCwds = readEvidence("worker.jsonl").map((e) => e.cwd);
    const verifierCwds = readEvidence("verifier.jsonl").map((e) => e.cwd);
    expect(plannerCwds.length).toBeGreaterThanOrEqual(1);
    expect(workerCwds.length).toBe(2); // one worker per iteration
    expect(verifierCwds.length).toBe(2);
    for (const cwd of [...plannerCwds, ...workerCwds, ...verifierCwds]) {
      expect(cwd).toBe(B);
    }
    // The worker received the hostile planner-authored cwd fields as DATA
    // and still executed in B.
    for (const entry of readEvidence("worker.jsonl")) {
      const input = (entry.input as Record<string, unknown>).cwd;
      expect(input).toBe("/etc");
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

    // 6. Terminal lifecycle: reconcile moves the lease to PRESERVED and
    //    captures the uncommitted work the Worker left behind.
    await workspaceExecutions.reconcileWorkspaceExecutions();
    const preserved = await dataSource
      .getRepository(WorkspaceExecutionEntity)
      .findOneOrFail({ where: { id: lease.id } });
    expect(preserved.state).toBe("PRESERVED");
    expect(preserved.hasUncommittedWork).toBe(true);

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
    // member; every host agent here requires one → refusal before spawn.
    const pipeline = await dataSource.getRepository(PipelineEntity).save(
      dataSource.getRepository(PipelineEntity).create({
        name: "pp1-plain",
        version: "1.0",
        steps: [{ id: "plain", agent: "cli-worker" }] as any[],
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
      "EXECUTOR_HOST_WORKSPACE_PATH_INVALID",
    );
    expect(plainAttempt.error).toContain("requires one");
    // No child evidence was recorded for the refused invocation.
    const workerEvidence = fs
      .readFileSync(path.join(evidenceDir, "worker.jsonl"), "utf8")
      .trim()
      .split("\n")
      .filter(Boolean);
    expect(
      workerEvidence.some((line) =>
        line.includes(plainAttempt.invocationId),
      ),
    ).toBe(false);

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
    // Materialize the Coordinator-owned Planner step WITHOUT claiming it
    // (reconcileCoordination only creates the step), then claim directly,
    // forge the reserved member, and dispatch through the outbox
    // dispatcher — the engine's own pass would dispatch before the tamper.
    // Promote the execution to RUNNING (no steps yet → nothing claims),
    // materialize the Coordinator-owned Planner step, then backfill +
    // advance its logical row to READY without dispatching.
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
    // Nothing spawned at the traversal target.
    expect(
      fs
        .readdirSync(forgedPath)
        .some((name) => name.startsWith("pp1-worker-marker-")),
    ).toBe(false);
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

    // (b) Continue the TERMINAL run on the OTHER fake runtime connection.
    // The planner child picks its worker from the host environment — keep
    // it pointed at the DIFFERENT runtime for the WHOLE continuation loop.
    process.env.FAKE_WORKER_AGENT = "cli-worker-b";
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
    expect(bundle.sourceRuntimeProvenance.some((p) => p.agent === "cli-worker")).toBe(
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

    // (c) Drive the continuation to ACCEPTED through cli-worker-b.
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
    process.env.FAKE_WORKER_AGENT = "cli-worker";

    // The continuation worker executed in the SAME preserved worktree.
    const workerBEvidence = fs
      .readFileSync(path.join(evidenceDir, "worker-b.jsonl"), "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    expect(workerBEvidence.length).toBe(2);
    for (const entry of workerBEvidence) {
      expect(entry.cwd).toBe(B);
    }
    const continueMarkers = fs
      .readdirSync(B)
      .filter((name) => name.startsWith("pp1-continue-marker-"));
    expect(continueMarkers.length).toBe(2);
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
    await workspaceExecutions.reconcileWorkspaceExecutions();
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

function httpAgent(host: string, port: number) {
  return {
    kind: "http",
    submitUrl: `http://${host}:${port}/v1/runs`,
    outboundAuthentication: { type: "bearer", tokenEnv: "HOST_TOKEN_1" },
    callbackAuthentication: { keyId: "host-v1", secretEnv: "TEAM_CALLBACK_SECRET" },
    requestTimeoutMs: 10_000,
    maxResponseBytes: 64 * 1024,
    delegationModes: ["opaque"],
  };
}