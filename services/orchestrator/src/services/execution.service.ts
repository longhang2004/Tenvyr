import { Injectable, Inject } from "@nestjs/common";
import { DataSource, Repository } from "typeorm";
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
import { sha256Json } from "../domain/canonical-json";
import { ConditionEvaluatorService } from "./condition-evaluator.service";

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
  ) {}

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

      const attempt = await attemptRepository.save(
        attemptRepository.create({
          executionId,
          logicalStepId: logicalStep.id,
          planRevisionId: revision.id,
          attemptNumber,
          invocationId: `${logicalStep.id}:${attemptNumber}`,
          frozenSpecHash,
          inputSnapshot,
          contextSnapshot: null,
          executorSnapshot: { agent: stepConfig.agent },
          status: "CREATED",
          deadlineAt,
        }),
      );
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
            deadlineAt: deadlineAt?.toISOString(),
            trace: {
              traceId: executionId,
              correlationId: attempt.invocationId,
            },
            metadata: { orchestration: { maxAttempts } },
          },
        }),
      );
      return { disposition: "claimed", logicalStep, attempt };
    });
  }

  async createExecution(
    pipeline: PipelineEntity,
    input: unknown,
  ): Promise<ExecutionEntity> {
    return this.dataSource.transaction(async (manager) => {
      const executionRepository = manager.getRepository(ExecutionEntity);
      const planRepository = manager.getRepository(ExecutionPlanRevisionEntity);
      const plan = { schemaVersion: 1 as const, steps: pipeline.steps };
      const pipelineHash =
        pipeline.contentHash ||
        sha256Json({
          name: pipeline.name,
          version: pipeline.version,
          description: pipeline.description,
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
    });
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
    return this.dataSource.transaction(async (manager) => {
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
          .andWhere('status IN (:...dispatchable)', {
            dispatchable: ["PENDING", "LEASED", "DISPATCHED"],
          })
          .execute();
      }

      execution.status = "CANCELLED";
      execution.endTime = now;
      execution.terminationReason = reason;
      return executionRepository.save(execution);
    });
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
