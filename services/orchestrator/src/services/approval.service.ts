import { Inject, Injectable } from "@nestjs/common";
import { DataSource, type EntityManager } from "typeorm";
import { ApprovalRequestEntity } from "../entities/approval-request.entity";
import { StepAttemptEntity } from "../entities/step-attempt.entity";
import { LogicalStepEntity } from "../entities/step-execution.entity";
import { ExecutionEntity } from "../entities/execution.entity";
import { ExecutionPlanRevisionEntity } from "../entities/execution-plan-revision.entity";
import { DispatchOutboxEntity } from "../entities/dispatch-outbox.entity";
import {
  APPROVAL_BOUNDS,
  assertApprovalTransition,
  approvalExpiry,
  boundedApprovalNote,
  type ApprovalStatus,
} from "../domain/approval";
import { PolicyError, type ActionProposal } from "../domain/policy";
import { BudgetLedgerService } from "./budget-ledger.service";
import { PlanProposalEntity } from "../entities/plan-proposal.entity";
import { PlanProposalService } from "./plan-proposal.service";
import { PipelineValidationService } from "./pipeline-validation.service";
import { ConditionEvaluatorService } from "./condition-evaluator.service";
import { AgentTransportConfigService } from "../agent-adapters/agent-transport-config.service";
import { BudgetError } from "../domain/budget";
import type { PipelineStepConfig } from "../domain/pipeline-definition";

/**
 * M4-S4: durable approval service.
 *
 * One PENDING request per intercepted action; approve/deny/expire are
 * exactly-once transitions under row locks. Approving RESUMES the same
 * attempt: request lock → attempt lock → step lock → budget reserve →
 * attempt WAITING→CREATED → step WAITING→RUNNING → outbox row. Replay
 * (already APPROVED) returns the same outcome without re-executing.
 * WAITING is never a retryable failure; expiry is the deterministic
 * time-based terminalization driven by the recovery sweep.
 */
@Injectable()
export class ApprovalService {
  constructor(
    @Inject("DATA_SOURCE") private readonly dataSource: DataSource,
    budgetLedger?: BudgetLedgerService,
    planProposals?: PlanProposalService,
    transportConfig?: AgentTransportConfigService,
  ) {
    this.budgetLedger =
      budgetLedger ?? new BudgetLedgerService(this.dataSource);
    this.planProposals =
      planProposals ??
      new PlanProposalService(
        this.dataSource,
        new PipelineValidationService(new ConditionEvaluatorService()),
      );
    this.transportConfig =
      transportConfig ?? new AgentTransportConfigService();
  }

  private readonly budgetLedger: BudgetLedgerService;
  private readonly planProposals: PlanProposalService;
  private readonly transportConfig: AgentTransportConfigService;

  private lockExecution(
    manager: EntityManager,
    executionId: string,
  ): Promise<ExecutionEntity | null> {
    return manager
      .getRepository(ExecutionEntity)
      .createQueryBuilder("execution")
      .setLock("pessimistic_write")
      .where('execution."id" = :id', { id: executionId })
      .getOne();
  }

  /** M5-S4: terminalize the proposal of a denied/expired plan_patch
   *  request (guarded: never overwrites a newer decision). */
  private async terminalizePlanProposal(
    manager: EntityManager,
    proposalId: string,
    status: "REJECTED",
    reason: string,
  ): Promise<void> {
    const planProposalId = proposalId.replace(/^plan:/, "");
    await manager
      .getRepository(PlanProposalEntity)
      .createQueryBuilder()
      .update()
      .set({ status, decisionReason: reason, decidedAt: new Date() })
      .where("id = :id", { id: planProposalId })
      .andWhere("status = 'PENDING'")
      .execute();
  }

  private tx<T>(
    manager: EntityManager | undefined,
    work: (manager: EntityManager) => Promise<T>,
  ): Promise<T> {
    return manager ? work(manager) : this.dataSource.transaction(work);
  }

  /**
   * Creates the durable PENDING request for an intercepted action.
   * Idempotent per proposalId: a repeated request returns the existing one.
   */
  async request(
    proposal: ActionProposal,
    manager?: EntityManager,
    expiresInMs = APPROVAL_BOUNDS.defaultExpiryMs,
  ): Promise<ApprovalRequestEntity> {
    const expiresAt = approvalExpiry(new Date(), expiresInMs);
    return this.tx(manager, async (manager) => {
      const repository = manager.getRepository(ApprovalRequestEntity);
      // P1: INSERT ... ON CONFLICT DO NOTHING — catching a 23505 here would
      // abort the whole Postgres transaction; the concurrent winner keeps
      // the tx healthy and its request is replayed.
      const inserted = await repository
        .createQueryBuilder()
        .insert()
        .into(ApprovalRequestEntity)
        .values({
          proposalId: proposal.proposalId,
          proposalHash: proposal.hash,
          actionType: proposal.actionType,
          executionId: proposal.scope.executionId,
          logicalStepId: proposal.scope.logicalStepId ?? "",
          attemptNumber: proposal.scope.attemptNumber ?? 1,
          targetAgent: proposal.target?.agent ?? null,
          targetExecutor: proposal.target?.executor ?? null,
          status: "PENDING",
          expiresAt,
          decidedAt: null,
          decisionNote: null,
        })
        .orIgnore()
        .execute();
      if (inserted.identifiers.length === 0) {
        // A concurrent activation created the request first; its authority
        // is authoritative.
        return this.replayRequest(manager, proposal.proposalId);
      }
      const saved = await repository.findOne({
        where: { proposalId: proposal.proposalId },
      });
      if (!saved) throw new Error("Approval request insert produced no row");
      return saved;
    });
  }

  /**
   * APPROVES the request and resumes the SAME attempt (same invocationId):
   * budget reserve (step budget from the frozen plan revision) → attempt
   * WAITING→CREATED → step WAITING→RUNNING → outbox row. Replay returns the
   * APPROVED request without creating anything again. Insufficient budget at
   * approval time fails the attempt durably (no work authority without a
   * successful reservation).
   */
  async approve(
    proposalId: string,
    manager?: EntityManager,
    note?: unknown,
  ): Promise<ApprovalRequestEntity> {
    const decisionNote = boundedApprovalNote(note);
    return this.tx(manager, async (manager) => {
      // M5-S4: for plan_patch requests, take the EXECUTION row lock BEFORE
      // the request row lock — the intercept path locks execution then
      // inserts the request, so the opposite order could deadlock (40P01)
      // under concurrent approve + activation.
      const preview = await manager
        .getRepository(ApprovalRequestEntity)
        .findOne({ where: { proposalId } });
      if (preview?.actionType === "plan_patch") {
        await this.lockExecution(manager, preview.executionId);
      }
      const request = await this.lockRequest(manager, proposalId);
      if (request.status !== "PENDING") {
        // Replay or conflicting transition: the recorded outcome is
        // authoritative and nothing re-executes.
        return request;
      }
      if (request.actionType === "plan_patch") {
        // M5-S4: approving a plan_patch request re-activates the proposal
        // in the SAME transaction. Activation RECHECKS base revision,
        // frozen steps, candidate validity, and policy — a stale approved
        // proposal becomes STALE, a now-denied one is REJECTED; the
        // approval itself is recorded as granted either way (the proposal
        // decision is authoritative).
        request.status = "APPROVED";
        request.decidedAt = new Date();
        request.decisionNote = decisionNote ?? "approved";
        await manager.getRepository(ApprovalRequestEntity).save(request);
        const planProposalId = request.proposalId.replace(/^plan:/, "");
        const activation = await this.planProposals.activateWithManager(
          manager,
          planProposalId,
        );
        request.decisionNote =
          decisionNote ??
          (activation.decision === "ACCEPTED"
            ? "approved; plan activated"
            : `approved; proposal ${activation.decision}: ${activation.reason}`);
        return manager.getRepository(ApprovalRequestEntity).save(request);
      }
      const attempt = await this.lockAttempt(manager, request);
      const step = await this.lockStep(manager, request.executionId, request.logicalStepId);

      if (attempt.status !== "WAITING") {
        // The attempt was terminalized by another authority (cancel/result/
        // dispatch failure) after the request was locked: the approval is
        // recorded, but nothing resumes — approval replay never re-executes.
        request.status = "APPROVED";
        request.decidedAt = new Date();
        request.decisionNote = decisionNote ?? "attempt already terminal";
        return manager.getRepository(ApprovalRequestEntity).save(request);
      }

      // Budget reserve BEFORE work authority, exactly like the claim path.
      const stepConfig = await this.stepConfig(manager, attempt, step);
      // M6-S5: capability negotiation is rechecked at resume — a runtime
      // narrowed to opaque-only while the attempt sat WAITING grants NO
      // dispatch authority (mirrors the claim-time check).
      if (stepConfig.delegation === "observed") {
        const runtimeModes =
          this.transportConfig.forAgent(stepConfig.agent).delegationModes ??
          ["opaque", "observed"];
        if (!runtimeModes.includes("observed")) {
          await this.failAttemptDurably(
            manager,
            attempt,
            step,
            `Runtime for agent "${stepConfig.agent}" does not support observed delegation`,
          );
          request.status = "APPROVED";
          request.decidedAt = new Date();
          request.decisionNote =
            decisionNote ?? "runtime capability changed; dispatch not granted";
          return manager.getRepository(ApprovalRequestEntity).save(request);
        }
      }
      if (stepConfig.budget) {
        try {
          const account = await this.budgetLedger.ensureExecutionAccount(
            manager,
            request.executionId,
            (await this.revisionPlan(manager, attempt))?.budget,
            stepConfig.budget,
          );
          await this.budgetLedger.reserveForAttempt(manager, {
            executionId: request.executionId,
            logicalStepId: step.id,
            attemptNumber: attempt.attemptNumber,
            invocationId: attempt.invocationId,
            accountId: account.id,
            budget: stepConfig.budget,
          });
        } catch (error) {
          if (error instanceof BudgetError) {
            await this.failAttemptDurably(
              manager,
              attempt,
              step,
              `Budget reservation failed: ${error.code}`,
            );
            request.status = "APPROVED";
            request.decidedAt = new Date();
            request.decisionNote = decisionNote ?? "budget insufficient";
            return manager.getRepository(ApprovalRequestEntity).save(request);
          }
          throw error;
        }
      }

      // Resume the SAME attempt: no new invocation, no second dispatch
      // identity. The outbox row is the only dispatch authority.
      attempt.status = "CREATED";
      await manager.getRepository(StepAttemptEntity).save(attempt);
      step.status = "RUNNING";
      await manager.getRepository(LogicalStepEntity).save(step);
      const maxAttempts = (stepConfig.retries ?? 0) + 1;
      await manager.getRepository(DispatchOutboxEntity).save(
        manager.getRepository(DispatchOutboxEntity).create({
          stepAttemptId: attempt.id,
          invocation: {
            schemaVersion: "1",
            invocationId: attempt.invocationId,
            executionId: request.executionId,
            stepExecutionId: step.id,
            stepId: stepConfig.id,
            target: { agent: stepConfig.agent },
            input: attempt.inputSnapshot,
            attempt: attempt.attemptNumber,
            createdAt: new Date().toISOString(),
            deadlineAt: attempt.deadlineAt?.toISOString(),
            ...(attempt.contextSnapshot
              ? { context: attempt.contextSnapshot }
              : {}),
            trace: {
              traceId: request.executionId,
              correlationId: attempt.invocationId,
            },
            metadata: { orchestration: { maxAttempts } },
          },
        }),
      );

      request.status = "APPROVED";
      request.decidedAt = new Date();
      request.decisionNote = decisionNote;
      return manager.getRepository(ApprovalRequestEntity).save(request);
    });
  }

  /**
   * DENIES the request: the attempt fails durably following the step's
   * failure policy (retry re-requests approval for the NEW attempt).
   */
  async deny(
    proposalId: string,
    manager?: EntityManager,
    note?: unknown,
  ): Promise<ApprovalRequestEntity> {
    const decisionNote = boundedApprovalNote(note);
    return this.tx(manager, async (manager) => {
      const request = await this.lockRequest(manager, proposalId);
      if (request.status !== "PENDING") return request;
      if (request.actionType === "plan_patch") {
        // No attempt row exists for plan_patch: terminalize the request
        // and REJECT the proposal (guarded; a concurrent activation may
        // have decided it already).
        await this.terminalizePlanProposal(
          manager,
          proposalId,
          "REJECTED",
          "Approval denied",
        );
        request.status = "DENIED";
        request.decidedAt = new Date();
        request.decisionNote = decisionNote;
        return manager.getRepository(ApprovalRequestEntity).save(request);
      }
      const attempt = await this.lockAttempt(manager, request);
      const step = await this.lockStep(manager, request.executionId, request.logicalStepId);
      await this.failAttemptDurably(
        manager,
        attempt,
        step,
        "Approval denied",
      );
      request.status = "DENIED";
      request.decidedAt = new Date();
      request.decisionNote = decisionNote;
      return manager.getRepository(ApprovalRequestEntity).save(request);
    });
  }

  /**
   * Expires ONE due request (deterministic time transition). Returns the
   * request or null when not PENDING/due.
   */
  async expire(
    proposalId: string,
    manager?: EntityManager,
    now = new Date(),
  ): Promise<ApprovalRequestEntity | null> {
    return this.tx(manager, async (manager) => {
      const request = await this.lockRequest(manager, proposalId);
      if (request.status !== "PENDING" || request.expiresAt > now) return null;
      if (request.actionType === "plan_patch") {
        await this.terminalizePlanProposal(
          manager,
          proposalId,
          "REJECTED",
          "Approval expired",
        );
        request.status = "EXPIRED";
        request.decidedAt = now;
        return manager.getRepository(ApprovalRequestEntity).save(request);
      }
      const attempt = await this.lockAttempt(manager, request);
      const step = await this.lockStep(manager, request.executionId, request.logicalStepId);
      await this.failAttemptDurably(
        manager,
        attempt,
        step,
        "Approval expired",
      );
      request.status = "EXPIRED";
      request.decidedAt = now;
      return manager.getRepository(ApprovalRequestEntity).save(request);
    });
  }

  /**
   * Autonomous expiry sweep (bounded batch) for the recovery pass: every
   * due PENDING request is expired and its WAITING attempt terminalized.
   */
  async expireDue(
    manager?: EntityManager,
    now = new Date(),
    limit = APPROVAL_BOUNDS.expireSweepBatch,
  ): Promise<number> {
    const run = async (m: EntityManager): Promise<number> => {
      const due = await m
        .getRepository(ApprovalRequestEntity)
        .createQueryBuilder("request")
        .setLock("pessimistic_write")
        .where("request.status = 'PENDING'")
        .andWhere("request.expiresAt <= :now", { now })
        .take(limit)
        .getMany();
      let expired = 0;
      for (const request of due) {
        if (request.actionType === "plan_patch") {
          await this.terminalizePlanProposal(
            m,
            request.proposalId,
            "REJECTED",
            "Approval expired",
          );
          request.status = "EXPIRED";
          request.decidedAt = now;
          await m.getRepository(ApprovalRequestEntity).save(request);
          expired += 1;
          continue;
        }
        const attempt = await this.lockAttempt(m, request);
        const step = await this.lockStep(m, request.executionId, request.logicalStepId);
        await this.failAttemptDurably(m, attempt, step, "Approval expired");
        request.status = "EXPIRED";
        request.decidedAt = now;
        await m.getRepository(ApprovalRequestEntity).save(request);
        expired += 1;
      }
      return expired;
    };
    return manager ? run(manager) : this.dataSource.transaction(run);
  }

  // ---- internals ---------------------------------------------------------

  private async replayRequest(
    manager: EntityManager,
    proposalId: string,
  ): Promise<ApprovalRequestEntity> {
    const existing = await manager
      .getRepository(ApprovalRequestEntity)
      .findOne({ where: { proposalId } });
    if (!existing) {
      throw new PolicyError(
        "POLICY_CONFIG_INVALID",
        `Approval request ${proposalId} vanished after a key conflict`,
      );
    }
    return existing;
  }

  private async lockRequest(
    manager: EntityManager,
    proposalId: string,
  ): Promise<ApprovalRequestEntity> {
    const request = await manager
      .getRepository(ApprovalRequestEntity)
      .createQueryBuilder("request")
      .setLock("pessimistic_write")
      .where("request.proposalId = :proposalId", { proposalId })
      .getOne();
    if (!request) {
      throw new PolicyError(
        "POLICY_CONFIG_INVALID",
        `Approval request ${proposalId} not found`,
      );
    }
    return request;
  }

  private async lockAttempt(
    manager: EntityManager,
    request: ApprovalRequestEntity,
  ): Promise<StepAttemptEntity> {
    const attempt = await manager
      .getRepository(StepAttemptEntity)
      .createQueryBuilder("attempt")
      .setLock("pessimistic_write")
      .where("attempt.executionId = :executionId", {
        executionId: request.executionId,
      })
      .andWhere("attempt.logicalStepId = :logicalStepId", {
        logicalStepId: request.logicalStepId,
      })
      .andWhere("attempt.attemptNumber = :attemptNumber", {
        attemptNumber: request.attemptNumber,
      })
      .getOne();
    if (!attempt) {
      throw new PolicyError(
        "POLICY_CONFIG_INVALID",
        `Attempt for approval ${request.proposalId} not found`,
      );
    }
    return attempt;
  }

  private async lockStep(
    manager: EntityManager,
    executionId: string,
    logicalStepId: string,
  ): Promise<LogicalStepEntity> {
    const step = await manager
      .getRepository(LogicalStepEntity)
      .createQueryBuilder("step")
      .setLock("pessimistic_write")
      .where("step.id = :logicalStepId", { logicalStepId })
      .andWhere("step.executionId = :executionId", { executionId })
      .getOne();
    if (!step) {
      throw new PolicyError(
        "POLICY_CONFIG_INVALID",
        `Step ${logicalStepId} not found`,
      );
    }
    return step;
  }

  private async stepConfig(
    manager: EntityManager,
    attempt: StepAttemptEntity,
    step: LogicalStepEntity,
  ): Promise<PipelineStepConfig> {
    const revision = await manager
      .getRepository(ExecutionPlanRevisionEntity)
      .findOne({ where: { id: attempt.planRevisionId } });
    if (!revision) {
      throw new PolicyError(
        "POLICY_CONFIG_INVALID",
        `Plan revision ${attempt.planRevisionId} not found`,
      );
    }
    const plan = revision.plan as { steps: PipelineStepConfig[] };
    const config = plan.steps.find((candidate) => candidate.id === step.stepId);
    if (!config) {
      throw new PolicyError(
        "POLICY_CONFIG_INVALID",
        `Step config ${step.stepId} not found in the frozen plan`,
      );
    }
    return config;
  }

  private async revisionPlan(
    manager: EntityManager,
    attempt: StepAttemptEntity,
  ): Promise<
    | {
        budget?: {
          parent?: { scopeType: string; scopeId: string };
          ceilings: Record<string, number>;
        };
      }
    | undefined
  > {
    const revision = await manager
      .getRepository(ExecutionPlanRevisionEntity)
      .findOne({ where: { id: attempt.planRevisionId } });
    return revision?.plan as
      | {
          budget?: {
            parent?: { scopeType: string; scopeId: string };
            ceilings: Record<string, number>;
          };
        }
      | undefined;
  }

  /**
   * Mirrors the claim's durable pre-dispatch failure policy: attempt
   * FAILED, step RETRYING (if retries remain) or FAILED, execution FAILED
   * unless the step policy says continue.
   *
   * GUARDED: only a still-WAITING attempt can be failed by an approval
   * outcome. If the attempt was already terminalized elsewhere (e.g.
   * cancelled after the request was locked), nothing is overwritten — the
   * earlier terminal authority wins and the request still records its
   * decided status.
   */
  private async failAttemptDurably(
    manager: EntityManager,
    attempt: StepAttemptEntity,
    step: LogicalStepEntity,
    failure: string,
  ): Promise<void> {
    const stepConfig = await this.stepConfig(manager, attempt, step);
    const now = new Date();
    const transition = await manager
      .getRepository(StepAttemptEntity)
      .createQueryBuilder()
      .update(StepAttemptEntity)
      .set({
        status: "FAILED",
        terminalAt: now,
        result: null,
        error: failure,
        terminationReason: failure,
      })
      .where("id = :id", { id: attempt.id })
      .andWhere("status = 'WAITING'")
      .execute();
    if (transition.affected !== 1) {
      // The attempt was terminalized by another authority (cancel/result/
      // dispatch failure); the step and execution belong to that outcome.
      return;
    }

    const retry = stepConfig.onFailure === "retry" && attempt.attemptNumber <= (stepConfig.retries ?? 0);
    const stepTransition = await manager
      .getRepository(LogicalStepEntity)
      .createQueryBuilder()
      .update(LogicalStepEntity)
      .set({
        status: retry ? "RETRYING" : "FAILED",
        error: failure,
        endTime: retry ? null : now,
        nextAttemptAt: retry ? now : null,
      })
      .where("id = :id", { id: step.id })
      .andWhere("status = 'WAITING'")
      .execute();

    if (!retry && stepConfig.onFailure !== "continue" && stepTransition.affected === 1) {
      const executionTransition = await manager
        .getRepository(ExecutionEntity)
        .createQueryBuilder()
        .update(ExecutionEntity)
        .set({
          status: "FAILED",
          endTime: now,
          terminationReason: failure,
          output: { failedStep: stepConfig.id, error: failure } as any,
        })
        .where("id = :id", { id: attempt.executionId })
        .andWhere("status = 'RUNNING'")
        .execute();
      void executionTransition;
    }
  }
}
