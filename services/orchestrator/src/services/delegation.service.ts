import { Inject, Injectable } from "@nestjs/common";
import { DataSource, EntityManager } from "typeorm";
import { PipelineEntity } from "../entities/pipeline.entity";
import {
  DelegationRequestEntity,
  DelegationRequestStatus,
} from "../entities/delegation-request.entity";
import { ExecutionService } from "./execution.service";
import { ExecutionEntity } from "../entities/execution.entity";
import { StepAttemptEntity } from "../entities/step-attempt.entity";
import { BudgetAccountEntity } from "../entities/budget-account.entity";
import { CoordinationRunEntity } from "../entities/coordination-run.entity";
import { DelegationObservationEntity } from "../entities/delegation-observation.entity";
import { parsePipelineBudget } from "../domain/budget";
import { DelegationRequestConflictEntity } from "../entities/delegation-request-conflict.entity";
import { sha256Json } from "../domain/canonical-json";
import { buildDelegationProposal } from "../domain/policy";
import { PolicyService } from "./policy.service";

/** M6-S4: server-derived delegation bounds (child can never exceed its
 *  parent: depth, per-attempt fanout, budget subset). */
export const DELEGATION_BOUNDS = {
  maxDepth: 3,
  maxRequestsPerAttempt: 10,
} as const;

export type DelegationRequestOutcome = {
  disposition: "created" | "replayed" | "conflict" | "already_decided";
  request: DelegationRequestEntity;
};

export type DelegationDecisionResult = {
  decision: DelegationRequestStatus;
  childExecutionId: string | null;
  reason: string;
};

/**
 * M6-S2: authoritative supervised delegation.
 *
 * `request` persists an idempotent, parent-attempt-scoped delegation
 * request (repeat calls replay the existing row). `approve` materializes
 * the child Execution — execution row, plan revision 1, logical step
 * rows — via the manager-aware materializer INSIDE the decision
 * transaction (all-or-none) and links childExecutionId. `reject`
 * terminalizes without a child. Decisions are terminal and idempotent;
 * the (parentAttemptId, requestId) unique key makes duplicate requests
 * harmless.
 */
@Injectable()
export class DelegationService {
  constructor(
    @Inject("DATA_SOURCE") private readonly dataSource: DataSource,
    private readonly executionService: ExecutionService,
    policyService?: PolicyService,
  ) {
    this.policyService = policyService ?? new PolicyService(this.dataSource);
  }

  private readonly policyService: PolicyService;

  async request(input: {
    parentExecutionId: string;
    parentAttemptId: string;
    requestId: string;
    requestedAgent: string;
    expiresAt: Date;
  }): Promise<DelegationRequestOutcome> {
    const payload = this.requestPayload(input);
    const payloadHash = sha256Json(payload);
    return this.dataSource.transaction(async (manager) => {
      // The attempt must actually belong to the declared parent execution:
      // a mismatched pair would attribute the child to the wrong
      // execution.
      const attempt = await manager
        .getRepository(StepAttemptEntity)
        .createQueryBuilder("attempt")
        .setLock("pessimistic_write")
        .where('attempt."id" = :id', { id: input.parentAttemptId })
        .getOne();
      if (!attempt || attempt.executionId !== input.parentExecutionId) {
        throw new Error(
          `Delegation request attempt ${input.parentAttemptId} does not belong to execution ${input.parentExecutionId}`,
        );
      }
      const repository = manager.getRepository(DelegationRequestEntity);
      const existing = await repository.findOne({
        where: {
          parentAttemptId: input.parentAttemptId,
          requestId: input.requestId,
        },
      });
      if (existing) {
        if (!existing.payloadHash || existing.payloadHash !== payloadHash) {
          const conflicts = manager.getRepository(
            DelegationRequestConflictEntity,
          );
          await conflicts.save(
            conflicts.create({
              parentAttemptId: input.parentAttemptId,
              requestId: input.requestId,
              payloadHash,
              payload,
              conflictKind: existing.payloadHash
                ? "PAYLOAD_MISMATCH"
                : "LEGACY_PAYLOAD_UNKNOWN",
            }),
          );
          return { disposition: "conflict", request: existing };
        }
        return { disposition: "replayed", request: existing };
      }
      // M6-S4: server-derived bounds — fanout per parent attempt and
      // delegation depth (parent depth + 1). Depth comes from the parent
      // execution's OWN delegation request (childExecutionId linkage), so
      // an untrusted runtime can never claim a shallower depth.
      // Only live requests consume fanout capacity: junk REJECTED or
      // EXPIRED rows must never exhaust an attempt's delegation quota.
      const activeCount = await repository
        .createQueryBuilder("request")
        .where('request."parentAttemptId" = :parentAttemptId', {
          parentAttemptId: input.parentAttemptId,
        })
        .andWhere("request.status IN (:...live)", {
          live: ["PENDING", "APPROVED"],
        })
        .getCount();
      if (activeCount >= DELEGATION_BOUNDS.maxRequestsPerAttempt) {
        throw new Error(
          `Delegation fanout exceeds ${DELEGATION_BOUNDS.maxRequestsPerAttempt} requests per parent attempt`,
        );
      }
      const parentDepth = await this.parentDepth(
        manager,
        input.parentExecutionId,
      );
      const childDepth = parentDepth + 1;
      if (childDepth > DELEGATION_BOUNDS.maxDepth) {
        throw new Error(
          `Delegation depth exceeds ${DELEGATION_BOUNDS.maxDepth}`,
        );
      }
      // M9-S7: the coordination run's frozen delegationDepthMax is the
      // authority for every descendant of the run — not just the first
      // hop. A worker step (depth 1) that delegates again (depth 2) is
      // bounded by the run's own limit, never silently widened to the
      // global ceiling.
      const runDepthMax = await this.coordinationDelegationDepthMax(
        manager,
        input.parentExecutionId,
      );
      if (runDepthMax !== undefined && childDepth > runDepthMax) {
        throw new Error(
          `Delegation depth exceeds the coordination run's delegationDepthMax ${runDepthMax}`,
        );
      }
      const request = await repository.save(
        repository.create({
          parentExecutionId: input.parentExecutionId,
          parentAttemptId: input.parentAttemptId,
          requestId: input.requestId,
          requestedAgent: input.requestedAgent,
          payloadHash,
          childDepth,
          childExecutionId: null,
          status: "PENDING",
          expiresAt: input.expiresAt,
          authorityDeadlineAt: attempt.deadlineAt ?? null,
        }),
      );
      return { disposition: "created", request };
    });
  }

  async approve(
    parentAttemptId: string,
    requestId: string,
    pipeline: PipelineEntity,
  ): Promise<DelegationDecisionResult> {
    return this.dataSource.transaction(async (manager) => {
      const request = await this.lockRequest(
        manager,
        parentAttemptId,
        requestId,
      );
      if (!request) {
        throw new Error(
          `Delegation request ${parentAttemptId}/${requestId} does not exist`,
        );
      }
      if (request.status !== "PENDING") {
        return {
          decision: request.status,
          childExecutionId: request.childExecutionId,
          reason: request.decisionNote ?? "Already decided",
        };
      }
      if (request.expiresAt <= new Date()) {
        return this.decide(
          manager,
          request,
          "EXPIRED",
          "Delegation request expired before approval",
        );
      }
      if (
        request.authorityDeadlineAt &&
        request.authorityDeadlineAt <= new Date()
      ) {
        return this.decide(
          manager,
          request,
          "EXPIRED",
          "Parent attempt authority deadline elapsed before child approval",
        );
      }
      // M6-S4: recheck the server-derived bounds at approval time (the
      // request row is authoritative; the depth can never exceed the
      // bound), and enforce the budget subset: the child's grant must be
      // within the parent's grant.
      if (request.childDepth > DELEGATION_BOUNDS.maxDepth) {
        return this.decide(
          manager,
          request,
          "REJECTED",
          `Delegation depth exceeds ${DELEGATION_BOUNDS.maxDepth}`,
        );
      }
      if (this.policyService.isConfigured()) {
        const decision = await this.policyService.evaluate(
          buildDelegationProposal(
            `delegate:${request.id}`,
            request.parentExecutionId,
            request.requestedAgent,
          ),
          manager,
        );
        if (decision.effect === "DENY") {
          return this.decide(
            manager,
            request,
            "REJECTED",
            `Policy DENY: ${decision.reasons.join("; ")}`,
          );
        }
        // `approve` is the explicit operator decision seam. A
        // REQUIRE_APPROVAL policy therefore proceeds only through this
        // method; runtime request creation alone can never authorize work.
      }
      let childBudget;
      try {
        childBudget = parsePipelineBudget(
          (pipeline as { budget?: unknown }).budget,
        );
        if (
          !childBudget &&
          pipeline.steps.some((step) => step.budget !== undefined)
        ) {
          throw new Error(
            "A budgeted child step requires an explicit child pipeline budget grant",
          );
        }
        await this.assertBudgetSubset(
          manager,
          request.parentExecutionId,
          childBudget,
        );
      } catch (error) {
        return this.decide(
          manager,
          request,
          "REJECTED",
          error instanceof Error ? error.message : String(error),
        );
      }
      // M6-S2: the child Execution materializes all-or-none with the
      // decision — execution row, plan revision 1, logical steps. The
      // child's pipeline is the operator-approved reusable pipeline; the
      // child runs as its own execution. Authority/budget inheritance is
      // enforced here (M6-S4): budget subset above; agent/executor classes
      // are governed by the policy boundary on the child's dispatch
      // claims; credentials are reference-only via the transport config.
      const governedPipeline = childBudget
        ? ({
            ...pipeline,
            contentHash: "",
            budget: {
              ...childBudget,
              parent: {
                scopeType: "execution",
                scopeId: request.parentExecutionId,
              },
            },
          } as PipelineEntity)
        : pipeline;
      const child = await this.executionService.materializeExecutionWithManager(
        manager,
        governedPipeline,
        { delegatedFrom: request.parentExecutionId },
        request.authorityDeadlineAt,
      );
      return this.decide(
        manager,
        request,
        "APPROVED",
        `Child execution ${child.id} materialized`,
        child.id,
      );
    });
  }

  async reject(
    parentAttemptId: string,
    requestId: string,
    note = "Delegation rejected",
  ): Promise<DelegationDecisionResult> {
    return this.dataSource.transaction(async (manager) => {
      const request = await this.lockRequest(
        manager,
        parentAttemptId,
        requestId,
      );
      if (!request) {
        throw new Error(
          `Delegation request ${parentAttemptId}/${requestId} does not exist`,
        );
      }
      if (request.status !== "PENDING") {
        return {
          decision: request.status,
          childExecutionId: request.childExecutionId,
          reason: request.decisionNote ?? "Already decided",
        };
      }
      return this.decide(manager, request, "REJECTED", note);
    });
  }

  /**
   * M6-S4: bounded durable cancellation cascade. For every CANCELLED
   * parent execution with APPROVED children that are still non-terminal,
   * cancel the children in deterministic order (createdAt, id), bounded
   * per cycle — crash-resumable because the recovery cycle re-scans every
   * tick until no runnable orphan remains. The cascade is depth-bounded
   * by construction (each child is itself a delegation parent at most
   * DELEGATION_BOUNDS.maxDepth deep).
   */
  /**
   * M6-S5: bounded read-only delegation-graph projection for one
   * execution. Supervised edges are APPROVED requests (the durable
   * parent→child relation); observed edges are runtime-asserted evidence;
   * opaque edges cannot exist by definition (nothing is recorded). The
   * depth is the execution's own server-derived depth. Service-level
   * only — the public graph API stays behind the exposure gate.
   */
  async projection(
    executionId: string,
    limit = 100,
    manager?: EntityManager,
  ): Promise<{
    executionId: string;
    depth: number;
    supervised: Array<{
      requestId: string;
      childExecutionId: string;
      childDepth: number;
      requestedAgent: string;
      status: string;
    }>;
    observed: Array<{
      observationId: string;
      provider: string;
      childId: string;
      stepAttemptId: string;
      occurredAt: Date;
    }>;
    supervisedTotal: number;
    observedTotal: number;
    supervisedTruncated: boolean;
    observedTruncated: boolean;
  }> {
    const read = manager ?? this.dataSource.manager;
    const supervised = await read
      .getRepository(DelegationRequestEntity)
      .createQueryBuilder("request")
      .select([
        'request."requestId"',
        'request."childExecutionId"',
        'request."childDepth"',
        'request."requestedAgent"',
        'request."status"',
      ])
      .where('request."parentExecutionId" = :executionId', { executionId })
      .andWhere('request."childExecutionId" IS NOT NULL')
      .orderBy("request.createdAt", "ASC")
      .addOrderBy("request.id", "ASC")
      .take(limit + 1)
      .getRawMany<{
        requestId: string;
        childExecutionId: string;
        childDepth: number;
        requestedAgent: string;
        status: string;
      }>();
    const supervisedTruncated = supervised.length > limit;
    if (supervisedTruncated) supervised.pop();
    const supervisedTotal = await read
      .getRepository(DelegationRequestEntity)
      .createQueryBuilder("request")
      .where('request."parentExecutionId" = :executionId', { executionId })
      .andWhere('request."childExecutionId" IS NOT NULL')
      .getCount();
    const observed = await read
      .getRepository(DelegationObservationEntity)
      .createQueryBuilder("observation")
      .select([
        'observation."observationId"',
        'observation."provider"',
        'observation."childId"',
        'observation."stepAttemptId"',
        'observation."occurredAt"',
      ])
      .where('observation."executionId" = :executionId', { executionId })
      .orderBy("observation.receivedAt", "ASC")
      .addOrderBy("observation.id", "ASC")
      .take(limit + 1)
      .getRawMany<{
        observationId: string;
        provider: string;
        childId: string;
        stepAttemptId: string;
        occurredAt: Date;
      }>();
    const observedTruncated = observed.length > limit;
    if (observedTruncated) observed.pop();
    const observedTotal = await read
      .getRepository(DelegationObservationEntity)
      .count({ where: { executionId } });
    const depth = await this.parentDepth(read, executionId);
    return {
      executionId,
      depth,
      supervised: supervised.map((row) => ({
        ...row,
        childDepth: Number(row.childDepth),
      })),
      observed: observed.map((row) => ({
        ...row,
        occurredAt: new Date(row.occurredAt),
      })),
      supervisedTotal,
      observedTotal,
      supervisedTruncated,
      observedTruncated,
    };
  }

  async cancelOrphans(manager?: EntityManager, limit = 20): Promise<number> {
    const run = async (m: EntityManager): Promise<number> => {
      const candidates = await m
        .getRepository(DelegationRequestEntity)
        .createQueryBuilder("request")
        .innerJoin(
          "executions",
          "parent",
          'parent."id" = request."parentExecutionId"',
        )
        .innerJoin(
          "executions",
          "child",
          'child."id" = request."childExecutionId"',
        )
        .where("request.status = 'APPROVED'")
        .andWhere("parent.status = 'CANCELLED'")
        .andWhere("child.status NOT IN (:...terminal)", {
          terminal: ["CANCELLED", "COMPLETED", "FAILED"],
        })
        .orderBy("request.createdAt", "ASC")
        .addOrderBy("request.id", "ASC")
        .take(limit)
        .getMany();
      let cancelled = 0;
      for (const request of candidates) {
        if (!request.childExecutionId) continue;
        try {
          await this.executionService.cancelExecution(request.childExecutionId);
          cancelled += 1;
        } catch (error) {
          console.warn("Delegation orphan cancellation failed", {
            childExecutionId: request.childExecutionId,
            reason: error instanceof Error ? error.message : String(error),
          });
        }
      }
      return cancelled;
    };
    return manager ? run(manager) : this.dataSource.transaction(run);
  }

  async expireDue(
    manager?: EntityManager,
    now = new Date(),
    limit = 100,
  ): Promise<number> {
    const run = async (m: EntityManager): Promise<number> => {
      const due = await m
        .getRepository(DelegationRequestEntity)
        .createQueryBuilder("request")
        .setLock("pessimistic_write")
        .where("request.status = 'PENDING'")
        .andWhere("request.expiresAt <= :now", { now })
        .take(limit)
        .getMany();
      let expired = 0;
      for (const request of due) {
        await this.decide(m, request, "EXPIRED", "Delegation request expired");
        expired += 1;
      }
      return expired;
    };
    return manager ? run(manager) : this.dataSource.transaction(run);
  }

  private async parentDepth(
    manager: EntityManager,
    parentExecutionId: string,
  ): Promise<number> {
    const row = await manager
      .getRepository(DelegationRequestEntity)
      .createQueryBuilder("request")
      .select("MAX(request.childDepth)", "depth")
      .where("request.childExecutionId = :parentExecutionId", {
        parentExecutionId,
      })
      .getRawOne<{ depth: string | null }>();
    return Number(row?.depth ?? 0);
  }

  /**
   * M9-S7: the frozen delegationDepthMax of the coordination run this
   * execution tree belongs to (walking the delegation chain to the root
   * execution). `undefined` when the root is not a coordination run — the
   * global DELEGATION_BOUNDS.maxDepth remains the ceiling.
   */
  private async coordinationDelegationDepthMax(
    manager: EntityManager,
    parentExecutionId: string,
  ): Promise<number | undefined> {
    let current = parentExecutionId;
    const repository = manager.getRepository(DelegationRequestEntity);
    for (let hop = 0; hop < DELEGATION_BOUNDS.maxDepth + 1; hop += 1) {
      const row = await repository
        .createQueryBuilder("request")
        .select("request.parentExecutionId", "parentExecutionId")
        .where("request.childExecutionId = :current", { current })
        .andWhere("request.childExecutionId IS NOT NULL")
        .orderBy("request.createdAt", "DESC")
        .getRawOne<{ parentExecutionId: string } | null>();
      if (!row) break;
      current = row.parentExecutionId;
    }
    const run = await manager.getRepository(CoordinationRunEntity).findOne({
      where: { executionId: current },
      select: ["config"],
    });
    return run?.config.delegationDepthMax;
  }

  /** M6-S4: the child's budget grant must be a per-dimension subset of the
   *  parent execution's grant; a parent without a grant cannot have a
   *  budgeted child. */
  private async assertBudgetSubset(
    manager: EntityManager,
    parentExecutionId: string,
    childBudget:
      | {
          parent?: { scopeType: string; scopeId: string };
          ceilings: Record<string, number>;
        }
      | undefined,
  ): Promise<void> {
    if (!childBudget || Object.keys(childBudget.ceilings).length === 0) return;
    const account = await manager.getRepository(BudgetAccountEntity).findOne({
      where: { scopeType: "execution", scopeId: parentExecutionId },
    });
    if (!account) {
      throw new Error(
        `Parent execution ${parentExecutionId} has no budget grant; a budgeted child cannot inherit authority`,
      );
    }
    for (const [dimension, amount] of Object.entries(childBudget.ceilings)) {
      const parentCeiling = (account.ceilings as Record<string, number>)[
        dimension
      ];
      if (parentCeiling === undefined || amount > parentCeiling) {
        throw new Error(
          `Child budget ${dimension} ${amount} exceeds the parent grant ${String(parentCeiling)}`,
        );
      }
    }
  }

  private lockRequest(
    manager: EntityManager,
    parentAttemptId: string,
    requestId: string,
  ): Promise<DelegationRequestEntity | null> {
    return manager
      .getRepository(DelegationRequestEntity)
      .createQueryBuilder("request")
      .setLock("pessimistic_write")
      .where('request."parentAttemptId" = :parentAttemptId', {
        parentAttemptId,
      })
      .andWhere('request."requestId" = :requestId', { requestId })
      .getOne();
  }

  private async decide(
    manager: EntityManager,
    request: DelegationRequestEntity,
    status: DelegationRequestStatus,
    reason: string,
    childExecutionId: string | null = null,
  ): Promise<DelegationDecisionResult> {
    // CAS-guarded terminal decision: only a still-PENDING request can be
    // decided by this call.
    const updated = await manager
      .getRepository(DelegationRequestEntity)
      .createQueryBuilder()
      .update()
      .set({
        status,
        decisionNote: reason,
        decidedAt: new Date(),
        ...(childExecutionId ? { childExecutionId } : {}),
      })
      .where("id = :id", { id: request.id })
      .andWhere("status = 'PENDING'")
      .execute();
    if (updated.affected !== 1) {
      const stored = await manager
        .getRepository(DelegationRequestEntity)
        .findOne({ where: { id: request.id } });
      return {
        decision: stored?.status ?? "PENDING",
        childExecutionId: stored?.childExecutionId ?? null,
        reason:
          stored?.decisionNote ??
          "Request row disappeared; no decision committed",
      };
    }
    return { decision: status, childExecutionId, reason };
  }

  private requestPayload(input: {
    parentExecutionId: string;
    parentAttemptId: string;
    requestId: string;
    requestedAgent: string;
    expiresAt: Date;
  }): Record<string, string> {
    for (const [field, value] of [
      ["parentExecutionId", input.parentExecutionId],
      ["parentAttemptId", input.parentAttemptId],
      ["requestId", input.requestId],
      ["requestedAgent", input.requestedAgent],
    ] as const) {
      if (!value || value.length > 255) {
        throw new Error(`${field} must be 1-255 characters`);
      }
    }
    if (
      !(input.expiresAt instanceof Date) ||
      !Number.isFinite(input.expiresAt.getTime())
    ) {
      throw new Error("expiresAt must be a valid Date");
    }
    return {
      parentExecutionId: input.parentExecutionId,
      parentAttemptId: input.parentAttemptId,
      requestId: input.requestId,
      requestedAgent: input.requestedAgent,
      expiresAt: input.expiresAt.toISOString(),
    };
  }
}
