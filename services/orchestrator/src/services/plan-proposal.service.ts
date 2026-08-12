import { Inject, Injectable } from "@nestjs/common";
import { DataSource, EntityManager } from "typeorm";
import { ExecutionEntity } from "../entities/execution.entity";
import { ExecutionPlanRevisionEntity } from "../entities/execution-plan-revision.entity";
import { LogicalStepEntity } from "../entities/step-execution.entity";
import { StepAttemptEntity } from "../entities/step-attempt.entity";
import {
  PlanProposalEntity,
  PlanProposalStatus,
} from "../entities/plan-proposal.entity";
import {
  applyPlanPatch,
  parsePlanPatch,
  PlanPatchError,
  type PlanPatchV1,
} from "../domain/plan-patch";
import { sha256Json } from "../domain/canonical-json";
import { PipelineValidationService } from "./pipeline-validation.service";
import { PolicyService } from "./policy.service";
import { buildPlanPatchProposal } from "../domain/policy";
import { ApprovalRequestEntity } from "../entities/approval-request.entity";
import { APPROVAL_BOUNDS, approvalExpiry } from "../domain/approval";

export type PlanActivationResult = {
  decision: PlanProposalStatus;
  reason: string;
};

const TERMINAL_EXECUTION_STATUSES: ExecutionEntity["status"][] = [
  "COMPLETED",
  "FAILED",
  "CANCELLED",
];

/**
 * M5-S2: durable proposals and atomic activation.
 *
 * `propose` persists a parsed, bounded PlanPatch as an immutable PENDING
 * proposal (numbered per execution under the execution row lock).
 * `activate` runs the whole activation in ONE transaction, holding the
 * same execution row lock the claim transaction uses — so claims and
 * activations serialize deterministically:
 *
 *   1. CAS the active revision against the proposal's baseRevision;
 *   2. protect every frozen step (any logical step with attempts);
 *   3. apply the patch and validate the full candidate through the exact
 *      safe pipeline validation;
 *   4. insert the new revision, materialize added logical steps, switch
 *      the active pointer;
 *   5. decide the proposal terminal (ACCEPTED / REJECTED / STALE).
 *
 * A crash mid-activation rolls everything back and the proposal stays
 * PENDING (retryable); a committed decision is final and idempotent.
 */
@Injectable()
export class PlanProposalService {
  constructor(
    @Inject("DATA_SOURCE") private readonly dataSource: DataSource,
    private readonly validation: PipelineValidationService,
    policyService?: PolicyService,
  ) {
    this.policyService = policyService ?? new PolicyService(this.dataSource);
  }

  private readonly policyService: PolicyService;

  async propose(
    executionId: string,
    patch: unknown,
    source = "operator",
  ): Promise<PlanProposalEntity> {
    // The CALLER's declared baseRevision is preserved verbatim: the CAS at
    // activation remains the authority and stale proposals become STALE.
    const parsed = parsePlanPatch(patch);
    return this.dataSource.transaction(async (manager) => {
      const execution = await this.lockExecution(manager, executionId);
      if (!execution) {
        throw new Error(`Execution ${executionId} does not exist`);
      }
      return this.insertProposal(manager, executionId, parsed, source);
    });
  }

  /**
   * Manager-passable propose (M5-S3: the result application owns the
   * transaction and holds the execution lock already). The proposal's
   * baseRevision is pinned to the ACTIVE revision at propose time — the
   * planner's declared base is untrusted input, and the CAS at activation
   * remains the authority.
   */
  async proposeWithManager(
    manager: EntityManager,
    executionId: string,
    patch: unknown,
    source = "operator",
  ): Promise<PlanProposalEntity> {
    const parsed = parsePlanPatch(patch);
    const execution = await this.lockExecution(manager, executionId);
    if (!execution) {
      throw new Error(`Execution ${executionId} does not exist`);
    }
    const revisionRepository = manager.getRepository(
      ExecutionPlanRevisionEntity,
    );
    const active = execution.activePlanRevisionId
      ? await revisionRepository.findOne({
          where: { id: execution.activePlanRevisionId },
        })
      : null;
    if (!active) {
      throw new Error(`Execution ${executionId} has no active plan revision`);
    }
    return this.insertProposal(
      manager,
      executionId,
      { ...parsed, baseRevision: active.revisionNumber },
      source,
    );
  }

  private async insertProposal(
    manager: EntityManager,
    executionId: string,
    proposal: PlanPatchV1,
    source: string,
  ): Promise<PlanProposalEntity> {
    const repository = manager.getRepository(PlanProposalEntity);
    const maxRow = await repository
      .createQueryBuilder("proposal")
      .select("COALESCE(MAX(proposal.proposalNumber), 0)", "max")
      .where("proposal.executionId = :executionId", { executionId })
      .getRawOne<{ max: string }>();
    const proposalNumber = Number(maxRow?.max ?? 0) + 1;
    return repository.save(
      repository.create({
        executionId,
        proposalNumber,
        baseRevision: proposal.baseRevision,
        proposal,
        proposalHash: sha256Json(proposal),
        source,
      }),
    );
  }

  async activate(proposalId: string): Promise<PlanActivationResult> {
    return this.dataSource.transaction((manager) =>
      this.activateWithManager(manager, proposalId),
    );
  }

  /**
   * Manager-passable activation (M5-S4: the approve flow re-activates
   * INSIDE its own transaction so the APPROVED grant is visible to the
   * policy gate — a nested dataSource transaction would run on a separate
   * connection and deadlock on the uncommitted request row).
   */
  async activateWithManager(
    manager: EntityManager,
    proposalId: string,
  ): Promise<PlanActivationResult> {
    {
      const proposalRepository = manager.getRepository(PlanProposalEntity);
      const proposal = await proposalRepository.findOne({
        where: { id: proposalId },
      });
      if (!proposal) {
        throw new Error(`Proposal ${proposalId} does not exist`);
      }
      if (proposal.status !== "PENDING") {
        return {
          decision: proposal.status,
          reason: proposal.decisionReason ?? "Already decided",
        };
      }

      // Deterministic lock order: execution row first (same as claims).
      const execution = await this.lockExecution(manager, proposal.executionId);
      // Re-read the proposal AFTER the lock: a concurrent activation of the
      // SAME proposal may have committed a terminal decision while we were
      // waiting — its decision is final and must never be overwritten.
      const freshProposal = await proposalRepository.findOne({
        where: { id: proposalId },
      });
      if (!freshProposal || freshProposal.status !== "PENDING") {
        return {
          decision: freshProposal?.status ?? "STALE",
          reason: freshProposal?.decisionReason ?? "Already decided",
        };
      }
      if (
        !execution ||
        TERMINAL_EXECUTION_STATUSES.includes(execution.status)
      ) {
        return this.decide(
          manager,
          proposal,
          "STALE",
          `Execution is ${execution ? execution.status : "gone"}; proposal cannot activate`,
        );
      }
      if (!execution.activePlanRevisionId) {
        return this.decide(
          manager,
          proposal,
          "STALE",
          "Execution has no active plan revision",
        );
      }
      const revisionRepository = manager.getRepository(
        ExecutionPlanRevisionEntity,
      );
      const active = await revisionRepository.findOne({
        where: { id: execution.activePlanRevisionId },
      });
      if (!active) {
        return this.decide(
          manager,
          proposal,
          "STALE",
          `Active revision ${execution.activePlanRevisionId} does not exist`,
        );
      }
      if (active.revisionNumber !== proposal.baseRevision) {
        return this.decide(
          manager,
          proposal,
          "STALE",
          `Base revision ${proposal.baseRevision} is no longer active (active is ${active.revisionNumber})`,
        );
      }

      // Protect every frozen step: any logical step that already has an
      // attempt is execution-defining and cannot be rewritten. The set
      // holds DAG step ids (the patch targets step ids, not row ids).
      const attemptRows = await manager
        .getRepository(StepAttemptEntity)
        .createQueryBuilder("attempt")
        .select('DISTINCT attempt."logicalStepId"', "logicalStepId")
        .where("attempt.executionId = :executionId", {
          executionId: proposal.executionId,
        })
        .getRawMany<{ logicalStepId: string }>();
      const logicalStepIds = attemptRows.map((row) => row.logicalStepId);
      const frozenStepIds = new Set<string>();
      if (logicalStepIds.length > 0) {
        const stepRows = await manager
          .getRepository(LogicalStepEntity)
          .createQueryBuilder("step")
          .select('step."stepId"', "stepId")
          .where("step.id IN (:...ids)", { ids: logicalStepIds })
          .getRawMany<{ stepId: string }>();
        for (const row of stepRows) frozenStepIds.add(row.stepId);
      }

      let candidate: unknown[];
      try {
        candidate = applyPlanPatch(
          active.plan.steps,
          frozenStepIds,
          proposal.proposal,
        );
      } catch (error) {
        return this.decide(
          manager,
          proposal,
          "REJECTED",
          error instanceof PlanPatchError ? error.message : String(error),
        );
      }

      let validatedSteps;
      try {
        validatedSteps = this.validation.validateSteps(candidate);
      } catch (error) {
        return this.decide(
          manager,
          proposal,
          "REJECTED",
          `Candidate plan is invalid: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }

      // M5-S4: policy intercepts BEFORE activation authority. The
      // append-only decision commits atomically with the proposal's
      // outcome. REQUIRE_APPROVAL creates the durable approval request and
      // leaves the proposal PENDING; the approve flow re-activates, which
      // RECHECKS base revision and all authority (a stale approved
      // proposal becomes STALE; a policy that now DENIES rejects it even
      // with a grant).
      if (this.policyService.isConfigured()) {
        const planProposal = buildPlanPatchProposal(
          `plan:${proposal.id}`,
          proposal.executionId,
        );
        const decision = await this.policyService.evaluate(
          planProposal,
          manager,
        );
        if (decision.effect === "DENY") {
          return this.decide(
            manager,
            proposal,
            "REJECTED",
            `Policy DENY: ${decision.reasons.join(", ")}`,
          );
        }
        if (decision.effect === "REQUIRE_APPROVAL") {
          const granted = await manager
            .getRepository(ApprovalRequestEntity)
            .findOne({
              where: {
                proposalId: `plan:${proposal.id}`,
                status: "APPROVED",
              },
            });
          if (!granted) {
            const expiresAt = approvalExpiry(
              new Date(),
              APPROVAL_BOUNDS.defaultExpiryMs,
            );
            try {
              await manager.getRepository(ApprovalRequestEntity).save(
                manager.getRepository(ApprovalRequestEntity).create({
                  proposalId: `plan:${proposal.id}`,
                  proposalHash: planProposal.hash,
                  actionType: "plan_patch",
                  executionId: proposal.executionId,
                  logicalStepId: "",
                  attemptNumber: 1,
                  targetAgent: null,
                  targetExecutor: null,
                  status: "PENDING",
                  expiresAt,
                  decidedAt: null,
                  decisionNote: null,
                }),
              );
            } catch (error) {
              if (
                (error as { code?: string }).code === "23505" &&
                (error as { constraint?: string }).constraint ===
                  "UQ_approval_request_proposal"
              ) {
                // A concurrent activation already created the request:
                // the existing request is authoritative.
              } else {
                throw error;
              }
            }
            return {
              decision: "PENDING",
              reason: "Awaiting approval before activation",
            };
          }
        }
      }

      const existingIds = new Set(active.plan.steps.map((step) => step.id));
      const basePlannerIds = new Set(
        active.plan.steps
          .filter((step) => step.planner === true)
          .map((step) => step.id),
      );

      // M5-S5: a planner-sourced proposal can never create MORE planner
      // work — planner recursion is an amplification risk. The candidate's
      // planner-step set must be a SUBSET of the base plan's planner steps:
      // both adding a planner step AND converting an existing unfrozen step
      // into one are operator-only privileges.
      if (
        proposal.source === "planner" &&
        validatedSteps.some(
          (step) => step.planner === true && !basePlannerIds.has(step.id),
        )
      ) {
        return this.decide(
          manager,
          proposal,
          "REJECTED",
          "A planner proposal cannot create planner steps (operator-only)",
        );
      }

      const candidatePlan = {
        schemaVersion: 1 as const,
        // The plan grant (budget envelope) is carried over unchanged; the
        // patch contract has no budget operations (M5-S4 enforces
        // allocation policy).
        ...("budget" in active.plan ? { budget: active.plan.budget } : {}),
        steps: validatedSteps,
      };
      const addedSteps = validatedSteps.filter(
        (step) => !existingIds.has(step.id),
      );
      const replacedSteps = validatedSteps.filter(
        (step) =>
          existingIds.has(step.id) &&
          sha256Json(step) !==
            sha256Json(active.plan.steps.find((base) => base.id === step.id)),
      );

      const revision = await revisionRepository.save(
        revisionRepository.create({
          executionId: proposal.executionId,
          revisionNumber: active.revisionNumber + 1,
          parentRevisionId: active.id,
          baseRevision: proposal.baseRevision,
          plan: candidatePlan,
          planHash: sha256Json(candidatePlan),
          source: proposal.source,
          reason: `Activated PlanPatch proposal ${proposal.proposalNumber}`,
          validationResult: {
            valid: true,
            proposalId: proposal.id,
            proposalHash: proposal.proposalHash,
            addedSteps: addedSteps.map((step) => step.id),
            replacedSteps: replacedSteps.map((step) => step.id),
          },
        }),
      );

      // Materialize added logical rows in the SAME transaction as the
      // pointer switch (mirrors createExecution's materialization).
      const logicalRepository = manager.getRepository(LogicalStepEntity);
      for (const step of addedSteps) {
        await logicalRepository.save(
          logicalRepository.create({
            executionId: proposal.executionId,
            stepId: step.id,
            agent: step.agent,
            status: "PENDING",
            input: null,
            attempt: 0,
            maxAttempts: 1,
            frozenSpecHash: null,
            frozenAt: null,
          }),
        );
      }

      execution.activePlanRevisionId = revision.id;
      await manager.getRepository(ExecutionEntity).save(execution);
      const outcome = await this.decide(
        manager,
        proposal,
        "ACCEPTED",
        `Activated revision ${revision.revisionNumber} (${addedSteps.length} added, ${replacedSteps.length} replaced)`,
      );
      if (outcome.decision !== "ACCEPTED") {
        // A concurrent authority (deny/expire) won the CAS after the
        // revision + pointer writes: abort so the activated plan can never
        // outlive a REJECTED proposal. (In the approve flow the request
        // lock serializes this path, so the CAS cannot lose there.)
        throw new Error(
          `Proposal ${proposal.id} was decided ${outcome.decision} concurrently; activation aborted`,
        );
      }
      return outcome;
    }
  }

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

  private async decide(
    manager: EntityManager,
    proposal: PlanProposalEntity,
    status: PlanProposalStatus,
    reason: string,
  ): Promise<PlanActivationResult> {
    // CAS-guarded terminal decision: only a still-PENDING proposal can be
    // decided by this activation. A concurrent authority (deny/expire of
    // the approval request) may have terminalized it first — its decision
    // wins and is returned verbatim.
    const updated = await manager
      .getRepository(PlanProposalEntity)
      .createQueryBuilder()
      .update()
      .set({ status, decisionReason: reason, decidedAt: new Date() })
      .where("id = :id", { id: proposal.id })
      .andWhere("status = 'PENDING'")
      .execute();
    if (updated.affected !== 1) {
      const stored = await manager
        .getRepository(PlanProposalEntity)
        .findOne({ where: { id: proposal.id } });
      return {
        decision: stored?.status ?? "STALE",
        reason: stored?.decisionReason ?? "Already decided",
      };
    }
    return { decision: status, reason };
  }
}
