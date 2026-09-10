import { DataSource, type EntityManager } from "typeorm";
import { ExecutionEntity } from "../entities/execution.entity";
import { LogicalStepEntity } from "../entities/step-execution.entity";
import { ExecutionPlanRevisionEntity } from "../entities/execution-plan-revision.entity";
import { StepAttemptEntity } from "../entities/step-attempt.entity";
import { DispatchOutboxEntity } from "../entities/dispatch-outbox.entity";
import type { PipelineStepConfig } from "../domain/pipeline-definition";
import {
  ContextProjectionError,
  materializeContextSnapshot,
  selectProjectedValues,
  type ArtifactContextReference,
  type TenvyrContextEnvelope,
} from "../domain/context-snapshot";
import type { ExecutionState } from "../domain/execution-state";
import {
  buildClaimEfficiencyEvidence,
  computeContextBundleHash,
  executionStateBytesOf,
  measureContextEnvelope,
  workspaceIdentityOf,
  type ContextMetricsV1,
  type ContextWorkspaceIdentityV1,
  type HarnessIdentityV1,
  type InvocationEfficiencyEvidenceV1,
} from "../domain/context-bundle";
import { ContextProjectionCache } from "../executors/context-projection-cache";
import { CoordinationRunEntity } from "../entities/coordination-run.entity";
import { WorkspaceExecutionEntity } from "../entities/workspace-execution.entity";
import {
  executionWorkspaceIdentityFromRow,
  type ExecutionWorkspaceIdentityV1,
} from "../domain/workspace-execution";
import { ArtifactExposureEntity } from "../entities/artifact-exposure.entity";
import { ArtifactEntity } from "../entities/artifact.entity";
import { ArtifactProjectionResolver } from "./artifact-projection.resolver";
import { sha256Json } from "../domain/canonical-json";
import { ConditionEvaluatorService } from "./condition-evaluator.service";
import { MODEL_ID_MAX_LENGTH, MODEL_ID_PATTERN } from "../domain/coordination";
import { AgentTransportConfigService } from "../agent-adapters/agent-transport-config.service";
import { RuntimeConnectionService } from "./runtime-connection.service";
import { buildConnectionReference } from "../executors/runtime-connection";
import {
  attachLocalExecutorProfile,
  type ExecutorDescriptorV1,
} from "../executors/executor-descriptor";
import { BudgetLedgerService } from "./budget-ledger.service";
import { BudgetError } from "../domain/budget";
import { PolicyService } from "./policy.service";
import { buildDispatchProposal } from "../domain/policy";
import { ApprovalService } from "./approval.service";

export type ClaimDeps = {
  dataSource: DataSource;
  conditions: ConditionEvaluatorService;
  transportConfig: AgentTransportConfigService;
  connections: RuntimeConnectionService;
  budgetLedger: BudgetLedgerService;
  policyService: PolicyService;
  approvalService: ApprovalService;
  bundleCache: ContextProjectionCache;
  dependenciesResolved: (
    step: PipelineStepConfig,
    logicalSteps: LogicalStepEntity[],
    planSteps: PipelineStepConfig[],
  ) => boolean;
  conditionContext: (
    input: unknown,
    logicalSteps: LogicalStepEntity[],
  ) => Record<string, unknown>;
};

export type StepSchedulingClaim =
  | {
      disposition: "claimed";
      logicalStep: LogicalStepEntity;
      attempt: StepAttemptEntity;
    }
  | { disposition: "skipped"; logicalStep: LogicalStepEntity }
  | { disposition: "projection_failed" }
  | { disposition: "budget_insufficient" }
  | { disposition: "policy_denied" }
  | { disposition: "approval_required" }
  | { disposition: "runtime_capability" }
  | { disposition: "authority_expired" }
  | null;

/**
 * M8-S2/S6: freezes the attempt's secret-free executor snapshot. When a
 * Runtime Connection is selected — either by the STEP's typed selection
 * (`metadata.tenvyrConnectionId`, authoritative when present) or by the
 * agent's static transport configuration — the claim resolves the
 * connection's CURRENT immutable revision and embeds its exact reference
 * (connectionId/revisionNumber/configHash/capabilities) plus the frozen
 * secret-free local CLI execution profile (command/argv/cwd/env
 * references) into the descriptor; dispatch and Capsule provenance
 * consume exactly that frozen identity. Without a connection the pre-M8
 * descriptor path applies unchanged.
 */
async function resolveAttemptSnapshot(
  deps: ClaimDeps,
  agent: string,
  stepConnectionId?: string,
  stepModelId?: string,
  manager?: EntityManager,
): Promise<ExecutorDescriptorV1> {
  const connectionId =
    stepConnectionId ?? deps.transportConfig.forAgent(agent).connectionId;
  if (!connectionId) {
    const descriptor = deps.transportConfig.resolveExecutorDescriptor(agent);
    if (stepModelId !== undefined) descriptor.requestedModelId = stepModelId;
    return descriptor;
  }
  const revision = manager
    ? await deps.connections.claimRevisionWithManager(manager, connectionId)
    : await deps.connections.claimRevision(connectionId);
  const descriptor = deps.transportConfig.resolveExecutorDescriptor(agent);
  descriptor.connection = buildConnectionReference(revision);
  // P2: freeze the requested model exactly as the step declared it —
  // retries and redeliveries reuse this frozen descriptor, and a later
  // catalog refresh can never rewrite an attempt's requested model.
  if (stepModelId !== undefined) descriptor.requestedModelId = stepModelId;
  return attachLocalExecutorProfile(descriptor, revision);
}

/**
 * Materialize an idempotent scheduling candidate, then make the scheduling
 * decision while holding its row lock. Step rows are materialized by
 * createExecution/reconcileExecution, so scheduling only ever updates
 * existing rows. The executor is deliberately not touched here: the
 * committed outbox is its only hand-off.
 */
export async function claimRunnableStep(
  deps: ClaimDeps,
  executionId: string,
  requestedStep: PipelineStepConfig,
  inputSnapshot: unknown,
  maxAttempts: number,
  deadlineAt?: Date,
): Promise<StepSchedulingClaim> {
  return deps.dataSource.transaction(async (manager) => {
    const now = new Date();
    const logicalRepository = manager.getRepository(LogicalStepEntity);
    const attemptRepository = manager.getRepository(StepAttemptEntity);
    const outboxRepository = manager.getRepository(DispatchOutboxEntity);

    // SKIP LOCKED turns competing schedulers into a harmless no-op instead
    // of letting both select the same logical scheduling decision.
    const logicalStep = await logicalRepository
      .createQueryBuilder("step")
      .setLock("pessimistic_write")
      .setOnLocked("skip_locked")
      .where('step."executionId" = :executionId', { executionId })
      .andWhere('step."stepId" = :stepId', { stepId: requestedStep.id })
      .andWhere('step."status" IN (:...runnable)', {
        runnable: ["READY", "RETRYING"],
      })
      .andWhere('(step."eligibleAt" IS NULL OR step."eligibleAt" <= :now)', {
        now,
      })
      .andWhere(
        '(step."nextAttemptAt" IS NULL OR step."nextAttemptAt" <= :now)',
        { now },
      )
      .getOne();
    if (!logicalStep) return null;

    const execution = await manager
      .getRepository(ExecutionEntity)
      .createQueryBuilder("execution")
      .setLock("pessimistic_write")
      .where('execution."id" = :id', { id: executionId })
      .getOne();
    if (!execution || execution.status !== "RUNNING") return null;
    if (
      execution.authorityDeadlineAt &&
      execution.authorityDeadlineAt.getTime() <= now.getTime()
    ) {
      const failure = "AUTHORITY_DEADLINE_EXCEEDED";
      logicalStep.status = "CANCELLED";
      logicalStep.error = failure;
      logicalStep.endTime = now;
      logicalStep.nextAttemptAt = null;
      execution.status = "FAILED";
      execution.endTime = now;
      execution.terminationReason = failure;
      await logicalRepository.save(logicalStep);
      await manager.getRepository(ExecutionEntity).save(execution);
      return { disposition: "authority_expired" };
    }
    const attemptDeadlineAt = execution.authorityDeadlineAt
      ? deadlineAt
        ? new Date(
            Math.min(
              deadlineAt.getTime(),
              execution.authorityDeadlineAt.getTime(),
            ),
          )
        : execution.authorityDeadlineAt
      : deadlineAt;
    if (!execution.activePlanRevisionId) {
      throw new Error(`Execution ${executionId} has no active plan revision`);
    }

    const revision = await manager
      .getRepository(ExecutionPlanRevisionEntity)
      .findOne({ where: { id: execution.activePlanRevisionId } });
    const stepConfig = revision?.plan.steps.find(
      (step) => step.id === requestedStep.id,
    );
    if (!revision || !stepConfig) {
      throw new Error(
        `Active plan revision does not define step ${requestedStep.id}`,
      );
    }

    const frozenSpecHash = sha256Json(stepConfig);
    if (
      logicalStep.frozenSpecHash &&
      logicalStep.frozenSpecHash !== frozenSpecHash
    ) {
      throw new Error(
        `Step ${stepConfig.id} execution specification is frozen`,
      );
    }
    // M8-S6: the TYPED runtime selection rides on the step (PlanPatch
    // validation -> materialization -> claim). The step's frozen
    // connection wins over the static agent transport configuration —
    // two steps selecting different connections can never be silently
    // routed through the same static config entry.
    const stepConnectionId = stepConnectionIdOf(stepConfig);
    // P2: the frozen requested model (data value) rides the same way.
    const stepModelId = stepModelIdOf(stepConfig);

    // P3: coordinated runs freeze a WorkspaceSnapshot at start; its
    // bounded structural identity participates in the ContextBundle
    // fingerprint and the efficiency evidence. One indexed lookup per
    // claim; absent for non-coordinated executions.
    const coordinationRun = await manager
      .getRepository(CoordinationRunEntity)
      .findOne({ where: { executionId } });
    const workspaceIdentity: ContextWorkspaceIdentityV1 | undefined =
      coordinationRun?.workspace
        ? workspaceIdentityOf(coordinationRun.workspace)
        : undefined;
    // PP1 — Pivot Invariant 1: the run's Tenvyr-owned execution workspace
    // (shared source tree or isolated git worktree) rides the invocation
    // as a RESERVED metadata member. The local executor host validates
    // the path against its allowlisted root and spawns every runtime
    // child there. Planner/worker task input can never choose or
    // override cwd — cwd comes from Tenvyr authority.
    const executionWorkspaceIdentity: ExecutionWorkspaceIdentityV1 | null =
      coordinationRun
        ? await manager
            .getRepository(WorkspaceExecutionEntity)
            .findOne({ where: { ownerRunId: coordinationRun.id } })
            .then((row) =>
              row ? executionWorkspaceIdentityFromRow(row) : null,
            )
        : null;

    const allSteps = await logicalRepository.find({
      where: { executionId },
    });
    if (!deps.dependenciesResolved(stepConfig, allSteps, revision.plan.steps)) {
      return null;
    }

    const conditionResult = stepConfig.condition
      ? deps.conditions.evaluate(
          stepConfig.condition,
          deps.conditionContext(execution.input, allSteps),
        )
      : true;
    logicalStep.conditionResult = conditionResult;
    logicalStep.frozenSpecHash = frozenSpecHash;
    logicalStep.frozenAt ??= now;
    if (!conditionResult) {
      logicalStep.status = "SKIPPED";
      logicalStep.endTime = now;
      logicalStep.nextAttemptAt = null;
      await logicalRepository.save(logicalStep);
      return { disposition: "skipped", logicalStep };
    }

    const activeAttempt = await attemptRepository
      .createQueryBuilder("attempt")
      .where('attempt."logicalStepId" = :logicalStepId', {
        logicalStepId: logicalStep.id,
      })
      .andWhere('attempt."status" IN (:...active)', {
        active: ["CREATED", "DISPATCHED", "RUNNING"],
      })
      .getOne();
    if (activeAttempt) return null;

    const attemptNumber = logicalStep.attempt + 1;
    logicalStep.agent = stepConfig.agent;
    logicalStep.input = inputSnapshot;
    logicalStep.status = "RUNNING";
    logicalStep.attempt = attemptNumber;
    logicalStep.maxAttempts = maxAttempts;
    logicalStep.eligibleAt = null;
    logicalStep.nextAttemptAt = null;
    logicalStep.output = null;
    logicalStep.error = null;
    logicalStep.startTime ??= now;
    logicalStep.endTime = null;
    await logicalRepository.save(logicalStep);

    // P3: resolve the frozen executor snapshot ONCE per claim. Every
    // sub-path (projection, policy/budget failures, WAITING, dispatch)
    // shares the same frozen harness identity, so the efficiency evidence
    // is internally consistent, and connection revocation stays a LIVE
    // authority gate — claimRevision asserts "not revoked" and throws
    // before any outbox is created.
    const executorSnapshot = await resolveAttemptSnapshot(
      deps,
      stepConfig.agent,
      stepConnectionId,
      stepModelId,
      manager,
    );

    // M2C/M2D: the execution lock is already held, so the state read below
    // is race-free. The immutable Tenvyr context envelope (state projection
    // plus resolved artifact references) is materialized here and persisted
    // on the attempt AND in the outbox invocation atomically; dispatch and
    // recovery never recompute it. M2D exposure edges commit in the same
    // transaction. A projection failure becomes a durable FAILED attempt
    // with no outbox/exposure, then follows the frozen step's retry/continue/
    // stop policy in this same transaction. This records the consumed retry
    // budget without pretending any Worker received context.
    //
    // P3: the SAME deterministic projection inputs may already exist as an
    // immutable ContextBundle — identical inputs → identical hash → the
    // already-materialized bounded projection is REUSED (Context Projection
    // Reuse) instead of rebuilding the envelope + validation pass. Authority
    // gates below (capability, policy, budget, deadline, connection) run
    // identically on hit AND miss.
    let contextSnapshot: TenvyrContextEnvelope | null = null;
    let exposureArtifacts: ArtifactEntity[] = [];
    let contextBundleEvidence: { hash: string; reused: boolean } | null = null;
    let contextMetrics: ContextMetricsV1 | null = null;
    if (stepConfig.contextProjection) {
      try {
        const projected = await materializeProjectedContext(
          deps,
          manager,
          execution,
          stepConfig,
          executorSnapshot,
          revision.planHash ?? undefined,
          workspaceIdentity,
        );
        contextSnapshot = projected.envelope;
        exposureArtifacts = projected.artifacts;
        contextBundleEvidence = {
          hash: projected.hash,
          reused: projected.reused,
        };
        contextMetrics = projected.metrics;
      } catch (error) {
        if (!(error instanceof ContextProjectionError)) throw error;

        const failure = `Context projection failed: ${error.code}`;
        await attemptRepository.save(
          attemptRepository.create({
            executionId,
            logicalStepId: logicalStep.id,
            planRevisionId: revision.id,
            attemptNumber,
            invocationId: `${logicalStep.id}:${attemptNumber}`,
            frozenSpecHash,
            inputSnapshot,
            contextSnapshot: null,
            executorSnapshot,
            efficiency: claimEfficiencyEvidence(
              `${logicalStep.id}:${attemptNumber}`,
              stepConfig.agent,
              executorSnapshot,
              workspaceIdentity,
              null,
              null,
              false,
              now.toISOString(),
            ),
            status: "FAILED",
            deadlineAt: attemptDeadlineAt,
            terminalAt: now,
            error: failure,
            terminationReason: failure,
          }),
        );

        const retry =
          stepConfig.onFailure === "retry" && attemptNumber < maxAttempts;
        logicalStep.status = retry ? "RETRYING" : "FAILED";
        logicalStep.error = failure;
        logicalStep.endTime = retry ? null : now;
        logicalStep.nextAttemptAt = retry ? now : null;
        await logicalRepository.save(logicalStep);

        if (!retry && stepConfig.onFailure !== "continue") {
          execution.status = "FAILED";
          execution.endTime = now;
          execution.terminationReason = failure;
          execution.output = { failedStep: stepConfig.id, error: failure };
          await manager.getRepository(ExecutionEntity).save(execution);
        }
        return { disposition: "projection_failed" };
      }
    }

    // M4-S2/S3: durable pre-dispatch failure — a policy DENY,
    // REQUIRE_APPROVAL (S3: treated as a blocked disposition until S4
    // adds the WAITING approval flow), or an insufficient budget grants
    // NO work authority. The FAILED attempt follows the step's failure
    // policy, exactly like the projection-failure path.
    // M6-S5: capability negotiation — the step's declared delegation
    // mode must be within the runtime's advertised modes (the operator
    // declares them in AGENT_TRANSPORT_CONFIG; absent declaration =
    // unrestricted). A mismatch is a deterministic safe failure: no work
    // authority without the negotiated capability.
    const negotiated = () => {
      if (stepConfig.delegation !== "observed") return true;
      const runtimeModes = deps.transportConfig.forAgent(stepConfig.agent)
        .delegationModes ?? ["opaque", "observed"];
      return runtimeModes.includes("observed");
    };

    const failAttemptDurably = async (
      failure: string,
      disposition:
        | "budget_insufficient"
        | "policy_denied"
        | "runtime_capability",
    ) => {
      await attemptRepository.save(
        attemptRepository.create({
          executionId,
          logicalStepId: logicalStep.id,
          planRevisionId: revision.id,
          attemptNumber,
          invocationId: `${logicalStep.id}:${attemptNumber}`,
          frozenSpecHash,
          inputSnapshot,
          contextSnapshot,
          executorSnapshot,
          efficiency: claimEfficiencyEvidence(
            `${logicalStep.id}:${attemptNumber}`,
            stepConfig.agent,
            executorSnapshot,
            workspaceIdentity,
            contextBundleEvidence,
            contextMetrics,
            false,
            now.toISOString(),
          ),
          status: "FAILED",
          deadlineAt: attemptDeadlineAt,
          terminalAt: now,
          error: failure,
          terminationReason: failure,
        }),
      );

      const retry =
        stepConfig.onFailure === "retry" && attemptNumber < maxAttempts;
      logicalStep.status = retry ? "RETRYING" : "FAILED";
      logicalStep.error = failure;
      logicalStep.endTime = retry ? null : now;
      logicalStep.nextAttemptAt = retry ? now : null;
      await logicalRepository.save(logicalStep);

      if (!retry && stepConfig.onFailure !== "continue") {
        execution.status = "FAILED";
        execution.endTime = now;
        execution.terminationReason = failure;
        execution.output = { failedStep: stepConfig.id, error: failure };
        await manager.getRepository(ExecutionEntity).save(execution);
      }
      return { disposition };
    };

    // M6-S5: capability negotiation — a mismatch is a deterministic safe
    // failure BEFORE any dispatch authority.
    if (!negotiated()) {
      return failAttemptDurably(
        `Runtime for agent "${stepConfig.agent}" does not support observed delegation`,
        "runtime_capability",
      );
    }

    // M4-S3: policy intercepts BEFORE side effects — before the budget
    // reserve and before any dispatch. The append-only decision commits
    // atomically with the intercepted action's outcome. An ALLOW decision
    // without a successful required reservation grants no authority (the
    // budget reserve below is that gate).
    if (deps.policyService.isConfigured()) {
      const proposal = buildDispatchProposal(
        `${logicalStep.id}:${attemptNumber}`,
        {
          executionId,
          logicalStepId: logicalStep.id,
          attemptNumber,
          agent: stepConfig.agent,
          executor: deps.transportConfig.resolveExecutorDescriptor(
            stepConfig.agent,
          ).kind,
        },
      );
      const decision = await deps.policyService.evaluate(proposal, manager);
      if (decision.effect === "DENY") {
        return failAttemptDurably(
          "Policy DENY: " + decision.reasons.join(", "),
          "policy_denied",
        );
      }
      if (decision.effect === "REQUIRE_APPROVAL") {
        // M4-S4: durable ApprovalRequest + WAITING — the attempt makes
        // NO autonomous progress (WAITING is never a retryable failure).
        // Approving resumes the SAME attempt; the request is exactly-once.
        const waitingAttempt = await attemptRepository.save(
          attemptRepository.create({
            executionId,
            logicalStepId: logicalStep.id,
            planRevisionId: revision.id,
            attemptNumber,
            invocationId: `${logicalStep.id}:${attemptNumber}`,
            frozenSpecHash,
            inputSnapshot,
            contextSnapshot,
            executorSnapshot,
            efficiency: claimEfficiencyEvidence(
              `${logicalStep.id}:${attemptNumber}`,
              stepConfig.agent,
              executorSnapshot,
              workspaceIdentity,
              contextBundleEvidence,
              contextMetrics,
              false,
              now.toISOString(),
            ),
            status: "WAITING",
            deadlineAt: attemptDeadlineAt,
          }),
        );
        logicalStep.status = "WAITING";
        logicalStep.error = "Approval required";
        await logicalRepository.save(logicalStep);
        await deps.approvalService.request(proposal, manager);
        void waitingAttempt;
        return { disposition: "approval_required" };
      }
    }

    // M4-S2: reserve before granting work authority. The reservation
    // commits atomically with the attempt + outbox; insufficient budget
    // becomes a durable FAILED attempt that follows the step's failure
    // policy — no dispatch authority is granted without a reservation.
    if (stepConfig.budget) {
      try {
        const account = await deps.budgetLedger.ensureExecutionAccount(
          manager,
          executionId,
          (
            revision.plan as {
              budget?: {
                parent?: { scopeType: string; scopeId: string };
                ceilings: Record<string, number>;
              };
            }
          ).budget,
          stepConfig.budget,
        );
        await deps.budgetLedger.reserveForAttempt(manager, {
          executionId,
          logicalStepId: logicalStep.id,
          attemptNumber,
          invocationId: `${logicalStep.id}:${attemptNumber}`,
          accountId: account.id,
          budget: stepConfig.budget,
        });
      } catch (error) {
        if (error instanceof BudgetError) {
          return failAttemptDurably(
            `Budget reservation failed: ${error.code}`,
            "budget_insufficient",
          );
        }
        throw error;
      }
    }

    // M8-S6: the frozen snapshot (connection reference + local profile)
    // is computed ONCE per claim (above) and reused for the attempt row AND
    // the outbox invocation, so dispatch carries exactly what the claim
    // froze. The dispatchable attempt records session mode FRESH (a real
    // runtime invocation is created out of this claim; current runtimes are
    // all single-shot, so no session is ever reused/resumed).
    const attempt = await attemptRepository.save(
      attemptRepository.create({
        executionId,
        logicalStepId: logicalStep.id,
        planRevisionId: revision.id,
        attemptNumber,
        invocationId: `${logicalStep.id}:${attemptNumber}`,
        frozenSpecHash,
        inputSnapshot,
        contextSnapshot,
        executorSnapshot,
        efficiency: claimEfficiencyEvidence(
          `${logicalStep.id}:${attemptNumber}`,
          stepConfig.agent,
          executorSnapshot,
          workspaceIdentity,
          contextBundleEvidence,
          contextMetrics,
          true,
          now.toISOString(),
        ),
        status: "CREATED",
        deadlineAt: attemptDeadlineAt,
      }),
    );

    // M2D: append-only exposure edges commit with the attempt; a failure
    // here rolls back the attempt, snapshot, and outbox together.
    if (exposureArtifacts.length > 0) {
      await manager
        .getRepository(ArtifactExposureEntity)
        .createQueryBuilder()
        .insert()
        .into(ArtifactExposureEntity)
        .values(
          exposureArtifacts.map((artifact) => ({
            stepAttemptId: attempt.id,
            artifactId: artifact.id,
          })),
        )
        .orIgnore()
        .execute();
    }
    const createdAt = now.toISOString();
    await outboxRepository.save(
      outboxRepository.create({
        stepAttemptId: attempt.id,
        invocation: {
          schemaVersion: "1",
          invocationId: attempt.invocationId,
          executionId,
          stepExecutionId: logicalStep.id,
          stepId: stepConfig.id,
          target: { agent: stepConfig.agent },
          input: inputSnapshot,
          attempt: attemptNumber,
          createdAt,
          deadlineAt: attemptDeadlineAt?.toISOString(),
          ...(contextSnapshot ? { context: contextSnapshot } : {}),
          trace: {
            traceId: executionId,
            correlationId: attempt.invocationId,
          },
          metadata: {
            orchestration: { maxAttempts },
            // PP1: the run's Tenvyr-owned execution workspace (reserved
            // shape — planner/worker input can never override it).
            ...(executionWorkspaceIdentity
              ? { tenvyr: { executionWorkspace: executionWorkspaceIdentity } }
              : {}),
          },
          // M8-S6: the frozen connection revision identity rides the
          // invocation; the executor host validates its fixed operator
          // configuration against it and fails closed on mismatch. Only
          // the identity triple crosses the wire (the full reference
          // stays in the attempt snapshot).
          ...(executorSnapshot.connection
            ? {
                connection: {
                  connectionId: executorSnapshot.connection.connectionId,
                  revisionNumber: executorSnapshot.connection.revisionNumber,
                  configHash: executorSnapshot.connection.configHash,
                },
              }
            : {}),
          // P2: the frozen requested model rides the invocation as data;
          // the executor host composes it behind its own fixed argv
          // (`modelArgvPrefix`) and fails closed when it cannot.
          ...(executorSnapshot.requestedModelId
            ? { requestedModelId: executorSnapshot.requestedModelId }
            : {}),
        },
      }),
    );
    return { disposition: "claimed", logicalStep, attempt };
  });
}

/**
 * M2C/M2D + P3: build the immutable context envelope under the already-held
 * execution lock. State values are selected from the authoritative semantic
 * state version; artifact references are resolved from the canonical
 * APPLIED results of declared dependency steps (same-execution only). The
 * complete envelope is bounded at 65,536 canonical UTF-8 bytes. Returns the
 * envelope plus the authoritative Artifact entities for exposure edges.
 *
 * P3 — Context Projection Reuse: the fingerprint is computed from canonical
 * deterministic projection inputs BEFORE the expensive materialization +
 * validation pass. An identical existing immutable bundle (same hash) is
 * REUSED instead of rebuilt; a miss performs the normal non-cache path and
 * stores the fresh bundle. Artifact resolution always executes — its
 * resolved references are a load-bearing fingerprint input and the
 * append-only exposure edges must be built from live resolution.
 */
async function materializeProjectedContext(
  deps: ClaimDeps,
  manager: EntityManager,
  execution: ExecutionEntity,
  stepConfig: PipelineStepConfig,
  executorSnapshot: ExecutorDescriptorV1,
  planHash: string | undefined,
  workspace: ContextWorkspaceIdentityV1 | undefined,
): Promise<{
  envelope: TenvyrContextEnvelope;
  artifacts: ArtifactEntity[];
  metrics: ContextMetricsV1;
  reused: boolean;
  hash: string;
}> {
  const projection = stepConfig.contextProjection!;
  let references: ArtifactContextReference[] = [];
  let artifacts: ArtifactEntity[] = [];
  if (projection.artifacts && projection.artifacts.length > 0) {
    const resolved = await new ArtifactProjectionResolver(manager).resolve(
      execution.id,
      projection.artifacts,
    );
    references = resolved.references;
    artifacts = resolved.artifacts;
  }
  const state = (execution.executionState ?? {}) as ExecutionState;
  const hash = computeContextBundleHash({
    bundleSchemaVersion: 1,
    contextSchemaVersion: 1,
    stateProjection: {
      version: execution.executionStateVersion,
      values: selectProjectedValues(projection, state),
    },
    artifacts: references,
    harness: harnessIdentityOf(stepConfig.agent, executorSnapshot),
    ...(planHash !== undefined ? { planHash } : {}),
    ...(workspace !== undefined ? { workspace } : {}),
  });
  const cached = deps.bundleCache.get(hash);
  if (cached) {
    // HIT: reuse the already-materialized immutable projection (the cache
    // hands out an isolated deep clone; callers persist it without ever
    // mutating the stored bundle). Envelope-derived metrics come from the
    // cached bundle, but `executionStateBytes` measures the FULL current
    // execution state — it is NOT a function of the cached envelope and is
    // recomputed per claim so an attempt never inherits another
    // execution's full-state size.
    return {
      envelope: cached.envelope,
      artifacts,
      metrics: {
        ...cached.metrics,
        executionStateBytes: executionStateBytesOf(state),
      },
      reused: true,
      hash,
    };
  }
  const envelope = materializeContextSnapshot(
    projection,
    state,
    execution.executionStateVersion,
    references,
  );
  const metrics = measureContextEnvelope(envelope, state);
  deps.bundleCache.set(hash, envelope, metrics);
  return { envelope, artifacts, metrics, reused: false, hash };
}

/** P3: frozen harness identity for one claim (no secrets, references
 *  only). */
function harnessIdentityOf(
  agent: string,
  snapshot: ExecutorDescriptorV1,
): HarnessIdentityV1 {
  const harness: HarnessIdentityV1 = {
    agent,
    executorKind: snapshot.kind,
    configHash: snapshot.configHash,
  };
  if (snapshot.connection) {
    harness.connectionId = snapshot.connection.connectionId;
    harness.connectionRevision = snapshot.connection.revisionNumber;
  }
  if (snapshot.requestedModelId) {
    harness.requestedModelId = snapshot.requestedModelId;
  }
  return harness;
}

/** P3: immutable claim-time efficiency evidence for one attempt. */
function claimEfficiencyEvidence(
  invocationId: string,
  agent: string,
  executorSnapshot: ExecutorDescriptorV1,
  workspace: ContextWorkspaceIdentityV1 | undefined,
  contextBundle: { hash: string; reused: boolean } | null,
  context: ContextMetricsV1 | null,
  dispatchable: boolean,
  startedAt: string,
): InvocationEfficiencyEvidenceV1 {
  return buildClaimEfficiencyEvidence({
    invocationId,
    harness: harnessIdentityOf(agent, executorSnapshot),
    ...(workspace !== undefined ? { workspace } : {}),
    contextBundle,
    context,
    dispatchable,
    startedAt,
  });
}

/**
 * M8-S6: extracts the typed Runtime Connection selection recorded on a
 * materialized step (`metadata.tenvyrConnectionId`, written by the
 * Coordinator's PlanPatch compilation or the operator). Strict bounds
 * mirror the connection-id contract; anything malformed is a
 * deterministic configuration failure, never silently ignored — a step
 * that claims a connection must claim a REAL one.
 */
export function stepConnectionIdOf(
  stepConfig: PipelineStepConfig,
): string | undefined {
  const raw = stepConfig.metadata?.tenvyrConnectionId;
  if (raw === undefined || raw === null) return undefined;
  if (
    typeof raw !== "string" ||
    raw.length === 0 ||
    raw.length > 255 ||
    !/^[A-Za-z0-9_.:-]+$/.test(raw)
  ) {
    throw new Error(
      `Step "${stepConfig.id}" metadata.tenvyrConnectionId must match [A-Za-z0-9_.:-] (at most 255 characters)`,
    );
  }
  return raw;
}

/**
 * P2: extracts the frozen requested model recorded on a materialized step
 * (`metadata.tenvyrModelId`, written by the Coordinator's PlanPatch
 * compilation — Planner task modelId, deterministic single-model
 * resolution, or the operator-frozen role target). Strict bounds mirror
 * the model-id data contract; anything malformed is a deterministic
 * configuration failure, never silently ignored — a step that requests a
 * model must request a REAL one.
 */
export function stepModelIdOf(
  stepConfig: PipelineStepConfig,
): string | undefined {
  const raw = stepConfig.metadata?.tenvyrModelId;
  if (raw === undefined || raw === null) return undefined;
  if (
    typeof raw !== "string" ||
    raw.length === 0 ||
    raw.length > MODEL_ID_MAX_LENGTH ||
    !MODEL_ID_PATTERN.test(raw)
  ) {
    throw new Error(
      `Step "${stepConfig.id}" metadata.tenvyrModelId must match ${MODEL_ID_PATTERN} (at most ${MODEL_ID_MAX_LENGTH} characters)`,
    );
  }
  return raw;
}
