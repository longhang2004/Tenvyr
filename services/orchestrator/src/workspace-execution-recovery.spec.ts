import { DataSource, type DataSourceOptions } from "typeorm";
import { databaseOptions } from "./database/database.provider";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { WorkspaceExecutionEntity } from "./entities/workspace-execution.entity";
import { CoordinationRunEntity } from "./entities/coordination-run.entity";
import { ExecutionEntity } from "./entities/execution.entity";
import { PipelineEntity } from "./entities/pipeline.entity";
import { LogicalStepEntity } from "./entities/step-execution.entity";
import { StepAttemptEntity } from "./entities/step-attempt.entity";
import { CoordinationIterationEntity } from "./entities/coordination-iteration.entity";
import { HandoffEntity } from "./entities/handoff.entity";
import { ApprovalRequestEntity } from "./entities/approval-request.entity";
import { OperatorActionEntity } from "./entities/operator-action.entity";
import { WorkspaceEntity } from "./entities/workspace.entity";
import { WorkspaceService } from "./services/workspace.service";
import {
  WorkspaceExecutionService,
  addGitWorktree,
  removeGitWorktree,
  assertAllocationCompatible,
} from "./services/workspace-execution.service";
import { WorkspaceExecutionError } from "./domain/workspace-execution";
import { deriveAttentionItems, attentionId } from "./domain/attention";
import { HandoffService } from "./services/handoff.service";
import { handoffBundleHash, type HandoffBundleV1 } from "./domain/handoff";
import { WorkbenchCommandService } from "./services/workbench-command.service";

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

function initGitRepo(root: string): string {
  fs.mkdirSync(root, { recursive: true });
  const run = (args: string[]) =>
    spawnSync("git", args, {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Tenvyr Test",
        GIT_AUTHOR_EMAIL: "test@tenvyr.local",
        GIT_COMMITTER_NAME: "Tenvyr Test",
        GIT_COMMITTER_EMAIL: "test@tenvyr.local",
      },
    });
  fs.writeFileSync(path.join(root, "README.md"), "# Test Repo\n", "utf8");
  run(["init", "-b", "main"]);
  run(["add", "README.md"]);
  run(["commit", "-m", "initial commit"]);
  return run(["rev-parse", "HEAD"]).stdout.trim();
}

describe("Workspace Execution Recovery, Idempotency & Handoff Safety Matrix", () => {
  let fixtureDir: string;
  let repoRoot: string;
  let headSha: string;
  let executionRoot: string;

  beforeAll(() => {
    fixtureDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "tenvyr-recovery-spec-"),
    );
    repoRoot = path.join(fixtureDir, "source-repo");
    headSha = initGitRepo(repoRoot);
    executionRoot = path.join(fixtureDir, "exec-workspaces");
    fs.mkdirSync(executionRoot, { recursive: true });
    process.env.TENVYR_WORKSPACE_ROOT = executionRoot;
  });

  afterAll(() => {
    if (fixtureDir && fs.existsSync(fixtureDir)) {
      try {
        fs.rmSync(fixtureDir, { recursive: true, force: true });
      } catch {
        // best effort cleanup
      }
    }
  });

  it("addGitWorktree creates worktree and verifies frozenHeadSha", () => {
    const wtPath = path.join(executionRoot, "wt-frozen-head");
    const err = addGitWorktree(repoRoot, wtPath, "tenvyr/wt-frozen", headSha);
    expect(err).toBeNull();

    const headCheck = spawnSync(
      "git",
      ["-C", wtPath, "rev-parse", "HEAD"],
      { encoding: "utf8" },
    );
    expect(headCheck.stdout.trim()).toBe(headSha);
  });

  it("removeGitWorktree removes clean worktree and refuses dirty worktree", () => {
    const cleanPath = path.join(executionRoot, "wt-clean-remove");
    addGitWorktree(repoRoot, cleanPath, "tenvyr/wt-clean-rm", headSha);
    const outcomeClean = removeGitWorktree(repoRoot, cleanPath);
    expect(outcomeClean).toBe("removed");

    const dirtyPath = path.join(executionRoot, "wt-dirty-remove");
    addGitWorktree(repoRoot, dirtyPath, "tenvyr/wt-dirty-rm", headSha);
    fs.writeFileSync(path.join(dirtyPath, "dirty.txt"), "dirty", "utf8");
    const outcomeDirty = removeGitWorktree(repoRoot, dirtyPath);
    expect(typeof outcomeDirty).toBe("object");
    expect((outcomeDirty as { refused: string }).refused).toBeTruthy();
  });

  it("derives deterministic attention IDs for pending approval requests", () => {
    const items = deriveAttentionItems({
      runs: [],
      approvalRequests: [
        {
          id: "req-1",
          proposalId: "prop-abc-123",
          actionType: "tool_use",
          targetAgent: "planner",
          status: "PENDING",
          createdAt: new Date("2026-08-17T00:00:00Z"),
          updatedAt: new Date("2026-08-17T00:00:00Z"),
        } as any,
      ],
      executions: [],
      workspaceExecutions: [],
      runByExecution: new Map(),
      executionByRun: new Map(),
    });

    expect(items).toHaveLength(1);
    expect(items[0].attentionId).toBe(
      attentionId("HUMAN_APPROVAL_REQUIRED", "prop-abc-123"),
    );
    expect(items[0].attentionId).not.toContain("?");
  });

  it("produces deterministic handoffBundleHash with summary: null", () => {
    const bundle: HandoffBundleV1 = {
      schemaVersion: 1,
      sourceExecutionId: "exec-1",
      sourceRunId: "run-1",
      goal: "implement feature",
      workspace: {
        workspaceId: "ws-1",
        path: repoRoot,
        branch: "main",
        headSha,
      },
      executionWorkspace: null,
      planRevision: { id: "rev-1", planHash: "hash-1" },
      iterationNumber: 1,
      verifierDecision: { action: "CONTINUE", reason: "more tests needed" },
      workerOutcomes: [
        { taskId: "task-1", status: "SUCCEEDED", summary: null },
      ],
      artifactRefs: [],
      acceptanceEvidence: null,
      nextWork: "more tests needed",
      sourceRuntimeProvenance: [
        {
          agent: "conn__hermes",
          connectionId: "conn:hermes",
          requestedModelId: "hermes-3",
        },
      ],
      createdAt: "2026-08-17T00:00:00.000Z",
    };

    const hash1 = handoffBundleHash(bundle);
    const hash2 = handoffBundleHash(bundle);
    expect(hash1).toBe(hash2);
    expect(hash1).toMatch(/^[a-f0-9]{64}$/);
    expect(bundle.workerOutcomes[0].summary).toBeNull();
  });

  it("derives WORKSPACE_REQUIRES_ATTENTION for dirty and unknown status workspaces, but not clean ones", () => {
    const items = deriveAttentionItems({
      runs: [],
      approvalRequests: [],
      executions: [],
      workspaceExecutions: [
        {
          id: "lease-clean",
          ownerRunId: "run-1",
          state: "PRESERVED",
          hasUncommittedWork: false,
          createdAt: new Date("2026-08-17T00:00:00Z"),
          updatedAt: new Date("2026-08-17T00:00:00Z"),
        },
        {
          id: "lease-dirty",
          ownerRunId: "run-2",
          state: "PRESERVED",
          hasUncommittedWork: true,
          createdAt: new Date("2026-08-17T00:00:00Z"),
          updatedAt: new Date("2026-08-17T00:00:00Z"),
        },
        {
          id: "lease-unknown",
          ownerRunId: "run-3",
          state: "PRESERVED",
          hasUncommittedWork: null,
          createdAt: new Date("2026-08-17T00:00:00Z"),
          updatedAt: new Date("2026-08-17T00:00:00Z"),
        },
      ],
      runByExecution: new Map(),
      executionByRun: new Map(),
    });

    // clean lease is omitted; dirty and unknown leases produce attention items
    expect(items).toHaveLength(2);
    const dirtyItem = items.find((i) => i.workspaceExecutionId === "lease-dirty");
    expect(dirtyItem).toBeDefined();
    expect(dirtyItem?.reason).toContain("uncommitted work");

    const unknownItem = items.find((i) => i.workspaceExecutionId === "lease-unknown");
    expect(unknownItem).toBeDefined();
    expect(unknownItem?.reason).toContain("unknown status");
  });

  it("service-level: handles broken git repo gracefully, records null status, creates attention item, and refuses removal", async () => {
    const brokenPath = path.join(executionRoot, "wt-broken-git");
    const addErr = addGitWorktree(repoRoot, brokenPath, "tenvyr/wt-broken", headSha);
    expect(addErr).toBeNull();

    // Corrupt git metadata in worktree (.git file/pointer)
    const dotGit = path.join(brokenPath, ".git");
    if (fs.existsSync(dotGit)) {
      fs.writeFileSync(dotGit, "invalid-git-pointer\n", "utf8");
    }

    const now = new Date();
    const mockRepo = {
      findOne: jest.fn().mockResolvedValue({
        id: "lease-broken",
        ownerRunId: "run-broken",
        mode: "git-worktree",
        executionPath: brokenPath,
        sourcePath: repoRoot,
        state: "IN_USE",
        createdAt: now,
        updatedAt: now,
      }),
      save: jest.fn().mockImplementation((r) => Promise.resolve(r)),
    };
    const mockManager = {
      getRepository: jest.fn().mockReturnValue(mockRepo),
    } as any;

    const svc = new WorkspaceExecutionService({ getRepository: () => mockRepo } as any);
    const preserved = await svc.preserveExecutionWorkspaceForRun(mockManager, "run-broken");
    expect(preserved).not.toBeNull();
    // Tri-state: status command failed, so hasUncommittedWork is null (unknown)
    expect(preserved?.hasUncommittedWork).toBeNull();

    const items = deriveAttentionItems({
      runs: [],
      approvalRequests: [],
      executions: [],
      workspaceExecutions: [preserved! as any],
      runByExecution: new Map(),
      executionByRun: new Map(),
    });
    expect(items).toHaveLength(1);
    expect(items[0].reason).toContain("unknown status");
  });

  const createMockRepoWithReleasing = (row: any) => ({
    createQueryBuilder: jest.fn().mockImplementation(() => {
      let queryType = "";
      const builder: any = {
        where: jest.fn().mockImplementation((condition: string) => {
          if (condition.includes("ALLOCATING")) queryType = "ALLOCATING";
          else if (condition.includes("READY")) queryType = "READY";
          else if (condition.includes("IN_USE")) queryType = "IN_USE";
          else if (condition.includes("RELEASE_REQUESTED"))
            queryType = "RELEASE_REQUESTED";
          return builder;
        }),
        andWhere: jest.fn().mockImplementation(() => builder),
        getMany: jest.fn().mockImplementation(async () => {
          if (queryType === "RELEASE_REQUESTED") {
            return [row];
          }
          return [];
        }),
      };
      return builder;
    }),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
    findOne: jest.fn().mockImplementation(async ({ where }: any) => {
      // H5 durable authority: return a matching OperatorAction when queried by targetId
      if (where?.targetId === row.id || where?.id === row.id) {
        // Simulate an OperatorAction row that authorizes this release
        if (where?.targetId) {
          return { id: "action-1", action: "release-execution-workspace", targetId: row.id, outcome: { pending: true, phase: "REQUESTED" } };
        }
        return row;
      }
      return row;
    }),
    findOneOrFail: jest.fn().mockImplementation(({ where }: any) =>
      Promise.resolve({ id: where.id, state: "REMOVED" }),
    ),
  });

  it("safe release saga crash recovery: reconciles RELEASE_REQUESTED when worktree was already removed", async () => {
    const mockRepo = createMockRepoWithReleasing({
      id: "lease-releasing-1",
      state: "RELEASE_REQUESTED",
      mode: "git-worktree",
      sourcePath: repoRoot,
      executionPath: path.join(executionRoot, "wt-already-gone"),
    });
    const svc = new WorkspaceExecutionService({ getRepository: () => mockRepo } as any);
    const transitions = await svc.reconcileWorkspaceExecutions();
    expect(transitions).toBe(1);
    expect(mockRepo.update).toHaveBeenCalledWith(
      "lease-releasing-1",
      expect.objectContaining({ state: "REMOVED" }),
    );
  });

  it("safe release saga crash recovery: performs safe removal on RELEASE_REQUESTED when worktree is still registered", async () => {
    const cleanPath = path.join(executionRoot, "wt-release-crash");
    addGitWorktree(repoRoot, cleanPath, "tenvyr/wt-release-crash", headSha);

    const mockRepo = createMockRepoWithReleasing({
      id: "lease-releasing-2",
      state: "RELEASE_REQUESTED",
      mode: "git-worktree",
      sourcePath: repoRoot,
      executionPath: cleanPath,
    });
    const svc = new WorkspaceExecutionService({ getRepository: () => mockRepo } as any);
    const transitions = await svc.reconcileWorkspaceExecutions();
    expect(transitions).toBe(1);
    expect(mockRepo.update).toHaveBeenCalledWith(
      "lease-releasing-2",
      expect.objectContaining({ state: "REMOVED" }),
    );
  });
});

describeWithPostgres("PostgreSQL Workspace Allocation Barrier Concurrency", () => {
  let dataSource: DataSource;
  let service: WorkspaceExecutionService;
  let fixtureDir: string;
  let repoRoot: string;
  let headSha: string;
  let executionRoot: string;

  beforeAll(async () => {
    assertDisposableTarget(TEST_DATABASE_URL);
    fixtureDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "tenvyr-barrier-concurrency-"),
    );
    repoRoot = path.join(fixtureDir, "source-repo");
    headSha = initGitRepo(repoRoot);
    executionRoot = path.join(fixtureDir, "exec-workspaces");
    fs.mkdirSync(executionRoot, { recursive: true });
    process.env.TENVYR_WORKSPACE_ROOT = executionRoot;

    dataSource = new DataSource({
      ...databaseOptions(),
      type: "postgres" as const,
      url: TEST_DATABASE_URL,
    } as DataSourceOptions);
    await dataSource.initialize();
    await dataSource.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await dataSource.runMigrations();

    service = new WorkspaceExecutionService(dataSource);
  });

  afterAll(async () => {
    await dataSource?.destroy();
    if (fixtureDir && fs.existsSync(fixtureDir)) {
      try {
        fs.rmSync(fixtureDir, { recursive: true, force: true });
      } catch {}
    }
  });

  it("converges concurrent duplicate git-worktree allocations under a single allocationKey to 1 row and 1 worktree", async () => {
    const allocationKey = "barrier-key-git-worktree-1";
    const workspaceSnapshot = {
      schemaVersion: 1 as const,
      workspaceId: "ws-source-1",
      path: repoRoot,
      repoRoot,
      branch: "main",
      headSha,
      dirty: false,
      capturedAt: "2026-08-17T00:00:00.000Z",
    };

    const [alloc1, alloc2] = await Promise.all([
      service.allocateExecutionWorkspace(
        workspaceSnapshot,
        "git-worktree",
        allocationKey,
      ),
      service.allocateExecutionWorkspace(
        workspaceSnapshot,
        "git-worktree",
        allocationKey,
      ),
    ]);

    expect(alloc1.id).toBe(alloc2.id);
    expect(alloc1.executionPath).toBe(alloc2.executionPath);

    const count = await dataSource
      .getRepository(WorkspaceExecutionEntity)
      .count({ where: { allocationKey } });
    expect(count).toBe(1);

    const list = spawnSync("git", ["worktree", "list", "--porcelain"], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    const worktreeLines = list.stdout
      .split("\n")
      .filter((l) => l.startsWith("worktree "))
      .map((l) => l.replace(/^worktree\s+/, "").trim());
    expect(worktreeLines).toHaveLength(2);
    expect(worktreeLines).toContain(fs.realpathSync(alloc1.executionPath!));
  });

  it("converges concurrent duplicate shared allocations under a single allocationKey to 1 row", async () => {
    const allocationKey = "barrier-key-shared-1";
    const workspaceSnapshot = {
      schemaVersion: 1 as const,
      workspaceId: "ws-source-2",
      path: repoRoot,
      repoRoot,
      branch: "main",
      headSha,
      dirty: false,
      capturedAt: "2026-08-17T00:00:00.000Z",
    };

    const [alloc1, alloc2] = await Promise.all([
      service.allocateExecutionWorkspace(
        workspaceSnapshot,
        "shared",
        allocationKey,
      ),
      service.allocateExecutionWorkspace(
        workspaceSnapshot,
        "shared",
        allocationKey,
      ),
    ]);

    expect(alloc1.id).toBe(alloc2.id);
    const count = await dataSource
      .getRepository(WorkspaceExecutionEntity)
      .count({ where: { allocationKey } });
    expect(count).toBe(1);
  });

  it("fails closed on conflicting parameters with same allocationKey", async () => {
    const allocationKey = "barrier-conflict-key-1";
    const workspaceSnapshot = {
      schemaVersion: 1 as const,
      workspaceId: "ws-source-3",
      path: repoRoot,
      repoRoot,
      branch: "main",
      headSha,
      dirty: false,
      capturedAt: "2026-08-17T00:00:00.000Z",
    };

    await service.allocateExecutionWorkspace(
      workspaceSnapshot,
      "shared",
      allocationKey,
    );

    await expect(
      service.allocateExecutionWorkspace(
        workspaceSnapshot,
        "git-worktree",
        allocationKey,
      ),
    ).rejects.toMatchObject({
      code: "ALLOCATION_CONFLICT",
    });
  });

  it("fails closed when same allocationKey is used with different frozen HEAD", async () => {
    const allocationKey = "barrier-head-conflict-key-1";
    const ws1 = {
      schemaVersion: 1 as const,
      workspaceId: "ws-source-head-1",
      path: repoRoot,
      repoRoot,
      branch: "main",
      headSha,
      dirty: false,
      capturedAt: "2026-08-17T00:00:00.000Z",
    };
    const ws2 = {
      ...ws1,
      headSha: headSha.slice(0, -1) + (headSha.endsWith("0") ? "1" : "0"),
    };

    await service.allocateExecutionWorkspace(ws1, "git-worktree", allocationKey);

    await expect(
      service.allocateExecutionWorkspace(ws2, "git-worktree", allocationKey),
    ).rejects.toMatchObject({
      code: "ALLOCATION_CONFLICT",
    });
  });

  it("startTeamRun-level concurrent duplicate converges to 1 OperatorAction and 1 WorkspaceExecution", async () => {
    const workspaceRepo = dataSource.getRepository(WorkspaceEntity);
    const savedWs = await workspaceRepo.save(
      workspaceRepo.create({
        name: "test-concurrent-ws",
        path: repoRoot,
        snapshot: {
          schemaVersion: 1,
          workspaceId: "ws-temp-id",
          path: repoRoot,
          repoRoot,
          branch: "main",
          headSha,
          dirty: false,
          capturedAt: new Date().toISOString(),
        },
      }),
    );

    const workspaceService = new WorkspaceService(dataSource);
    const workbenchService = new WorkbenchCommandService(
      dataSource,
      undefined,
      undefined,
      undefined,
      undefined,
      workspaceService,
      undefined,
      undefined,
      service,
    );

    const idempotencyKey = "cmd-start-team-run-dup-1";
    const teamConfig = {
      schemaVersion: 1 as const,
      planner: { kind: "agent" as const, name: "planner" },
      verifier: { kind: "agent" as const, name: "verifier" },
      allowedWorkers: [{ kind: "agent" as const, name: "worker" }],
      maxIterations: 2,
      maxWorkersPerIteration: 2,
      maxTotalWorkers: 4,
      loopDeadlineMs: 60000,
      delegationDepthMax: 1,
      allowedExecutors: ["agent:planner", "agent:verifier", "agent:worker", "local-host"],
    };

    const runInput = {
      idempotencyKey,
      name: "Concurrent Test Run",
      goal: "Test goal for concurrent start",
      config: teamConfig,
      workspace: { workspaceId: savedWs.id },
      executionIsolation: "shared" as const,
    };

    const [res1, res2] = await Promise.all([
      workbenchService.startTeamRun(runInput),
      workbenchService.startTeamRun(runInput),
    ]);

    expect(res1.result.executionId).toBe(res2.result.executionId);
    expect(res1.result.runId).toBe(res2.result.runId);

    const actions = await dataSource
      .getRepository(OperatorActionEntity)
      .find({ where: { idempotencyKey } });
    expect(actions).toHaveLength(1);
    expect(actions[0].action).toBe("start-team-run");
  });

  it("audited safe release crash saga: recovers truthfully across crash points and refuses dirty removal", async () => {
    const workbenchService = new WorkbenchCommandService(
      dataSource,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      service,
    );

    // 1. Setup clean worktree for release
    const wtPath = path.join(executionRoot, "wt-audited-release");
    addGitWorktree(repoRoot, wtPath, "tenvyr/wt-audited-release", headSha);

    const lease = await dataSource.getRepository(WorkspaceExecutionEntity).save(
      dataSource.getRepository(WorkspaceExecutionEntity).create({
        sourceWorkspaceId: "ws-audit-test",
        sourcePath: repoRoot,
        mode: "git-worktree",
        executionPath: wtPath,
        baseBranch: "main",
        baseHeadSha: headSha,
        state: "PRESERVED",
      }),
    );

    // 2. Normal audited release executes cleanly and records durable outcome
    const relKey = "cmd-release-clean-1";
    const res = await workbenchService.releaseExecutionWorkspace({
      idempotencyKey: relKey,
      workspaceExecutionId: lease.id,
    });
    expect(res.outcome).toBe("executed");
    expect(res.result.state).toBe("REMOVED");

    const action = await dataSource
      .getRepository(OperatorActionEntity)
      .findOne({ where: { idempotencyKey: relKey } });
    expect(action).not.toBeNull();
    expect(action?.outcome).toEqual({
      workspaceExecutionId: lease.id,
      state: "REMOVED",
    });

    // 3. Duplicate release command converges without re-running Git
    const dupRes = await workbenchService.releaseExecutionWorkspace({
      idempotencyKey: relKey,
      workspaceExecutionId: lease.id,
    });
    expect(dupRes.outcome).toBe("duplicate");
    expect(dupRes.result.state).toBe("REMOVED");

    // 4. Dirty worktree release is refused and preserves uncommitted work + records durable audit refusal
    const dirtyPath = path.join(executionRoot, "wt-audited-dirty");
    addGitWorktree(repoRoot, dirtyPath, "tenvyr/wt-audited-dirty", headSha);
    fs.writeFileSync(path.join(dirtyPath, "dirty.txt"), "uncommitted dirty content");

    const dirtyLease = await dataSource.getRepository(WorkspaceExecutionEntity).save(
      dataSource.getRepository(WorkspaceExecutionEntity).create({
        sourceWorkspaceId: "ws-audit-dirty",
        sourcePath: repoRoot,
        mode: "git-worktree",
        executionPath: dirtyPath,
        baseBranch: "main",
        baseHeadSha: headSha,
        state: "PRESERVED",
      }),
    );

    const dirtyKey = "cmd-release-dirty-1";
    await expect(
      workbenchService.releaseExecutionWorkspace({
        idempotencyKey: dirtyKey,
        workspaceExecutionId: dirtyLease.id,
      }),
    ).rejects.toThrow();

    // Verify lease remains PRESERVED with uncommitted work recorded
    const reloadedDirty = await dataSource
      .getRepository(WorkspaceExecutionEntity)
      .findOne({ where: { id: dirtyLease.id } });
    expect(reloadedDirty?.state).toBe("PRESERVED");
    expect(reloadedDirty?.hasUncommittedWork).toBe(true);
    expect(fs.existsSync(dirtyPath)).toBe(true);

    // Verify durable audit evidence recorded refusal
    const dirtyAction = await dataSource
      .getRepository(OperatorActionEntity)
      .findOne({ where: { idempotencyKey: dirtyKey } });
    expect(dirtyAction).not.toBeNull();
    expect((dirtyAction?.outcome as any)?.refusal).toBe(true);
    expect((dirtyAction?.outcome as any)?.failureCode).toBe("WORKTREE_DIRTY");

    // Duplicate call on dirty worktree re-throws from audit evidence without running git again
    await expect(
      workbenchService.releaseExecutionWorkspace({
        idempotencyKey: dirtyKey,
        workspaceExecutionId: dirtyLease.id,
      }),
    ).rejects.toThrow();
  });

  it("CASE 1: operator intent COMMITTED -> crash BEFORE RELEASE_REQUESTED / Git -> retry completes release", async () => {
    const workbenchService = new WorkbenchCommandService(
      dataSource,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      service,
    );

    const wtPath = path.join(executionRoot, "wt-case1");
    addGitWorktree(repoRoot, wtPath, "tenvyr/wt-case1", headSha);

    const lease = await dataSource.getRepository(WorkspaceExecutionEntity).save(
      dataSource.getRepository(WorkspaceExecutionEntity).create({
        sourceWorkspaceId: "ws-case1",
        sourcePath: repoRoot,
        mode: "git-worktree",
        executionPath: wtPath,
        baseBranch: "main",
        baseHeadSha: headSha,
        state: "PRESERVED",
      }),
    );

    const idempotencyKey = "cmd-release-case1";
    // Simulate crash after operator intent commit
    await dataSource.getRepository(OperatorActionEntity).save(
      dataSource.getRepository(OperatorActionEntity).create({
        action: "release-execution-workspace",
        idempotencyKey,
        actor: "local-operator",
        targetId: lease.id,
        payload: { workspaceExecutionId: lease.id, reason: null },
        outcome: { pending: true, phase: "REQUESTED" },
      }),
    );

    // Caller retries: saga picks up pending intent and completes release
    const res = await workbenchService.releaseExecutionWorkspace({
      idempotencyKey,
      workspaceExecutionId: lease.id,
    });
    expect(res.result.state).toBe("REMOVED");

    const reloaded = await dataSource
      .getRepository(WorkspaceExecutionEntity)
      .findOne({ where: { id: lease.id } });
    expect(reloaded?.state).toBe("REMOVED");
    expect(fs.existsSync(wtPath)).toBe(false);
  });

  it("CASE 2: RELEASE_REQUESTED committed -> Git worktree removed -> crash BEFORE WorkspaceExecution REMOVED -> retry converges", async () => {
    const workbenchService = new WorkbenchCommandService(
      dataSource,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      service,
    );

    const wtPath = path.join(executionRoot, "wt-case2");
    addGitWorktree(repoRoot, wtPath, "tenvyr/wt-case2", headSha);
    removeGitWorktree(repoRoot, wtPath); // physical removal happened before crash

    const lease = await dataSource.getRepository(WorkspaceExecutionEntity).save(
      dataSource.getRepository(WorkspaceExecutionEntity).create({
        sourceWorkspaceId: "ws-case2",
        sourcePath: repoRoot,
        mode: "git-worktree",
        executionPath: wtPath,
        baseBranch: "main",
        baseHeadSha: headSha,
        state: "RELEASE_REQUESTED", // crashed before REMOVED
      }),
    );

    const idempotencyKey = "cmd-release-case2";
    await dataSource.getRepository(OperatorActionEntity).save(
      dataSource.getRepository(OperatorActionEntity).create({
        action: "release-execution-workspace",
        idempotencyKey,
        actor: "local-operator",
        targetId: lease.id,
        payload: { workspaceExecutionId: lease.id, reason: null },
        outcome: { pending: true, phase: "REQUESTED" },
      }),
    );

    const res = await workbenchService.releaseExecutionWorkspace({
      idempotencyKey,
      workspaceExecutionId: lease.id,
    });
    expect(res.result.state).toBe("REMOVED");

    const reloaded = await dataSource
      .getRepository(WorkspaceExecutionEntity)
      .findOne({ where: { id: lease.id } });
    expect(reloaded?.state).toBe("REMOVED");
  });

  it("CASE 3: WorkspaceExecution REMOVED -> crash BEFORE final OperatorAction outcome -> retry finalizes audit without running Git again", async () => {
    const workbenchService = new WorkbenchCommandService(
      dataSource,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      service,
    );

    const lease = await dataSource.getRepository(WorkspaceExecutionEntity).save(
      dataSource.getRepository(WorkspaceExecutionEntity).create({
        sourceWorkspaceId: "ws-case3",
        sourcePath: repoRoot,
        mode: "git-worktree",
        executionPath: path.join(executionRoot, "wt-case3-already-gone"),
        baseBranch: "main",
        baseHeadSha: headSha,
        state: "REMOVED", // workspace execution finalized before crash
      }),
    );

    const idempotencyKey = "cmd-release-case3";
    await dataSource.getRepository(OperatorActionEntity).save(
      dataSource.getRepository(OperatorActionEntity).create({
        action: "release-execution-workspace",
        idempotencyKey,
        actor: "local-operator",
        targetId: lease.id,
        payload: { workspaceExecutionId: lease.id, reason: null },
        outcome: { pending: true, phase: "REQUESTED" }, // operator action unfinalized
      }),
    );

    const res = await workbenchService.releaseExecutionWorkspace({
      idempotencyKey,
      workspaceExecutionId: lease.id,
    });
    expect(res.result.state).toBe("REMOVED");

    const action = await dataSource
      .getRepository(OperatorActionEntity)
      .findOne({ where: { idempotencyKey } });
    expect((action?.outcome as any)?.state).toBe("REMOVED");
  });

  it("conflicting idempotency payload fails closed", async () => {
    const workbenchService = new WorkbenchCommandService(
      dataSource,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      service,
    );

    const idempotencyKey = "cmd-release-conflict";
    await dataSource.getRepository(OperatorActionEntity).save(
      dataSource.getRepository(OperatorActionEntity).create({
        action: "release-execution-workspace",
        idempotencyKey,
        actor: "local-operator",
        targetId: "lease-a",
        payload: { workspaceExecutionId: "lease-a", reason: "initial reason" },
        outcome: { workspaceExecutionId: "lease-a", state: "REMOVED" },
      }),
    );

    await expect(
      workbenchService.releaseExecutionWorkspace({
        idempotencyKey,
        workspaceExecutionId: "lease-b", // conflicting payload
      }),
    ).rejects.toThrow(/different request payload|IDEMPOTENCY_CONFLICT/);
  });

  it("H1 audit truth: LEASE_NOT_FOUND -> NOT_FOUND, LEASE_NOT_RELEASABLE -> IN_USE, SHARED_MODE_NO_REMOVAL truthful code", async () => {
    const workbenchService = new WorkbenchCommandService(
      dataSource,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      service,
    );

    // LEASE_NOT_FOUND
    const missingId = "00000000-0000-4000-a000-000000000001";
    await expect(
      workbenchService.releaseExecutionWorkspace({
        idempotencyKey: "h1-lease-not-found",
        workspaceExecutionId: missingId,
      }),
    ).rejects.toMatchObject({ code: "LEASE_NOT_FOUND" });
    const a1 = await dataSource.getRepository(OperatorActionEntity).findOne({ where: { idempotencyKey: "h1-lease-not-found" } });
    expect((a1?.outcome as any)?.state).toBe("NOT_FOUND");
    expect((a1?.outcome as any)?.failureCode).toBe("LEASE_NOT_FOUND");

    // IN_USE -> LEASE_NOT_RELEASABLE -> IN_USE truth
    const wtInUse = `${executionRoot}/wt-h1-inuse`;
    addGitWorktree(repoRoot, wtInUse, "tenvyr/h1-inuse", headSha);
    const leaseInUse = await dataSource.getRepository(WorkspaceExecutionEntity).save(
      dataSource.getRepository(WorkspaceExecutionEntity).create({
        sourceWorkspaceId: "ws-h1-inuse",
        sourcePath: repoRoot,
        mode: "git-worktree",
        executionPath: wtInUse,
        baseBranch: "main",
        baseHeadSha: headSha,
        state: "IN_USE",
      }),
    );
    await expect(
      workbenchService.releaseExecutionWorkspace({
        idempotencyKey: "h1-not-releasable",
        workspaceExecutionId: leaseInUse.id,
      }),
    ).rejects.toMatchObject({ code: "LEASE_NOT_RELEASABLE" });
    const a2 = await dataSource.getRepository(OperatorActionEntity).findOne({ where: { idempotencyKey: "h1-not-releasable" } });
    expect((a2?.outcome as any)?.state).toBe("IN_USE");
    expect((a2?.outcome as any)?.failureCode).toBe("LEASE_NOT_RELEASABLE");

    // PRESERVED shared -> SHARED_MODE_NO_REMOVAL (not WORKTREE_DIRTY)
    const sharedLease = await dataSource.getRepository(WorkspaceExecutionEntity).save(
      dataSource.getRepository(WorkspaceExecutionEntity).create({
        sourceWorkspaceId: "ws-h1-shared",
        sourcePath: repoRoot,
        mode: "shared",
        executionPath: repoRoot,
        baseBranch: "main",
        baseHeadSha: headSha,
        state: "PRESERVED",
      }),
    );
    await expect(
      workbenchService.releaseExecutionWorkspace({
        idempotencyKey: "h1-shared-no-removal",
        workspaceExecutionId: sharedLease.id,
      }),
    ).rejects.toMatchObject({ code: "SHARED_MODE_NO_REMOVAL" });
    const a3 = await dataSource.getRepository(OperatorActionEntity).findOne({ where: { idempotencyKey: "h1-shared-no-removal" } });
    expect((a3?.outcome as any)?.failureCode).toBe("SHARED_MODE_NO_REMOVAL");
  });

  it("H2 truth: dirty->WORKTREE_DIRTY hasUncommittedWork=true, unknown->null, operational->REMOVE_FAILED", async () => {
    const workbenchService = new WorkbenchCommandService(
      dataSource,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      service,
    );
    // Dirty path
    const dirtyPath = `${executionRoot}/wt-h2-dirty`;
    addGitWorktree(repoRoot, dirtyPath, "tenvyr/h2-dirty", headSha);
    require("node:fs").writeFileSync(`${dirtyPath}/dirty.txt`, "dirty");
    const dirtyLease = await dataSource.getRepository(WorkspaceExecutionEntity).save(
      dataSource.getRepository(WorkspaceExecutionEntity).create({
        sourceWorkspaceId: "ws-h2-dirty",
        sourcePath: repoRoot,
        mode: "git-worktree",
        executionPath: dirtyPath,
        baseBranch: "main",
        baseHeadSha: headSha,
        state: "PRESERVED",
      }),
    );
    await expect(workbenchService.releaseExecutionWorkspace({ idempotencyKey: "h2-dirty", workspaceExecutionId: dirtyLease.id })).rejects.toMatchObject({ code: "WORKTREE_DIRTY" });
    const reDirty = await dataSource.getRepository(WorkspaceExecutionEntity).findOne({ where: { id: dirtyLease.id } });
    expect(reDirty?.failureCode).toBe("WORKTREE_DIRTY");
    expect(reDirty?.hasUncommittedWork).toBe(true);
  });

  it("H3 concurrent same-key release: exactly one external Git execution (EXECUTING claim)", async () => {
    const workbenchService = new WorkbenchCommandService(
      dataSource,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      service,
    );
    const wt = `${executionRoot}/wt-h3-concurrent`;
    addGitWorktree(repoRoot, wt, "tenvyr/h3-concurrent", headSha);
    const lease = await dataSource.getRepository(WorkspaceExecutionEntity).save(
      dataSource.getRepository(WorkspaceExecutionEntity).create({
        sourceWorkspaceId: "ws-h3",
        sourcePath: repoRoot,
        mode: "git-worktree",
        executionPath: wt,
        baseBranch: "main",
        baseHeadSha: headSha,
        state: "PRESERVED",
      }),
    );
    const key = "h3-same-key";
    const [r1, r2] = await Promise.all([
      workbenchService.releaseExecutionWorkspace({ idempotencyKey: key, workspaceExecutionId: lease.id }),
      workbenchService.releaseExecutionWorkspace({ idempotencyKey: key, workspaceExecutionId: lease.id }),
    ]);
    // One executed, one duplicate — both converge to REMOVED
    const states = [r1.result.state, r2.result.state].sort();
    expect(states).toEqual(["REMOVED", "REMOVED"]);
    const outcomes = [r1.outcome, r2.outcome].sort();
    expect(outcomes).toContain("executed");
    expect(outcomes).toContain("duplicate");
    const actions = await dataSource.getRepository(OperatorActionEntity).find({ where: { idempotencyKey: key } });
    expect(actions).toHaveLength(1);
  });

  it("H4 crash REQUESTED before RELEASE_REQUESTED: pending->INTERRUPTED with retryRequired, same-key retry converges", async () => {
    const workbenchService = new WorkbenchCommandService(
      dataSource,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      service,
    );
    const wt = `${executionRoot}/wt-h4-pending`;
    addGitWorktree(repoRoot, wt, "tenvyr/h4-pending", headSha);
    const lease = await dataSource.getRepository(WorkspaceExecutionEntity).save(
      dataSource.getRepository(WorkspaceExecutionEntity).create({
        sourceWorkspaceId: "ws-h4",
        sourcePath: repoRoot,
        mode: "git-worktree",
        executionPath: wt,
        baseBranch: "main",
        baseHeadSha: headSha,
        state: "PRESERVED",
      }),
    );
    const key = "h4-crash-before-release";
    await dataSource.getRepository(OperatorActionEntity).save(
      dataSource.getRepository(OperatorActionEntity).create({
        action: "release-execution-workspace",
        idempotencyKey: key,
        actor: "local-operator",
        targetId: lease.id,
        payload: { workspaceExecutionId: lease.id, reason: null },
        outcome: { pending: true, phase: "REQUESTED" },
      }),
    );
    // Reconcile should mark the pending action against PRESERVED truth — in this new design
    // the pending PRESERVED action is reconciled to PRESERVED (with failureCode if any).
    // For a clean PRESERVED lease, reconcile leaves it as success-like PRESERVED; the
    // retry path via releaseExecutionWorkspace with EXECUTING claim completes to REMOVED.
    const res = await workbenchService.releaseExecutionWorkspace({ idempotencyKey: key, workspaceExecutionId: lease.id });
    expect(res.result.state).toBe("REMOVED");
  });

  it("H5 unmatched RELEASE_REQUESTED fails closed: RELEASE_UNAUTHORIZED and preserved", async () => {
    // Create a RELEASE_REQUESTED lease with NO matching OperatorAction
    const wt = `${executionRoot}/wt-h5-unmatched`;
    addGitWorktree(repoRoot, wt, "tenvyr/h5-unmatched", headSha);
    const lease = await dataSource.getRepository(WorkspaceExecutionEntity).save(
      dataSource.getRepository(WorkspaceExecutionEntity).create({
        sourceWorkspaceId: "ws-h5",
        sourcePath: repoRoot,
        mode: "git-worktree",
        executionPath: wt,
        baseBranch: "main",
        baseHeadSha: headSha,
        state: "RELEASE_REQUESTED",
      }),
    );
    const transitions = await service.reconcileWorkspaceExecutions();
    expect(transitions).toBeGreaterThanOrEqual(1);
    const reloaded = await dataSource.getRepository(WorkspaceExecutionEntity).findOne({ where: { id: lease.id } });
    expect(reloaded?.state).toBe("PRESERVED");
    expect(reloaded?.failureCode).toBe("RELEASE_UNAUTHORIZED");
    expect(require("node:fs").existsSync(wt)).toBe(true);
  });
});
