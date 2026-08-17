import { DataSource } from "typeorm";
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
import {
  WorkspaceExecutionService,
  addGitWorktree,
  removeGitWorktree,
} from "./services/workspace-execution.service";
import { WorkspaceExecutionError } from "./domain/workspace-execution";
import { deriveAttentionItems, attentionId } from "./domain/attention";
import { HandoffService } from "./services/handoff.service";
import { handoffBundleHash, type HandoffBundleV1 } from "./domain/handoff";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithPostgres = TEST_DATABASE_URL ? describe : describe.skip;

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
});
