import { Injectable, Inject, Optional } from "@nestjs/common";
import { DataSource, type EntityManager, Repository } from "typeorm";
import { ExecutionEntity, ExecutionStatus } from "../entities/execution.entity";
import {
  LogicalStepEntity,
  StepExecutionEntity,
  StepStatus,
} from "../entities/step-execution.entity";
import { ExecutionPlanRevisionEntity } from "../entities/execution-plan-revision.entity";
import {
  StepAttemptEntity,
  StepAttemptStatus,
} from "../entities/step-attempt.entity";
import { DispatchOutboxEntity } from "../entities/dispatch-outbox.entity";
import { PipelineEntity } from "../entities/pipeline.entity";
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
  measureContextEnvelope,
  workspaceIdentityOf,
  type ContextMetricsV1,
  type ContextWorkspaceIdentityV1,
  type HarnessIdentityV1,
  type InvocationEfficiencyEvidenceV1,
} from "../domain/context-bundle";
import { ContextProjectionCache } from "../executors/context-projection-cache";
import { CoordinationRunEntity } from "../entities/coordination-run.entity";
import { ArtifactExposureEntity } from "../entities/artifact-exposure.entity";
import { ArtifactEntity } from "../entities/artifact.entity";
import { ArtifactProjectionResolver } from "./artifact-projection.resolver";
import { sha256Json } from "../domain/canonical-json";
import { ConditionEvaluatorService } from "./condition-evaluator.service";
import { MODEL_ID_MAX_LENGTH, MODEL_ID_PATTERN } from "../domain/coordination";
import { AgentTransportConfigService } from "../agent-adapters/agent-transport-config.service";
import { RuntimeConnectionService } from "./runtime-connection.service";
import { RuntimeCoordinationService } from "./runtime-coordination.service";
import { buildConnectionReference } from "../executors/runtime-connection";
import {
  attachLocalExecutorProfile,
  type ExecutorDescriptorV1,
} from "../executors/executor-descriptor";
import { BudgetLedgerService } from "./budget-ledger.service";
import { BudgetError, parsePipelineBudget } from "../domain/budget";
import { PolicyService } from "./policy.service";
import { buildDispatchProposal } from "../domain/policy";
import { ApprovalService } from "./approval.service";

const TERMINAL_ATTEMPT_STATUSES: StepAttemptStatus[] = [
  "SUCCESS",
  "FAILED",
  "TIMED_OUT",
  "CANCELLED",
];

const TERMINAL_EXECUTION_STATUSES: ExecutionStatus[] = [
  "COMPLETED",
  "FAILED",
  "CANCELLED",
];

const ACTIVE_ATTEMPT_STATUSES: StepAttemptStatus[] = [
  "CREATED",
  "DISPATCHED",
  "RUNNING",
  "WAITING",
];

const CANCELLABLE_STEP_STATUSES: StepStatus[] = [
  "PENDING",
  "READY",
  "RUNNING",
  "RETRYING",
  "WAITING",
];

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

@Injectable()
export class ExecutionService {
  constructor(
    @Inject("EXECUTION_REPOSITORY")
    private executionRepository: Repository<ExecutionEntity>,
    @Inject("STEP_EXECUTION_REPOSITORY")
    private stepExecutionRepository: Repository<StepExecutionEntity>,
    @Inject("STEP_ATTEMPT_REPOSITORY")
    private stepAttemptRepository: Repository<StepAttemptEntity>,
    @Inject("EXECUTION_PLAN_REVISION_REPOSITORY")
    private planRevisionRepository: Repository<ExecutionPlanRevisionEntity>,
    @Inject("DATA_SOURCE")
    private dataSource: DataSource,
    private readonly conditions: ConditionEvaluatorService = new ConditionEvaluatorService(),
    private readonly transportConfig: AgentTransportConfigService = new AgentTransportConfigService(),
    budgetLedger?: BudgetLedgerService,
    policyService?: PolicyService,
    approvalService?: ApprovalService,
    connections?: RuntimeConnectionService,
    coordinationService?: RuntimeCoordinationService,
    @Optional() bundleCache?: ContextProjectionCache,
  ) {
    // M4-S2: default ledger bound to the injected DataSource so direct
    // constructions (tests) and Nest DI both get a working instance.
    this.budgetLedger =
      budgetLedger ?? new BudgetLedgerService(this.dataSource);
    this.policyService = policyService ?? new PolicyService(this.dataSource);
    this.approvalService =
      approvalService ?? new ApprovalService(this.dataSource);
    this.connections =
      connections ?? new RuntimeConnectionService(this.dataSource);
    this.coordination =
      coordinationService ?? new RuntimeCoordinationService(this.dataSource);
    this.bundleCache = bundleCache ?? new ContextProjectionCache();
  }

  private readonly budgetLedger: BudgetLedgerService;
  private readonly policyService: PolicyService;
  private readonly approvalService: ApprovalService;
  private readonly connections: RuntimeConnectionService;
  private readonly coordination: RuntimeCoordinationService;
  /** P3: the ONE deterministic optimization — content-addressed reuse of
   *  already-materialized immutable context envelopes. Process-local,
   *  bounded, fail-closed on restart; never authority. Exposed for tests
   *  and aggregate projections. */
  readonly bundleCache: ContextProjectionCache;

  /**
   * M11-S4: liveness/readiness probe with safe reason codes (never
   * secrets or raw errors). Readiness requires PostgreSQL reachable and
   * migrations applied.
   */
  async healthProbe(): Promise<{ ready: boolean; reasonCode: string }> {
    try {
      await this.dataSource.query("SELECT 1");
      const migrationsTable = (await this.dataSource.query(
        "SELECT to_regclass('public.migrations') AS name",
      )) as Array<{ name: string | null }>;
      if (migrationsTable[0]?.name === null) {
        return { ready: false, reasonCode: "migrations-required" };
      }
      const rows = (await this.dataSource.query(
        "SELECT count(*)::int AS applied FROM migrations",
      )) as Array<{ applied: number }>;
      if ((rows[0]?.applied ?? 0) > 0) {
        return { ready: true, reasonCode: "ready" };
      }
      return { ready: false, reasonCode: "migrations-required" };
    } catch {
      return { ready: false, reasonCode: "postgres-unreachable" };
    }
  }

  /**
   * M9-S2: completion hold — a non-terminal CoordinationRun prevents the
   * generic engine from marking the Execution COMPLETED. The hold releases
   * when the run reaches a terminal phase (ACCEPTED/Failed/etc.).
   */
  async isCoordinationCompletionHeld(executionId: string): Promise<boolean> {
    return this.coordination.isCompletionHeld(executionId);
  }

  /** M9-S4: deterministic Coordinator loop reconciliation (PostgreSQL
   *  only). True when the loop made an autonomous decision. */
  async reconcileCoordination(executionId: string): Promise<boolean> {
    return this.coordination.reconcileCoordination(executionId);
  }

  /** M9-S4: is this logical step a Coordinator-owned Verifier step? */
  async isCoordinationVerifierStep(
    executionId: string,
    stepId: string,
  ): Promise<boolean> {
    return this.coordination.isVerifierStep(executionId, stepId);
  }

  /** M9-S4: bounded Verifier aggregation, frozen at claim time. */
  async buildVerifierInput(
    executionId: string,
    stepId: string,
  ): Promise<unknown> {
    return this.coordination.buildVerifierInput(executionId, stepId);
  }

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
  private async resolveAttemptSnapshot(
    agent: string,
    stepConnectionId?: string,
    stepModelId?: string,
    manager?: import("typeorm").EntityManager,
  ): Promise<ExecutorDescriptorV1> {
    const connectionId =
      stepConnectionId ?? this.transportConfig.forAgent(agent).connectionId;
    if (!connectionId) {
      const descriptor = this.transportConfig.resolveExecutorDescriptor(agent);
      if (stepModelId !== undefined) descriptor.requestedModelId = stepModelId;
      return descriptor;
    }
    const revision = manager
      ? await this.connections.claimRevisionWithManager(manager, connectionId)
      : await this.connections.claimRevision(connectionId);
    const descriptor = this.transportConfig.resolveExecutorDescriptor(agent);
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
  async claimRunnableStep(
    executionId: string,
    requestedStep: PipelineStepConfig,
    inputSnapshot: unknown,
    maxAttempts: number,
    deadlineAt?: Date,
  ): Promise<StepSchedulingClaim> {
    return this.dataSource.transaction(async (manager) => {
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

      const allSteps = await logicalRepository.find({
        where: { executionId },
      });
      if (
        !this.dependenciesResolved(stepConfig, allSteps, revision.plan.steps)
      ) {
        return null;
      }

      const conditionResult = stepConfig.condition
        ? this.conditions.evaluate(
            stepConfig.condition,
            this.conditionContext(execution.input, allSteps),
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
      const executorSnapshot = await this.resolveAttemptSnapshot(
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
          const projected = await this.materializeProjectedContext(
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
              efficiency: this.claimEfficiencyEvidence(
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
        const runtimeModes = this.transportConfig.forAgent(stepConfig.agent)
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
            efficiency: this.claimEfficiencyEvidence(
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
      if (this.policyService.isConfigured()) {
        const proposal = buildDispatchProposal(
          `${logicalStep.id}:${attemptNumber}`,
          {
            executionId,
            logicalStepId: logicalStep.id,
            attemptNumber,
            agent: stepConfig.agent,
            executor: this.transportConfig.resolveExecutorDescriptor(
              stepConfig.agent,
            ).kind,
          },
        );
        const decision = await this.policyService.evaluate(proposal, manager);
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
              efficiency: this.claimEfficiencyEvidence(
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
          await this.approvalService.request(proposal, manager);
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
          const account = await this.budgetLedger.ensureExecutionAccount(
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
          await this.budgetLedger.reserveForAttempt(manager, {
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
          efficiency: this.claimEfficiencyEvidence(
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
            metadata: { orchestration: { maxAttempts } },
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
  private async materializeProjectedContext(
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
      harness: this.harnessIdentityOf(stepConfig.agent, executorSnapshot),
      ...(planHash !== undefined ? { planHash } : {}),
      ...(workspace !== undefined ? { workspace } : {}),
    });
    const cached = this.bundleCache.get(hash);
    if (cached) {
      // HIT: reuse the already-materialized immutable projection (the cache
      // hands out an isolated deep clone; callers persist it without ever
      // mutating the stored bundle).
      return {
        envelope: cached.envelope,
        artifacts,
        metrics: cached.metrics,
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
    this.bundleCache.set(hash, envelope, metrics);
    return { envelope, artifacts, metrics, reused: false, hash };
  }

  /** P3: frozen harness identity for one claim (no secrets, references
   *  only). */
  private harnessIdentityOf(
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
  private claimEfficiencyEvidence(
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
      harness: this.harnessIdentityOf(agent, executorSnapshot),
      ...(workspace !== undefined ? { workspace } : {}),
      contextBundle,
      context,
      dispatchable,
      startedAt,
    });
  }

  async createExecution(
    pipeline: PipelineEntity,
    input: unknown,
  ): Promise<ExecutionEntity> {
    return this.dataSource.transaction((manager) =>
      this.materializeExecutionWithManager(manager, pipeline, input),
    );
  }

  /**
   * M6-S2: manager-aware execution materializer — execution row, plan
   * revision 1, and logical step rows commit all-or-none inside the
   * CALLER's transaction. Used by createExecution and by supervised
   * delegation (a child execution materializes atomically with its
   * authority decision).
   */
  /**
   * M7-S3: bounded read of this execution's artifact exposure edges —
   * the claim seam is the single exposure authority, so the read lives
   * here (never in the capsule/provenance services).
   */
  async listArtifactExposures(
    executionId: string,
    limit = 100,
    manager: EntityManager = this.dataSource.manager,
  ): Promise<ArtifactExposureEntity[]> {
    return manager
      .getRepository(ArtifactExposureEntity)
      .createQueryBuilder("exposure")
      .innerJoin(
        StepAttemptEntity,
        "attempt",
        'attempt."id" = exposure."stepAttemptId"',
      )
      .where('attempt."executionId" = :executionId', { executionId })
      .orderBy("exposure.createdAt", "ASC")
      .take(limit)
      .getMany();
  }

  async countArtifactExposures(
    executionId: string,
    manager: EntityManager = this.dataSource.manager,
  ): Promise<number> {
    return manager
      .getRepository(ArtifactExposureEntity)
      .createQueryBuilder("exposure")
      .innerJoin(
        StepAttemptEntity,
        "attempt",
        'attempt."id" = exposure."stepAttemptId"',
      )
      .where('attempt."executionId" = :executionId', { executionId })
      .getCount();
  }

  async materializeExecutionWithManager(
    manager: EntityManager,
    pipeline: PipelineEntity,
    input: unknown,
    authorityDeadlineAt: Date | null = null,
  ): Promise<ExecutionEntity> {
    {
      const executionRepository = manager.getRepository(ExecutionEntity);
      const planRepository = manager.getRepository(ExecutionPlanRevisionEntity);
      // M4-S5: the frozen plan carries the NORMALIZED budget envelope
      // (parent scope + dimension ceilings), so the claim transaction can
      // create the execution account from the approved plan — never from
      // live pipeline mutation — regardless of the shape the operator
      // stored.
      const planBudget = parsePipelineBudget(pipeline.budget);
      const plan = {
        schemaVersion: 1 as const,
        ...(planBudget === undefined ? {} : { budget: planBudget }),
        steps: pipeline.steps,
      };
      const pipelineHash =
        pipeline.contentHash ||
        sha256Json({
          name: pipeline.name,
          version: pipeline.version,
          description: pipeline.description,
          ...(planBudget === undefined ? {} : { budget: planBudget }),
          steps: pipeline.steps,
        });
      let execution = await executionRepository.save(
        executionRepository.create({
          pipelineId: pipeline.id,
          pipelineVersion: pipeline.version,
          pipelineHash,
          configurationSnapshot: {
            schemaVersion: 1,
            pipelineId: pipeline.id,
            pipelineVersion: pipeline.version,
            pipelineHash,
          },
          status: "PENDING",
          input,
          startTime: new Date(),
          authorityDeadlineAt,
        }),
      );
      const revision = await planRepository.save(
        planRepository.create({
          executionId: execution.id,
          revisionNumber: 1,
          plan,
          planHash: sha256Json(plan),
          source: "pipeline",
          reason: "Initial execution plan snapshot",
          validationResult: { valid: true },
        }),
      );
      execution.activePlanRevisionId = revision.id;
      execution = await executionRepository.save(execution);

      // Materialize every logical step row in the same transaction as the
      // execution and its plan revision, so a crash between creation and the
      // first scheduling pass cannot leave an execution with no step rows and
      // nothing that will ever schedule it. Scheduling only updates rows.
      // Materialized rows are scheduling candidates, not consumed specs:
      // frozenSpecHash/frozenAt stay null until the claim or gate decision
      // makes the execution-defining specification authoritative, so future
      // plan revisions remain applicable to unstarted steps.
      const stepRepository = manager.getRepository(LogicalStepEntity);
      for (const stepConfig of plan.steps) {
        await stepRepository.save(
          stepRepository.create({
            executionId: execution.id,
            stepId: stepConfig.id,
            agent: stepConfig.agent,
            status: "PENDING",
            input: null,
            attempt: 0,
            maxAttempts: 1,
            frozenSpecHash: null,
            frozenAt: null,
          }),
        );
      }
      return execution;
    }
  }

  /**
   * Advances only the state a crashed run is allowed to advance:
   * - a stuck PENDING execution with an active plan revision becomes RUNNING
   *   through a guarded update;
   * - missing logical-step rows (pre-materialization executions) are
   *   backfilled from the active plan revision;
   * - unclaimed PENDING steps whose dependencies are terminal become READY.
   * Terminal executions are left untouched. The promotion and the step
   * advancement run as separate transactions so the row-lock order never
   * inverts the claim/cancel order (logical rows before execution rows).
   */
  async reconcileExecution(executionId: string): Promise<{
    promoted: boolean;
    backfilled: number;
    advanced: number;
  }> {
    const promoted = await this.dataSource.transaction(async (manager) => {
      const executionRepository = manager.getRepository(ExecutionEntity);
      const execution = await executionRepository
        .createQueryBuilder("execution")
        .setLock("pessimistic_write")
        .where('execution."id" = :id', { id: executionId })
        .getOne();
      if (
        !execution ||
        execution.status !== "PENDING" ||
        !execution.activePlanRevisionId
      ) {
        return false;
      }
      const result = await executionRepository
        .createQueryBuilder()
        .update(ExecutionEntity)
        .set({ status: "RUNNING" })
        .where("id = :id", { id: executionId })
        .andWhere("status = :pending", { pending: "PENDING" })
        .execute();
      return result.affected === 1;
    });

    const steps = await this.dataSource.transaction(async (manager) => {
      // Deliberately no pessimistic execution lock here: cancel/claim take
      // logical rows before the execution row, so holding the execution lock
      // while taking step locks would invert that order and risk a deadlock.
      // The per-row status re-check below keeps the advancement correct.
      const execution = await manager
        .getRepository(ExecutionEntity)
        .findOne({ where: { id: executionId } });
      if (!execution || !execution.activePlanRevisionId) {
        return { backfilled: 0, advanced: 0 };
      }
      if (TERMINAL_EXECUTION_STATUSES.includes(execution.status)) {
        return { backfilled: 0, advanced: 0 };
      }

      const revision = await manager
        .getRepository(ExecutionPlanRevisionEntity)
        .findOne({ where: { id: execution.activePlanRevisionId } });
      if (!revision) return { backfilled: 0, advanced: 0 };

      const logicalRepository = manager.getRepository(LogicalStepEntity);
      const attemptRepository = manager.getRepository(StepAttemptEntity);
      const now = new Date();

      let backfilled = 0;
      for (const stepConfig of revision.plan.steps) {
        const exists = await logicalRepository.findOne({
          where: { executionId, stepId: stepConfig.id },
        });
        if (exists) continue;
        // orIgnore: a concurrent replica may backfill the same row; the unique
        // (executionId, stepId) constraint makes the second insert a no-op
        // instead of a 23505 propagating to startExecution/resumeAfterResult.
        await logicalRepository
          .createQueryBuilder()
          .insert()
          .into(LogicalStepEntity)
          .values({
            executionId,
            stepId: stepConfig.id,
            agent: stepConfig.agent,
            status: "PENDING",
            input: null,
            attempt: 0,
            maxAttempts: 1,
            // Backfilled rows follow the same rule as fresh materialization:
            // unfrozen until the scheduling/gate decision freezes them.
            frozenSpecHash: null,
            frozenAt: null,
          })
          .orIgnore()
          .execute();
        backfilled += 1;
      }

      if (execution.status !== "RUNNING") {
        return { backfilled, advanced: 0 };
      }

      // Per-row pessimistic locks on PENDING rows only: the claim path never
      // locks PENDING rows, so this cannot invert the claim/cancel lock order.
      // Rows are locked in id order to match cancelExecution's id-ordered step
      // locks, so reconcile and cancel can never AB-BA deadlock.
      const allSteps = await logicalRepository.find({ where: { executionId } });
      const candidates = allSteps
        .filter((step) => step.status === "PENDING")
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      let advanced = 0;
      for (const logicalStep of candidates) {
        const stepConfig = revision.plan.steps.find(
          (step) => step.id === logicalStep.stepId,
        );
        if (!stepConfig) continue;
        if (
          !this.dependenciesResolved(stepConfig, allSteps, revision.plan.steps)
        ) {
          continue;
        }
        const locked = await logicalRepository
          .createQueryBuilder("step")
          .setLock("pessimistic_write")
          .where('step."id" = :id', { id: logicalStep.id })
          .andWhere('step."status" = :pending', { pending: "PENDING" })
          .getOne();
        if (!locked) continue;
        const activeAttempt = await attemptRepository
          .createQueryBuilder("attempt")
          .where('attempt."logicalStepId" = :logicalStepId', {
            logicalStepId: locked.id,
          })
          .andWhere('attempt."status" IN (:...active)', {
            active: ACTIVE_ATTEMPT_STATUSES,
          })
          .getOne();
        if (activeAttempt) continue;
        locked.status = "READY";
        locked.eligibleAt = now;
        await logicalRepository.save(locked);
        advanced += 1;
      }
      return { backfilled, advanced };
    });

    return { promoted, ...steps };
  }

  async getExecutionPlanSteps(
    execution: ExecutionEntity | string,
  ): Promise<PipelineStepConfig[]> {
    const entity =
      typeof execution === "string"
        ? await this.getExecution(execution)
        : execution;
    if (!entity?.activePlanRevisionId)
      throw new Error(
        `Execution ${typeof execution === "string" ? execution : execution.id} has no active plan revision`,
      );
    const revision = await this.planRevisionRepository.findOne({
      where: { id: entity.activePlanRevisionId },
    });
    if (!revision || revision.executionId !== entity.id)
      throw new Error(
        `Active plan revision not found for execution ${entity.id}`,
      );
    return revision.plan.steps;
  }

  async updateExecutionStatus(
    id: string,
    status: ExecutionStatus,
    output?: any,
  ): Promise<ExecutionEntity> {
    const updateData: Partial<ExecutionEntity> = { status };
    if (
      status === "COMPLETED" ||
      status === "FAILED" ||
      status === "CANCELLED"
    ) {
      updateData.endTime = new Date();
    }
    if (output !== undefined) {
      updateData.output = output;
    }
    if (TERMINAL_EXECUTION_STATUSES.includes(status)) {
      await this.executionRepository
        .createQueryBuilder()
        .update(ExecutionEntity)
        .set(updateData)
        .where("id = :id", { id })
        .andWhere("status NOT IN (:...terminal)", {
          terminal: TERMINAL_EXECUTION_STATUSES,
        })
        .execute();
    } else {
      await this.executionRepository.update(id, updateData);
    }
    return this.executionRepository.findOne({
      where: { id },
    }) as Promise<ExecutionEntity>;
  }

  /**
   * Cancellation wins only while the execution is non-terminal. Active
   * attempts, logical summaries, and pending dispatches are retired in the
   * same transaction, so a later terminal callback cannot revive the run.
   */
  async cancelExecution(
    executionId: string,
    reason = "Execution cancelled by request",
  ): Promise<ExecutionEntity> {
    return this.dataSource.transaction((manager) =>
      this.cancelExecutionWithManager(manager, executionId, reason),
    );
  }

  /** P1/M10: manager-passable cancel — caller-owned transactions compose
   *  authority atomically (Workbench command audit + cancel commit
   *  together). Mirrors the exact locking order of the terminal-result
   *  path (attempt -> logical step -> execution). */
  async cancelExecutionWithManager(
    manager: EntityManager,
    executionId: string,
    reason = "Execution cancelled by request",
  ): Promise<ExecutionEntity> {
    const attemptRepository = manager.getRepository(StepAttemptEntity);
    const logicalRepository = manager.getRepository(LogicalStepEntity);
    const executionRepository = manager.getRepository(ExecutionEntity);
    const outboxRepository = manager.getRepository(DispatchOutboxEntity);

    // Match terminal-result locking order (attempt -> logical step ->
    // execution) to make result-versus-cancel races serialize cleanly.
    const attempts = await attemptRepository
      .createQueryBuilder("attempt")
      .setLock("pessimistic_write")
      .where('attempt."executionId" = :executionId', { executionId })
      .andWhere('attempt."status" IN (:...active)', {
        active: ACTIVE_ATTEMPT_STATUSES,
      })
      .orderBy('attempt."id"', "ASC")
      .getMany();
    const steps = await logicalRepository
      .createQueryBuilder("step")
      .setLock("pessimistic_write")
      .where('step."executionId" = :executionId', { executionId })
      .orderBy('step."id"', "ASC")
      .getMany();
    const execution = await executionRepository
      .createQueryBuilder("execution")
      .setLock("pessimistic_write")
      .where('execution."id" = :id', { id: executionId })
      .getOne();
    if (!execution) throw new Error(`Execution ${executionId} not found`);
    if (TERMINAL_EXECUTION_STATUSES.includes(execution.status)) {
      return execution;
    }

    const now = new Date();
    for (const attempt of attempts) {
      attempt.status = "CANCELLED";
      attempt.terminalAt = now;
      attempt.result = null;
      attempt.error = reason;
      attempt.terminationReason = reason;
    }
    if (attempts.length) await attemptRepository.save(attempts);

    // M4-S2: cancelled attempts never complete, so their reservations are
    // fully unused — release them in the SAME transaction (explicit
    // authority action, unlike unreported terminal usage which stays
    // consumed by default).
    for (const attempt of attempts) {
      await this.budgetLedger.releaseForAction(
        manager,
        attempt.invocationId,
        "execution cancelled",
      );
    }

    for (const step of steps) {
      if (!CANCELLABLE_STEP_STATUSES.includes(step.status)) continue;
      step.status = "CANCELLED";
      step.error = reason;
      step.endTime = now;
      step.nextAttemptAt = null;
      step.eligibleAt = null;
    }
    if (steps.length) await logicalRepository.save(steps);

    if (attempts.length) {
      await outboxRepository
        .createQueryBuilder()
        .update(DispatchOutboxEntity)
        .set({ status: "COMPLETED", leaseExpiresAt: null, leaseToken: null })
        .where('"stepAttemptId" IN (:...attemptIds)', {
          attemptIds: attempts.map((attempt) => attempt.id),
        })
        .andWhere("status IN (:...dispatchable)", {
          dispatchable: ["PENDING", "LEASED", "DISPATCHED"],
        })
        .execute();
    }

    execution.status = "CANCELLED";
    execution.endTime = now;
    execution.terminationReason = reason;
    return executionRepository.save(execution);
  }

  async getExecution(id: string): Promise<ExecutionEntity | null> {
    return this.executionRepository.findOne({ where: { id } });
  }

  async listExecutions(): Promise<ExecutionEntity[]> {
    return this.executionRepository.find({ order: { createdAt: "DESC" } });
  }

  /**
   * @deprecated Compatibility/test helper only. The authoritative scheduling
   * path is `claimRunnableStep` (freezes the spec and creates StepAttempt +
   * DispatchOutbox in one transaction); result application is
   * `ResultInboxService.apply`. This legacy entry point materializes AND
   * claims in one call and is not wired into the AgentResult path.
   */
  async createStepExecution(
    executionId: string,
    stepId: string,
    agent: string,
    input: any,
    maxAttempts = 1,
    stepConfig?: PipelineStepConfig,
    deadlineAt?: Date,
  ): Promise<StepExecutionEntity> {
    // M2C: the deprecated compatibility path never materializes a
    // ContextSnapshot. A projection-enabled step config is rejected instead
    // of silently dispatching without its declared context.
    if (stepConfig?.contextProjection) {
      throw new Error(
        "createStepExecution does not support contextProjection; use claimRunnableStep",
      );
    }
    return this.dataSource.transaction(async (manager) => {
      const logicalRepository = manager.getRepository(LogicalStepEntity);
      const attemptRepository = manager.getRepository(StepAttemptEntity);
      // Lock order matches the claim path (logical step before execution) so
      // this legacy entry point cannot invert cancelExecution's step-first
      // order into an AB-BA deadlock if it is ever re-wired into a live path.
      let logicalStep = await logicalRepository
        .createQueryBuilder("step")
        .setLock("pessimistic_write")
        .where('step."executionId" = :executionId', { executionId })
        .andWhere('step."stepId" = :stepId', { stepId })
        .getOne();
      const execution = await manager
        .getRepository(ExecutionEntity)
        .createQueryBuilder("execution")
        .setLock("pessimistic_write")
        .where('execution."id" = :id', { id: executionId })
        .getOne();
      if (!execution?.activePlanRevisionId)
        throw new Error(`Execution ${executionId} has no active plan revision`);
      if (execution.status !== "RUNNING") {
        throw new Error(`Execution ${executionId} is not runnable`);
      }
      const requestedSpecHash = sha256Json(stepConfig ?? { id: stepId, agent });
      if (
        logicalStep?.frozenSpecHash &&
        logicalStep.frozenSpecHash !== requestedSpecHash
      ) {
        throw new Error(`Step ${stepId} execution specification is frozen`);
      }
      const frozenSpecHash = logicalStep?.frozenSpecHash || requestedSpecHash;
      const attemptNumber = (logicalStep?.attempt ?? 0) + 1;

      if (
        logicalStep?.status === "RUNNING" ||
        logicalStep?.status === "PENDING"
      ) {
        throw new Error(
          `Step ${stepId} already has an active scheduling decision`,
        );
      }

      if (logicalStep) {
        logicalStep.agent = agent;
        logicalStep.input = input;
        logicalStep.status = "PENDING";
        logicalStep.output = null;
        logicalStep.error = null;
        logicalStep.startTime = null;
        logicalStep.endTime = null;
        logicalStep.attempt = attemptNumber;
        logicalStep.maxAttempts = maxAttempts;
        logicalStep.frozenSpecHash = frozenSpecHash;
        logicalStep.frozenAt ??= new Date();
      } else {
        logicalStep = logicalRepository.create({
          executionId,
          stepId,
          agent,
          status: "PENDING",
          input,
          attempt: attemptNumber,
          maxAttempts,
          frozenSpecHash,
          frozenAt: new Date(),
        });
      }
      logicalStep = await logicalRepository.save(logicalStep);
      const attemptEntity = await attemptRepository.save(
        attemptRepository.create({
          executionId,
          logicalStepId: logicalStep.id,
          planRevisionId: execution.activePlanRevisionId,
          attemptNumber,
          invocationId: `${logicalStep.id}:${attemptNumber}`,
          frozenSpecHash,
          inputSnapshot: input,
          contextSnapshot: null,
          executorSnapshot: { agent },
          efficiency: buildClaimEfficiencyEvidence({
            invocationId: `${logicalStep.id}:${attemptNumber}`,
            harness: { agent, executorKind: "legacy", configHash: frozenSpecHash },
            contextBundle: null,
            context: null,
            dispatchable: true,
            startedAt: new Date().toISOString(),
          }),
          status: "CREATED",
          deadlineAt,
        }),
      );
      const createdAt = new Date().toISOString();
      const outboxRepository = manager.getRepository(DispatchOutboxEntity);
      await outboxRepository.save(
        outboxRepository.create({
          stepAttemptId: attemptEntity.id,
          invocation: {
            schemaVersion: "1",
            invocationId: attemptEntity.invocationId,
            executionId,
            stepExecutionId: logicalStep.id,
            stepId,
            target: { agent },
            input,
            attempt: attemptNumber,
            createdAt,
            deadlineAt: deadlineAt?.toISOString(),
            trace: {
              traceId: executionId,
              correlationId: attemptEntity.invocationId,
            },
            metadata: { orchestration: { maxAttempts } },
          },
        }),
      );
      return logicalStep;
    });
  }

  async createSkippedLogicalStep(
    executionId: string,
    stepConfig: PipelineStepConfig,
    conditionResult = false,
  ): Promise<LogicalStepEntity> {
    const frozenSpecHash = sha256Json(stepConfig);
    const existing = await this.stepExecutionRepository.findOne({
      where: { executionId, stepId: stepConfig.id },
    });
    if (existing) return existing;
    return this.stepExecutionRepository.save(
      this.stepExecutionRepository.create({
        executionId,
        stepId: stepConfig.id,
        agent: stepConfig.agent,
        status: "SKIPPED",
        input: null,
        output: null,
        attempt: 0,
        maxAttempts: 0,
        frozenSpecHash,
        frozenAt: new Date(),
        conditionResult,
        endTime: new Date(),
      }),
    );
  }

  async updateStepStatus(
    executionId: string,
    stepId: string,
    status: StepStatus,
    output?: any,
    error?: string,
  ): Promise<StepExecutionEntity> {
    const step = await this.stepExecutionRepository.findOne({
      where: { executionId, stepId },
    });
    if (!step) {
      throw new Error(
        `Step execution not found for run ${executionId} and step ${stepId}`,
      );
    }

    const attempt =
      step.attempt > 0
        ? await this.stepAttemptRepository.findOne({
            where: { logicalStepId: step.id, attemptNumber: step.attempt },
          })
        : null;
    if (attempt) {
      const attemptStatus = this.attemptStatus(status);
      const terminal = TERMINAL_ATTEMPT_STATUSES.includes(attemptStatus);
      const update: Partial<StepAttemptEntity> = {
        status: attemptStatus,
        ...(status === "RUNNING"
          ? { startTime: attempt.startTime ?? new Date() }
          : {}),
        ...(terminal
          ? {
              terminalAt: new Date(),
              result: output,
              error,
              terminationReason: error,
            }
          : {}),
      };
      const result = await this.stepAttemptRepository
        .createQueryBuilder()
        .update(StepAttemptEntity)
        .set(update)
        .where("id = :id", { id: attempt.id })
        .andWhere("status NOT IN (:...terminal)", {
          terminal: TERMINAL_ATTEMPT_STATUSES,
        })
        .execute();
      if (result.affected !== 1) return step;
    }

    step.status = status;
    if (status === "RUNNING" && !step.startTime) {
      step.startTime = new Date();
    }
    if (
      status === "COMPLETED" ||
      status === "FAILED" ||
      status === "SKIPPED" ||
      status === "CANCELLED"
    ) {
      step.endTime = new Date();
    }
    if (output !== undefined) {
      step.output = output;
    }
    if (error !== undefined) {
      step.error = error;
    }
    return this.stepExecutionRepository.save(step);
  }

  async getStepExecutions(executionId: string): Promise<StepExecutionEntity[]> {
    return this.stepExecutionRepository.find({
      where: { executionId },
      order: { createdAt: "ASC" },
    });
  }

  async getStepExecution(
    executionId: string,
    stepId: string,
  ): Promise<StepExecutionEntity | null> {
    return this.stepExecutionRepository.findOne({
      where: { executionId, stepId },
    });
  }

  async getStepExecutionById(id: string): Promise<StepExecutionEntity | null> {
    return this.stepExecutionRepository.findOne({ where: { id } });
  }

  async getStepAttempts(logicalStepId: string): Promise<StepAttemptEntity[]> {
    return this.stepAttemptRepository.find({
      where: { logicalStepId },
      order: { attemptNumber: "ASC" },
    });
  }

  async getAttemptByInvocationId(
    invocationId: string,
  ): Promise<StepAttemptEntity | null> {
    return this.stepAttemptRepository.findOne({ where: { invocationId } });
  }

  private dependenciesResolved(
    step: PipelineStepConfig,
    logicalSteps: LogicalStepEntity[],
    planSteps: PipelineStepConfig[],
  ): boolean {
    return (step.dependsOn ?? []).every((dependencyId) => {
      const dependency = logicalSteps.find(
        (logicalStep) => logicalStep.stepId === dependencyId,
      );
      if (!dependency) return false;
      if (
        dependency.status === "COMPLETED" ||
        dependency.status === "SKIPPED"
      ) {
        return true;
      }
      if (dependency.status !== "FAILED") return false;
      return (
        planSteps.find((planStep) => planStep.id === dependencyId)
          ?.onFailure === "continue"
      );
    });
  }

  private conditionContext(
    input: unknown,
    logicalSteps: LogicalStepEntity[],
  ): Record<string, unknown> {
    return {
      pipeline: { input },
      steps: Object.fromEntries(
        logicalSteps.map((step) => [
          step.stepId,
          {
            result: step.output,
            output: step.output,
            status: step.status,
            error: step.error,
            attempt: step.attempt,
          },
        ]),
      ),
    };
  }

  private attemptStatus(status: StepStatus): StepAttemptStatus {
    switch (status) {
      case "COMPLETED":
        return "SUCCESS";
      case "FAILED":
        return "FAILED";
      case "CANCELLED":
        return "CANCELLED";
      case "RUNNING":
        return "RUNNING";
      default:
        return "CREATED";
    }
  }
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
