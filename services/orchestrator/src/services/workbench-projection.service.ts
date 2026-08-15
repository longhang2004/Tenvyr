import { Inject, Injectable } from "@nestjs/common";
import { DataSource, In } from "typeorm";
import { RuntimeConnectionService } from "./runtime-connection.service";
import { RuntimeConnectionEntity } from "../entities/runtime-connection.entity";
import { ConnectionRevisionEntity } from "../entities/connection-revision.entity";
import { ExecutionEntity } from "../entities/execution.entity";
import { CoordinationRunEntity } from "../entities/coordination-run.entity";
import { CoordinationIterationEntity } from "../entities/coordination-iteration.entity";
import { LogicalStepEntity } from "../entities/step-execution.entity";
import { StepAttemptEntity } from "../entities/step-attempt.entity";
import { ExecutionPlanRevisionEntity } from "../entities/execution-plan-revision.entity";
import { ApprovalRequestEntity } from "../entities/approval-request.entity";
import { ArtifactEntity } from "../entities/artifact.entity";
import { DelegationService } from "./delegation.service";
import { ExecutionService } from "./execution.service";
import { ExecutionCapsuleService } from "./execution-capsule.service";

/**
 * M10-S1: bounded Workbench read projections. Every response has stable
 * ids, a server timestamp, per-section bounds with truncation metadata,
 * and NO raw secrets, credential refs, unselected context, raw logs,
 * chain of thought, or artifact bytes. Cache/browser state never decides
 * authority: these are projections of PostgreSQL + current services only.
 */

export const WORKBENCH_BOUNDS = {
  maxExecutionsPerPage: 50,
  maxGoalChars: 4096,
  maxIterations: 100,
  maxWorkersPerIteration: 64,
  maxAttemptsPerExecution: 200,
  maxArtifactRefs: 64,
  maxReasonChars: 512,
  maxNameChars: 255,
} as const;

export type WorkbenchConnectionCardV1 = {
  connectionId: string;
  name: string;
  runtimeKind: string;
  executorId: string;
  testedVersion: string | null;
  status: string;
  reasonCode: string | null;
  testedAt: string | null;
  capabilities: Array<{ key: string; supported: boolean; source: string }>;
  revoked: boolean;
};

export type WorkbenchExecutionSummaryV1 = {
  id: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  terminationReason: string | null;
  coordinationPhase: string | null;
  iterationNumber: number | null;
  stepCount: number;
};

export type WorkbenchExecutionProjectionV1 = {
  schemaVersion: 1;
  serverTime: string;
  execution: {
    id: string;
    status: string;
    createdAt: string;
    updatedAt: string;
    terminationReason: string | null;
    /** Bounded goal preview; never raw unselected context. */
    goal: { preview: string; truncated: boolean };
    planRevisionCount: number;
    activePlanRevisionId: string | null;
  };
  coordination: {
    run: {
      runId: string;
      phase: string;
      currentIterationNumber: number;
      cumulativeWorkers: number;
      maxIterations: number;
      maxWorkersPerIteration: number;
      maxTotalWorkers: number;
      remainingDeadlineMs: number;
      budgetAccountId: string | null;
      waitReason: string | null;
      /** Product Phase 1: frozen workspace snapshot (bounded); null when
       *  the run has no workspace. */
      workspace: unknown;
      /** Operator-declared acceptance evidence (run metadata only). */
      acceptanceEvidence: unknown;
    };
    iterations: Array<{
      iterationNumber: number;
      plannerStepId: string | null;
      plannerProposal: {
        reason: string;
        tasks: Array<{
          taskId: string;
          agent: string;
          connectionId?: string;
          required: boolean;
          dependsOn: string[];
          reason: string;
        }>;
      } | null;
      workerManifest: Array<{
        taskId: string;
        logicalStepId: string;
        required: boolean;
        status: string;
      }>;
      verifierStepId: string | null;
      decisionAction: string | null;
      decisionReason: string | null;
      decisionRecommendation: {
        reason: string;
        focus: string[];
      } | null;
      decisionHash: string | null;
      outcome: string | null;
    }>;
    truncated: boolean;
  } | null;
  attempts: Array<{
    stepId: string;
    attemptNumber: number;
    status: string;
    terminalAt: string | null;
    error: string | null;
  }>;
  attemptsTruncated: boolean;
  approvals: { pending: number; decided: number };
  artifacts: Array<{
    artifactId: string;
    descriptorOrdinal: number;
    descriptorHash: string;
  }>;
  artifactsTruncated: boolean;
  delegation: {
    supervisedTotal: number;
    observedTotal: number;
    truncated: boolean;
  };
  capsule: { contentHash: string | null } | null;
  bounds: typeof WORKBENCH_BOUNDS;
};

@Injectable()
export class WorkbenchProjectionService {
  constructor(
    @Inject("DATA_SOURCE") private readonly dataSource: DataSource,
    connections?: RuntimeConnectionService,
    delegation?: DelegationService,
    executionService?: ExecutionService,
  ) {
    this.connections =
      connections ?? new RuntimeConnectionService(this.dataSource);
    this.executionService =
      executionService ??
      new ExecutionService(
        this.dataSource.getRepository(ExecutionEntity),
        this.dataSource.getRepository(LogicalStepEntity),
        this.dataSource.getRepository(StepAttemptEntity),
        this.dataSource.getRepository(ExecutionPlanRevisionEntity),
        this.dataSource,
      );
    this.delegation =
      delegation ??
      new DelegationService(this.dataSource, this.executionService);
    this.capsules = new ExecutionCapsuleService(
      this.dataSource,
      this.delegation,
      this.executionService,
    );
  }

  private readonly connections: RuntimeConnectionService;
  private readonly delegation: DelegationService;
  private readonly executionService: ExecutionService;
  private readonly capsules: ExecutionCapsuleService;

  /** M10-S4: bounded Capsule summary for the Workbench inspection view. */
  async capsuleFor(executionId: string): Promise<unknown> {
    const capsule = await this.capsules.build(executionId);
    return {
      schemaVersion: capsule.schemaVersion,
      pointInTime: capsule.pointInTime,
      sourceStatus: capsule.sourceStatus,
      contentHash: capsule.contentHash,
      header: {
        stepCount: capsule.header.stepCount,
        revisionCount: capsule.header.revisionCount,
        attemptCount: capsule.header.attemptCount,
        budget: capsule.header.budget,
        policy: capsule.header.policy,
        approvals: capsule.header.approvals,
        delegation: capsule.header.delegation,
        artifacts: capsule.header.artifacts,
      },
      coordination: capsule.coordination ?? null,
      evidenceCompleteness: capsule.evidenceCompleteness,
    };
  }

  async connectionCards(): Promise<{
    cards: WorkbenchConnectionCardV1[];
    serverTime: string;
  }> {
    const rows = await this.connections.listConnections();
    const cards: WorkbenchConnectionCardV1[] = [];
    for (const row of rows) {
      const connection = await this.dataSource
        .getRepository(RuntimeConnectionEntity)
        .findOne({ where: { connectionId: row.connectionId } });
      const status = connection
        ? await this.connections.connectionStatus(row.connectionId)
        : null;
      const latestRevision = await this.dataSource
        .getRepository(ConnectionRevisionEntity)
        .findOne({
          where: { connectionId: row.connectionId },
          order: { revisionNumber: "DESC" },
        });
      cards.push({
        connectionId: row.connectionId,
        name: row.name.slice(0, WORKBENCH_BOUNDS.maxNameChars),
        runtimeKind: row.runtimeKind,
        executorId: row.executorId,
        testedVersion: connection?.statusTestedVersion ?? row.version,
        status: status?.state ?? "UNKNOWN",
        reasonCode: status?.reasonCode ?? null,
        testedAt: status?.testedAt ?? null,
        capabilities: Object.entries(
          latestRevision?.profile?.declaredCapabilities ?? {},
        )
          .slice(0, 64)
          .map(([key, value]) => ({
            key,
            supported:
              typeof value === "boolean"
                ? value
                : Boolean(
                    value &&
                    typeof value === "object" &&
                    (value as { supported?: boolean }).supported,
                  ),
            source: "declared",
          })),
        revoked: status?.state === "REVOKED",
      });
    }
    return { cards, serverTime: new Date().toISOString() };
  }

  async executionSummaries(page = 1): Promise<{
    items: WorkbenchExecutionSummaryV1[];
    serverTime: string;
    page: number;
    truncated: boolean;
  }> {
    const take = WORKBENCH_BOUNDS.maxExecutionsPerPage;
    const executions = await this.dataSource
      .getRepository(ExecutionEntity)
      .find({ order: { createdAt: "DESC" }, skip: (page - 1) * take, take });
    const executionIds = executions.map((execution) => execution.id);
    const runs = await this.dataSource
      .getRepository(CoordinationRunEntity)
      .find({ where: { executionId: In(executionIds) } });
    const steps = await this.dataSource
      .getRepository(LogicalStepEntity)
      .find({ where: { executionId: In(executionIds) } });
    const runByExecution = new Map(runs.map((run) => [run.executionId, run]));
    const stepCounts = new Map<string, number>();
    for (const step of steps) {
      stepCounts.set(
        step.executionId,
        (stepCounts.get(step.executionId) ?? 0) + 1,
      );
    }
    const items = executions.map((execution) => {
      const run = runByExecution.get(execution.id);
      return {
        id: execution.id,
        status: execution.status,
        createdAt: execution.createdAt.toISOString(),
        updatedAt: execution.updatedAt.toISOString(),
        terminationReason: execution.terminationReason ?? null,
        coordinationPhase: run?.phase ?? null,
        iterationNumber: run?.currentIterationNumber ?? null,
        stepCount: stepCounts.get(execution.id) ?? 0,
      };
    });
    return {
      items,
      serverTime: new Date().toISOString(),
      page,
      truncated: items.length === take,
    };
  }

  async executionProjection(
    executionId: string,
  ): Promise<WorkbenchExecutionProjectionV1> {
    const execution = await this.dataSource
      .getRepository(ExecutionEntity)
      .findOne({ where: { id: executionId } });
    if (!execution) {
      throw new WorkbenchProjectionError(
        "EXECUTION_NOT_FOUND",
        `Execution "${executionId}" does not exist`,
      );
    }
    const serverTime = new Date().toISOString();
    const planRevisionCount = await this.dataSource
      .getRepository(ExecutionPlanRevisionEntity)
      .count({ where: { executionId } });
    const goalRaw = JSON.stringify(execution.input ?? {});
    const goalTruncated = goalRaw.length > WORKBENCH_BOUNDS.maxGoalChars;
    const goalPreview = goalTruncated
      ? goalRaw.slice(0, WORKBENCH_BOUNDS.maxGoalChars)
      : goalRaw;

    // Coordination loop projection.
    const run = await this.dataSource
      .getRepository(CoordinationRunEntity)
      .findOne({ where: { executionId } });
    let coordination: WorkbenchExecutionProjectionV1["coordination"] = null;
    if (run) {
      const iterations = await this.dataSource
        .getRepository(CoordinationIterationEntity)
        .find({
          where: { coordinationRunId: run.id },
          order: { iterationNumber: "ASC" },
        });
      const iterationTruncated =
        iterations.length > WORKBENCH_BOUNDS.maxIterations;
      const boundedIterations = iterations.slice(
        0,
        WORKBENCH_BOUNDS.maxIterations,
      );
      const workerStatuses = new Map<string, string>();
      const workerIds = boundedIterations.flatMap((iteration) =>
        iteration.workerManifest.map((entry) => entry.logicalStepId),
      );
      if (workerIds.length > 0) {
        const steps = await this.dataSource
          .getRepository(LogicalStepEntity)
          .find({ where: { id: In(workerIds) } });
        for (const step of steps) {
          workerStatuses.set(step.id, step.status);
        }
      }
      coordination = {
        run: {
          runId: run.id,
          phase: run.phase,
          currentIterationNumber: run.currentIterationNumber,
          cumulativeWorkers: run.cumulativeWorkers,
          maxIterations: run.config.maxIterations,
          maxWorkersPerIteration: run.config.maxWorkersPerIteration,
          maxTotalWorkers: run.config.maxTotalWorkers,
          remainingDeadlineMs: Math.max(
            0,
            run.loopDeadlineAt.getTime() - Date.now(),
          ),
          budgetAccountId: run.config.budgetAccountId ?? null,
          waitReason: run.waitReason,
          workspace: run.workspace,
          acceptanceEvidence: run.acceptanceEvidence,
        },
        iterations: boundedIterations.map((iteration) => ({
          iterationNumber: iteration.iterationNumber,
          plannerStepId: iteration.plannerStepId ?? null,
          plannerProposal: iteration.plannerProposal
            ? {
                reason:
                  iteration.plannerProposal.reason?.slice(
                    0,
                    WORKBENCH_BOUNDS.maxReasonChars,
                  ) ?? "",
                tasks: (iteration.plannerProposal.tasks ?? [])
                  .slice(0, WORKBENCH_BOUNDS.maxWorkersPerIteration)
                  .map((task) => ({
                    taskId: task.taskId,
                    agent: task.agent,
                    ...(task.connectionId
                      ? { connectionId: task.connectionId }
                      : {}),
                    required: Boolean(task.required),
                    dependsOn: Array.isArray(task.dependsOn)
                      ? task.dependsOn.slice(0, 16)
                      : [],
                    reason:
                      task.reason?.slice(0, WORKBENCH_BOUNDS.maxReasonChars) ??
                      "",
                  })),
              }
            : null,
          workerManifest: iteration.workerManifest.map((entry) => ({
            taskId: entry.taskId,
            logicalStepId: entry.logicalStepId,
            required: entry.required,
            status: workerStatuses.get(entry.logicalStepId) ?? "UNKNOWN",
          })),
          verifierStepId: iteration.verifierStepId ?? null,
          decisionAction: iteration.decision?.action ?? null,
          decisionReason:
            iteration.decision?.reason?.slice(
              0,
              WORKBENCH_BOUNDS.maxReasonChars,
            ) ?? null,
          decisionRecommendation: iteration.decision?.recommendation
            ? {
                reason:
                  iteration.decision.recommendation.reason?.slice(
                    0,
                    WORKBENCH_BOUNDS.maxReasonChars,
                  ) ?? "",
                focus: Array.isArray(iteration.decision.recommendation.focus)
                  ? iteration.decision.recommendation.focus.slice(0, 16)
                  : [],
              }
            : null,
          decisionHash: iteration.decisionHash ?? null,
          outcome: iteration.outcome ?? null,
        })),
        truncated: iterationTruncated,
      };
    }

    // Bounded attempt summaries (never raw snapshots/results).
    const attempts = await this.dataSource
      .getRepository(StepAttemptEntity)
      .find({
        where: { executionId },
        order: { createdAt: "DESC" },
        take: WORKBENCH_BOUNDS.maxAttemptsPerExecution,
      });
    const attemptsTruncated =
      attempts.length === WORKBENCH_BOUNDS.maxAttemptsPerExecution;
    const steps = await this.dataSource
      .getRepository(LogicalStepEntity)
      .find({ where: { executionId } });
    const stepIdByRow = new Map(steps.map((step) => [step.id, step.stepId]));

    const approvals = await this.dataSource
      .getRepository(ApprovalRequestEntity)
      .find({ where: { executionId } });
    // M10-S1: artifacts belong to THIS execution's lineage (artifact ->
    // result inbox -> step attempt -> execution) — never globally newest.
    const artifacts = await this.dataSource
      .getRepository(ArtifactEntity)
      .createQueryBuilder("artifact")
      .where(
        `artifact."resultInboxId" IN (
          SELECT "id" FROM "result_inbox"
          WHERE "stepAttemptId" IN (
            SELECT "id" FROM "step_attempts"
            WHERE "executionId" = :executionId
          )
        )`,
        { executionId },
      )
      .orderBy('artifact."createdAt"', "DESC")
      .take(WORKBENCH_BOUNDS.maxArtifactRefs)
      .getMany();
    const artifactsTruncated =
      artifacts.length === WORKBENCH_BOUNDS.maxArtifactRefs;

    let delegation: WorkbenchExecutionProjectionV1["delegation"] = {
      supervisedTotal: 0,
      observedTotal: 0,
      truncated: false,
    };
    try {
      const delegationProjection = await this.delegation.projection(
        executionId,
        100,
      );
      delegation = {
        supervisedTotal: delegationProjection.supervisedTotal,
        observedTotal: delegationProjection.observedTotal,
        truncated:
          delegationProjection.supervisedTruncated ||
          delegationProjection.observedTruncated,
      };
    } catch {
      // Delegation is unavailable, never invented.
      delegation = { supervisedTotal: 0, observedTotal: 0, truncated: false };
    }

    return {
      schemaVersion: 1,
      serverTime,
      execution: {
        id: execution.id,
        status: execution.status,
        createdAt: execution.createdAt.toISOString(),
        updatedAt: execution.updatedAt.toISOString(),
        terminationReason:
          execution.terminationReason?.slice(
            0,
            WORKBENCH_BOUNDS.maxReasonChars,
          ) ?? null,
        goal: { preview: goalPreview, truncated: goalTruncated },
        planRevisionCount,
        activePlanRevisionId: execution.activePlanRevisionId,
      },
      coordination,
      attempts: attempts.map((attempt) => {
        const summary: {
          stepId: string;
          attemptNumber: number;
          status: string;
          terminalAt: string | null;
          error: string | null;
          requestedModelId?: string;
          observedModelId?: string;
        } = {
          stepId:
            stepIdByRow.get(attempt.logicalStepId) ?? attempt.logicalStepId,
          attemptNumber: attempt.attemptNumber,
          status: attempt.status,
          terminalAt: attempt.terminalAt?.toISOString() ?? null,
          error:
            attempt.error?.slice(0, WORKBENCH_BOUNDS.maxReasonChars) ?? null,
        };
        // P2: frozen requested model — exact execution provenance from the
        // attempt's frozen executor snapshot (absent = Runtime default).
        const snapshot = (attempt.executorSnapshot ?? {}) as {
          requestedModelId?: unknown;
        };
        if (
          typeof snapshot.requestedModelId === "string" &&
          snapshot.requestedModelId.length > 0 &&
          snapshot.requestedModelId.length <= 256
        ) {
          summary.requestedModelId = snapshot.requestedModelId;
        }
        // P2: observed model ONLY when the runtime/worker itself reported
        // it inside the bounded structured result — never fabricated.
        const resultOutput = (attempt.result ?? null) as {
          observedModelId?: unknown;
        } | null;
        if (
          resultOutput !== null &&
          typeof resultOutput.observedModelId === "string" &&
          resultOutput.observedModelId.length > 0 &&
          resultOutput.observedModelId.length <= 256
        ) {
          summary.observedModelId = resultOutput.observedModelId;
        }
        return summary;
      }),
      attemptsTruncated,
      approvals: {
        pending: approvals.filter((approval) => approval.status === "PENDING")
          .length,
        decided: approvals.length,
      },
      artifacts: artifacts.map((artifact) => ({
        artifactId: artifact.id,
        descriptorOrdinal: artifact.descriptorOrdinal,
        descriptorHash: artifact.descriptorHash,
      })),
      artifactsTruncated,
      delegation,
      capsule: null,
      bounds: WORKBENCH_BOUNDS,
    };
  }
}

export class WorkbenchProjectionError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "WorkbenchProjectionError";
    this.code = code;
  }
}
