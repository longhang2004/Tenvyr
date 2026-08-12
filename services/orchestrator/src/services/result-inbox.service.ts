import type { AgentResultV1 } from "@tenvyr/contracts";
import type { JsonValue } from "@tenvyr/contracts";
import { Inject, Injectable } from "@nestjs/common";
import { DataSource, type EntityManager } from "typeorm";
import type { AgentTransportMetadata } from "../agent-adapters/agent-adapter.types";
import { sha256Json } from "../domain/canonical-json";
import {
  applyStatePatch,
  EXECUTION_STATE_BOUNDS,
  jsonValueUtf8Size,
  validateStatePatch,
  type ExecutionState,
  type ExecutionStatePatch,
} from "../domain/execution-state";
import {
  buildStateWritesPatch,
  StateWriteResolutionError,
  type StateWriteMapping,
} from "../domain/state-writes";
import { durableTransportIdentity } from "../domain/transport-identity";
import { ExecutionEntity } from "../entities/execution.entity";
import { ExecutionPlanRevisionEntity } from "../entities/execution-plan-revision.entity";
import { DispatchOutboxEntity } from "../entities/dispatch-outbox.entity";
import { ResultConflictEntity } from "../entities/result-conflict.entity";
import { ResultInboxEntity } from "../entities/result-inbox.entity";
import { ArtifactEntity } from "../entities/artifact.entity";
import { StateWriteEvidenceEntity } from "../entities/state-write-evidence.entity";
import { LogicalStepEntity } from "../entities/step-execution.entity";
import {
  StepAttemptEntity,
  type StepAttemptStatus,
} from "../entities/step-attempt.entity";
import { PlanProposalEntity } from "../entities/plan-proposal.entity";
import { DelegationObservationEntity } from "../entities/delegation-observation.entity";
import { DelegationObservationConflictEntity } from "../entities/delegation-observation-conflict.entity";
import { BudgetLedgerService } from "./budget-ledger.service";
import { PlanProposalService } from "./plan-proposal.service";
import { PipelineValidationService } from "./pipeline-validation.service";
import { ConditionEvaluatorService } from "./condition-evaluator.service";
import { usageFromResult, type UsageObservation } from "../domain/budget";

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

/** M2E controlled state-write outcome for one canonical successful result. */
type StateWriteApplication =
  | {
      disposition: "applied" | "noop";
      priorVersion: number;
      resultVersion: number;
      mappingHash: string;
      rejectionCode?: never;
    }
  | {
      disposition: "rejected";
      priorVersion: number;
      resultVersion: number;
      mappingHash?: never;
      rejectionCode: string;
    };

@Injectable()
export class ResultInboxService {
  constructor(
    @Inject("DATA_SOURCE") private readonly dataSource: DataSource,
    budgetLedger?: BudgetLedgerService,
    proposals?: PlanProposalService,
  ) {
    this.budgetLedger =
      budgetLedger ?? new BudgetLedgerService(this.dataSource);
    this.proposals =
      proposals ??
      new PlanProposalService(
        this.dataSource,
        new PipelineValidationService(new ConditionEvaluatorService()),
      );
  }

  private readonly budgetLedger: BudgetLedgerService;
  private readonly proposals: PlanProposalService;

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
        throw new Error(
          "Result inbox insertion did not produce a canonical row",
        );
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

      // The frozen plan revision is read under the execution lock so M2E can
      // apply pipeline-declared state writes in the same transaction (the
      // step config is the authoritative mapping source, never the result).
      const plan = await manager
        .getRepository(ExecutionPlanRevisionEntity)
        .findOne({
          where: { id: attempt.planRevisionId },
        });
      const stepConfig = plan?.plan.steps.find(
        (step) => step.id === logicalStep.stepId,
      );

      const terminalStatus = this.attemptStatus(result.status);

      // Terminal-outcome precedence runs BEFORE any state write: a late
      // result whose attempt already owns a different authoritative terminal
      // outcome (e.g. terminalized by the non-retryable dispatch path or a
      // supervision synthetic result) must never apply state — the conflict
      // disposition below commits nothing.
      if (TERMINAL_ATTEMPTS.includes(attempt.status)) {
        if (attempt.status !== terminalStatus) {
          inbox.status = "REJECTED";
          inbox.lastApplicationError =
            "A different terminal outcome is already authoritative";
          await inboxRepository.save(inbox);
          return { disposition: "conflict" };
        }
      }

      // M2E: pipeline-declared controlled state writes apply only to the
      // first canonical successful result, under the already-held execution
      // lock, using the pure M2B patch semantics (never a nested standalone
      // mutation transaction). A real change increments the semantic version
      // exactly once; a semantic no-op touches nothing.
      let stateWrite: StateWriteApplication | null = null;
      let effectiveTerminalStatus = terminalStatus;
      let postconditionFailure: string | null = null;
      // Once sibling work has made the execution terminal, this result stays
      // durable evidence but is late for mutation authority. It may settle its
      // own attempt/logical-step facts below; it cannot change ExecutionState.
      if (
        execution.status === "RUNNING" &&
        result.status === "succeeded" &&
        stepConfig?.stateWrites &&
        stepConfig.stateWrites.length > 0
      ) {
        stateWrite = await this.applyControlledStateWrites(
          manager,
          execution,
          stepConfig.stateWrites,
          result.output,
        );
        if (stateWrite.disposition === "rejected") {
          // Deterministic Tenvyr postcondition failure: the canonical result
          // stays evidence, no state key is applied, the attempt follows the
          // existing retry/onFailure policy, and transport redelivery can
          // never poison-loop (the inbox row becomes APPLIED below).
          effectiveTerminalStatus = "FAILED";
          postconditionFailure = `TENVYR_STATE_WRITE_REJECTED: ${stateWrite.rejectionCode}`;
        }
      }

      // M5-S3: a supervised Planner step's successful output is a bounded
      // PlanPatch — nothing more. It is persisted as a PENDING proposal
      // inside THIS transaction (the planner never receives execution
      // authority); an invalid patch is a deterministic Tenvyr rejection
      // that follows the step's retry/onFailure policy. The baseRevision is
      // pinned to the active revision by proposeWithManager.
      if (
        execution.status === "RUNNING" &&
        result.status === "succeeded" &&
        stepConfig?.planner &&
        postconditionFailure === null &&
        !TERMINAL_ATTEMPTS.includes(attempt.status)
      ) {
        try {
          await this.proposals.proposeWithManager(
            manager,
            execution.id,
            result.output,
            "planner",
          );
        } catch (error) {
          effectiveTerminalStatus = "FAILED";
          postconditionFailure = `PLANNER_PROPOSAL_INVALID: ${
            error instanceof Error ? error.message : String(error)
          }`;
        }
      }

      if (!TERMINAL_ATTEMPTS.includes(attempt.status)) {
        const transition = await manager
          .getRepository(StepAttemptEntity)
          .createQueryBuilder()
          .update(StepAttemptEntity)
          .set({
            status: effectiveTerminalStatus,
            terminalAt: new Date(),
            result: result.status === "succeeded" ? result.output : null,
            error: postconditionFailure ?? this.error(result),
            terminationReason:
              postconditionFailure ?? this.terminationReason(result),
          })
          .where("id = :id", { id: attempt.id })
          .andWhere("status NOT IN (:...terminal)", {
            terminal: TERMINAL_ATTEMPTS,
          })
          .execute();
        if (transition.affected !== 1) {
          throw new Error("Attempt terminal transition lost its guard");
        }

        // M4-S2: reconcile the attempt's budget reservations ONLY when THIS
        // result owns the terminal transition (affected === 1). A late
        // result for an attempt already terminalized elsewhere (e.g. a
        // non-retryable dispatch failure that released the reservation)
        // must never re-enter the ledger — its inbox row still becomes
        // APPLIED as duplicate evidence below.
        let usage: UsageObservation[] = [];
        try {
          usage = usageFromResult(result.usage);
        } catch (error) {
          console.warn("Result usage ignored as malformed", {
            invocationId: attempt.invocationId,
            reason: error instanceof Error ? error.message : String(error),
          });
        }
        await this.budgetLedger.reconcileTerminal(
          manager,
          attempt.invocationId,
          usage,
        );
      }

      // Retire any pending/leased delivery in the same transaction as the
      // terminal outcome. A late dispatcher receipt can no longer revive it.
      await manager
        .getRepository(DispatchOutboxEntity)
        .createQueryBuilder()
        .update(DispatchOutboxEntity)
        .set({ status: "COMPLETED", leaseExpiresAt: null, leaseToken: null })
        .where('"stepAttemptId" = :stepAttemptId', {
          stepAttemptId: attempt.id,
        })
        .andWhere("status IN (:...dispatchable)", {
          dispatchable: ["PENDING", "LEASED", "DISPATCHED"],
        })
        .execute();
      // Retry scheduling is only meaningful while the run is still live: a
      // late sibling outcome under an already-terminal execution must record
      // its step as terminal (FAILED) instead of RETRYING with a past
      // nextAttemptAt, which recovery would otherwise re-pick every tick.
      const retry =
        execution.status === "RUNNING" &&
        (effectiveTerminalStatus === "FAILED" ||
          effectiveTerminalStatus === "TIMED_OUT") &&
        stepConfig?.onFailure === "retry" &&
        attempt.attemptNumber < logicalStep.maxAttempts;
      logicalStep.status =
        effectiveTerminalStatus === "SUCCESS"
          ? "COMPLETED"
          : effectiveTerminalStatus === "CANCELLED"
            ? "CANCELLED"
            : retry
              ? "RETRYING"
              : "FAILED";
      logicalStep.output =
        effectiveTerminalStatus === "SUCCESS" ? result.output : null;
      logicalStep.error = postconditionFailure ?? this.error(result);
      logicalStep.endTime = retry ? null : new Date();
      logicalStep.nextAttemptAt = retry ? new Date() : null;
      await manager.getRepository(LogicalStepEntity).save(logicalStep);

      // The execution transition is guarded: once another step's outcome made
      // the run terminal (FAILED/CANCELLED/COMPLETED), a late result records
      // its own attempt/step facts but must never rewrite the terminal run
      // truth (e.g. a late `cancelled` outcome cannot turn a FAILED run into
      // a CANCELLED one).
      if (
        !retry &&
        logicalStep.status === "FAILED" &&
        stepConfig?.onFailure !== "continue"
      ) {
        if (!TERMINAL_EXECUTION_STATUSES.includes(execution.status)) {
          execution.status = "FAILED";
          execution.endTime = new Date();
          execution.terminationReason =
            postconditionFailure ?? this.error(result);
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

      // Durable artifact identity: one immutable Artifact row per canonical
      // descriptor, registered inside this transaction regardless of the
      // terminal outcome. The worker descriptor id stays opaque producer data;
      // identity is the inbox row + descriptor ordinal, and the canonical
      // descriptor hash is the stable descriptor projection. orIgnore() is
      // defense in depth — the pessimistic inbox lock above already serializes
      // identical deliveries, so a duplicate can never reach this insert.
      const descriptors = result.artifacts ?? [];
      if (descriptors.length > 0) {
        await manager
          .getRepository(ArtifactEntity)
          .createQueryBuilder()
          .insert()
          .into(ArtifactEntity)
          .values(
            descriptors.map((descriptor, descriptorOrdinal) => ({
              resultInboxId: inbox.id,
              descriptorOrdinal,
              descriptorHash: sha256Json(descriptor),
            })),
          )
          .orIgnore()
          .execute();
      }

      // M2E: append-only provenance for every canonical successful result
      // with configured state writes. The unique resultInboxId makes a
      // duplicate delivery unable to create a second row; no state/output
      // values are stored, only versions, the canonical mapping hash, and a
      // stable rejection code.
      if (stateWrite) {
        await manager
          .getRepository(StateWriteEvidenceEntity)
          .createQueryBuilder()
          .insert()
          .into(StateWriteEvidenceEntity)
          .values({
            executionId: execution.id,
            stepAttemptId: attempt.id,
            resultInboxId: inbox.id,
            priorVersion: stateWrite.priorVersion,
            resultVersion: stateWrite.resultVersion,
            disposition: stateWrite.disposition,
            mappingHash: stateWrite.mappingHash ?? null,
            rejectionCode: stateWrite.rejectionCode ?? null,
          })
          .orIgnore()
          .execute();
      }

      // M6-S1: OBSERVED-mode delegation evidence — inert, bounded,
      // hash-pinned rows correlated to THIS attempt, persisted in the same
      // transaction as the canonical result. Observations never schedule,
      // spend, cancel, or terminalize work. Identity is
      // (stepAttemptId, provider:childId): duplicates are idempotent
      // (orIgnore), a same-identity different-payload delivery is retained
      // in the conflict table, and the canonical row stays authoritative.
      const observations = result.delegation ?? [];
      if (observations.length > 0 && stepConfig?.delegation === "observed") {
        // Evidence is inert and failure-isolated: a persistence problem
        // must never roll back the canonical terminal transition (the
        // same precedent as usage reconciliation).
        try {
          const observationRepository = manager.getRepository(
            DelegationObservationEntity,
          );
          for (const observation of observations) {
            const observationHash = sha256Json(observation);
            const observationId = `${observation.provider}:${observation.childId}`;
            await observationRepository
              .createQueryBuilder()
              .insert()
              .into(DelegationObservationEntity)
              .values({
                stepAttemptId: attempt.id,
                invocationId: attempt.invocationId,
                executionId: attempt.executionId,
                observationId,
                provider: observation.provider,
                childId: observation.childId,
                payloadHash: observationHash,
                payload: observation,
                occurredAt: new Date(observation.assertedAt),
              })
              .orIgnore()
              .execute();
            const after = await observationRepository
              .createQueryBuilder("observation")
              .where('observation."stepAttemptId" = :stepAttemptId', {
                stepAttemptId: attempt.id,
              })
              .andWhere('observation."observationId" = :observationId', {
                observationId,
              })
              .getOne();
            if (after && after.payloadHash !== observationHash) {
              await manager
                .getRepository(DelegationObservationConflictEntity)
                .createQueryBuilder()
                .insert()
                .into(DelegationObservationConflictEntity)
                .values({
                  stepAttemptId: attempt.id,
                  executionId: attempt.executionId,
                  observationId,
                  payloadHash: observationHash,
                  payload: observation,
                  conflictKind: "identity_payload",
                })
                .orIgnore()
                .execute();
            }
          }
        } catch (error) {
          console.warn("Delegation observations ignored as malformed", {
            invocationId: attempt.invocationId,
            reason: error instanceof Error ? error.message : String(error),
          });
        }
      }

      inbox.status = "APPLIED";
      inbox.appliedAt = new Date();
      // A state-write rejection is authoritative evidence: the canonical
      // result is applied with a stable code, never retried by transport.
      inbox.lastApplicationError = postconditionFailure ?? null;
      await inboxRepository.save(inbox);
      return {
        disposition: "applied",
        executionId: attempt.executionId,
        stepId: logicalStep.stepId,
      };
    });
  }

  /**
   * M2E: apply pipeline-declared controlled state writes from a canonical
   * successful output under the already-held execution row lock, using the
   * pure M2B patch semantics. Never nests a standalone mutation transaction.
   *
   * - every mapping is required; the first missing pointer or non-JSON value
   *   rejects the whole write with a stable code and applies no keys;
   * - a semantic no-op changes no state, version, or timestamp;
   * - a real change increments the semantic version exactly once and updates
   *   the state timestamp;
   * - final-state bounds (64 KiB, 128 keys) are hard ceilings: a violation
   *   is a deterministic rejection, never a retry loop.
   */
  private async applyControlledStateWrites(
    manager: EntityManager,
    execution: ExecutionEntity,
    mappings: StateWriteMapping[],
    output: unknown,
  ): Promise<StateWriteApplication> {
    const priorVersion = execution.executionStateVersion;
    let patch: { set: Record<string, JsonValue> };
    try {
      patch = buildStateWritesPatch(output, mappings);
    } catch (error) {
      const code =
        error instanceof StateWriteResolutionError
          ? error.code
          : "TENVYR_STATE_WRITE_INVALID_PATCH";
      return {
        disposition: "rejected",
        priorVersion,
        resultVersion: priorVersion,
        rejectionCode: code,
      };
    }

    let validated: ExecutionStatePatch;
    try {
      validated = validateStatePatch({ set: patch.set });
    } catch {
      return {
        disposition: "rejected",
        priorVersion,
        resultVersion: priorVersion,
        rejectionCode: "TENVYR_STATE_WRITE_INVALID_PATCH",
      };
    }
    const mappingHash = sha256Json(validated);

    const applied = applyStatePatch(
      (execution.executionState ?? {}) as ExecutionState,
      validated,
    );
    if (!applied.changed) {
      return {
        disposition: "noop",
        priorVersion,
        resultVersion: priorVersion,
        mappingHash,
      };
    }

    let finalSize: number;
    try {
      finalSize = jsonValueUtf8Size(applied.state);
    } catch {
      return {
        disposition: "rejected",
        priorVersion,
        resultVersion: priorVersion,
        rejectionCode: "TENVYR_STATE_WRITE_UNSAFE_VALUE",
      };
    }
    if (
      finalSize > EXECUTION_STATE_BOUNDS.maxStateBytes ||
      Object.keys(applied.state).length > EXECUTION_STATE_BOUNDS.maxStateKeys
    ) {
      return {
        disposition: "rejected",
        priorVersion,
        resultVersion: priorVersion,
        rejectionCode: "TENVYR_STATE_WRITE_BOUNDS",
      };
    }

    // The execution row is already locked; state, semantic version, and the
    // state-specific timestamp commit atomically with the result application.
    execution.executionState = structuredClone(applied.state);
    execution.executionStateVersion = priorVersion + 1;
    execution.executionStateUpdatedAt = new Date();
    await manager.getRepository(ExecutionEntity).save(execution);
    return {
      disposition: "applied",
      priorVersion,
      resultVersion: priorVersion + 1,
      mappingHash,
    };
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
    return result.error
      ? `${result.error.code}: ${result.error.message}`
      : null;
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
    // Durable transport identity, shared with AgentEventService: the bounded
    // storage constraints (varchar columns) are encoded once in
    // durableTransportIdentity, and Kafka scopes are deterministically
    // bounded when a long topic would overflow.
    const identity = durableTransportIdentity(transport);
    return {
      adapter: identity.adapter,
      scope: identity.scope ?? undefined,
      messageId: identity.messageId ?? undefined,
    };
  }
}
