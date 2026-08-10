import type { AgentResultV1 } from "@tenvyr/contracts";
import { Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { IsNull, LessThanOrEqual, Repository } from "typeorm";
import { Inject } from "@nestjs/common";
import { DispatchOutboxService } from "./dispatch-outbox.service";
import { SupervisionService } from "./supervision.service";
import { EngineService } from "./engine.service";
import { ResultInboxService } from "./result-inbox.service";
import { StepAttemptEntity } from "../entities/step-attempt.entity";
import { ExecutionEntity } from "../entities/execution.entity";

const RECOVERY_BATCH = 100;

/**
 * Durable timestamps, rather than process timers, are the authority for
 * retry/deadline recovery. The short interval merely asks PostgreSQL what is
 * due; a restart or another orchestrator instance reaches the same records.
 *
 * Recovery discovers candidate EXECUTIONS (not step rows): stuck PENDING
 * executions plus RUNNING executions with autonomous work. Every candidate
 * is driven through `EngineService.reconcileExecution`, so recovery never
 * depends on remembering which step callback happened before a crash.
 */
@Injectable()
export class RuntimeRecoveryService implements OnModuleInit, OnModuleDestroy {
  private timer?: NodeJS.Timeout;
  // ponytail: single-process overlap guard; if a recovery cycle ever needs to
  // overlap itself (multi-minute cycles), move the guard to a DB advisory lock.
  private cycleInProgress = false;
  // ponytail: in-memory keyset cursor over candidate executions. A restart
  // resets it and re-visits the oldest candidates (idempotent), so every
  // candidate is eventually visited across ticks even when more exist than
  // one batch. Persist the cursor only if revisits ever become a real cost.
  private cursor?: { createdAt: string; id: string };

  constructor(
    @Inject("STEP_ATTEMPT_REPOSITORY")
    private readonly attempts: Repository<StepAttemptEntity>,
    @Inject("EXECUTION_REPOSITORY")
    private readonly executions: Repository<ExecutionEntity>,
    private readonly outbox: DispatchOutboxService,
    private readonly inbox: ResultInboxService,
    private readonly engine: EngineService,
    private readonly supervision: SupervisionService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.recover();
    this.timer = setInterval(() => void this.recover(), 1_000);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async recover(now = new Date()): Promise<void> {
    if (this.cycleInProgress) return;
    this.cycleInProgress = true;
    try {
      await this.expireAttempts(now);
      // Deterministic supervision (acceptance timeout / stale heartbeat) runs
      // after persisted deadlines so Milestone-0 deadline authority is
      // unchanged, and before candidate reconciliation so terminalized
      // attempts never re-enter the schedulable set in the same cycle.
      await this.supervision.evaluate(now);
      await this.reconcileCandidateExecutions(now);
      const result = await this.outbox.recover();
      if (result.retryableFailures > 0) {
        console.warn("Deferred retryable outbox deliveries", {
          count: result.retryableFailures,
        });
      }
      for (const executionId of result.terminalFailures) {
        await this.engine.reconcileExecution(executionId, {
          projectTerminal: true,
        });
      }
    } catch (error) {
      // A scheduled recovery promise must never become an unhandled
      // rejection: durable state decides what a later tick redoes.
      console.error("Recovery cycle failed; the next tick retries", {
        reason: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.cycleInProgress = false;
    }
  }

  private async expireAttempts(now: Date): Promise<void> {
    const overdue = await this.attempts.find({
      where: [
        { status: "CREATED", deadlineAt: LessThanOrEqual(now) },
        { status: "DISPATCHED", deadlineAt: LessThanOrEqual(now) },
        { status: "RUNNING", deadlineAt: LessThanOrEqual(now) },
      ],
      order: { deadlineAt: "ASC", id: "ASC" },
      take: RECOVERY_BATCH,
    });
    for (const attempt of overdue) {
      // Per-record isolation: one problematic attempt must not block the
      // other overdue attempts of this tick (or later ticks).
      try {
        const result: AgentResultV1 = {
          schemaVersion: "1",
          invocationId: attempt.invocationId,
          executionId: attempt.executionId,
          stepExecutionId: attempt.logicalStepId,
          status: "timed_out",
          error: {
            code: "DEADLINE_EXCEEDED",
            message: "Persisted attempt deadline exceeded",
            retryable: true,
          },
          // The persisted deadline, not the recovery tick time, makes the
          // synthetic result deterministic: every replica that times out the
          // same attempt produces the identical payload hash, so the inbox
          // deduplicates instead of recording a conflicting payload.
          completedAt: (attempt.deadlineAt ?? now).toISOString(),
        };
        const applied = await this.inbox.apply(result, {
          adapter: "recovery",
          receivedAt: now.toISOString(),
        });
        if (
          applied.disposition === "applied" ||
          applied.disposition === "duplicate"
        ) {
          await this.engine.reconcileExecution(applied.executionId, {
            projectTerminal: true,
          });
        }
      } catch (error) {
        console.warn("Deferred attempt deadline application", {
          attemptId: attempt.id,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  /**
   * Repairs crash windows that no worker result will ever close: executions
   * stuck PENDING (crash between creation and RUNNING), RUNNING executions
   * with materialized-but-unclaimed steps, and pre-materialization executions
   * that have no step rows at all. Terminal executions are never candidates,
   * so their historical nonterminal-looking rows cannot consume recovery
   * capacity. The keyset cursor keeps bounded scans fair across executions.
   */
  private async reconcileCandidateExecutions(now: Date): Promise<void> {
    const candidates = await this.findCandidates(now);
    for (const executionId of candidates) {
      // Per-execution error isolation: one bad execution must not permanently
      // block unrelated candidates in this or later batches.
      try {
        await this.engine.reconcileExecution(executionId);
      } catch (error) {
        console.warn("Deferred execution reconciliation", {
          executionId,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  private async findCandidates(now: Date): Promise<string[]> {
    const builder = this.executions
      .createQueryBuilder("execution")
      .select('execution."id"', "id")
      .addSelect('execution."createdAt"', "createdAt")
      .where('execution."status" IN (:...active)', {
        active: ["PENDING", "RUNNING"],
      })
      .andWhere('execution."activePlanRevisionId" IS NOT NULL')
      .andWhere(
        `(
          EXISTS (
            SELECT 1 FROM "step_executions" s
            WHERE s."executionId" = execution."id"
              AND (
                s."status" = 'PENDING'
                OR (s."status" = 'READY'
                    AND (s."eligibleAt" IS NULL OR s."eligibleAt" <= :now))
                OR (s."status" = 'RETRYING'
                    AND (s."nextAttemptAt" IS NULL OR s."nextAttemptAt" <= :now))
              )
          )
          OR NOT EXISTS (
            SELECT 1 FROM "step_executions" s
            WHERE s."executionId" = execution."id"
          )
          -- A RUNNING execution whose every step is already terminal needs
          -- completion detection (crash between the ResultInbox commit and
          -- resumeAfterResult); the engine completes it in one pass.
          OR NOT EXISTS (
            SELECT 1 FROM "step_executions" s
            WHERE s."executionId" = execution."id"
              AND s."status" NOT IN ('COMPLETED', 'FAILED', 'SKIPPED', 'CANCELLED')
          )
        )`,
        { now },
      )
      .orderBy('execution."createdAt"', "ASC")
      .addOrderBy('execution."id"', "ASC")
      .take(RECOVERY_BATCH);
    if (this.cursor) {
      builder.andWhere(
        '(execution."createdAt" > :cursorCreatedAt OR (execution."createdAt" = :cursorCreatedAt AND execution."id" > :cursorId))',
        {
          cursorCreatedAt: this.cursor.createdAt,
          cursorId: this.cursor.id,
        },
      );
    }
    const rows = await builder.getRawMany<{
      id: string;
      createdAt: string;
    }>();
    if (rows.length < RECOVERY_BATCH) {
      // The scan reached the end of the candidate set: wrap around next tick
      // so executions that became candidates later are visited again.
      this.cursor = undefined;
    } else {
      const last = rows[rows.length - 1];
      this.cursor = { createdAt: last.createdAt, id: last.id };
    }
    return rows.map((row) => row.id);
  }
}
