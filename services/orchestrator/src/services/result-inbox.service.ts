import type { AgentResultV1 } from "@tenvyr/contracts";
import { Inject, Injectable } from "@nestjs/common";
import { DataSource } from "typeorm";
import type { AgentTransportMetadata } from "../agent-adapters/agent-adapter.types";
import { sha256Json } from "../domain/canonical-json";
import { ExecutionEntity } from "../entities/execution.entity";
import { ExecutionPlanRevisionEntity } from "../entities/execution-plan-revision.entity";
import { DispatchOutboxEntity } from "../entities/dispatch-outbox.entity";
import { ResultConflictEntity } from "../entities/result-conflict.entity";
import { ResultInboxEntity } from "../entities/result-inbox.entity";
import { LogicalStepEntity } from "../entities/step-execution.entity";
import {
  StepAttemptEntity,
  type StepAttemptStatus,
} from "../entities/step-attempt.entity";

const TERMINAL_ATTEMPTS: StepAttemptStatus[] = [
  "SUCCESS",
  "FAILED",
  "TIMED_OUT",
  "CANCELLED",
];

const TERMINAL_EXECUTION_STATUSES: ExecutionEntity["status"][] = [
  "COMPLETED",
  "FAILED",
  "CANCELLED",
];

export type ResultApplication =
  | { disposition: "applied"; executionId: string; stepId: string }
  | { disposition: "duplicate"; executionId: string; stepId: string }
  | { disposition: "conflict" }
  | { disposition: "ignored" };

@Injectable()
export class ResultInboxService {
  constructor(@Inject("DATA_SOURCE") private readonly dataSource: DataSource) {}

  /**
   * The inbox row and authoritative terminal transition commit together. A
   * delivery that dies before commit is retried; a delivery after commit sees
   * the same invocationId and payload hash and becomes a no-op.
   */
  async apply(
    result: AgentResultV1,
    transport: AgentTransportMetadata,
  ): Promise<ResultApplication> {
    const payload = result as unknown as Record<string, unknown>;
    const payloadHash = sha256Json(payload);
    const source = this.source(transport);

    return this.dataSource.transaction(async (manager) => {
      const attempt = await manager
        .getRepository(StepAttemptEntity)
        .createQueryBuilder("attempt")
        .setLock("pessimistic_write")
        .where('attempt."invocationId" = :invocationId', {
          invocationId: result.invocationId,
        })
        .getOne();
      if (
        !attempt ||
        attempt.executionId !== result.executionId ||
        attempt.logicalStepId !== result.stepExecutionId
      ) {
        return { disposition: "ignored" };
      }

      const inboxRepository = manager.getRepository(ResultInboxEntity);
      await inboxRepository
        .createQueryBuilder()
        .insert()
        .into(ResultInboxEntity)
        .values({
          invocationId: result.invocationId,
          stepAttemptId: attempt.id,
          payloadHash,
          payload,
          sourceAdapter: source.adapter,
          sourceScope: source.scope,
          sourceMessageId: source.messageId,
          status: "RECEIVED",
          receivedAt: new Date(),
        })
        .orIgnore()
        .execute();
      const inbox = await inboxRepository
        .createQueryBuilder("inbox")
        .setLock("pessimistic_write")
        .where('inbox."invocationId" = :invocationId', {
          invocationId: result.invocationId,
        })
        .getOne();

      // The semantic identity is invocationId, but a reused transport receipt
      // must be audited rather than retried forever on its diagnostic unique
      // index. This path cannot become an authoritative inbox row.
      if (!inbox) {
        const transportInbox = source.messageId
          ? await inboxRepository
              .createQueryBuilder("transportInbox")
              .setLock("pessimistic_write")
              .where('transportInbox."sourceAdapter" = :sourceAdapter', {
                sourceAdapter: source.adapter,
              })
              .andWhere('transportInbox."sourceScope" = :sourceScope', {
                sourceScope: source.scope,
              })
              .andWhere('transportInbox."sourceMessageId" = :sourceMessageId', {
                sourceMessageId: source.messageId,
              })
              .getOne()
          : null;
        if (transportInbox) {
          await manager
            .getRepository(ResultConflictEntity)
            .createQueryBuilder()
            .insert()
            .into(ResultConflictEntity)
            .values({
              invocationId: result.invocationId,
              resultInboxId: transportInbox.id,
              payloadHash,
              payload,
              sourceAdapter: source.adapter,
              sourceScope: source.scope,
              sourceMessageId: source.messageId,
              receivedAt: new Date(),
            })
            .orIgnore()
            .execute();
          return { disposition: "conflict" };
        }
        throw new Error("Result inbox insertion did not produce a canonical row");
      }

      if (inbox.payloadHash !== payloadHash) {
        const conflictRepository = manager.getRepository(ResultConflictEntity);
        await conflictRepository
          .createQueryBuilder()
          .insert()
          .into(ResultConflictEntity)
          .values({
            invocationId: result.invocationId,
            resultInboxId: inbox.id,
            payloadHash,
            payload,
            sourceAdapter: source.adapter,
            sourceScope: source.scope,
            sourceMessageId: source.messageId,
            receivedAt: new Date(),
          })
          .orIgnore()
          .execute();
        return { disposition: "conflict" };
      }

      const logicalStep = await manager
        .getRepository(LogicalStepEntity)
        .createQueryBuilder("step")
        .setLock("pessimistic_write")
        .where('step."id" = :id', { id: attempt.logicalStepId })
        .getOneOrFail();
      if (inbox.status === "APPLIED") {
        return {
          disposition: "duplicate",
          executionId: attempt.executionId,
          stepId: logicalStep.stepId,
        };
      }

      const executionRepository = manager.getRepository(ExecutionEntity);
      const execution = await executionRepository
        .createQueryBuilder("execution")
        .setLock("pessimistic_write")
        .where('execution."id" = :id', { id: attempt.executionId })
        .getOneOrFail();
      if (execution.status === "CANCELLED") {
        inbox.status = "REJECTED";
        inbox.lastApplicationError =
          "Execution cancellation is already authoritative";
        await inboxRepository.save(inbox);
        return { disposition: "conflict" };
      }

      const terminalStatus = this.attemptStatus(result.status);
      if (TERMINAL_ATTEMPTS.includes(attempt.status)) {
        if (attempt.status !== terminalStatus) {
          inbox.status = "REJECTED";
          inbox.lastApplicationError = "A different terminal outcome is already authoritative";
          await inboxRepository.save(inbox);
          return { disposition: "conflict" };
        }
      } else {
        const transition = await manager
          .getRepository(StepAttemptEntity)
          .createQueryBuilder()
          .update(StepAttemptEntity)
          .set({
            status: terminalStatus,
            terminalAt: new Date(),
            result: result.status === "succeeded" ? result.output : null,
            error: this.error(result),
            terminationReason: this.terminationReason(result),
          })
          .where("id = :id", { id: attempt.id })
          .andWhere("status NOT IN (:...terminal)", {
            terminal: TERMINAL_ATTEMPTS,
          })
          .execute();
        if (transition.affected !== 1) {
          throw new Error("Attempt terminal transition lost its guard");
        }
      }

      // Retire any pending/leased delivery in the same transaction as the
      // terminal outcome. A late dispatcher receipt can no longer revive it.
      await manager
        .getRepository(DispatchOutboxEntity)
        .createQueryBuilder()
        .update(DispatchOutboxEntity)
        .set({ status: "COMPLETED", leaseExpiresAt: null, leaseToken: null })
        .where('"stepAttemptId" = :stepAttemptId', { stepAttemptId: attempt.id })
        .andWhere('status IN (:...dispatchable)', {
          dispatchable: ["PENDING", "LEASED", "DISPATCHED"],
        })
        .execute();

      const plan = await manager.getRepository(ExecutionPlanRevisionEntity).findOne({
        where: { id: attempt.planRevisionId },
      });
      const stepConfig = plan?.plan.steps.find((step) => step.id === logicalStep.stepId);
      // Retry scheduling is only meaningful while the run is still live: a
      // late sibling outcome under an already-terminal execution must record
      // its step as terminal (FAILED) instead of RETRYING with a past
      // nextAttemptAt, which recovery would otherwise re-pick every tick.
      const retry =
        execution.status === "RUNNING" &&
        (terminalStatus === "FAILED" || terminalStatus === "TIMED_OUT") &&
        stepConfig?.onFailure === "retry" &&
        attempt.attemptNumber < logicalStep.maxAttempts;
      logicalStep.status =
        terminalStatus === "SUCCESS"
          ? "COMPLETED"
          : terminalStatus === "CANCELLED"
            ? "CANCELLED"
            : retry
              ? "RETRYING"
              : "FAILED";
      logicalStep.output = result.status === "succeeded" ? result.output : null;
      logicalStep.error = this.error(result);
      logicalStep.endTime = retry ? null : new Date();
      logicalStep.nextAttemptAt = retry ? new Date() : null;
      await manager.getRepository(LogicalStepEntity).save(logicalStep);

      // The execution transition is guarded: once another step's outcome made
      // the run terminal (FAILED/CANCELLED/COMPLETED), a late result records
      // its own attempt/step facts but must never rewrite the terminal run
      // truth (e.g. a late `cancelled` outcome cannot turn a FAILED run into
      // a CANCELLED one).
      if (!retry && logicalStep.status === "FAILED" && stepConfig?.onFailure !== "continue") {
        if (!TERMINAL_EXECUTION_STATUSES.includes(execution.status)) {
          execution.status = "FAILED";
          execution.endTime = new Date();
          execution.terminationReason = this.error(result);
          await executionRepository.save(execution);
        }
      } else if (logicalStep.status === "CANCELLED") {
        if (!TERMINAL_EXECUTION_STATUSES.includes(execution.status)) {
          execution.status = "CANCELLED";
          execution.endTime = new Date();
          execution.terminationReason = this.terminationReason(result);
          await executionRepository.save(execution);
        }
      }

      inbox.status = "APPLIED";
      inbox.appliedAt = new Date();
      inbox.lastApplicationError = null;
      await inboxRepository.save(inbox);
      return {
        disposition: "applied",
        executionId: attempt.executionId,
        stepId: logicalStep.stepId,
      };
    });
  }

  private attemptStatus(status: AgentResultV1["status"]): StepAttemptStatus {
    switch (status) {
      case "succeeded":
        return "SUCCESS";
      case "cancelled":
        return "CANCELLED";
      case "timed_out":
        return "TIMED_OUT";
      default:
        return "FAILED";
    }
  }

  private error(result: AgentResultV1): string | null {
    return result.error ? `${result.error.code}: ${result.error.message}` : null;
  }

  private terminationReason(result: AgentResultV1): string | null {
    if (result.status === "cancelled") return "Worker cancelled the attempt";
    if (result.status === "timed_out") return "Worker reported a timeout";
    return this.error(result);
  }

  private source(transport: AgentTransportMetadata): {
    adapter: string;
    scope?: string;
    messageId?: string;
  } {
    if (transport.adapter === "kafka") {
      return {
        adapter: transport.adapter,
        scope:
          transport.topic !== undefined && transport.partition !== undefined
            ? `${transport.topic}:${transport.partition}`
            : undefined,
        messageId: transport.offset,
      };
    }
    return {
      adapter: transport.adapter,
      scope: transport.keyId,
      messageId: transport.deliveryId,
    };
  }
}
