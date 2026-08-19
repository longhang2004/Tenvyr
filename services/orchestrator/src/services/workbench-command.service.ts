import { Inject, Injectable, Optional } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { DataSource } from "typeorm";
import { OperatorActionEntity } from "../entities/operator-action.entity";
import { PipelineEntity } from "../entities/pipeline.entity";
import { ExecutionEntity } from "../entities/execution.entity";
import { LogicalStepEntity } from "../entities/step-execution.entity";
import { StepAttemptEntity } from "../entities/step-attempt.entity";
import { ExecutionPlanRevisionEntity } from "../entities/execution-plan-revision.entity";
import { ExecutionService } from "./execution.service";
import { RuntimeCoordinationService } from "./runtime-coordination.service";
import { ExecutionCapsuleService } from "./execution-capsule.service";
import { DelegationService } from "./delegation.service";
import { RuntimeConnectionService } from "./runtime-connection.service";
import { WorkspaceService } from "./workspace.service";
import { ModelSourceService } from "./model-source.service";
import { ProviderDiscoveryService } from "./provider-discovery.service";
import { WorkspaceExecutionService } from "./workspace-execution.service";
import { WorkspaceExecutionError } from "../domain/workspace-execution";
import { HandoffService } from "./handoff.service";
import { handoffBundleHash } from "../domain/handoff";
import type { ConnectionProfileV1 } from "../executors/runtime-connection";
import { sha256Json } from "../domain/canonical-json";
import {
  parseCoordinationConfig,
  type CoordinationConfigV1,
} from "../domain/coordination";
import {
  parseAcceptanceEvidence,
  type AcceptanceEvidenceV1,
  type WorkspaceSnapshotV1,
} from "../domain/workspace";
import {
  configFromTeamTemplate,
  TEAM_TEMPLATES,
} from "../domain/team-templates";
import {
  RuntimeOnboardingService,
  isOnboardingRuntimeKind,
  type RuntimeOnboardingStatus,
} from "./runtime-onboarding.service";
import { buildRuntimeConnectionProfile } from "../executors/runtime-profiles";

/**
 * M10-S2: idempotent local operator commands through EXISTING authority
 * services. Every command records durable audit evidence; duplicate
 * delivery (same action + idempotency key) returns the stored outcome
 * instead of re-executing authority. The UI never dispatches a Worker,
 * applies a PlanPatch, advances an iteration, or marks completion
 * directly. Initial actor is the single local operator.
 */

export const PROCESS_INSTANCE_ID = randomUUID();
export function getProcessInstanceId(): string {
  return PROCESS_INSTANCE_ID;
}

export const COMMAND_BOUNDS = {
  idempotencyKeyMax: 128,
  goalMaxChars: 4096,
  runNameMax: 255,
  payloadMaxBytes: 16 * 1024,
} as const;

export type CommandResult = {
  action: string;
  idempotencyKey: string;
  outcome: "executed" | "duplicate";
  result: Record<string, unknown>;
};

export class WorkbenchCommandError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "WorkbenchCommandError";
    this.code = code;
  }
}

@Injectable()
export class WorkbenchCommandService {
  constructor(
    @Inject("DATA_SOURCE") private readonly dataSource: DataSource,
    executionService?: ExecutionService,
    coordination?: RuntimeCoordinationService,
    capsules?: ExecutionCapsuleService,
    connections?: RuntimeConnectionService,
    workspaces?: WorkspaceService,
    modelSources?: ModelSourceService,
    providerDiscovery?: ProviderDiscoveryService,
    @Optional() workspaceExecutions?: WorkspaceExecutionService,
    @Optional() handoffs?: HandoffService,
  ) {
    this.executionService =
      executionService ??
      new ExecutionService(
        this.dataSource.getRepository(ExecutionEntity),
        this.dataSource.getRepository(LogicalStepEntity),
        this.dataSource.getRepository(StepAttemptEntity),
        this.dataSource.getRepository(ExecutionPlanRevisionEntity),
        this.dataSource,
      );
    this.coordination =
      coordination ?? new RuntimeCoordinationService(this.dataSource);
    this.capsules =
      capsules ??
      new ExecutionCapsuleService(
        this.dataSource,
        new DelegationService(this.dataSource, this.executionService),
        this.executionService,
      );
    this.connections =
      connections ?? new RuntimeConnectionService(this.dataSource);
    this.workspaces = workspaces ?? new WorkspaceService(this.dataSource);
    // P2 closure: the model-source commands must receive the REAL service —
    // an unassigned field crashed every model-source command at runtime.
    this.modelSources =
      modelSources ?? new ModelSourceService(this.dataSource);
    // P2 closure round 2: connection-scoped provider discovery (audited
    // test-runtime-target + opencode oauth commands) — wired like the
    // model-source service above (the round-1 DI crash must not repeat).
    this.providerDiscovery =
      providerDiscovery ?? new ProviderDiscoveryService(this.dataSource);
    // PP1: workspace execution / isolation leases (shared | git-worktree).
    this.workspaceExecutions =
      workspaceExecutions ?? new WorkspaceExecutionService(this.dataSource);
    // PP1 Slice C: portable handoff / continuation.
    this.handoffs =
      handoffs ??
      new HandoffService(
        this.dataSource,
        this.executionService,
        this.coordination,
        this.workspaceExecutions,
      );
  }

  private readonly executionService: ExecutionService;
  private readonly coordination: RuntimeCoordinationService;
  private readonly capsules: ExecutionCapsuleService;
  private readonly connections: RuntimeConnectionService;
  private readonly workspaces: WorkspaceService;
  private readonly modelSources: ModelSourceService;
  private readonly providerDiscovery: ProviderDiscoveryService;
  private readonly workspaceExecutions: WorkspaceExecutionService;
  private readonly handoffs: HandoffService;

  private boundedKey(idempotencyKey: string): string {
    if (
      !idempotencyKey ||
      idempotencyKey.length > COMMAND_BOUNDS.idempotencyKeyMax ||
      /[^A-Za-z0-9_.:-]/.test(idempotencyKey)
    ) {
      throw new WorkbenchCommandError(
        "INVALID_IDEMPOTENCY_KEY",
        `idempotencyKey must be 1-${COMMAND_BOUNDS.idempotencyKeyMax} characters of [A-Za-z0-9_.:-]`,
      );
    }
    return idempotencyKey;
  }

  private boundedGoal(goal: unknown): string {
    const raw = typeof goal === "string" ? goal : JSON.stringify(goal ?? {});
    if (raw.length > COMMAND_BOUNDS.goalMaxChars) {
      throw new WorkbenchCommandError(
        "GOAL_TOO_LARGE",
        `goal exceeds ${COMMAND_BOUNDS.goalMaxChars} characters`,
      );
    }
    return raw;
  }

  /**
   * Executes exactly once per (action, idempotencyKey). The audit row is
   * inserted FIRST with a pending marker via INSERT ... ON CONFLICT DO
   * NOTHING — a concurrent duplicate loses the insert (identifiers empty)
   * and returns the winner's stored outcome WITHOUT executing authority.
   * The authority mutation and the outcome CAS commit in the SAME
   * transaction (manager-passable WithManager variants), so a crash can
   * never leave an executed command without evidence or a duplicate
   * authority action, and a caught 23505 can never abort the transaction
   * (Postgres poisons the tx on any error).
   *
   * M10-S2: same idempotency identity + CONFLICTING payload is rejected —
   * the stored request payload (canonical-hashed) is compared on every
   * duplicate delivery, so the same key can never silently execute a
   * different semantic request.
   */
  private async runCommand(
    action: string,
    idempotencyKey: string,
    targetId: string | null,
    payload: Record<string, unknown>,
    execute: (
      manager: import("typeorm").EntityManager,
    ) => Promise<Record<string, unknown>>,
  ): Promise<CommandResult> {
    const key = this.boundedKey(idempotencyKey);
    const actor = "local-operator";
    const payloadHash = sha256Json(payload);
    return this.dataSource.transaction(async (manager) => {
      const actions = manager.getRepository(OperatorActionEntity);
      const inserted = await actions
        .createQueryBuilder()
        .insert()
        .into(OperatorActionEntity)
        .values({
          action,
          idempotencyKey: key,
          actor,
          targetId,
          payload,
          outcome: { pending: true },
        })
        .orIgnore()
        .execute();
      if (inserted.identifiers.length === 0) {
        // A concurrent delivery won the row; its outcome is authoritative
        // and authority was NOT re-executed. The insert waited for that
        // commit, so the row is readable now.
        const winner = await actions.findOne({
          where: { action, idempotencyKey: key },
        });
        if (!winner) throw new Error("Audit row disappeared");
        assertSameRequestPayload(winner.payload, payloadHash, action, key);
        return {
          action,
          idempotencyKey: key,
          outcome: "duplicate",
          result: (winner.outcome as Record<string, unknown>) ?? {},
        };
      }
      // NOTE: with ON CONFLICT DO NOTHING Postgres returns no RETURNING
      // rows, so `identifiers` is NOT the insert proof. The authoritative
      // row is the one visible under (action, key) — ours when still
      // pending, the winner's committed outcome otherwise.
      const row = await actions.findOne({
        where: { action, idempotencyKey: key },
      });
      if (!row) throw new Error("Audit insert produced no row");
      if ((row.outcome as { pending?: boolean })?.pending !== true) {
        assertSameRequestPayload(row.payload, payloadHash, action, key);
        return {
          action,
          idempotencyKey: key,
          outcome: "duplicate",
          result: row.outcome as Record<string, unknown>,
        };
      }
      // A pending row exists with a DIFFERENT payload: a concurrent caller
      // is executing a conflicting semantic request under this key.
      assertSameRequestPayload(row.payload, payloadHash, action, key);
      const result = await execute(manager);
      await actions.update({ id: row.id }, { outcome: result });
      return { action, idempotencyKey: key, outcome: "executed", result };
    });
  }

  /** Launch: pipeline (goal) + execution + coordination run + iteration 1.
   *  The recovery tick drives the engine from here.
   *
   *  PP1: `executionIsolation` (shared | git-worktree) allocates the run's
   *  Tenvyr-owned execution workspace BEFORE the authority transaction
   *  (external git mutations are never transactional); the lease binds to
   *  the run inside it. Allocation failure aborts the launch with the
   *  precise code — never a silent fallback to shared. */
  async startTeamRun(input: {
    idempotencyKey: string;
    name: string;
    goal: unknown;
    config: CoordinationConfigV1;
    /** Product Phase 1: workspace by existing id or by operator path
     *  (frozen into a bounded snapshot at start). */
    workspace?: { workspaceId: string } | { path: string };
    /** Optional operator-declared acceptance evidence (run metadata). */
    acceptanceEvidence?: unknown;
    /** PP1: execution isolation mode for the run's workspace (default
     *  shared = execute against the source workspace itself). */
    executionIsolation?: "shared" | "git-worktree";
  }): Promise<CommandResult> {
    const name = input.name.slice(0, COMMAND_BOUNDS.runNameMax);
    const goal = this.boundedGoal(input.goal);
    const config = parseCoordinationConfig(input.config);
    const acceptanceEvidence: AcceptanceEvidenceV1 | null =
      parseAcceptanceEvidence(input.acceptanceEvidence);
    const executionIsolation =
      input.executionIsolation === "git-worktree"
        ? ("git-worktree" as const)
        : ("shared" as const);

    // P2 final closure: SERVER-SIDE provider readiness enforcement BEFORE
    // the authority transaction. A NEW Team Run may freeze an explicit
    // opencode provider/model target ONLY when the provider is
    // authenticated through that exact connection's CURRENT revision.
    // The probe is external/runtime-owned and runs before the authority
    // transaction; the validated targets are frozen unchanged (never
    // silently rewritten). Frontend bypass, direct REST callers, and
    // stale browser state are all blocked here.
    await this.assertExplicitTargetsReady(config);
    // Freeze the workspace snapshot BEFORE the authority transaction: the
    // snapshot is deterministic run context, never operator-controlled
    // after this point.
    let workspace: WorkspaceSnapshotV1 | null = null;
    if (input.workspace) {
      if ("workspaceId" in input.workspace) {
        workspace = await this.workspaces.refreshWorkspace(
          input.workspace.workspaceId,
        );
      } else {
        const created = await this.workspaces.createWorkspace({
          name,
          path: input.workspace.path,
        });
        workspace = created.snapshot;
      }
    }
    // Dirty source validation: git-worktree requires a clean source repository
    if (
      workspace &&
      workspace.dirty === true &&
      executionIsolation === "git-worktree"
    ) {
      throw new WorkspaceExecutionError(
        "DIRTY_SOURCE_NOT_SUPPORTED",
        `Workspace "${workspace.workspaceId}" has uncommitted changes; git-worktree execution isolation requires a clean source repository (commit or stash changes before starting a run)`,
      );
    }

    // PP1: allocate the Tenvyr-owned execution workspace BEFORE the
    // authority transaction. External git mutations are not transactional;
    // a crash leaves a durable ALLOCATING/READY row that reconciliation
    // fails closed. A failed allocation aborts the launch with the precise
    // code — git-worktree is never silently downgraded to shared.
    let executionWorkspaceAllocation:
      | Awaited<ReturnType<WorkspaceExecutionService["allocateExecutionWorkspace"]>>
      | null = null;
    if (workspace) {
      executionWorkspaceAllocation =
        await this.workspaceExecutions.allocateExecutionWorkspace(
          workspace,
          executionIsolation,
          input.idempotencyKey,
        );
    }
    return this.runCommand(
      "start-team-run",
      input.idempotencyKey,
      null,
      {
        name,
        config: summarizeConfig(config),
        workspace: workspace
          ? {
              workspaceId: workspace.workspaceId,
              path: workspace.path,
              repoRoot: workspace.repoRoot ?? null,
              branch: workspace.branch ?? null,
              headSha: workspace.headSha ?? null,
              dirty: workspace.dirty ?? null,
            }
          : null,
        acceptanceEvidence,
        // Only include the key when a workspace exists: an undefined value
        // would canonicalize to null in the idempotency hash while JSONB
        // storage drops it — a false IDEMPOTENCY_CONFLICT.
        ...(workspace ? { executionIsolation } : {}),
      },
      async (manager) => {
        const pipeline = await manager.getRepository(PipelineEntity).save(
          manager.getRepository(PipelineEntity).create({
            name: name || "team-run",
            version: "1.0",
            steps: [],
          }),
        );
        const execution =
          await this.executionService.materializeExecutionWithManager(
            manager,
            pipeline,
            { goal },
          );
        const run = await this.coordination.startRunWithManager(
          manager,
          execution.id,
          config,
          new Date(Date.now() + config.loopDeadlineMs),
          workspace,
          acceptanceEvidence,
        );
        // PP1: bind the lease to its exclusive run owner inside the
        // authority transaction (UNIQUE ownerRunId; guarded UPDATE).
        let executionWorkspace: unknown = null;
        if (executionWorkspaceAllocation) {
          const bound = await this.workspaceExecutions.bindExecutionWorkspace(
            manager,
            executionWorkspaceAllocation.id,
            run.id,
          );
          executionWorkspace = {
            workspaceExecutionId: bound.id,
            mode: bound.mode,
            path: bound.executionPath,
            baseHeadSha: bound.baseHeadSha,
          };
        }
        const iteration =
          await this.coordination.createNextIterationWithManager(
            manager,
            run.id,
          );
        return {
          executionId: execution.id,
          runId: run.id,
          iterationNumber: iteration.iterationNumber,
          ...(workspace ? { workspace: workspace.path } : {}),
          ...(executionWorkspace ? { executionWorkspace } : {}),
        };
      },
    );
  }

  /** WAIT decision through the existing authority (approve/deny). */
  async resolveWait(input: {
    idempotencyKey: string;
    runId: string;
    approve: boolean;
  }): Promise<CommandResult> {
    return this.runCommand(
      "resolve-wait",
      input.idempotencyKey,
      input.runId,
      { runId: input.runId, approve: input.approve },
      async (manager) => {
        const phase = await this.coordination.resolveWaitWithManager(
          manager,
          input.runId,
          input.approve,
        );
        return { runId: input.runId, phase };
      },
    );
  }

  /** Cancel through the existing whole-execution authority. */
  async cancelExecution(input: {
    idempotencyKey: string;
    executionId: string;
  }): Promise<CommandResult> {
    return this.runCommand(
      "cancel-execution",
      input.idempotencyKey,
      input.executionId,
      { executionId: input.executionId },
      async (manager) => {
        await this.executionService.cancelExecutionWithManager(
          manager,
          input.executionId,
        );
        return { executionId: input.executionId, status: "CANCELLED" };
      },
    );
  }

  /** Controlled replay as a new execution (existing Capsule authority). */
  async replayExecution(input: {
    idempotencyKey: string;
    executionId: string;
  }): Promise<CommandResult> {
    return this.runCommand(
      "replay-execution",
      input.idempotencyKey,
      input.executionId,
      { executionId: input.executionId },
      async (manager) => {
        const replay = await this.capsules.replayWithManager(
          manager,
          input.executionId,
        );
        return {
          sourceExecutionId: input.executionId,
          targetExecutionId: replay.targetExecutionId,
        };
      },
    );
  }

  /**
   * PP1 Slice C: continue a TERMINAL source run as a NEW Team Run on the
   * destination Runtime Target (existing P2 authority validates the frozen
   * targets BEFORE this command). The bounded HandoffBundle is built before
   * the authority transaction; the continuation execution/run + handoff
   * lineage row + exclusive execution-workspace transfer commit atomically.
   */
  async continueRun(input: {
    idempotencyKey: string;
    sourceExecutionId: string;
    config: CoordinationConfigV1;
  }): Promise<CommandResult> {
    const bundle = await this.handoffs.buildHandoffBundle(
      input.sourceExecutionId,
    );
    const bundleHash = handoffBundleHash(bundle);
    // P2 final closure: destination Runtime Target authority is validated
    // against CURRENT provider state BEFORE the authority transaction —
    // exactly like startTeamRun.
    await this.assertExplicitTargetsReady(input.config);
    return this.runCommand(
      "continue-run",
      input.idempotencyKey,
      input.sourceExecutionId,
      {
        sourceExecutionId: input.sourceExecutionId,
        config: summarizeConfig(input.config),
        bundleHash,
      },
      async (manager) => {
        const continued = await this.handoffs.continueRunWithManager(
          manager,
          input.sourceExecutionId,
          input.config,
          bundle,
        );
        return {
          executionId: continued.executionId,
          runId: continued.runId,
          handoffId: continued.handoffId,
          bundleHash: continued.bundleHash,
          sourceExecutionId: input.sourceExecutionId,
        };
      },
    );
  }

  /** M10-S4: bounded structural comparison of two executions. */
  async compareExecutions(input: {
    idempotencyKey: string;
    executionA: string;
    executionB: string;
  }): Promise<CommandResult> {
    return this.runCommand(
      "compare-executions",
      input.idempotencyKey,
      null,
      { executionA: input.executionA, executionB: input.executionB },
      async () => {
        const comparison = await this.capsules.compare(
          input.executionA,
          input.executionB,
        );
        return { comparison };
      },
    );
  }

  /**
   * M10-S2: audited Runtime Connection creation (revision 1). The audit
   * evidence and the authority mutation commit in ONE transaction. The
   * profile is secret-free by construction (credential references only);
   * the audit payload stores the same bounded profile the authority froze.
   */
  async createConnection(input: {
    idempotencyKey: string;
    connectionId: string;
    profile: ConnectionProfileV1;
  }): Promise<CommandResult> {
    const profile = this.boundedProfile(input.profile);
    return this.runCommand(
      "create-connection",
      input.idempotencyKey,
      input.connectionId,
      { connectionId: input.connectionId, profile },
      async (manager) => {
        const revision = await this.connections.createConnectionWithManager(
          manager,
          input.connectionId,
          profile,
        );
        return {
          connectionId: input.connectionId,
          revisionNumber: revision.revisionNumber,
        };
      },
    );
  }

  /** M10-S2: audited revision append (immutable revision N+1). */
  async reviseConnection(input: {
    idempotencyKey: string;
    connectionId: string;
    profile: ConnectionProfileV1;
  }): Promise<CommandResult> {
    const profile = this.boundedProfile(input.profile);
    return this.runCommand(
      "revise-connection",
      input.idempotencyKey,
      input.connectionId,
      { connectionId: input.connectionId, profile },
      async (manager) => {
        const revision = await this.connections.reviseConnectionWithManager(
          manager,
          input.connectionId,
          profile,
        );
        return {
          connectionId: input.connectionId,
          revisionNumber: revision.revisionNumber,
        };
      },
    );
  }

  /**
   * M10-S2: audited terminal revocation. Repeated equivalent revoke
   * commands share one effective authority transition and one durable
   * evidence row.
   */
  async revokeConnection(input: {
    idempotencyKey: string;
    connectionId: string;
  }): Promise<CommandResult> {
    return this.runCommand(
      "revoke-connection",
      input.idempotencyKey,
      input.connectionId,
      { connectionId: input.connectionId },
      async (manager) => {
        const status = await this.connections.revokeConnectionWithManager(
          manager,
          input.connectionId,
        );
        return { connectionId: input.connectionId, status };
      },
    );
  }

  /**
   * PP1 Final Closure: audited safe workspace release command saga.
   *
   * 1. Commits operator intent in PostgreSQL first with outcome = { pending: true, phase: "REQUESTED" }.
   * 2. Reconciles/observes existing execution lease state:
   *    - If lease is already REMOVED: finalizes audit outcome with state: "REMOVED" (no git execution).
   *    - If lease is RELEASE_REQUESTED / PRESERVED: executes safe git worktree removal.
   * 3. On success (clean worktree removal): lease -> REMOVED, audit outcome -> { workspaceExecutionId, state: "REMOVED" }.
   * 4. On refusal (dirty worktree / removal failed): lease stays PRESERVED with failureCode: "WORKTREE_DIRTY",
   *    audit outcome -> { workspaceExecutionId, state: "PRESERVED", failureCode: "WORKTREE_DIRTY", error: "...", refusal: true },
   *    and throws WorkspaceExecutionError("WORKTREE_DIRTY").
   */
   async releaseExecutionWorkspace(input: {
    idempotencyKey: string;
    workspaceExecutionId: string;
    reason?: string;
  }): Promise<CommandResult> {
    const key = this.boundedKey(input.idempotencyKey);
    const action = "release-execution-workspace";
    const targetId = input.workspaceExecutionId;
    const actor = "local-operator";
    const payload = {
      workspaceExecutionId: input.workspaceExecutionId,
      reason: input.reason ?? null,
    };
    const payloadHash = sha256Json(payload);

    // Step 1: Commit operator intent in PostgreSQL BEFORE any external Git removal
    let auditRow = await this.dataSource.transaction(async (manager) => {
      const actions = manager.getRepository(OperatorActionEntity);
      await actions
        .createQueryBuilder()
        .insert()
        .into(OperatorActionEntity)
        .values({
          action,
          idempotencyKey: key,
          actor,
          targetId,
          payload,
          outcome: { pending: true, phase: "REQUESTED" },
        })
        .orIgnore()
        .execute();

      const existing = await actions.findOne({
        where: { action, idempotencyKey: key },
      });
      if (!existing) throw new Error("Audit row disappeared");
      assertSameRequestPayload(existing.payload, payloadHash, action, key);
      return existing;
    });

    let outcome = auditRow.outcome as Record<string, unknown> | undefined;
    // PP1 FINAL: explicit outcome semantics — INTERRUPTED/IN_PROGRESS are NOT success.
    if (outcome && outcome.pending !== true) {
      const state = outcome.state as string | undefined;
      const retryRequired = outcome.retryRequired as boolean | undefined;
      if (outcome.refusal === true) {
        throw new WorkspaceExecutionError(
          (outcome.failureCode as string) ?? "WORKTREE_DIRTY",
          (outcome.error as string) ??
            `Execution workspace "${input.workspaceExecutionId}" release was refused`,
        );
      }
      if (state === "INTERRUPTED" && retryRequired === true) {
        // Allow same operation to be intentionally resumed: reset INTERRUPTED → REQUESTED for retry
        const repo = this.dataSource.getRepository(OperatorActionEntity);
        const reset = await repo
          .createQueryBuilder()
          .update(OperatorActionEntity)
          .set({ outcome: { pending: true, phase: "REQUESTED", resumedFrom: outcome } as unknown as Record<string, unknown> })
          .where("id = :id", { id: auditRow.id })
          .andWhere("outcome->>'state' = 'INTERRUPTED'")
          .execute();
        if ((reset.affected ?? 0) === 1) {
          const refreshed = await repo.findOne({ where: { id: auditRow.id } });
          if (refreshed) {
            auditRow = refreshed;
            outcome = refreshed.outcome as Record<string, unknown> | undefined;
          }
        } else {
          // Concurrent reset — re-read and throw INTERRUPTED for caller to retry
          const refreshed = await repo.findOne({ where: { id: auditRow.id } });
          const out2 = refreshed?.outcome as Record<string, unknown> | undefined;
          if (out2 && out2.state === "INTERRUPTED") {
            throw new WorkspaceExecutionError(
              (out2.failureCode as string) ?? "RELEASE_INTERRUPTED",
              (out2.error as string) ?? "Release was interrupted; retry with the same idempotency key",
            );
          }
          throw new WorkspaceExecutionError(
            (outcome.failureCode as string) ?? "RELEASE_INTERRUPTED",
            (outcome.error as string) ?? "Release was interrupted; retry required",
          );
        }
      } else if (state === "IN_PROGRESS") {
        throw new WorkspaceExecutionError(
          (outcome.failureCode as string) ?? "OPERATION_IN_PROGRESS",
          (outcome.error as string) ?? "Release operation is in progress",
        );
      } else if (state === "REMOVED") {
        return {
          action,
          idempotencyKey: key,
          outcome: "duplicate",
          result: outcome,
        };
      } else if (state === "NOT_FOUND" || state === "PRESERVED") {
        // For non-REMOVED final states, treat as refusal if flagged, otherwise as duplicate success is wrong — throw
        if (outcome.refusal === true) {
          throw new WorkspaceExecutionError(
            (outcome.failureCode as string) ?? "RELEASE_REFUSED",
            (outcome.error as string) ?? `Release was refused (${state})`,
          );
        }
        // If it's a PRESERVED without refusal (should not happen after fix), treat as refusal to avoid false success
        if (state === "PRESERVED") {
          throw new WorkspaceExecutionError(
            (outcome.failureCode as string) ?? "PRESERVED",
            (outcome.error as string) ?? "Workspace is preserved; release was not completed",
          );
        }
        return {
          action,
          idempotencyKey: key,
          outcome: "duplicate",
          result: outcome,
        };
      } else {
        // Unknown final outcome — do not pretend success
        throw new WorkspaceExecutionError(
          (outcome.failureCode as string) ?? "RELEASE_INTERRUPTED",
          (outcome.error as string) ?? "Release outcome requires retry",
        );
      }
    }

    // Step 1.5: Idempotent durable execution ownership — at most one
    // caller drives the external Git mutation for this (action, key).
    // Uses processInstanceId to distinguish active owner vs dead process.
    // The outcome row carries phase: EXECUTING with ownerToken/ownerProcessId/claimedAt once the winner claims
    // ownership; other concurrent callers in the SAME process observe IN_PROGRESS and never run Git.
    // A stale EXECUTING from a previous dead process (different ownerProcessId) may be taken over via CAS.
    const claimed = await this.claimReleaseOwnership(auditRow.id, auditRow.outcome as Record<string, unknown> | undefined);
    if (!claimed.claimed) {
      const authoritative = await this.waitForReleaseFinalOutcome(auditRow.id, key, action);
      const aState = authoritative.state as string | undefined;
      const aRetry = authoritative.retryRequired as boolean | undefined;
      if (authoritative.refusal === true) {
        throw new WorkspaceExecutionError(
          (authoritative.failureCode as string) ?? "WORKTREE_DIRTY",
          (authoritative.error as string) ?? `Execution workspace "${input.workspaceExecutionId}" release was refused`,
        );
      }
      if (aState === "INTERRUPTED" && aRetry === true) {
        throw new WorkspaceExecutionError(
          (authoritative.failureCode as string) ?? "RELEASE_INTERRUPTED",
          (authoritative.error as string) ?? "Release was interrupted; retry with the same idempotency key",
        );
      }
      if (aState === "IN_PROGRESS") {
        throw new WorkspaceExecutionError(
          (authoritative.failureCode as string) ?? "OPERATION_IN_PROGRESS",
          (authoritative.error as string) ?? "Release operation is in progress",
        );
      }
      if (aState === "REMOVED") {
        return {
          action,
          idempotencyKey: key,
          outcome: "duplicate",
          result: authoritative,
        };
      }
      // Any other final state is not success
      throw new WorkspaceExecutionError(
        (authoritative.failureCode as string) ?? "RELEASE_NOT_COMPLETED",
        (authoritative.error as string) ?? `Release not completed (state ${aState ?? "unknown"})`,
      );
    }

    // Step 2: Execute safe release saga (we are the owner) — pass exact operationId for correlation
    // eslint-disable-next-line no-restricted-syntax -- bounded safe release controls its own catch per invariant
    try {
      const released =
        await this.workspaceExecutions.releaseExecutionWorkspace(
          input.workspaceExecutionId,
          auditRow.id,
        );
      const result: Record<string, unknown> = {
        workspaceExecutionId: released.id,
        state: released.state,
      };
      await this.dataSource
        .getRepository(OperatorActionEntity)
        .update({ id: auditRow.id }, { outcome: result });
      return {
        action,
        idempotencyKey: key,
        outcome: "executed",
        result,
      };
    } catch (error) {
      if (error instanceof WorkspaceExecutionError) {
        // H1/PP1 FINAL audit truth: read actual durable workspace state, never hardcode IN_USE etc
        const code = error.code;
        const truthful = await this.truthfulReleaseRefusalOutcome(
          input.workspaceExecutionId,
          code,
          error.message,
        );
        await this.dataSource
          .getRepository(OperatorActionEntity)
          .update({ id: auditRow.id }, { outcome: truthful });
        throw new WorkspaceExecutionError(truthful.failureCode as string, truthful.error as string);
      }
      // Non-WorkspaceExecutionError: mark INTERRUPTED with truthful evidence
      // so a retry can re-enter and recover (no ambiguous pending forever).
      const interrupted: Record<string, unknown> = {
        workspaceExecutionId: input.workspaceExecutionId,
        state: "INTERRUPTED",
        failureCode: "RELEASE_INTERRUPTED",
        error: error instanceof Error ? error.message : String(error),
        retryRequired: true,
      };
      await this.dataSource
        .getRepository(OperatorActionEntity)
        .update({ id: auditRow.id }, { outcome: interrupted });
      throw error;
    }
  }

  /**
   * Product Phase 1: ONE-CLICK guided runtime onboarding. Detect the
   * executable on PATH -> probe version/auth -> create the connection from
   * the documented template -> test it. Never reads credentials.
   */
  async onboardRuntime(input: {
    idempotencyKey: string;
    runtimeKind: string;
    /** Optional operator-chosen connection id (default: conn:<kind>). */
    connectionId?: string;
    name?: string;
  }): Promise<CommandResult> {
    if (!isOnboardingRuntimeKind(input.runtimeKind)) {
      throw new WorkbenchCommandError(
        "RUNTIME_NOT_SUPPORTED",
        `onboarding supports codex/claude/opencode, got "${input.runtimeKind}"`,
      );
    }
    const status = await new RuntimeOnboardingService().status(
      input.runtimeKind,
    );
    if (!status.detected || !status.connectPayload) {
      throw new WorkbenchCommandError(
        "RUNTIME_NOT_DETECTED",
        `"${input.runtimeKind}" was not detected on PATH; install the official CLI first`,
      );
    }
    const connectionId = input.connectionId ?? `conn:${input.runtimeKind}`;
    const created = await this.createConnection({
      idempotencyKey: `${input.idempotencyKey}:create`,
      connectionId,
      profile: buildRuntimeConnectionProfile({
        runtimeKind: input.runtimeKind,
        name: input.name ?? `runtime:${input.runtimeKind}`,
        executorId: "local-host",
        executable: status.connectPayload.executable,
        ...(status.connectPayload.version
          ? { version: status.connectPayload.version }
          : {}),
      }),
    });
    const tested = await this.testConnection({
      idempotencyKey: `${input.idempotencyKey}:test`,
      connectionId,
    });
    return {
      action: "onboard-runtime",
      idempotencyKey: input.idempotencyKey,
      outcome: created.outcome === "duplicate" ? "duplicate" : "executed",
      result: {
        connectionId,
        runtimeKind: input.runtimeKind,
        detected: true,
        version: status.version ?? null,
        authReady: status.authReady,
        guidance: status.guidance,
        create: created.result,
        test: tested.result,
      },
    };
  }

  /** Product Phase 1: create/refresh a stable workspace from a local path
   *  (bounded git identity capture; never reads credentials). */
  async createWorkspace(input: {
    idempotencyKey: string;
    name?: string;
    path: string;
  }): Promise<CommandResult> {
    return this.runCommand(
      "create-workspace",
      input.idempotencyKey,
      null,
      { name: input.name ?? null, path: input.path },
      async () => {
        const created = await this.workspaces.createWorkspace({
          name: input.name ?? "workspace",
          path: input.path,
        });
        return {
          workspaceId: created.id,
          snapshot: created.snapshot,
        };
      },
    );
  }

  /** Product Phase 1: the bounded team templates (roles + useful bounds +
   *  goal framing; Planner still proposes, Tenvyr still authorizes). */
  teamTemplates(): {
    templateId: string;
    name: string;
    description: string;
    goalFraming: string;
    defaultBounds: Record<string, number>;
    configSkeleton: CoordinationConfigV1;
    roleSuggestions: unknown;
  }[] {
    return TEAM_TEMPLATES.map((template) => ({
      templateId: template.templateId,
      name: template.name,
      description: template.description,
      goalFraming: template.goalFraming,
      defaultBounds: { ...template.defaultBounds },
      configSkeleton: configFromTeamTemplate(template.templateId),
      roleSuggestions: template.roleSuggestions,
    }));
  }

  /**
   * M10-S2: audited connection test. Testing does not change authority;
   * the command retains bounded evidence that the operator requested the
   * test (the secret-free receipt, never probe output or credentials).
   * The probe is bounded and rate-limited by the connection service.
   */
  async testConnection(input: {
    idempotencyKey: string;
    connectionId: string;
  }): Promise<CommandResult> {
    return this.runCommand(
      "test-connection",
      input.idempotencyKey,
      input.connectionId,
      { connectionId: input.connectionId },
      async (manager) => {
        // The probe must see the audit row's committed revision context;
        // it resolves the CURRENT revision itself under the service's
        // own claim lock and returns a bounded, secret-free receipt.
        const receipt = await this.connections.testConnection(
          input.connectionId,
        );
        return {
          connectionId: input.connectionId,
          receipt: {
            revisionNumber: receipt.revisionNumber,
            testedAt: receipt.testedAt,
            state: receipt.state,
            reasonCode: receipt.reasonCode,
            durationMs: receipt.durationMs,
            ...(receipt.testedVersion !== undefined
              ? { testedVersion: receipt.testedVersion }
              : {}),
            ...(receipt.superseded === true ? { superseded: true } : {}),
          },
        };
      },
    );
  }

  // P2: audited Model Source commands. Catalogs are bounded on-demand
  // projections returned to the caller — never persisted as authority.
  // Credential env REFERENCES only; values never cross this layer.
  // P2 closure (M10 invariant): every authority mutation runs through the
  // runCommand EntityManager (WithManager variants) so the authority row,
  // the OperatorAction evidence row, and the stored outcome commit
  // atomically — a failure anywhere rolls the whole transaction back.

  async createModelSource(input: {
    idempotencyKey: string;
    source: unknown;
  }): Promise<CommandResult> {
    return this.runCommand(
      "model-source-create",
      input.idempotencyKey,
      null,
      { source: input.source as Record<string, unknown> },
      async (manager) => {
        const source = await this.modelSources.createWithManager(
          manager,
          input.source,
        );
        return { source };
      },
    );
  }

  async updateModelSource(input: {
    idempotencyKey: string;
    sourceId: string;
    patch: unknown;
  }): Promise<CommandResult> {
    return this.runCommand(
      "model-source-update",
      input.idempotencyKey,
      input.sourceId,
      {
        sourceId: input.sourceId,
        patch: input.patch as Record<string, unknown>,
      },
      async (manager) => {
        const source = await this.modelSources.updateWithManager(
          manager,
          input.sourceId,
          input.patch,
        );
        return { source };
      },
    );
  }

  async deleteModelSource(input: {
    idempotencyKey: string;
    sourceId: string;
  }): Promise<CommandResult> {
    return this.runCommand(
      "model-source-delete",
      input.idempotencyKey,
      input.sourceId,
      { sourceId: input.sourceId },
      async (manager) => {
        await this.modelSources.deleteWithManager(manager, input.sourceId);
        return { sourceId: input.sourceId, deleted: true };
      },
    );
  }

  /** Test Model Source (endpoint/auth/catalog — never inference). */
  async testModelSource(input: {
    idempotencyKey: string;
    sourceId: string;
  }): Promise<CommandResult> {
    return this.runCommand(
      "model-source-test",
      input.idempotencyKey,
      input.sourceId,
      { sourceId: input.sourceId },
      async (manager) => {
        const source = await this.modelSources.testWithManager(
          manager,
          input.sourceId,
        );
        return { source };
      },
    );
  }

  /** Refresh Models: bounded on-demand catalog projection. */
  async refreshModelSource(input: {
    idempotencyKey: string;
    sourceId: string;
  }): Promise<CommandResult> {
    return this.runCommand(
      "model-source-refresh",
      input.idempotencyKey,
      input.sourceId,
      { sourceId: input.sourceId },
      async (manager) => {
        const { source, catalog } = await this.modelSources.refreshWithManager(
          manager,
          input.sourceId,
        );
        return { source, catalog };
      },
    );
  }

  /**
   * Server-side provider readiness: every explicit model target on an
   * opencode connection must reference a provider authenticated through
   * that EXACT connection revision. Zero authenticated providers means NO
   * explicit provider/model target may launch. Runtime default (no
   * modelId) remains available with its documented semantics: no model
   * argument is composed and the runtime resolves its own default.
   * Historical frozen executions are never touched.
   */
  private async assertExplicitTargetsReady(config: CoordinationConfigV1): Promise<void> {
    const targets: Array<{ connectionId: string; modelId?: string }> = [];
    if (config.plannerTarget?.connectionId) {
      targets.push(config.plannerTarget);
    }
    if (config.verifierTarget?.connectionId) {
      targets.push(config.verifierTarget);
    }
    for (const target of config.allowedTargets ?? []) {
      targets.push(target);
    }
    const explicitByConnection = new Map<string, string[]>();
    for (const target of targets) {
      if (!target.modelId) continue;
      const list = explicitByConnection.get(target.connectionId) ?? [];
      list.push(target.modelId);
      explicitByConnection.set(target.connectionId, list);
    }
    for (const [connectionId, modelIds] of explicitByConnection) {
      // Resolve the exact revision (rejects missing/revoked) and discover
      // the CURRENT provider state through it.
      let discovery: Awaited<
        ReturnType<ProviderDiscoveryService["discoverRuntimeProviders"]>
      >;
      try {
        discovery = await this.providerDiscovery.discoverRuntimeProviders(connectionId);
      } catch (error) {
        // CONNECTION_NOT_FOUND / CONNECTION_REVOKED propagate as-is.
        throw error;
      }
      if (discovery.runtimeKind !== "opencode") continue;
      const connected = discovery.providers.filter((p) => p.authenticated);
      for (const modelId of modelIds) {
        const providerId = modelId.includes("/") ? modelId.split("/")[0] : null;
        if (!providerId) {
          // An explicit model without a provider prefix cannot be proven
          // against the runtime's provider state — fail closed.
          throw new WorkbenchCommandError(
            "PROVIDER_NOT_AUTHENTICATED",
            `model "${modelId}" on "${connectionId}" has no provider prefix; explicit opencode targets must reference a connected provider`,
          );
        }
        if (!connected.some((p) => p.providerId === providerId)) {
          throw new WorkbenchCommandError(
            "PROVIDER_NOT_AUTHENTICATED",
            `provider "${providerId}" is not authenticated through "${connectionId}" (revision ${discovery.revisionNumber}) — connect it on the Runtimes page first`,
          );
        }
      }
    }
  }

  /**
   * Test Runtime Target (P2 closure round 2): a SMALL BOUNDED REAL
   * INVOCATION through the selected Runtime Connection's frozen profile
   * and the requested model — audited because it may consume external
   * provider credits/tokens. Failure is surfaced as failure, never READY.
   */
  async testRuntimeTarget(input: {
    idempotencyKey: string;
    connectionId: string;
    modelId: string;
  }): Promise<CommandResult> {
    const connectionId = input.connectionId.slice(0, 255);
    const modelId = input.modelId.slice(0, 255);
    return this.runCommand(
      "test-runtime-target",
      input.idempotencyKey,
      connectionId,
      { connectionId, modelId },
      async () => {
        const evidence = await this.providerDiscovery.testRuntimeTarget(
          connectionId,
          modelId,
        );
        return { evidence };
      },
    );
  }

  /** OpenCode OAuth: BEGIN the runtime-owned auth flow. Resolves the exact
   *  connection revision, starts a LIVE management server, validates the
   *  methodIndex against the fresh auth-method snapshot, performs POST
   *  authorize — and RETAINS the same live session for the completion
   *  step (OpenCode pending state is instance-local). Audited. */
  async openCodeOauthBegin(input: {
    idempotencyKey: string;
    connectionId: string;
    providerId: string;
    methodIndex: number;
  }): Promise<CommandResult> {
    const connectionId = input.connectionId.slice(0, 255);
    const providerId = input.providerId.slice(0, 255);
    const methodIndex = input.methodIndex;
    return this.runCommand(
      "opencode-oauth-begin",
      input.idempotencyKey,
      connectionId,
      { connectionId, providerId, methodIndex },
      async () => {
        const flow = await this.providerDiscovery.beginAuthFlow({
          connectionId,
          providerId,
          methodIndex,
        });
        return {
          authFlowId: flow.authFlowId,
          url: flow.url,
          method: flow.method,
          instructions: flow.instructions,
          connectionId: flow.connectionId,
          connectionRevision: flow.connectionRevision,
          providerId: flow.providerId,
        };
      },
    );
  }

/** OpenCode OAuth: COMPLETE through the SAME live session that performed
   *  authorize; proves connected via a refreshed GET /provider; then
   *  closes the server and removes the flow. The bounded code (code flow
   *  only) is never logged or persisted. Audited. */
  async openCodeOauthComplete(input: {
    idempotencyKey: string;
    authFlowId: string;
    code?: string;
  }): Promise<CommandResult> {
    const authFlowId = input.authFlowId.slice(0, 64);
    return this.runCommand(
      "opencode-oauth-complete",
      input.idempotencyKey,
      authFlowId,
      { authFlowId, ...(input.code !== undefined ? { hasCode: true } : {}) },
      async () => {
        const { connected, providerId, connectionId } =
          await this.providerDiscovery.completeAuthFlow(authFlowId, input.code);
        return { providerId, connectionId, connected };
      },
    );
  }

  // ---- Safe Release execution ownership + audit truth (PP1 final closure) ----

  private async claimReleaseOwnership(
    auditRowId: string,
    outcome: Record<string, unknown> | undefined,
  ): Promise<{ claimed: boolean }> {
    const phase = (outcome as { phase?: string } | undefined)?.phase;
    const ownerProcessId = (outcome as { ownerProcessId?: string } | undefined)?.ownerProcessId;
    const repo = this.dataSource.getRepository(OperatorActionEntity);
    if (outcome?.pending === true && phase === "REQUESTED") {
      const ownerToken = randomUUID();
      const result = await repo
        .createQueryBuilder()
        .update(OperatorActionEntity)
        .set({
          outcome: {
            pending: true,
            phase: "EXECUTING",
            ownerToken,
            ownerProcessId: PROCESS_INSTANCE_ID,
            claimedAt: new Date().toISOString(),
          } as unknown as Record<string, unknown>,
        })
        .where("id = :id", { id: auditRowId })
        .andWhere("(outcome->>'pending')::boolean = true")
        .andWhere("outcome->>'phase' = 'REQUESTED'")
        .execute();
      return { claimed: (result.affected ?? 0) === 1 };
    }
    if (outcome?.pending === true && phase === "EXECUTING") {
      // Active owner in same process → cannot claim
      if (ownerProcessId === PROCESS_INSTANCE_ID) {
        return { claimed: false };
      }
      // Stale owner from previous dead process → explicit takeover via CAS
      const newToken = randomUUID();
      const result = await repo
        .createQueryBuilder()
        .update(OperatorActionEntity)
        .set({
          outcome: {
            pending: true,
            phase: "EXECUTING",
            ownerToken: newToken,
            ownerProcessId: PROCESS_INSTANCE_ID,
            claimedAt: new Date().toISOString(),
            takenOverFrom: ownerProcessId ?? null,
          } as unknown as Record<string, unknown>,
        })
        .where("id = :id", { id: auditRowId })
        .andWhere("(outcome->>'pending')::boolean = true")
        .andWhere("outcome->>'phase' = 'EXECUTING'")
        .andWhere("outcome->>'ownerProcessId' = :oldProcessId", {
          oldProcessId: ownerProcessId ?? "",
        })
        .execute();
      if ((result.affected ?? 0) === 1) return { claimed: true };
      // If old ownerProcessId was null/undefined (legacy), try without that predicate
      if (!ownerProcessId) {
        const fallback = await repo
          .createQueryBuilder()
          .update(OperatorActionEntity)
          .set({
            outcome: {
              pending: true,
              phase: "EXECUTING",
              ownerToken: newToken,
              ownerProcessId: PROCESS_INSTANCE_ID,
              claimedAt: new Date().toISOString(),
              takenOverFrom: null,
            } as unknown as Record<string, unknown>,
          })
          .where("id = :id", { id: auditRowId })
          .andWhere("(outcome->>'pending')::boolean = true")
          .andWhere("outcome->>'phase' = 'EXECUTING'")
          .execute();
        return { claimed: (fallback.affected ?? 0) === 1 };
      }
      return { claimed: false };
    }
    return { claimed: false };
  }

  private async waitForReleaseFinalOutcome(
    auditRowId: string,
    _key: string,
    _action: string,
  ): Promise<Record<string, unknown>> {
    const repo = this.dataSource.getRepository(OperatorActionEntity);
    for (let attempt = 0; attempt < 20; attempt++) {
      const row = await repo.findOne({ where: { id: auditRowId } });
      const out = row?.outcome as Record<string, unknown> | undefined;
      if (out && out.pending !== true) return out;
      if (out?.pending === true && (out as { phase?: string }).phase === "EXECUTING") {
        const ownerPid = (out as { ownerProcessId?: string }).ownerProcessId;
        // PP1 FINAL: normal duplicate while owner is alive (same process) MUST NOT run Git via reconcile.
        // Only poll, return IN_PROGRESS if timeout.
        if (ownerPid === PROCESS_INSTANCE_ID) {
          // Active owner — just wait
        } else {
          // Stale owner from dead process — we could attempt takeover, but this path is for waiting duplicates;
          // the caller will attempt takeover via claimReleaseOwnership on retry. Here just wait for that takeover to complete.
        }
        // Do NOT call reconcileWorkspaceExecutions here — that would execute Git while owner is alive (exactly-one violation)
      }
      if (attempt < 19) await new Promise((r) => setTimeout(r, 100));
    }
    const finalRow = await repo.findOne({ where: { id: auditRowId } });
    const fin = finalRow?.outcome as Record<string, unknown> | undefined;
    if (fin && fin.pending !== true) return fin as Record<string, unknown>;
    // Still pending EXECUTING after timeout → report IN_PROGRESS truthfully, never fabricate REMOVED
    if (fin && fin.pending === true && (fin as { phase?: string }).phase === "EXECUTING") {
      return {
        workspaceExecutionId: (fin.workspaceExecutionId as string | undefined) ?? (finalRow?.targetId as string | undefined) ?? "",
        state: "IN_PROGRESS",
        failureCode: "OPERATION_IN_PROGRESS",
        error: "Release operation is in progress; retry with the same idempotency key to observe the final outcome",
      };
    }
    // Still pending REQUESTED → also IN_PROGRESS
    if (fin && fin.pending === true) {
      return {
        workspaceExecutionId: (fin.workspaceExecutionId as string | undefined) ?? (finalRow?.targetId as string | undefined) ?? "",
        state: "IN_PROGRESS",
        failureCode: "OPERATION_IN_PROGRESS",
        error: "Release operation is pending; retry to observe outcome",
      };
    }
    return (fin as Record<string, unknown>) ?? { state: "INTERRUPTED", failureCode: "RELEASE_INTERRUPTED", retryRequired: true };
  }

  private async truthfulReleaseRefusalOutcome(
    workspaceExecutionId: string,
    code: string,
    message: string,
  ): Promise<Record<string, unknown>> {
    // PP1 FINAL §5: audit must read actual durable workspace state, never hardcode IN_USE etc
    if (code === "LEASE_NOT_FOUND") {
      return {
        workspaceExecutionId,
        state: "NOT_FOUND",
        failureCode: "LEASE_NOT_FOUND",
        error: message,
        refusal: true,
      };
    }
    try {
      const { WorkspaceExecutionEntity } = await import("../entities/workspace-execution.entity");
      const repo = this.dataSource.getRepository(WorkspaceExecutionEntity);
      const lease = await repo.findOne({ where: { id: workspaceExecutionId } as unknown as Record<string, unknown> });
      if (!lease) {
        return {
          workspaceExecutionId,
          state: "NOT_FOUND",
          failureCode: "LEASE_NOT_FOUND",
          error: `Execution workspace "${workspaceExecutionId}" does not exist`,
          refusal: true,
        };
      }
      const actualState = (lease as unknown as { state: string }).state;
      const hasUncommittedWork = (lease as unknown as { hasUncommittedWork?: boolean | null }).hasUncommittedWork;
      // For LEASE_NOT_RELEASABLE and similar, record the actual observed state, not a hardcoded IN_USE
      return {
        workspaceExecutionId,
        state: actualState,
        failureCode: code,
        error: message,
        refusal: true,
        ...(hasUncommittedWork !== null && hasUncommittedWork !== undefined ? { hasUncommittedWork } : {}),
      };
    } catch {
      // Fallback if DB read fails — still truthful code but state is unknown; do not hardcode IN_USE
      return {
        workspaceExecutionId,
        state: "PRESERVED",
        failureCode: code,
        error: message,
        refusal: true,
      };
    }
  }

  private boundedProfile(profile: ConnectionProfileV1): ConnectionProfileV1 {
    const rendered = JSON.stringify(profile);
    if (rendered.length > COMMAND_BOUNDS.payloadMaxBytes) {
      throw new WorkbenchCommandError(
        "PAYLOAD_TOO_LARGE",
        `connection profile exceeds ${COMMAND_BOUNDS.payloadMaxBytes} bytes`,
      );
    }
    return profile;
  }

  /** Audit trail (bounded, newest first). */
  async auditTrail(
    action?: string,
    limit = 50,
  ): Promise<{
    items: Array<{
      id: string;
      action: string;
      idempotencyKey: string;
      actor: string;
      targetId: string | null;
      outcome: Record<string, unknown>;
      createdAt: string;
    }>;
    truncated: boolean;
  }> {
    const take = Math.min(Math.max(limit, 1), 100);
    const rows = await this.dataSource
      .getRepository(OperatorActionEntity)
      .find({
        where: action ? { action } : {},
        order: { createdAt: "DESC" },
        take: take + 1,
      });
    const truncated = rows.length > take;
    return {
      items: rows.slice(0, take).map((row) => ({
        id: row.id,
        action: row.action,
        idempotencyKey: row.idempotencyKey,
        actor: row.actor,
        targetId: row.targetId ?? null,
        outcome: row.outcome,
        createdAt:
          row.createdAt instanceof Date
            ? row.createdAt.toISOString()
            : String(row.createdAt),
      })),
      truncated,
    };
  }
}

/** Redacted config summary for the audit payload (never secrets). */
function summarizeConfig(
  config: CoordinationConfigV1,
): Record<string, unknown> {
  return {
    planner: config.planner,
    verifier: config.verifier,
    workerAgents: config.allowedWorkers
      .filter((selection) => selection.kind === "agent")
      .map((selection) => selection.name),
    workerConnections: config.allowedWorkers
      .filter((selection) => selection.kind === "connection")
      .map((selection) => selection.name),
    maxIterations: config.maxIterations,
    maxWorkersPerIteration: config.maxWorkersPerIteration,
    maxTotalWorkers: config.maxTotalWorkers,
    loopDeadlineMs: config.loopDeadlineMs,
    budgetAccountId: config.budgetAccountId ?? null,
  };
}

/**
 * M10-S2: same (action, idempotencyKey) with a DIFFERENT semantic request
 * payload is a conflict, never a silent re-execution. The stored payload
 * is compared by canonical hash (key order and formatting insensitive).
 */
function assertSameRequestPayload(
  stored: Record<string, unknown> | null | undefined,
  expectedHash: string,
  action: string,
  key: string,
): void {
  if (!stored) return; // legacy rows without payload: no comparison possible
  if (sha256Json(stored) !== expectedHash) {
    throw new WorkbenchCommandError(
      "IDEMPOTENCY_CONFLICT",
      `idempotencyKey "${key}" for action "${action}" was already used with a different request payload`,
    );
  }
}
