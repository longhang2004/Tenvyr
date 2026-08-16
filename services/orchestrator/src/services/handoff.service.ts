import { Inject, Injectable } from "@nestjs/common";
import { DataSource, type EntityManager } from "typeorm";
import { ExecutionEntity } from "../entities/execution.entity";
import { PipelineEntity } from "../entities/pipeline.entity";
import { CoordinationRunEntity } from "../entities/coordination-run.entity";
import { CoordinationIterationEntity } from "../entities/coordination-iteration.entity";
import { ExecutionPlanRevisionEntity } from "../entities/execution-plan-revision.entity";
import { StepAttemptEntity } from "../entities/step-attempt.entity";
import { ArtifactEntity } from "../entities/artifact.entity";
import { WorkspaceExecutionEntity } from "../entities/workspace-execution.entity";
import { HandoffEntity } from "../entities/handoff.entity";
import { ExecutionService } from "./execution.service";
import { RuntimeCoordinationService } from "./runtime-coordination.service";
import { WorkspaceExecutionService } from "./workspace-execution.service";
import {
  HANDOFF_BOUNDS,
  HandoffError,
  handoffBundleBytes,
  handoffBundleHash,
  parseHandoffBundle,
  type HandoffBundleV1,
} from "../domain/handoff";
import type { CoordinationConfigV1 } from "../domain/coordination";
import type { WorkspaceSnapshotV1 } from "../domain/workspace";

/**
 * PP1 Slice C — Portable Handoff V1.
 *
 * `buildHandoffBundle` projects durable Tenvyr truth into a bounded,
 * strictly-parsed HandoffBundleV1 (references, never raw logs/credentials/
 * reasoning). `continueRunWithManager` creates a NEW execution/run whose
 * goal is the handoff's goal and whose initial input carries the bounded
 * bundle; the source run must be TERMINAL, the destination Runtime Target
 * is frozen through the existing P2 authority (assertExplicitTargetsReady
 * at the command boundary), and a preserved git-worktree lease transfers
 * only under EXCLUSIVE ownership (guarded PRESERVED → IN_USE rebind —
 * concurrent continuation fails closed, never a false READY). The source
 * execution's historical runtime/model identity is never rewritten; the
 * handoffs row (unique (sourceExecutionId, bundleHash)) is the lineage.
 */
const TERMINAL_RUN_PHASES = ["ACCEPTED", "FAILED", "CANCELLED", "LIMIT_REACHED"];

@Injectable()
export class HandoffService {
  constructor(
    @Inject("DATA_SOURCE") private readonly dataSource: DataSource,
    private readonly executionService: ExecutionService,
    private readonly coordination: RuntimeCoordinationService,
    private readonly workspaceExecutions: WorkspaceExecutionService,
  ) {}

  /** Bounded projection of durable truth for a TERMINAL source execution.
   *  Throws HandoffError for non-terminal sources (fail closed). */
  async buildHandoffBundle(
    sourceExecutionId: string,
    manager?: EntityManager,
  ): Promise<HandoffBundleV1> {
    const dataSource = manager ?? this.dataSource;
    const execution = await dataSource
      .getRepository(ExecutionEntity)
      .findOne({ where: { id: sourceExecutionId } });
    if (!execution) {
      throw new HandoffError(
        "SOURCE_NOT_FOUND",
        `Source execution "${sourceExecutionId}" does not exist`,
      );
    }
    const coordinationRun = await dataSource
      .getRepository(CoordinationRunEntity)
      .findOne({ where: { executionId: sourceExecutionId } });
    if (
      !coordinationRun ||
      !TERMINAL_RUN_PHASES.includes(coordinationRun.phase)
    ) {
      throw new HandoffError(
        "SOURCE_NOT_TERMINAL",
        `Source execution "${sourceExecutionId}" is ${coordinationRun?.phase ?? "not a coordinated run"}; handoffs require a terminal source run`,
      );
    }

    // Latest iteration (highest number) + its verifier decision.
    const iterations = await dataSource
      .getRepository(CoordinationIterationEntity)
      .find({
        where: { coordinationRunId: coordinationRun.id },
        order: { iterationNumber: "DESC" },
        take: 1,
      });
    const latestIteration = iterations[0] ?? null;

    // Bounded worker outcome summaries of the latest iteration (from
    // durable step attempts of the worker manifest).
    const workerOutcomes: HandoffBundleV1["workerOutcomes"] = [];
    const workerStepIds =
      latestIteration?.workerManifest.map((entry) => entry.logicalStepId) ?? [];
    if (workerStepIds.length > 0) {
      const workerAttempts = await dataSource
        .getRepository(StepAttemptEntity)
        .createQueryBuilder("attempt")
        .where("attempt.logicalStepId IN (:...ids)", { ids: workerStepIds })
        .orderBy("attempt.createdAt", "DESC")
        .take(HANDOFF_BOUNDS.maxWorkers)
        .getMany();
      const byStep = new Map<string, StepAttemptEntity>();
      for (const attempt of workerAttempts) {
        if (!byStep.has(attempt.logicalStepId)) {
          byStep.set(attempt.logicalStepId, attempt);
        }
      }
      for (const entry of latestIteration.workerManifest.slice(
        0,
        HANDOFF_BOUNDS.maxWorkers,
      )) {
        const attempt = byStep.get(entry.logicalStepId);
        const rawSummary = attempt?.result
          ? JSON.stringify(attempt.result)
          : null;
        workerOutcomes.push({
          taskId: entry.taskId,
          status: attempt?.status ?? "UNKNOWN",
          summary:
            rawSummary !== null
              ? rawSummary.slice(0, HANDOFF_BOUNDS.workerSummaryBytes)
              : null,
        });
      }
    }

    // Selected artifact references for this execution's lineage.
    const artifacts = await dataSource
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
        { executionId: sourceExecutionId },
      )
      .orderBy('artifact."createdAt"', "DESC")
      .take(HANDOFF_BOUNDS.maxArtifactRefs)
      .getMany();

    // Source runtime/model provenance from frozen attempt efficiency
    // evidence (deduplicated, bounded).
    const provenanceMap = new Map<string, HandoffBundleV1["sourceRuntimeProvenance"][number]>();
    const attempts = await dataSource.getRepository(StepAttemptEntity).find({
      where: { executionId: sourceExecutionId },
      take: 200,
    });
    for (const attempt of attempts) {
      const efficiency = attempt.efficiency as
        | { harness?: { agent?: string; connectionId?: string; requestedModelId?: string } }
        | null
        | undefined;
      const harness = efficiency?.harness;
      if (!harness?.agent) continue;
      const key = `${harness.agent}|${harness.connectionId ?? ""}|${harness.requestedModelId ?? ""}`;
      if (!provenanceMap.has(key)) {
        provenanceMap.set(key, {
          agent: harness.agent,
          connectionId: harness.connectionId ?? null,
          requestedModelId: harness.requestedModelId ?? null,
        });
      }
    }

    // Execution workspace lease identity (when the run had one).
    const lease = await dataSource
      .getRepository(WorkspaceExecutionEntity)
      .findOne({ where: { ownerRunId: coordinationRun.id } });

    const workspace = coordinationRun.workspace;
    const bundle: HandoffBundleV1 = {
      schemaVersion: 1,
      sourceExecutionId,
      sourceRunId: coordinationRun.id,
      goal:
        typeof execution.input === "object" &&
        execution.input !== null &&
        typeof (execution.input as { goal?: unknown }).goal === "string"
          ? ((execution.input as { goal: string }).goal.slice(0, 4096))
          : "",
      workspace: workspace
        ? {
            workspaceId: workspace.workspaceId,
            path: workspace.path,
            branch: workspace.branch ?? null,
            headSha: workspace.headSha ?? null,
          }
        : null,
      executionWorkspace:
        lease && lease.executionPath
          ? {
              workspaceExecutionId: lease.id,
              mode: lease.mode,
              path: lease.executionPath,
              baseHeadSha: lease.baseHeadSha ?? null,
              state: lease.state,
            }
          : null,
      planRevision: execution.activePlanRevisionId
        ? await dataSource
            .getRepository(ExecutionPlanRevisionEntity)
            .findOne({ where: { id: execution.activePlanRevisionId } })
            .then((revision) =>
              revision?.planHash
                ? { id: revision.id, planHash: revision.planHash }
                : null,
            )
        : null,
      iterationNumber: coordinationRun.currentIterationNumber,
      verifierDecision: latestIteration?.decision
        ? {
            action: String(latestIteration.decision.action ?? "").slice(0, 64),
            reason: String(latestIteration.decision.reason ?? "").slice(
              0,
              HANDOFF_BOUNDS.reasonMax,
            ),
          }
        : null,
      workerOutcomes,
      artifactRefs: artifacts.slice(0, HANDOFF_BOUNDS.maxArtifactRefs).map(
        (artifact) => ({
          artifactId: artifact.id,
          name: null,
        }),
      ),
      acceptanceEvidence: coordinationRun.acceptanceEvidence ?? null,
      nextWork:
        (coordinationRun.waitReason ??
          latestIteration?.decision?.reason ??
          execution.terminationReason ??
          null)
          ?.slice(0, HANDOFF_BOUNDS.reasonMax) ?? null,
      sourceRuntimeProvenance: [...provenanceMap.values()].slice(
        0,
        HANDOFF_BOUNDS.maxProvenanceEntries,
      ),
      createdAt: new Date().toISOString(),
    };
    if (handoffBundleBytes(bundle) > HANDOFF_BOUNDS.bundleBytes) {
      throw new HandoffError(
        "BUNDLE_TOO_LARGE",
        `HandoffBundle exceeds ${HANDOFF_BOUNDS.bundleBytes} bytes`,
      );
    }
    return bundle;
  }

  /**
   * Create the continuation INSIDE the caller's authority transaction:
   * NEW execution/run, destination Runtime Target already validated by the
   * existing P2 authority at the command boundary, preserved git-worktree
   * lease transferred under EXCLUSIVE ownership (fail closed otherwise),
   * handoff lineage row committed atomically.
   */
  async continueRunWithManager(
    manager: EntityManager,
    sourceExecutionId: string,
    config: CoordinationConfigV1,
    bundle: HandoffBundleV1,
  ): Promise<{
    executionId: string;
    runId: string;
    handoffId: string;
    bundleHash: string;
  }> {
    const bundleHash = handoffBundleHash(bundle);
    // The terminal check is re-asserted INSIDE the authority transaction.
    const sourceRun = await manager
      .getRepository(CoordinationRunEntity)
      .findOne({ where: { executionId: sourceExecutionId } });
    if (!sourceRun || !TERMINAL_RUN_PHASES.includes(sourceRun.phase)) {
      throw new HandoffError(
        "SOURCE_NOT_TERMINAL",
        `Source execution "${sourceExecutionId}" is ${sourceRun?.phase ?? "not a coordinated run"}; handoffs require a terminal source run`,
      );
    }

    const pipeline = await manager.getRepository(PipelineEntity).save(
      manager.getRepository(PipelineEntity).create({
        name: `continue:${sourceExecutionId.slice(0, 8)}`,
        version: "1.0",
        steps: [],
      }),
    );
    const execution = await this.executionService.materializeExecutionWithManager(
      manager,
      pipeline,
      { goal: bundle.goal, handoff: bundle },
    );
    const run = await this.coordination.startRunWithManager(
      manager,
      execution.id,
      config,
      new Date(Date.now() + config.loopDeadlineMs),
      (sourceRun.workspace as WorkspaceSnapshotV1 | null) ?? null,
      sourceRun.acceptanceEvidence ?? null,
    );

    // Exclusive execution-workspace ownership:
    // - git-worktree lease: transfer ONLY when the source run still owns a
    //   PRESERVED lease (source lease → TRANSFERRED keeping its identity;
    //   destination receives a NEW lease for the same physical worktree;
    //   concurrent continuation fails closed with no false READY).
    // - shared mode: a fresh shared lease is bound to the new run (no
    //   external git mutation — safe inside the transaction).
    const sourceLease = await manager
      .getRepository(WorkspaceExecutionEntity)
      .findOne({ where: { ownerRunId: sourceRun.id } });
    if (sourceLease?.mode === "git-worktree") {
      await this.workspaceExecutions.transferExecutionWorkspaceWithManager(
        manager,
        sourceLease.id,
        sourceRun.id,
        run.id,
      );
    } else if (sourceLease?.mode === "shared") {
      await this.workspaceExecutions.allocateSharedExecutionWorkspaceWithManager(
        manager,
        sourceRun.workspace as WorkspaceSnapshotV1,
        run.id,
      );
    }

    const handoffRepository = manager.getRepository(HandoffEntity);
    const existing = await handoffRepository.findOne({
      where: { sourceExecutionId, bundleHash },
    });
    const handoff = existing
      ? existing
      : await handoffRepository.save(
          handoffRepository.create({
            sourceExecutionId,
            sourceRunId: sourceRun.id,
            bundleHash,
            bundle: parseHandoffBundle(bundle) as unknown as Record<string, unknown>,
            destinationExecutionId: execution.id,
            requester: "operator",
          }),
        );

    await this.coordination.createNextIterationWithManager(manager, run.id);
    return {
      executionId: execution.id,
      runId: run.id,
      handoffId: handoff.id,
      bundleHash,
    };
  }
}