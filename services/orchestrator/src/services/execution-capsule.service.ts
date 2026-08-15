import { createHash } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { DataSource, type EntityManager } from "typeorm";
import { ExecutionEntity } from "../entities/execution.entity";
import { ExecutionPlanRevisionEntity } from "../entities/execution-plan-revision.entity";
import { CoordinationRunEntity } from "../entities/coordination-run.entity";
import { CoordinationIterationEntity } from "../entities/coordination-iteration.entity";
import { LogicalStepEntity } from "../entities/step-execution.entity";
import { StepAttemptEntity } from "../entities/step-attempt.entity";
import { DispatchOutboxEntity } from "../entities/dispatch-outbox.entity";
import { ResultInboxEntity } from "../entities/result-inbox.entity";
import { ResultConflictEntity } from "../entities/result-conflict.entity";
import { AgentEventEntity } from "../entities/agent-event.entity";
import { PolicyDecisionEntity } from "../entities/policy-decision.entity";
import { PolicySnapshotEntity } from "../entities/policy-snapshot.entity";
import { ApprovalRequestEntity } from "../entities/approval-request.entity";
import { BudgetAccountEntity } from "../entities/budget-account.entity";
import { BudgetReservationEntity } from "../entities/budget-reservation.entity";
import { ArtifactEntity } from "../entities/artifact.entity";
import { StateWriteEvidenceEntity } from "../entities/state-write-evidence.entity";
import { sha256Json } from "../domain/canonical-json";
import { DelegationService } from "./delegation.service";
import { ExecutionService } from "./execution.service";
import { ExecutionExportEntity } from "../entities/execution-export.entity";
import { ExecutionReplayEntity } from "../entities/execution-replay.entity";
import type { PipelineEntity } from "../entities/pipeline.entity";

/** M7-S1 bounds for the capsule read model (documented defaults). */
export const CAPSULE_BOUNDS = {
  maxInputBytes: 65_536,
  maxRevisions: 20,
  maxAttempts: 100,
  maxCoordinationIterations: 100,
} as const;

/** M7-S3: structural comparison between two capsules. Drift is computed
 *  over STABLE logical identities (step ids + spec hashes, attempt
 *  outcomes); runtime-asserted delegation evidence is always a separate
 *  `runtimeClaims` section and NEVER part of drift conclusions. Any
 *  truncated section marks its category `unavailable` instead of drawing
 *  a conclusion. */
export type CapsuleComparisonV1 = {
  schemaVersion: "1";
  a: { executionId: string; capsuleHash: string };
  b: { executionId: string; capsuleHash: string };
  plan: {
    identical: boolean;
    unavailable: boolean;
    stepDrift: Array<{
      stepId: string;
      aHash: string | null;
      bHash: string | null;
      drift:
        | "identical"
        | "drifted"
        | "present_in_a_only"
        | "present_in_b_only";
    }>;
  };
  outcome: {
    identical: boolean;
    unavailable: boolean;
    perStep: Array<{
      stepId: string;
      aStatus: string | null;
      bStatus: string | null;
      drift:
        | "same"
        | "drifted"
        | "no_evidence_a"
        | "no_evidence_b"
        | "no_evidence_both";
    }>;
  };
  runtimeClaims: { aObserved: number; bObserved: number };
  warnings: string[];
};

/** M7-S3: derived provenance graph. Authority edges are durable facts;
 *  claim edges are runtime-asserted; exposure edges are M2 artifact
 *  exposure events (never overclaimed as semantic use). Bounded. */
/** M7-S4: OTLP-JSON-shaped telemetry projection (bounded, derived from
 *  the capsule; NEVER authoritative and NEVER written back). The
 *  convention mapping is pinned here — the exporter consumes exactly
 *  this shape. */
export type TelemetryProjectionV1 = {
  resourceSpans: Array<{
    resource: {
      attributes: Array<{ key: string; value: { stringValue: string } }>;
    };
    scopeSpans: Array<{
      scope: { name: string };
      spans: Array<{
        traceId: string;
        spanId: string;
        parentSpanId: string | null;
        name: string;
        kind: number;
        startTimeUnixNano: string;
        endTimeUnixNano: string;
        status: { code: number; message?: string };
        attributes: Array<{ key: string; value: { stringValue: string } }>;
      }>;
    }>;
  }>;
};

export type ExecutionProvenanceV1 = {
  schemaVersion: "1";
  executionId: string;
  nodes: Array<{
    id: string;
    kind:
      | "execution"
      | "revision"
      | "attempt"
      | "budget_account"
      | "policy_decision"
      | "delegation_child"
      | "delegation_observation"
      | "artifact_exposure";
    label: string;
  }>;
  edges: Array<{
    from: string;
    to: string;
    kind: "authority" | "claim" | "exposure";
  }>;
};

export type ExecutionCapsuleV1 = {
  schemaVersion: "1";
  executionId: string;
  /** Volatile capture instant (excluded from contentHash). */
  capturedAt: string;
  pointInTime: "terminal" | "live";
  sourceStatus: string;
  /** Stable hash over the durable facts below (comparison identity). */
  contentHash: string;
  header: {
    pipelineId: string;
    pipelineVersion: string;
    pipelineHash: string;
    /** The ACTIVE revision's plan hash at capture (replay pins this). */
    activeRevisionHash: string | null;
    authorityDeadlineAt: string | null;
    input: unknown;
    configurationSnapshot: unknown;
    stepCount: number;
    revisionCount: number;
    attemptCount: number;
    eventCount: number;
    inboxCount: number;
    conflictCount: number;
    outbox: Record<string, number>;
    budget: {
      account: { ceilings: unknown; parentAccountId: string | null } | null;
      reservationCount: number;
    };
    policy: {
      snapshotVersion: string | null;
      snapshotHash: string | null;
      decisionCount: number;
      decisions: Array<{ id: string; actionType: string; effect: string }>;
    };
    approvals: {
      pending: number;
      decided: number;
    };
    delegation: {
      supervised: number;
      observed: number;
    };
    state: {
      version: number;
      contentHash: string;
      writeEvidenceCount: number;
    };
    artifacts: {
      producedCount: number;
      exposureCount: number;
    };
  };
  revisions: Array<{
    /** Row id — stable provenance node key. */
    id: string;
    revisionNumber: number;
    planHash: string | null;
    source: string;
    reason: string | null;
    validationResult: Record<string, unknown> | null;
    budget: unknown;
    steps: unknown[];
  }>;
  attempts: Array<{
    stepId: string;
    attemptNumber: number;
    status: string;
    invocationId: string;
    planRevisionId: string;
    frozenSpecHash: string | null;
    executorSnapshot: unknown;
    inputSnapshotHash: string | null;
    contextSnapshotHash: string | null;
    terminalAt: Date | null;
    error: string | null;
  }>;
  /** M9-S5: bounded loop projection; absent for non-coordinated runs. */
  coordination?: {
    run: {
      phase: string;
      currentIterationNumber: number;
      cumulativeWorkers: number;
      config: unknown;
      /** Frozen workspace snapshot the run executed against (Product
       *  Phase 1); null for runs without a workspace. */
      workspace: unknown;
      /** Operator-declared acceptance evidence (run metadata only). */
      acceptanceEvidence: unknown;
    };
    iterations: Array<{
      iterationNumber: number;
      workerCount: number;
      requiredCount: number;
      verifierStepId: string | null;
      decisionAction: string | null;
      decisionHash: string | null;
      outcome: string | null;
    }>;
  };
  evidenceCompleteness: string[];
};

/**
 * M7-S1: the internal Execution Capsule V1 read model.
 *
 * Assembles explicit, bounded DTO sections from AUTHORITATIVE rows inside
 * a REPEATABLE READ transaction (a consistent point-in-time capture).
 * Terminal source executions are preferred; a live capture is labelled
 * `pointInTime: "live"`. Large sections are bounded and every bound that
 * bit is recorded as an `evidenceCompleteness` warning. There is no giant
 * source table and no public download — this is a service-level read
 * model (the export/replay surfaces land in M7-S2 and stay behind the
 * exposure gate).
 */
@Injectable()
export class ExecutionCapsuleService {
  constructor(
    @Inject("DATA_SOURCE") private readonly dataSource: DataSource,
    private readonly delegation: DelegationService,
    private readonly executionService: ExecutionService,
  ) {}

  /**
   * M7-S2: persist a SMALL immutable export manifest pinning the source
   * execution to its current capsule content hash. The manifest never
   * duplicates execution truth; re-exporting the same capsule hash is
   * idempotent (the existing manifest is returned).
   */
  async createExport(
    executionId: string,
    exporter = "operator",
    note?: string,
  ): Promise<ExecutionExportEntity> {
    const capsule = await this.build(executionId);
    return this.dataSource.transaction(async (manager) => {
      await manager
        .getRepository(ExecutionEntity)
        .createQueryBuilder("execution")
        .setLock("pessimistic_write")
        .where('execution."id" = :executionId', { executionId })
        .getOneOrFail();
      const repository = manager.getRepository(ExecutionExportEntity);
      const existing = await repository.findOne({
        where: { executionId, capsuleHash: capsule.contentHash },
      });
      if (existing) return existing;
      return repository.save(
        repository.create({
          executionId,
          capsuleHash: capsule.contentHash,
          exporter,
          note: note ?? null,
        }),
      );
    });
  }

  /**
   * M7-S2: controlled replay. Builds the source capsule (TERMINAL
   * sources only — a live capture is not reproducible), pins the ACTIVE
   * revision by its plan hash, and materializes a NEW execution from the
   * CAPTURED plan + captured input (never the current pipeline) in one
   * transaction with the idempotent replay row (unique
   * (sourceExecutionId, sourceCapsuleHash)). All authority — policy,
   * budget, credentials — is re-evaluated by the normal claim machinery;
   * historical approvals are never copied.
   */
  async replay(
    sourceExecutionId: string,
    requester = "operator",
    note?: string,
  ): Promise<{
    replay: ExecutionReplayEntity;
    capsuleHash: string;
    targetExecutionId: string;
  }> {
    const capsule = await this.build(sourceExecutionId);
    if (capsule.pointInTime !== "terminal") {
      throw new Error(
        `Execution ${sourceExecutionId} is ${capsule.sourceStatus}; replays require a terminal source`,
      );
    }
    if (!capsule.header.activeRevisionHash) {
      throw new Error("Source capsule has no active revision hash");
    }
    return this.dataSource.transaction((manager) =>
      this.replayWithManager(
        manager,
        sourceExecutionId,
        capsule,
        requester,
        note,
      ),
    );
  }

  /** P1/M10: manager-passable replay — caller-owned transactions compose
   *  authority atomically (Workbench audit + replay commit together). The
   *  capsule is built by the caller when already available; otherwise it is
   *  rebuilt here (a pure read) with the same terminal-source guard. */
  async replayWithManager(
    manager: EntityManager,
    sourceExecutionId: string,
    capsule?: Awaited<ReturnType<ExecutionCapsuleService["build"]>>,
    requester = "operator",
    note?: string,
  ): Promise<{
    replay: ExecutionReplayEntity;
    capsuleHash: string;
    targetExecutionId: string;
  }> {
    const resolved = capsule ?? (await this.build(sourceExecutionId));
    if (resolved.pointInTime !== "terminal") {
      throw new Error(
        `Execution ${sourceExecutionId} is ${resolved.sourceStatus}; replays require a terminal source`,
      );
    }
    if (!resolved.header.activeRevisionHash) {
      throw new Error("Source capsule has no active revision hash");
    }
      const source = await manager
        .getRepository(ExecutionEntity)
        .createQueryBuilder("execution")
        .setLock("pessimistic_write")
        .where('execution."id" = :sourceExecutionId', { sourceExecutionId })
        .getOne();
      if (!source) throw new Error(`Execution ${sourceExecutionId} is gone`);
      const replayRepository = manager.getRepository(ExecutionReplayEntity);
      const existing = await replayRepository.findOne({
        where: {
          sourceExecutionId,
          sourceCapsuleHash: resolved.contentHash,
        },
      });
      if (existing) {
        return {
          replay: existing,
          capsuleHash: resolved.contentHash,
          targetExecutionId: existing.targetExecutionId,
        };
      }
      const revision = await manager
        .getRepository(ExecutionPlanRevisionEntity)
        .findOne({
          where: {
            executionId: sourceExecutionId,
            planHash: resolved.header.activeRevisionHash,
          },
        });
      if (!revision) {
        throw new Error("The active revision is no longer readable");
      }
      const replayPipeline = {
        // The captured plan came from the source pipeline; the replay
        // references it but uses the CAPTURED revision's plan (the
        // pipeline row may have evolved since).
        id: source.pipelineId,
        name: source.pipelineId,
        version: source.pipelineVersion,
        description: `Replay of ${sourceExecutionId}`,
        contentHash: revision.planHash,
        steps: revision.plan.steps,
        ...("budget" in revision.plan
          ? { budget: (revision.plan as { budget?: unknown }).budget }
          : {}),
      } as unknown as PipelineEntity;
      const target =
        await this.executionService.materializeExecutionWithManager(
          manager,
          replayPipeline,
          source.input,
        );
      const replay = await replayRepository.save(
        replayRepository.create({
          sourceExecutionId,
          sourceCapsuleHash: resolved.contentHash,
          targetExecutionId: target.id,
          requester,
          note: note ?? null,
        }),
      );
      // M9-S5: replay of a coordinated execution creates a NEW
      // CoordinationRun from the frozen team template with a FRESH loop
      // deadline — current connections, credentials, policy, approvals,
      // budgets, permissions, and deadline are re-resolved by the normal
      // claim/consume authority. Historical identity is provenance.
      const sourceRun = await manager
        .getRepository(CoordinationRunEntity)
        .findOne({ where: { executionId: sourceExecutionId } });
      if (sourceRun) {
        await manager.getRepository(CoordinationRunEntity).save(
          manager.getRepository(CoordinationRunEntity).create({
            executionId: target.id,
            config: sourceRun.config,
            phase: "PLANNING",
            currentIterationNumber: 0,
            cumulativeWorkers: 0,
            loopDeadlineAt: new Date(
              Date.now() + sourceRun.config.loopDeadlineMs,
            ),
            version: 1,
          }),
        );
      }
      return {
        replay,
        capsuleHash: resolved.contentHash,
        targetExecutionId: target.id,
      };
  }

  /**
   * M7-S3: structural comparison of two capsules (both built fresh).
   * Step drift uses stable logical identities (id + step-config hash);
   * outcome drift uses the per-step terminal attempt status. Sections
   * that were truncated in either capsule are `unavailable` — no
   * conclusion is drawn. Runtime-asserted delegation evidence is counted
   * separately and never compared as drift.
   */
  async compare(
    aExecutionId: string,
    bExecutionId: string,
  ): Promise<CapsuleComparisonV1> {
    const a = await this.build(aExecutionId);
    const b = await this.build(bExecutionId);

    const warnings: string[] = [];
    const aSteps = new Map<string, string>();
    for (const step of a.revisions[0]?.steps ?? []) {
      aSteps.set((step as { id: string }).id, sha256Json(step));
    }
    const bSteps = new Map<string, string>();
    for (const step of b.revisions[0]?.steps ?? []) {
      bSteps.set((step as { id: string }).id, sha256Json(step));
    }

    const stepIds = new Set([...aSteps.keys(), ...bSteps.keys()]);
    const stepDrift: CapsuleComparisonV1["plan"]["stepDrift"] = [];
    for (const stepId of [...stepIds].sort()) {
      const aHash = aSteps.get(stepId) ?? null;
      const bHash = bSteps.get(stepId) ?? null;
      stepDrift.push({
        stepId,
        aHash,
        bHash,
        drift:
          aHash !== null && bHash !== null
            ? aHash === bHash
              ? "identical"
              : "drifted"
            : aHash !== null
              ? "present_in_a_only"
              : "present_in_b_only",
      });
    }

    const planUnavailable =
      a.evidenceCompleteness.some((w) => w.startsWith("Revisions truncated")) ||
      b.evidenceCompleteness.some((w) => w.startsWith("Revisions truncated"));
    if (planUnavailable) {
      warnings.push("Plan comparison unavailable: revisions were truncated");
    }

    const TERMINAL_ATTEMPT_STATUSES = new Set([
      "SUCCESS",
      "FAILED",
      "CANCELLED",
      "TIMED_OUT",
    ]);
    const aOutcome = new Map<string, string | null>();
    const bOutcome = new Map<string, string | null>();
    for (const attempt of a.attempts) {
      if (!TERMINAL_ATTEMPT_STATUSES.has(attempt.status)) continue;
      const stepId = attempt.stepId;
      aOutcome.set(
        stepId,
        aOutcome.has(stepId) ? aOutcome.get(stepId)! : attempt.status,
      );
    }
    for (const attempt of b.attempts) {
      if (!TERMINAL_ATTEMPT_STATUSES.has(attempt.status)) continue;
      const stepId = attempt.stepId;
      bOutcome.set(
        stepId,
        bOutcome.has(stepId) ? bOutcome.get(stepId)! : attempt.status,
      );
    }
    const perStep: CapsuleComparisonV1["outcome"]["perStep"] = [];
    for (const stepId of [...stepIds].sort()) {
      const aStatus = aOutcome.get(stepId) ?? null;
      const bStatus = bOutcome.get(stepId) ?? null;
      perStep.push({
        stepId,
        aStatus,
        bStatus,
        drift:
          aStatus !== null && bStatus !== null
            ? aStatus === bStatus
              ? "same"
              : "drifted"
            : aStatus === null && bStatus === null
              ? "no_evidence_both"
              : aStatus !== null
                ? "no_evidence_b"
                : "no_evidence_a",
      });
    }
    const outcomeUnavailable =
      a.evidenceCompleteness.some((w) => w.startsWith("Attempts truncated")) ||
      b.evidenceCompleteness.some((w) => w.startsWith("Attempts truncated")) ||
      a.pointInTime === "live" ||
      b.pointInTime === "live";
    if (outcomeUnavailable) {
      warnings.push(
        a.pointInTime === "live" || b.pointInTime === "live"
          ? "Outcome comparison unavailable: a source is a LIVE capture"
          : "Outcome comparison unavailable: attempts were truncated",
      );
    }

    return {
      schemaVersion: "1",
      a: { executionId: a.executionId, capsuleHash: a.contentHash },
      b: { executionId: b.executionId, capsuleHash: b.contentHash },
      plan: {
        identical: stepDrift.every((row) => row.drift === "identical"),
        unavailable: planUnavailable,
        stepDrift,
      },
      outcome: {
        identical: perStep.every(
          (row) => row.drift === "same" || row.drift === "no_evidence_both",
        ),
        unavailable: outcomeUnavailable,
        perStep,
      },
      runtimeClaims: {
        aObserved: a.header.delegation.observed,
        bObserved: b.header.delegation.observed,
      },
      warnings,
    };
  }

  /**
   * M7-S3: derived provenance graph for one execution. Authority edges
   * (revision/attempt/budget/policy/delegation-supervision) are durable
   * facts; claim edges are runtime-asserted (observed delegation); M2
   * artifact exposures are exposure events, never semantic use. Bounded.
   */
  async provenance(executionId: string): Promise<ExecutionProvenanceV1> {
    const capsule = await this.build(executionId);
    const graph = await this.delegation.projection(executionId, 100, undefined);
    const nodes: ExecutionProvenanceV1["nodes"] = [];
    const edges: ExecutionProvenanceV1["edges"] = [];
    const nodeIds = new Set<string>();
    const addNode = (
      id: string,
      kind: ExecutionProvenanceV1["nodes"][0]["kind"],
      label: string,
    ): boolean => {
      if (nodeIds.has(id)) return true;
      if (nodes.length >= 200) return false;
      nodeIds.add(id);
      nodes.push({ id, kind, label });
      return true;
    };
    const addEdge = (
      from: string,
      to: string,
      kind: ExecutionProvenanceV1["edges"][0]["kind"],
    ) => {
      if (edges.length >= 500 || !nodeIds.has(from) || !nodeIds.has(to)) return;
      edges.push({ from, to, kind });
    };
    addNode(`execution:${executionId}`, "execution", executionId);
    const revisionByPlanHash = new Map(
      capsule.revisions
        .filter((revision) => revision.planHash !== null)
        .map((revision) => [revision.planHash, revision.id]),
    );
    for (const revision of capsule.revisions) {
      const id = `revision:${revision.id}`;
      addNode(id, "revision", `revision ${revision.revisionNumber}`);
      addEdge(id, `execution:${executionId}`, "authority");
    }
    for (const attempt of capsule.attempts) {
      const id = `attempt:${attempt.invocationId}`;
      addNode(id, "attempt", attempt.invocationId);
      addEdge(id, `execution:${executionId}`, "authority");
      if (attempt.planRevisionId) {
        addEdge(id, `revision:${attempt.planRevisionId}`, "authority");
      }
    }
    if (capsule.header.budget.account) {
      addNode(
        `budget:${executionId}`,
        "budget_account",
        "execution budget account",
      );
      addEdge(`budget:${executionId}`, `execution:${executionId}`, "authority");
    }
    for (const decision of capsule.header.policy.decisions) {
      const id = `policy:${decision.id}`;
      addNode(
        id,
        "policy_decision",
        `${decision.actionType} ${decision.effect}`,
      );
      addEdge(id, `execution:${executionId}`, "authority");
    }
    for (const child of graph.supervised) {
      const id = `delegation:${child.childExecutionId}`;
      addNode(id, "delegation_child", child.requestId);
      addEdge(`execution:${executionId}`, id, "authority");
    }
    for (const observation of graph.observed) {
      const id = `claim:${observation.observationId}`;
      addNode(id, "delegation_observation", observation.observationId);
      addEdge(`execution:${executionId}`, id, "claim");
    }
    // The claim seam is the single exposure authority: read through its
    // bounded API, never the entity directly.
    const exposures = await this.executionService.listArtifactExposures(
      executionId,
      100,
    );
    for (const exposure of exposures) {
      const id = `exposure:${exposure.id}`;
      addNode(id, "artifact_exposure", exposure.artifactId);
      addEdge(`execution:${executionId}`, id, "exposure");
    }
    return {
      schemaVersion: "1",
      executionId,
      nodes,
      edges,
    };
  }

  /**
   * M7-S4: bounded OTLP-JSON-shaped telemetry projection derived from the
   * capsule. One root span per execution, one span per terminal attempt
   * (bounded), one span per supervised delegation child. The projection
   * is a PURE read: it never writes, never blocks a transaction, and is
   * NEVER authoritative — telemetry can never influence lifecycle.
   */
  async projectTelemetry(executionId: string): Promise<TelemetryProjectionV1> {
    const capsule = await this.build(executionId);
    const traceId = createHash("sha256")
      .update(capsule.executionId)
      .digest("hex")
      .slice(0, 32);
    const executionSpanId = createHash("sha256")
      .update(`execution:${capsule.executionId}`)
      .digest("hex")
      .slice(0, 16);
    const spans: TelemetryProjectionV1["resourceSpans"][0]["scopeSpans"][0]["spans"] =
      [
        {
          traceId,
          spanId: executionSpanId,
          parentSpanId: null,
          name: "pipeline.execute",
          kind: 1,
          startTimeUnixNano: "0",
          endTimeUnixNano: "0",
          status: {
            code: capsule.sourceStatus === "FAILED" ? 2 : 1,
            ...(capsule.sourceStatus === "FAILED"
              ? { message: capsule.sourceStatus }
              : {}),
          },
          attributes: [
            {
              key: "tenvyr.executionId",
              value: { stringValue: capsule.executionId },
            },
            {
              key: "tenvyr.sourceStatus",
              value: { stringValue: capsule.sourceStatus },
            },
            {
              key: "tenvyr.pipelineHash",
              value: { stringValue: capsule.header.pipelineHash },
            },
            {
              key: "tenvyr.pointInTime",
              value: { stringValue: capsule.pointInTime },
            },
          ],
        },
      ];
    const terminalStatuses = new Set([
      "SUCCESS",
      "FAILED",
      "CANCELLED",
      "TIMED_OUT",
    ]);
    for (const attempt of capsule.attempts) {
      if (spans.length >= 101) break;
      if (!terminalStatuses.has(attempt.status)) continue;
      const spanId = createHash("sha256")
        .update(`attempt:${attempt.invocationId}`)
        .digest("hex")
        .slice(0, 16);
      spans.push({
        traceId,
        spanId,
        parentSpanId: executionSpanId,
        name: "step.execute",
        // The attempt CALLS the executor: a client span, not a server one.
        kind: 3,
        startTimeUnixNano: "0",
        endTimeUnixNano: "0",
        status: {
          code: attempt.status === "SUCCESS" ? 1 : 2,
          message: attempt.status,
        },
        attributes: [
          {
            key: "tenvyr.attempt",
            value: { stringValue: String(attempt.attemptNumber) },
          },
          { key: "tenvyr.stepId", value: { stringValue: attempt.stepId } },
          {
            key: "tenvyr.agent",
            value: {
              stringValue: String(
                (attempt.executorSnapshot as { agent?: unknown })?.agent ?? "",
              ),
            },
          },
          {
            key: "tenvyr.executorKind",
            value: {
              stringValue: String(
                (attempt.executorSnapshot as { kind?: unknown })?.kind ?? "",
              ),
            },
          },
          {
            key: "tenvyr.invocationId",
            value: { stringValue: attempt.invocationId },
          },
        ],
      });
    }
    const graph = await this.delegation.projection(executionId, 100, undefined);
    for (const child of graph.supervised) {
      if (spans.length >= 101) break;
      const spanId = createHash("sha256")
        .update(`child:${child.childExecutionId}`)
        .digest("hex")
        .slice(0, 16);
      spans.push({
        traceId,
        spanId,
        parentSpanId: executionSpanId,
        name: "delegation.execute",
        kind: 2,
        startTimeUnixNano: "0",
        endTimeUnixNano: "0",
        status: { code: 1 },
        attributes: [
          {
            key: "tenvyr.childExecutionId",
            value: { stringValue: child.childExecutionId },
          },
          {
            key: "tenvyr.delegationRequestId",
            value: { stringValue: child.requestId },
          },
          {
            key: "tenvyr.requestedAgent",
            value: { stringValue: child.requestedAgent },
          },
        ],
      });
    }
    return {
      resourceSpans: [
        {
          resource: {
            attributes: [
              {
                key: "service.name",
                value: { stringValue: "tenvyr-orchestrator" },
              },
              {
                key: "tenvyr.capsuleHash",
                value: { stringValue: capsule.contentHash },
              },
            ],
          },
          scopeSpans: [
            {
              scope: { name: "tenvyr.execution" },
              spans,
            },
          ],
        },
      ],
    };
  }

  async build(executionId: string): Promise<ExecutionCapsuleV1> {
    // Repeatable read: every section below observes ONE snapshot.
    return this.dataSource.transaction("REPEATABLE READ", async (manager) => {
      const execution = await manager
        .getRepository(ExecutionEntity)
        .findOne({ where: { id: executionId } });
      if (!execution) {
        throw new Error(`Execution ${executionId} does not exist`);
      }

      const warnings: string[] = [];
      const terminal = ["COMPLETED", "FAILED", "CANCELLED"].includes(
        execution.status,
      );
      if (!terminal) {
        warnings.push(
          `Execution is ${execution.status}; this is a LIVE point-in-time capture, not a terminal capsule`,
        );
      }

      // Revisions: newest first, bounded.
      const revisions = await manager
        .getRepository(ExecutionPlanRevisionEntity)
        .find({
          where: { executionId },
          order: { revisionNumber: "DESC" },
          take: CAPSULE_BOUNDS.maxRevisions,
        });
      const revisionCount = await manager
        .getRepository(ExecutionPlanRevisionEntity)
        .count({ where: { executionId } });
      if (revisionCount > CAPSULE_BOUNDS.maxRevisions) {
        warnings.push(
          `Revisions truncated to ${CAPSULE_BOUNDS.maxRevisions} of ${revisionCount}`,
        );
      }

      const steps = await manager
        .getRepository(LogicalStepEntity)
        .find({ where: { executionId } });
      const dagStepIdByLogicalId = new Map(
        steps.map((step) => [step.id, step.stepId]),
      );

      // M9-S5: bounded coordination loop projection — run phase + iteration
      // manifests and consumed decisions. Provenance only: authority stays
      // in the coordination tables and replay re-resolves current authority.
      const coordinationRun = await manager
        .getRepository(CoordinationRunEntity)
        .findOne({ where: { executionId } });
      let coordination:
        | ExecutionCapsuleV1["coordination"]
        | undefined;
      if (coordinationRun) {
        const coordinationIterations = await manager
          .getRepository(CoordinationIterationEntity)
          .find({
            where: { coordinationRunId: coordinationRun.id },
            order: { iterationNumber: "ASC" },
            take: CAPSULE_BOUNDS.maxCoordinationIterations,
          });
        const iterationCount = await manager
          .getRepository(CoordinationIterationEntity)
          .count({ where: { coordinationRunId: coordinationRun.id } });
        if (iterationCount > CAPSULE_BOUNDS.maxCoordinationIterations) {
          warnings.push(
            `Coordination iterations truncated to ${CAPSULE_BOUNDS.maxCoordinationIterations} of ${iterationCount}`,
          );
        }
        coordination = {
          run: {
            phase: coordinationRun.phase,
            currentIterationNumber: coordinationRun.currentIterationNumber,
            cumulativeWorkers: coordinationRun.cumulativeWorkers,
            config: coordinationRun.config,
            workspace: coordinationRun.workspace,
            acceptanceEvidence: coordinationRun.acceptanceEvidence,
          },
          iterations: coordinationIterations.map((iteration) => ({
            iterationNumber: iteration.iterationNumber,
            workerCount: iteration.workerManifest.length,
            requiredCount: iteration.workerManifest.filter(
              (entry) => entry.required,
            ).length,
            verifierStepId: iteration.verifierStepId ?? null,
            decisionAction: iteration.decision?.action ?? null,
            decisionHash: iteration.decisionHash ?? null,
            outcome: iteration.outcome ?? null,
          })),
        };
      }

      // Attempts: newest first, bounded.
      const attempts = await manager.getRepository(StepAttemptEntity).find({
        where: { executionId },
        order: { createdAt: "DESC", id: "DESC" },
        take: CAPSULE_BOUNDS.maxAttempts,
      });
      const attemptCount = await manager
        .getRepository(StepAttemptEntity)
        .count({ where: { executionId } });
      if (attemptCount > CAPSULE_BOUNDS.maxAttempts) {
        warnings.push(
          `Attempts truncated to ${CAPSULE_BOUNDS.maxAttempts} of ${attemptCount}`,
        );
      }

      // Input bound (the input is operator-provided context, potentially
      // large; the capsule keeps a bounded capture with an explicit
      // warning instead of a silent cut).
      let input = execution.input;
      const inputBytes = Buffer.byteLength(
        JSON.stringify(execution.input ?? null),
        "utf8",
      );
      if (inputBytes > CAPSULE_BOUNDS.maxInputBytes) {
        input = {
          truncated: true,
          bytes: inputBytes,
          sha256: sha256Json(execution.input ?? null),
        };
        warnings.push(
          `Input exceeds ${CAPSULE_BOUNDS.maxInputBytes} bytes; truncated marker captured`,
        );
      }

      const outboxRows = await manager
        .getRepository(DispatchOutboxEntity)
        .createQueryBuilder("outbox")
        .select("outbox.status", "status")
        .addSelect("COUNT(*)", "count")
        .innerJoin(
          StepAttemptEntity,
          "attempt",
          'attempt."id" = outbox."stepAttemptId"',
        )
        .where('attempt."executionId" = :executionId', { executionId })
        .groupBy("outbox.status")
        .getRawMany<{ status: string; count: string }>();
      const outbox: Record<string, number> = {};
      for (const row of outboxRows) outbox[row.status] = Number(row.count);

      const eventCount = await manager
        .getRepository(AgentEventEntity)
        .count({ where: { executionId } });
      // Inbox/conflict rows correlate via invocationId -> attempt.
      const inboxCount = await manager
        .getRepository(ResultInboxEntity)
        .createQueryBuilder("inbox")
        .innerJoin(
          StepAttemptEntity,
          "attempt",
          'attempt."invocationId" = inbox."invocationId"',
        )
        .where('attempt."executionId" = :executionId', { executionId })
        .getCount();
      const conflictCount = await manager
        .getRepository(ResultConflictEntity)
        .createQueryBuilder("conflict")
        .innerJoin(
          StepAttemptEntity,
          "attempt",
          'attempt."invocationId" = conflict."invocationId"',
        )
        .where('attempt."executionId" = :executionId', { executionId })
        .getCount();

      const artifactCount = await manager
        .getRepository(ArtifactEntity)
        .createQueryBuilder("artifact")
        .innerJoin(
          ResultInboxEntity,
          "inbox",
          'inbox."id" = artifact."resultInboxId"',
        )
        .innerJoin(
          StepAttemptEntity,
          "attempt",
          'attempt."invocationId" = inbox."invocationId"',
        )
        .where('attempt."executionId" = :executionId', { executionId })
        .getCount();
      const exposureCount = await this.executionService.countArtifactExposures(
        executionId,
        manager,
      );
      const writeEvidenceCount = await manager
        .getRepository(StateWriteEvidenceEntity)
        .count({ where: { executionId } });

      const budgetAccount = await manager
        .getRepository(BudgetAccountEntity)
        .findOne({ where: { scopeType: "execution", scopeId: executionId } });
      const reservationCount = budgetAccount
        ? await manager
            .getRepository(BudgetReservationEntity)
            .count({ where: { accountId: budgetAccount.id } })
        : 0;

      // Policy snapshots are global (versioned canonical rule data); the
      // capsule records the latest frozen snapshot + this execution's
      // decisions.
      const policySnapshot = await manager
        .getRepository(PolicySnapshotEntity)
        .createQueryBuilder("snapshot")
        .orderBy("snapshot.createdAt", "DESC")
        .getOne();
      const decisionCount = await manager
        .getRepository(PolicyDecisionEntity)
        .count({ where: { executionId } });
      const policyDecisions = await manager
        .getRepository(PolicyDecisionEntity)
        .find({
          where: { executionId },
          order: { createdAt: "ASC", id: "ASC" },
          take: 20,
        });
      if (decisionCount > policyDecisions.length) {
        warnings.push(
          `Policy decisions truncated to ${policyDecisions.length} of ${decisionCount}`,
        );
      }
      const approvalRows = await manager
        .getRepository(ApprovalRequestEntity)
        .createQueryBuilder("request")
        .select("request.status", "status")
        .addSelect("COUNT(*)", "count")
        .where('request."executionId" = :executionId', { executionId })
        .groupBy("request.status")
        .getRawMany<{ status: string; count: string }>();
      const approvals = { pending: 0, decided: 0 };
      for (const row of approvalRows) {
        if (row.status === "PENDING") approvals.pending = Number(row.count);
        else approvals.decided += Number(row.count);
      }

      // M6 graph edges (bounded inside the projection) — read through
      // the SAME manager so they are part of the repeatable-read
      // snapshot.
      const graph = await this.delegation.projection(executionId, 100, manager);

      const activeRevision = execution.activePlanRevisionId
        ? await manager
            .getRepository(ExecutionPlanRevisionEntity)
            .findOne({ where: { id: execution.activePlanRevisionId } })
        : null;
      const header = {
        pipelineId: execution.pipelineId,
        pipelineVersion: execution.pipelineVersion,
        pipelineHash: execution.pipelineHash,
        activeRevisionHash: activeRevision?.planHash ?? null,
        authorityDeadlineAt:
          execution.authorityDeadlineAt?.toISOString() ?? null,
        input,
        configurationSnapshot: execution.configurationSnapshot,
        stepCount: steps.length,
        revisionCount,
        attemptCount,
        eventCount,
        inboxCount,
        conflictCount,
        outbox,
        budget: {
          account: budgetAccount
            ? {
                ceilings: budgetAccount.ceilings,
                parentAccountId: budgetAccount.parentAccountId,
              }
            : null,
          reservationCount,
        },
        policy: {
          snapshotVersion: policySnapshot
            ? String(policySnapshot.version ?? "")
            : null,
          snapshotHash: policySnapshot?.hash ?? null,
          decisionCount,
          decisions: policyDecisions.map((decision) => ({
            id: decision.id,
            actionType: decision.actionType,
            effect: decision.effect,
          })),
        },
        approvals,
        delegation: {
          supervised: graph.supervisedTotal,
          observed: graph.observedTotal,
        },
        state: {
          version: execution.executionStateVersion,
          contentHash: sha256Json(execution.executionState ?? {}),
          writeEvidenceCount,
        },
        artifacts: {
          producedCount: artifactCount,
          exposureCount,
        },
      };
      if (graph.supervisedTruncated) {
        warnings.push("Supervised delegation edges may be truncated");
      }
      if (graph.observedTruncated) {
        warnings.push("Observed delegation edges may be truncated");
      }

      const capsule: ExecutionCapsuleV1 = {
        schemaVersion: "1",
        executionId,
        capturedAt: new Date().toISOString(),
        pointInTime: terminal ? "terminal" : "live",
        sourceStatus: execution.status,
        contentHash: "",
        header,
        revisions: revisions.map((revision) => ({
          id: revision.id,
          revisionNumber: revision.revisionNumber,
          planHash: revision.planHash ?? null,
          source: revision.source,
          reason: revision.reason ?? null,
          validationResult:
            (revision.validationResult as Record<string, unknown>) ?? null,
          budget:
            "budget" in revision.plan
              ? ((revision.plan as { budget?: unknown }).budget ?? null)
              : null,
          steps: revision.plan.steps,
        })),
        attempts: attempts.map((attempt) => ({
          // The DAG step id (stable logical identity), not the row id.
          stepId:
            dagStepIdByLogicalId.get(attempt.logicalStepId) ??
            attempt.logicalStepId,
          attemptNumber: attempt.attemptNumber,
          status: attempt.status,
          invocationId: attempt.invocationId,
          planRevisionId: attempt.planRevisionId,
          frozenSpecHash: attempt.frozenSpecHash ?? null,
          executorSnapshot: attempt.executorSnapshot ?? null,
          inputSnapshotHash:
            attempt.inputSnapshot === null ||
            attempt.inputSnapshot === undefined
              ? null
              : sha256Json(attempt.inputSnapshot),
          contextSnapshotHash:
            attempt.contextSnapshot === null ||
            attempt.contextSnapshot === undefined
              ? null
              : sha256Json(attempt.contextSnapshot),
          terminalAt: attempt.terminalAt ?? null,
          error: attempt.error ?? null,
        })),
        ...(coordination ? { coordination } : {}),
        evidenceCompleteness: warnings,
      };
      const {
        capturedAt: _capturedAt,
        contentHash: _contentHash,
        ...stable
      } = capsule;
      // The policy snapshot version/hash are GLOBAL (the latest frozen
      // snapshot at capture) — they would drift for a terminal execution
      // when a new policy publishes. The stable hash covers the
      // execution's own durable facts only; the snapshot fields stay in
      // the header for display.
      const stableForHash = {
        ...stable,
        header: {
          ...stable.header,
          policy: {
            ...stable.header.policy,
            snapshotVersion: null,
            snapshotHash: null,
          },
        },
      };
      capsule.contentHash = sha256Json(stableForHash);
      return capsule;
    });
  }
}
