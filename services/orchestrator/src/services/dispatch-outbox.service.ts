import { Inject, Injectable } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import {
  DataSource,
  type EntityManager,
  type SelectQueryBuilder,
} from "typeorm";
import { parseAgentInvocation, type AgentInvocationV1 } from "@tenvyr/contracts";
import { AGENT_ADAPTER } from "../agent-adapters/agent-adapter";
import { AgentAdapterError } from "../agent-adapters/agent-adapter.errors";
import type { AgentAdapter } from "../agent-adapters/agent-adapter.types";
import { DispatchOutboxEntity } from "../entities/dispatch-outbox.entity";
import { ExecutionEntity } from "../entities/execution.entity";
import { ExecutionPlanRevisionEntity } from "../entities/execution-plan-revision.entity";
import { LogicalStepEntity, type StepStatus } from "../entities/step-execution.entity";
import {
  StepAttemptEntity,
  type StepAttemptStatus,
} from "../entities/step-attempt.entity";

// ponytail: fixed lease ceiling; the per-agent request timeout is config-
// owned and can exceed 60s. A lease that expires mid-invoke only causes a
// second at-least-once delivery of the same invocationId (executors dedupe),
// never a second execution identity. Make this configurable if leases shorter
// than configured request timeouts become a real cost.
const DISPATCH_LEASE_MS = 60_000;
const TERMINAL_ATTEMPT_STATUSES: StepAttemptStatus[] = [
  "SUCCESS",
  "FAILED",
  "TIMED_OUT",
  "CANCELLED",
];
const TERMINAL_STEP_STATUSES: StepStatus[] = [
  "COMPLETED",
  "FAILED",
  "SKIPPED",
  "CANCELLED",
];
const TERMINAL_EXECUTION_STATUSES: ExecutionEntity["status"][] = [
  "COMPLETED",
  "FAILED",
  "CANCELLED",
];

export type DispatchDisposition =
  | { outcome: "idle" }
  | { outcome: "dispatched" }
  | { outcome: "terminal_failure"; executionId: string };

export type RecoverySummary = {
  dispatched: number;
  terminalFailures: string[];
  retryableFailures: number;
};

// ponytail: hard ceiling per recovery drain. Each iteration claims a distinct
// outbox record and retryable failures move nextDispatchAt into the future,
// so 100 iterations cover far more than one batch of healthy records; the
// bound only defends against a pathological claim/dispatch loop.
const MAX_DISPATCH_RECOVERY_BATCH = 100;

@Injectable()
export class DispatchOutboxService {
  constructor(
    @Inject("DATA_SOURCE") private readonly dataSource: DataSource,
    @Inject(AGENT_ADAPTER) private readonly adapter: AgentAdapter,
  ) {}

  /**
   * Claims the globally-oldest eligible outbox record and delivers it.
   * Used by background recovery to drain eligible work independent of any
   * single execution's reconciliation context.
   */
  async dispatchNext(): Promise<DispatchDisposition> {
    const claimed = await this.claimNext();
    if (!claimed) return { outcome: "idle" };
    return this.dispatchClaimed(claimed);
  }

  /**
   * Claim-specific dispatch: targets the outbox row of ONE StepAttempt, so
   * the immediate dispatch after a claim is always that attempt's own
   * delivery and can never steal a different execution's record. Respects
   * the same PENDING / expired-LEASED eligibility and terminal filters as
   * the global path; returns `idle` when the row is not eligible.
   */
  async dispatchAttempt(stepAttemptId: string): Promise<DispatchDisposition> {
    const claimed = await this.claimAttempt(stepAttemptId);
    if (!claimed) return { outcome: "idle" };
    return this.dispatchClaimed(claimed);
  }

  /**
   * Shared claimed-record delivery: leases are already committed, so the
   * executor is invoked outside any transaction. A non-retryable transport
   * rejection is committed durably (outbox FAILED, attempt FAILED, then the
   * pipeline's workflow failure policy) and reported as `terminal_failure`
   * so the caller can reconcile the affected execution; the outbox service
   * itself never touches the Gateway. Retryable errors are rethrown after
   * returning the record to PENDING for a later tick.
   */
  private async dispatchClaimed(
    claimed: DispatchOutboxEntity,
  ): Promise<DispatchDisposition> {
    try {
      const receipt = await this.adapter.invoke(
        parseAgentInvocation(claimed.invocation) as AgentInvocationV1,
      );
      await this.markDispatched(claimed, receipt);
      return { outcome: "dispatched" };
    } catch (error) {
      if (
        error instanceof AgentAdapterError &&
        error.retryable === false
      ) {
        // A permanently rejected invocation (e.g. HTTP 400, agent not
        // configured) must not be redelivered through the transport, but the
        // pipeline's workflow failure policy still governs the step/execution
        // lifecycle: a new attempt with a NEW invocationId may retry the same
        // configuration, bounded by maxAttempts.
        const executionId = await this.failNonRetryable(claimed, error);
        return { outcome: "terminal_failure", executionId };
      }
      // Publishing may have succeeded before the transport threw or this
      // process crashed. Keep the same durable invocation for at-least-once
      // redelivery instead of inventing a second execution identity.
      await this.dataSource
        .getRepository(DispatchOutboxEntity)
        .createQueryBuilder()
        .update(DispatchOutboxEntity)
        .set({
          status: "PENDING",
          leaseExpiresAt: null,
          leaseToken: null,
          nextDispatchAt: new Date(Date.now() + 1_000),
          error: this.message(error),
        })
        .where("id = :id", { id: claimed.id })
        .andWhere("status = :status", { status: "LEASED" })
        .andWhere('"leaseToken" = :leaseToken', {
          leaseToken: claimed.leaseToken,
        })
        .execute();
      throw error;
    }
  }

  private async failNonRetryable(
    claimed: DispatchOutboxEntity,
    error: AgentAdapterError,
  ): Promise<string> {
    const message = this.message(error);
    // The caller needs the affected execution to reconcile/project it.
    const executionId = String(
      (claimed.invocation as Record<string, unknown>).executionId ?? "",
    );
    await this.dataSource.transaction(async (manager) => {
      const attemptRepository = manager.getRepository(StepAttemptEntity);
      const attempt = await attemptRepository
        .createQueryBuilder("attempt")
        .setLock("pessimistic_write")
        .where('attempt."id" = :id', { id: claimed.stepAttemptId })
        .getOne();
      if (!attempt) return;

      // The lease guard runs first: if a newer dispatcher already re-claimed
      // this record (stale worker reporting a late 400 after the lease
      // expired), the failure belongs to an invocation that is no longer
      // authoritative and must not fail the attempt a newer claim owns.
      const outboxTransition = await manager
        .getRepository(DispatchOutboxEntity)
        .createQueryBuilder()
        .update(DispatchOutboxEntity)
        .set({
          status: "FAILED",
          leaseExpiresAt: null,
          leaseToken: null,
          error: message,
        })
        .where("id = :id", { id: claimed.id })
        .andWhere("status = :status", { status: "LEASED" })
        .andWhere('"leaseToken" = :leaseToken', {
          leaseToken: claimed.leaseToken,
        })
        .execute();
      if (outboxTransition.affected !== 1) return;

      const failureReason = `Non-retryable dispatch failure: ${message}`;
      const transition = await attemptRepository
        .createQueryBuilder()
        .update(StepAttemptEntity)
        .set({
          status: "FAILED",
          terminalAt: new Date(),
          result: null,
          error: failureReason,
          terminationReason: failureReason,
        })
        .where("id = :id", { id: attempt.id })
        .andWhere("status NOT IN (:...terminal)", {
          terminal: TERMINAL_ATTEMPT_STATUSES,
        })
        .execute();
      if (transition.affected !== 1) return;

      // Lock order mirrors result application (attempt -> logical step ->
      // execution) so cancellation and result races serialize cleanly.
      const logicalRepository = manager.getRepository(LogicalStepEntity);
      const logicalStep = await logicalRepository
        .createQueryBuilder("step")
        .setLock("pessimistic_write")
        .where('step."id" = :id', { id: attempt.logicalStepId })
        .getOne();
      if (
        !logicalStep ||
        TERMINAL_STEP_STATUSES.includes(logicalStep.status)
      ) {
        return;
      }

      const revision = await manager
        .getRepository(ExecutionPlanRevisionEntity)
        .findOne({ where: { id: attempt.planRevisionId } });
      const stepConfig = revision?.plan.steps.find(
        (step) => step.id === logicalStep.stepId,
      );
      const now = new Date();

      // Transport redelivery of this invocation is impossible, but the
      // pipeline's workflow failure policy still decides the step/execution
      // lifecycle. `onFailure: retry` with attempts remaining schedules a
      // fresh attempt (a NEW invocationId) that later reconciliation creates.
      if (
        stepConfig?.onFailure === "retry" &&
        attempt.attemptNumber < logicalStep.maxAttempts
      ) {
        logicalStep.status = "RETRYING";
        logicalStep.error = failureReason;
        logicalStep.nextAttemptAt = now;
        logicalStep.endTime = null;
        await logicalRepository.save(logicalStep);
        return;
      }

      logicalStep.status = "FAILED";
      logicalStep.error = failureReason;
      logicalStep.endTime = now;
      logicalStep.nextAttemptAt = null;
      await logicalRepository.save(logicalStep);

      if (stepConfig?.onFailure !== "continue") {
        const executionRepository = manager.getRepository(ExecutionEntity);
        const execution = await executionRepository
          .createQueryBuilder("execution")
          .setLock("pessimistic_write")
          .where('execution."id" = :id', { id: attempt.executionId })
          .getOne();
        if (
          execution &&
          !TERMINAL_EXECUTION_STATUSES.includes(execution.status)
        ) {
          execution.status = "FAILED";
          execution.endTime = now;
          execution.terminationReason = failureReason;
          await executionRepository.save(execution);
        }
      }
    });
    return executionId;
  }

  /**
   * Drains eligible outbox records with per-record error isolation: one
   * retryable delivery failure returns THAT record to PENDING with a future
   * nextDispatchAt and does not stop unrelated eligible work behind it.
   * Claim-phase (database) failures still abort the drain so outages are not
   * hidden — the next tick retries. Bounded by MAX_DISPATCH_RECOVERY_BATCH.
   */
  async recover(): Promise<RecoverySummary> {
    let dispatched = 0;
    const terminalFailures: string[] = [];
    let retryableFailures = 0;
    for (let iteration = 0; iteration < MAX_DISPATCH_RECOVERY_BATCH; iteration += 1) {
      // claimNext sits OUTSIDE the per-record try: a claim-phase failure is a
      // systemic database problem and must abort (and surface), not count as
      // a delivery failure.
      const claimed = await this.claimNext();
      if (!claimed) break;
      try {
        const disposition = await this.dispatchClaimed(claimed);
        if (disposition.outcome === "dispatched") dispatched += 1;
        else if (
          disposition.outcome === "terminal_failure" &&
          !terminalFailures.includes(disposition.executionId)
        ) {
          terminalFailures.push(disposition.executionId);
        }
      } catch {
        // Retryable invoke failure: the record is already back to PENDING
        // with a future nextDispatchAt and the same invocationId.
        retryableFailures += 1;
      }
    }
    return { dispatched, terminalFailures, retryableFailures };
  }

  /**
   * Leases one eligible outbox row transactionally: PENDING and due, or
   * LEASED with an expired lease. The attempt/execution terminal filters run
   * first, so a stale PENDING record of a terminal attempt or execution can
   * never be leased. The shared WHERE predicate is parenthesized so the
   * status disjunction cannot bypass the terminal filters.
   */
  private async leaseOutboxRow(
    manager: EntityManager,
    builder: SelectQueryBuilder<DispatchOutboxEntity>,
  ): Promise<DispatchOutboxEntity | null> {
    const now = new Date();
    const outbox = await builder
      .setLock("pessimistic_write")
      .setOnLocked("skip_locked")
      .andWhere(
        '((outbox."status" = :pending AND outbox."nextDispatchAt" <= :now) OR (outbox."status" = :leased AND outbox."leaseExpiresAt" <= :now))',
        { pending: "PENDING", leased: "LEASED", now },
      )
      .andWhere('attempt."status" NOT IN (:...terminal)', {
        terminal: TERMINAL_ATTEMPT_STATUSES,
      })
      .andWhere(
        'EXISTS (SELECT 1 FROM "executions" execution WHERE execution."id" = attempt."executionId" AND execution."status" NOT IN (:...executionTerminal))',
        { executionTerminal: TERMINAL_EXECUTION_STATUSES },
      )
      .getOne();
    if (!outbox) return null;

    outbox.status = "LEASED";
    outbox.leaseExpiresAt = new Date(now.getTime() + DISPATCH_LEASE_MS);
    outbox.leaseToken = randomUUID();
    outbox.dispatchCount += 1;
    return manager.getRepository(DispatchOutboxEntity).save(outbox);
  }

  private async claimNext(): Promise<DispatchOutboxEntity | null> {
    return this.dataSource.transaction(async (manager) => {
      const builder = manager
        .getRepository(DispatchOutboxEntity)
        .createQueryBuilder("outbox")
        .innerJoin(
          StepAttemptEntity,
          "attempt",
          'attempt."id" = outbox."stepAttemptId"',
        )
        .orderBy('outbox."nextDispatchAt"', "ASC");
      return this.leaseOutboxRow(manager, builder);
    });
  }

  private async claimAttempt(
    stepAttemptId: string,
  ): Promise<DispatchOutboxEntity | null> {
    return this.dataSource.transaction(async (manager) => {
      const builder = manager
        .getRepository(DispatchOutboxEntity)
        .createQueryBuilder("outbox")
        .innerJoin(
          StepAttemptEntity,
          "attempt",
          'attempt."id" = outbox."stepAttemptId"',
        )
        .where('outbox."stepAttemptId" = :stepAttemptId', { stepAttemptId });
      return this.leaseOutboxRow(manager, builder);
    });
  }

  private async markDispatched(
    claimed: DispatchOutboxEntity,
    receipt: Record<string, unknown>,
  ): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const attempt = await manager
        .getRepository(StepAttemptEntity)
        .createQueryBuilder("attempt")
        .setLock("pessimistic_write")
        .where('attempt."id" = :id', { id: claimed.stepAttemptId })
        .getOne();
      if (!attempt || TERMINAL_ATTEMPT_STATUSES.includes(attempt.status)) return;

      // Result application takes the same Attempt -> Outbox order. The lease
      // token prevents an expired worker from committing over a newer claim.
      const receiptUpdate = await manager
        .getRepository(DispatchOutboxEntity)
        .createQueryBuilder()
        .update(DispatchOutboxEntity)
        .set({
          status: "DISPATCHED",
          leaseExpiresAt: null,
          leaseToken: null,
          receipt,
          error: null,
        })
        .where("id = :id", { id: claimed.id })
        .andWhere("status = :status", { status: "LEASED" })
        .andWhere('"leaseToken" = :leaseToken', {
          leaseToken: claimed.leaseToken,
        })
        .execute();
      if (receiptUpdate.affected !== 1) return;

      if (attempt.status === "CREATED") {
        attempt.status = "DISPATCHED";
        attempt.dispatchedAt = new Date();
        await manager.getRepository(StepAttemptEntity).save(attempt);
      }
    });
  }

  private message(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
