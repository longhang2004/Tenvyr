import { Inject, Injectable } from "@nestjs/common";
import { DataSource, EntityManager, QueryFailedError } from "typeorm";
import { CoordinationIterationEntity } from "../entities/coordination-iteration.entity";
import { CoordinationRunEntity } from "../entities/coordination-run.entity";
import { LogicalStepEntity } from "../entities/step-execution.entity";
import { StepAttemptEntity } from "../entities/step-attempt.entity";
import type { StepAttemptStatus } from "../entities/step-attempt.entity";
import { ExecutionPlanRevisionEntity } from "../entities/execution-plan-revision.entity";
import { ExecutionEntity } from "../entities/execution.entity";
import { PlanProposalService } from "./plan-proposal.service";
import { PipelineValidationService } from "./pipeline-validation.service";
import { ConditionEvaluatorService } from "./condition-evaluator.service";
import { BudgetLedgerService } from "./budget-ledger.service";
import { BUDGET_DIMENSION_IDS } from "../domain/budget";
import { RuntimeConnectionService } from "./runtime-connection.service";
import {
  applyPhaseTransition,
  buildVerifierContext,
  canonicalDecisionHash,
  compileIterationPlanPatch,
  continueAllowed,
  CoordinationError,
  parseCoordinationConfig,
  parseTaskBatchProposal,
  parseVerifierDecision,
  TERMINAL_COORDINATION_PHASES,
  validateTaskBatchProposal,
  type CoordinationConfigV1,
  type CoordinationPhase,
  type TaskBatchProposalV1,
  type VerifierContextV1,
  type VerifierDecisionV1,
  type WorkerOutcomeSummaryV1,
} from "../domain/coordination";
import type { WorkerManifestEntryV1 } from "../entities/coordination-iteration.entity";
import type {
  AcceptanceEvidenceV1,
  WorkspaceSnapshotV1,
} from "../domain/workspace";

const TERMINAL_ATTEMPT_STATUSES: readonly StepAttemptStatus[] = [
  "SUCCESS",
  "FAILED",
  "TIMED_OUT",
  "CANCELLED",
];

/** Worker outcome status for the bounded aggregation. */
function attemptStatus(
  attempt: StepAttemptEntity | null,
): WorkerOutcomeSummaryV1["status"] {
  switch (attempt?.status) {
    case "SUCCESS":
      return "SUCCESS";
    case "FAILED":
      return "FAILED";
    case "TIMED_OUT":
      return "TIMED_OUT";
    case "CANCELLED":
      return "CANCELLED";
    default:
      return "FAILED";
  }
}

/** Explicit output selection source for the bounded aggregation; the
 *  per-field byte cap and truncation metadata live in
 *  `buildVerifierContext` (domain/coordination.ts). Raw logs/COT can
 *  never enter. */
function boundedFields(result: unknown): Record<string, unknown> {
  if (result === null || typeof result !== "object" || Array.isArray(result)) {
    return {};
  }
  const fields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(
    result as Record<string, unknown>,
  )) {
    if (key === "artifactRefs") continue;
    fields[key] = value;
  }
  return fields;
}

/** Bounded artifact references from the worker output; never bytes. */
function boundedArtifactRefs(result: unknown): string[] {
  if (result === null || typeof result !== "object" || Array.isArray(result)) {
    return [];
  }
  const refs = (result as Record<string, unknown>).artifactRefs;
  if (!Array.isArray(refs)) return [];
  return refs
    .filter((ref): ref is string => typeof ref === "string")
    .slice(0, 64);
}

export type CoordinationRunErrorCode =
  | "RUN_NOT_FOUND"
  | "ITERATION_NOT_FOUND"
  | "DECISION_CONFLICT"
  | "DECISION_STALE"
  | "RUN_ALREADY_EXISTS"
  | "PLANNER_BASE_REVISION_MISMATCH";

export class CoordinationRunError extends Error {
  readonly code: CoordinationRunErrorCode;

  constructor(code: CoordinationRunErrorCode, message: string) {
    super(message);
    this.name = "CoordinationRunError";
    this.code = code;
  }
}

export type ConsumeDecisionOutcome =
  | { outcome: "consumed"; phase: CoordinationPhase }
  | { outcome: "idempotent"; phase: CoordinationPhase }
  | { outcome: "conflict"; phase: CoordinationPhase };

/**
 * M9-S2: minimal durable Coordinator authority.
 *
 * Lock order (documented, deterministic): the CoordinationRun row is locked
 * FIRST (pessimistic write), then the iteration row, then existing records.
 * Every phase transition and iteration creation happens under that lock, so
 * N racing replicas delivering the same decision serialize: the first
 * consumes it and creates the next iteration; the rest observe the consumed
 * decision (idempotent) or a conflicting payload (conflict, nothing
 * changes). The UNIQUE (run, iterationNumber) constraint and the guarded
 * `decisionHash IS NULL` update backstop the lock at the database level.
 * Recovery reads PostgreSQL only; no process-local state is loop truth.
 */
@Injectable()
export class RuntimeCoordinationService {
  constructor(
    @Inject("DATA_SOURCE") private readonly dataSource: DataSource,
    planProposals?: PlanProposalService,
    budgets?: BudgetLedgerService,
    connections?: RuntimeConnectionService,
  ) {
    this.planProposals =
      planProposals ??
      new PlanProposalService(
        this.dataSource,
        new PipelineValidationService(new ConditionEvaluatorService()),
      );
    this.budgets = budgets ?? new BudgetLedgerService(this.dataSource);
    this.connections =
      connections ?? new RuntimeConnectionService(this.dataSource);
  }

  private readonly planProposals: PlanProposalService;
  private readonly budgets: BudgetLedgerService;
  private readonly connections: RuntimeConnectionService;

  /** Creates the one-to-one run. Idempotent: an existing run for the same
   *  execution is returned unchanged (at-least-once start), and concurrent
   *  equivalent starts converge on exactly one run. All authority checks
   *  (role connection claims + executor allowlist) run inside the create
   *  transaction — the manager-aware path enforces the same invariants. */
  async startRun(
    executionId: string,
    config: CoordinationConfigV1,
    loopDeadlineAt: Date,
    workspace?: WorkspaceSnapshotV1 | null,
    acceptanceEvidence?: AcceptanceEvidenceV1 | null,
  ): Promise<CoordinationRunEntity> {
    const parsed = parseCoordinationConfig(config);
    return this.dataSource.transaction((manager) =>
      this.startRunWithManager(
        manager,
        executionId,
        parsed,
        loopDeadlineAt,
        workspace,
        acceptanceEvidence,
      ),
    );
  }

  /**
   * P1/M9 + M10: manager-passable start — caller-owned transactions compose
   * authority atomically (Workbench audit + run creation commit together).
   *
   * Enforces the FULL run-creation authority chain under the caller's
   * transaction, exactly like the standalone path:
   *   1. freeze the parsed team config;
   *   2. claim the Planner connection (manager-aware, revoked => deny);
   *   3. claim the Verifier connection (manager-aware, revoked => deny);
   *   4. verify the Planner executor is in the frozen allowlist;
   *   5. verify the Verifier executor is in the frozen allowlist;
   *   6. the claims above resolve immutable connection revisions — their
   *      identity is frozen for the run's role steps;
   *   7. create the CoordinationRun (one per execution).
   *
   * Concurrent idempotency: the execution row is locked FOR UPDATE first, so
   * N equivalent concurrent starts serialize; the loser re-reads the winner's
   * run and converges on it. The DB unique constraint
   * (UQ_coordination_run_execution) remains the backstop; a leaked 23505 is
   * translated into a re-read, never surfaced as a raw unique violation.
   */
  async startRunWithManager(
    manager: EntityManager,
    executionId: string,
    config: CoordinationConfigV1,
    loopDeadlineAt: Date,
    workspace?: WorkspaceSnapshotV1 | null,
    acceptanceEvidence?: AcceptanceEvidenceV1 | null,
  ): Promise<CoordinationRunEntity> {
    const parsed = parseCoordinationConfig(config);
    const runs = manager.getRepository(CoordinationRunEntity);

    // Authority chain BEFORE run materialization (manager-aware claims).
    await this.assertRoleConnectionsClaimable(parsed, manager);
    await this.assertRoleExecutorsAllowed(parsed, manager);

    // Linearize concurrent starts on the execution authority row.
    const executionRepository = manager.getRepository(ExecutionEntity);
    const execution = await executionRepository
      .createQueryBuilder("execution")
      .setLock("pessimistic_write")
      .where('execution."id" = :id', { id: executionId })
      .getOne();
    if (!execution) {
      throw new CoordinationRunError(
        "RUN_NOT_FOUND",
        `Execution "${executionId}" does not exist; cannot start a coordination run`,
      );
    }
    const existing = await runs.findOne({ where: { executionId } });
    if (existing) return existing;
    try {
      return await runs.save(
        runs.create({
          executionId,
          config: parsed,
          workspace: workspace ?? null,
          acceptanceEvidence: acceptanceEvidence ?? null,
          phase: "PLANNING",
          currentIterationNumber: 0,
          cumulativeWorkers: 0,
          loopDeadlineAt,
          version: 1,
        }),
      );
    } catch (error) {
      // A concurrent start that bypassed the row lock (or a retry after a
      // commit race) surfaces as a unique violation: converge on the winner.
      if (isUniqueViolation(error)) {
        const winner = await runs.findOne({ where: { executionId } });
        if (winner) return winner;
      }
      throw error;
    }
  }

  /** M9-S5: run-level wall-clock budget exhaustion. */
  private deadlineExceeded(run: CoordinationRunEntity): boolean {
    return Date.now() > run.loopDeadlineAt.getTime();
  }

  /** M9-S5/S7: run-level budget account exhaustion, DIMENSION-CORRECT.
   *  The account is exhausted only when EVERY canonical dimension has zero
   *  remaining availability (per-dimension projection from the existing
   *  ledger). Workers reserve specific dimensions; a batch that could
   *  still reserve on a dimension with remaining budget is NOT stopped by
   *  a different exhausted dimension. No account configured = no gate. */
  private async budgetExhausted(run: CoordinationRunEntity): Promise<boolean> {
    if (!run.config.budgetAccountId) return false;
    try {
      const { available } = await this.budgets.projection(
        run.config.budgetAccountId,
      );
      return BUDGET_DIMENSION_IDS.every(
        (dimension) => (available[dimension] ?? 0) <= 0,
      );
    } catch {
      // Missing account is a deterministic stop, not an open loop.
      return true;
    }
  }

  /** M9-S7: REAL bounded remaining-budget facts for the Verifier context,
   *  projected from the ledger at aggregation time. */
  private async remainingBudget(run: CoordinationRunEntity): Promise<{
    accountId: string;
    remaining: Record<string, number>;
  }> {
    const accountId = run.config.budgetAccountId!;
    try {
      const { available } = await this.budgets.projection(accountId);
      const remaining: Record<string, number> = {};
      for (const dimension of BUDGET_DIMENSION_IDS) {
        remaining[dimension] = Math.max(0, available[dimension] ?? 0);
      }
      return { accountId, remaining };
    } catch {
      // The account vanished: the honest fact is zero remaining.
      const remaining: Record<string, number> = {};
      for (const dimension of BUDGET_DIMENSION_IDS) {
        remaining[dimension] = 0;
      }
      return { accountId, remaining };
    }
  }

  /**
   * M9-S5: M8 revocation gate at batch validation — a batch may only admit
   * workers whose selected connections are currently claimable (REVOKED
   * denies). Agent-only tasks are unaffected.
   */
  private async assertConnectionsClaimable(
    proposal: TaskBatchProposalV1,
    manager?: EntityManager,
  ): Promise<void> {
    for (const task of proposal.tasks) {
      if (!task.connectionId) continue;
      try {
        if (manager) {
          await this.connections.claimRevisionWithManager(
            manager,
            task.connectionId,
          );
        } else {
          await this.connections.claimRevision(task.connectionId);
        }
      } catch (error) {
        throw new CoordinationError(
          "CONNECTION_NOT_ALLOWED",
          `task "${task.taskId}" selects revoked or missing connection "${task.connectionId}"`,
        );
      }
    }
  }

  /**
   * M8-S6/M9-S7: allowedExecutors gate at batch admission. Every task's
   * resolved executor identity must be in the frozen allowlist:
   * - connection-kind task -> the connection revision's operator-declared
   *   executorId (e.g. "local-host");
   * - agent-kind task -> the static transport executor (`agent:<name>`).
   * A task outside the allowlist is rejected before anything is proposed.
   */
  private async assertExecutorsAllowed(
    config: CoordinationConfigV1,
    proposal: TaskBatchProposalV1,
    manager?: EntityManager,
  ): Promise<void> {
    for (const task of proposal.tasks) {
      const executorId = task.connectionId
        ? (manager
            ? await this.connections.claimRevisionWithManager(
                manager,
                task.connectionId,
              )
            : await this.connections.claimRevision(task.connectionId)
          ).profile.executorId
        : `agent:${task.agent}`;
      if (!config.allowedExecutors.includes(executorId)) {
        throw new CoordinationError(
          "EXECUTOR_NOT_ALLOWED",
          `task "${task.taskId}" selects executor "${executorId}" outside the frozen allowlist`,
        );
      }
    }
  }

  /** M8-S6: Planner/Verifier connections must stay claimable when the
   *  loop resumes (WAIT approval, CONTINUE) — a revoked role connection
   *  denies the next iteration deterministically. */
  private async assertRoleConnectionsClaimable(
    config: CoordinationConfigV1,
    manager?: EntityManager,
  ): Promise<void> {
    const selections = [config.planner, config.verifier];
    for (const selection of selections) {
      if (selection.kind !== "connection") continue;
      try {
        if (manager) {
          await this.connections.claimRevisionWithManager(
            manager,
            selection.name,
          );
        } else {
          await this.connections.claimRevision(selection.name);
        }
      } catch {
        throw new CoordinationError(
          "CONNECTION_NOT_ALLOWED",
          `Role connection "${selection.name}" is revoked or missing`,
        );
      }
    }
  }

  /**
   * P1/M9: the frozen allowedExecutors gates the Planner and Verifier
   * selections exactly like worker tasks — before ANY materialization.
   * - connection-kind role -> the CURRENT revision's operator-declared
   *   executorId (a rotated revision can move the role outside the
   *   allowlist, so this is rechecked at CONTINUE and WAIT approval);
   * - agent-kind role -> `agent:<name>` (the step agent's transport
   *   executor identity, mirroring task semantics).
   */
  private async assertRoleExecutorsAllowed(
    config: CoordinationConfigV1,
    manager?: EntityManager,
  ): Promise<void> {
    const selections = [config.planner, config.verifier];
    for (const selection of selections) {
      if (selection.kind === "connection") {
        let executorId: string;
        try {
          const revision = manager
            ? await this.connections.claimRevisionWithManager(
                manager,
                selection.name,
              )
            : await this.connections.claimRevision(selection.name);
          executorId = revision.profile.executorId;
        } catch (error) {
          if (error instanceof CoordinationError) throw error;
          throw new CoordinationError(
            "EXECUTOR_NOT_ALLOWED",
            `Role connection "${selection.name}" is unavailable for executor allowlist validation`,
          );
        }
        if (!config.allowedExecutors.includes(executorId)) {
          throw new CoordinationError(
            "EXECUTOR_NOT_ALLOWED",
            `Role "${selection.name}" selects executor "${executorId}" outside the frozen allowlist`,
          );
        }
      } else {
        const executorId = `agent:${selection.name}`;
        if (!config.allowedExecutors.includes(executorId)) {
          throw new CoordinationError(
            "EXECUTOR_NOT_ALLOWED",
            `Role "${selection.name}" selects executor "${executorId}" outside the frozen allowlist`,
          );
        }
      }
    }
  }

  /**
   * M9-S3: creates the Coordinator-owned Planner step for the active
   * iteration via the existing PlanPatch/proposal/activation authority
   * (planner: true, fixed agent from the frozen config — the Planner can
   * never add Planner steps). Idempotent per iteration. Returns the
   * Planner step id.
   *
   * M8-S6: a connection-kind Planner selection records the typed
   * connection on the step; the claim freezes exactly that connection's
   * revision. A revoked/missing planner connection denies loop start.
   */
  async createPlannerStep(runId: string): Promise<string> {
    return this.dataSource.transaction(async (manager) => {
      const run = await lockRun(manager, runId);
      if (run.phase !== "PLANNING") {
        throw new CoordinationRunError(
          "RUN_NOT_FOUND",
          `Coordination run "${runId}" is not in PLANNING`,
        );
      }
      const iterationNumber = run.currentIterationNumber;
      const plannerStepId = `planner-${iterationNumber}`;
      const iterations = manager.getRepository(CoordinationIterationEntity);
      const iteration = await iterations.findOne({
        where: { coordinationRunId: runId, iterationNumber },
      });
      if (!iteration) {
        throw new CoordinationRunError(
          "ITERATION_NOT_FOUND",
          `Iteration ${iterationNumber} does not exist for run "${runId}"`,
        );
      }
      if (iteration.plannerStepId === plannerStepId) {
        return plannerStepId; // idempotent
      }
      // M9-S8: the planner runs against the revision THIS activation creates
      // (active + 1). The planner's TaskBatchProposal.baseRevision must equal
      // that frozen revision; the input carries it so a truthful planner can
      // echo it, and admission verifies it — never silently rebased.
      const executionRepository = manager.getRepository(ExecutionEntity);
      const executionRow = await executionRepository
        .createQueryBuilder("execution")
        .setLock("pessimistic_write")
        .where('execution."id" = :id', { id: run.executionId })
        .getOne();
      const activeRevisionNumber = executionRow?.activePlanRevisionId
        ? ((
            await manager
              .getRepository(ExecutionPlanRevisionEntity)
              .findOne({ where: { id: executionRow.activePlanRevisionId } })
          )?.revisionNumber ?? 1)
        : 1;
      const plannerFrozenRevision = activeRevisionNumber + 1;
      const step: Record<string, unknown> = {
        id: plannerStepId,
        // M8-S6: connection-kind Planner routes through its declared
        // routing agent (the executor host's transport key).
        agent: run.config.planner.agent ?? run.config.planner.name,
        input: { iterationNumber, planRevision: plannerFrozenRevision },
        onFailure: "stop",
      };
      if (run.config.planner.kind === "connection") {
        // The selected connection must be claimable NOW — a revoked
        // planner connection denies loop start deterministically.
        try {
          await this.connections.claimRevisionWithManager(
            manager,
            run.config.planner.name,
          );
        } catch {
          throw new CoordinationError(
            "CONNECTION_NOT_ALLOWED",
            `Planner connection "${run.config.planner.name}" is revoked or missing`,
          );
        }
        step.metadata = { tenvyrConnectionId: run.config.planner.name };
        // P2: freeze the operator-selected Planner model on the step; the
        // attempt claim then freezes exactly this model.
        if (run.config.plannerTarget?.modelId !== undefined) {
          (step.metadata as Record<string, unknown>).tenvyrModelId =
            run.config.plannerTarget.modelId;
        }
      }
      const patch = {
        schemaVersion: 1 as const,
        // The Planner-step activation applies on the CURRENT active revision
        // (the execution row lock is held): the proposal CAS stays the
        // authority and any concurrent activation makes this STALE.
        baseRevision: activeRevisionNumber,
        operations: [
          {
            op: "addStep" as const,
            // NOT `planner: true`: the M5 result-inbox would intercept the
            // planner's TaskBatchProposalV1 output as a PlanPatch. M9 batch
            // recursion is guarded in validateTaskBatchProposal (the batch
            // can never select the Planner or Verifier agent).
            step,
          },
        ],
      };
      const proposal = await this.planProposals.proposeWithManager(
        manager,
        run.executionId,
        patch,
        "coordinator",
      );
      const outcome = await this.planProposals.activateWithManager(
        manager,
        proposal.id,
      );
      if (outcome.decision !== "ACCEPTED") {
        throw new CoordinationRunError(
          "RUN_NOT_FOUND",
          `Planner step activation decided ${outcome.decision}: ${outcome.reason}`,
        );
      }
      iteration.plannerStepId = plannerStepId;
      await iterations.save(iteration);
      return plannerStepId;
    });
  }

  /**
   * M9-S3: Coordinator validates the untrusted Planner batch, compiles it
   * plus the Coordinator-owned Verifier step into the restricted PlanPatch,
   * activates the new immutable plan revision through the existing
   * proposal authority, and atomically binds the iteration manifest,
   * counters, and phase (PLANNING -> BATCH_VALIDATION -> WORKING). Planner
   * rejection is bounded failure evidence — no partial materialization.
   */
  async submitIterationBatch(input: {
    runId: string;
    iterationNumber: number;
    proposal: TaskBatchProposalV1;
    plannerAttemptId: string;
  }): Promise<
    | { outcome: "ACCEPTED" | "PENDING"; revisionNumber: number }
    | { outcome: "LIMIT_REACHED" | "FAILED"; revisionNumber: 0 }
  > {
    const parsed = parseTaskBatchProposal(input.proposal);
    return this.dataSource.transaction(async (manager) => {
      const run = await lockRun(manager, input.runId);
      if (run.phase !== "PLANNING") {
        throw new CoordinationRunError(
          "RUN_NOT_FOUND",
          `Coordination run "${input.runId}" is not in PLANNING`,
        );
      }
      // M9-S8: EXACT iteration identity. Admission is only valid for the
      // CURRENT iteration: older iterations (already consumed) and future
      // iterations (not yet authorized) are rejected deterministically.
      if (input.iterationNumber !== run.currentIterationNumber) {
        throw new CoordinationRunError(
          "ITERATION_NOT_FOUND",
          `Iteration ${input.iterationNumber} is not the current iteration ${run.currentIterationNumber} of run "${input.runId}"`,
        );
      }
      // M9 closure: EXACT iteration identity on the PROPOSAL payload too.
      // The untrusted Planner proposal embeds its own iterationNumber and
      // must name the CURRENT iteration — an older or future iteration is
      // rejected deterministically with the same bounded evidence as the
      // caller-declared identity, before any worker/verifier materialization
      // and before any plan revision can be created from the batch.
      if (parsed.iterationNumber !== run.currentIterationNumber) {
        throw new CoordinationRunError(
          "ITERATION_NOT_FOUND",
          `Proposal iterationNumber ${parsed.iterationNumber} does not match the current iteration ${run.currentIterationNumber} of run "${input.runId}"`,
        );
      }
      // Hard bounds + allowlist + no Planner/Verifier selection.
      validateTaskBatchProposal(run.config, parsed, run.cumulativeWorkers);
      // M9-S5/S7 authority rechecks at admission: wall-clock budget, run-level
      // budget account, M8 connection availability, and the frozen executor
      // allowlist.
      if (this.deadlineExceeded(run) || (await this.budgetExhausted(run))) {
        run.phase = applyPhaseTransition(run.phase, "limitReached");
        run.version += 1;
        await manager.getRepository(CoordinationRunEntity).save(run);
        return { outcome: "LIMIT_REACHED", revisionNumber: 0 };
      }
      await this.assertConnectionsClaimable(parsed, manager);
      await this.assertExecutorsAllowed(run.config, parsed, manager);

      const iterations = manager.getRepository(CoordinationIterationEntity);
      const iteration = await iterations.findOne({
        where: {
          coordinationRunId: input.runId,
          iterationNumber: input.iterationNumber,
        },
      });
      if (!iteration) {
        throw new CoordinationRunError(
          "ITERATION_NOT_FOUND",
          `Iteration ${input.iterationNumber} does not exist for run "${input.runId}"`,
        );
      }

      // M9-S8: Planner attempt ownership. The referenced StepAttempt must be
      // the SUCCESSFUL terminal attempt of THIS run's Coordinator-owned
      // Planner step (same execution, same iteration) — an arbitrary
      // unrelated attempt id is never accepted as Planner authority.
      let plannerAttempt: {
        attempt: StepAttemptEntity;
        frozenRevisionNumber: number;
      };
      try {
        plannerAttempt = await this.verifyPlannerAttempt(
          manager,
          run,
          iteration,
          input.plannerAttemptId,
        );
      } catch (error) {
        if (error instanceof CoordinationRunError) {
          return this.failStaleBatch(manager, run, {
            code: "PLANNER_ATTEMPT_INVALID",
            reason: error.message,
          });
        }
        throw error;
      }

      // M9-S8: strict base revision. The proposal's baseRevision must equal
      // the revision the Planner attempt was frozen on — it is never
      // silently rewritten to whatever happens to be active on arrival.
      if (parsed.baseRevision !== plannerAttempt.frozenRevisionNumber) {
        return this.failStaleBatch(manager, run, {
          code: "PLANNER_BASE_REVISION_MISMATCH",
          reason: `Planner proposal baseRevision ${parsed.baseRevision} does not match the Planner attempt's frozen revision ${plannerAttempt.frozenRevisionNumber}`,
        });
      }
      // M9 closure: the active-revision check is AUTHORITATIVE only under
      // the execution row lock. The lock is acquired HERE — before the
      // check — and held through proposal creation and activation (the
      // re-lock inside proposeWithManager/activateWithManager is a no-op
      // on the same transaction). An authorized PlanPatch activating N+1
      // can therefore never interleave between this check and the
      // proposal's base-revision pin: either this batch linearizes first
      // and keeps its frozen base N, or the other activation wins first
      // and this batch is deterministically STALE. A Planner result
      // produced against N is never silently proposed/activated against
      // N+1.
      const executionRow = await manager
        .getRepository(ExecutionEntity)
        .createQueryBuilder("execution")
        .setLock("pessimistic_write")
        .where('execution."id" = :id', { id: run.executionId })
        .getOne();
      if (!executionRow?.activePlanRevisionId) {
        throw new CoordinationRunError(
          "RUN_NOT_FOUND",
          `Execution "${run.executionId}" has no active plan revision`,
        );
      }
      const activeRevision = await manager
        .getRepository(ExecutionPlanRevisionEntity)
        .findOne({ where: { id: executionRow.activePlanRevisionId } });
      if (!activeRevision) {
        throw new CoordinationRunError(
          "RUN_NOT_FOUND",
          `Execution "${run.executionId}" active plan revision is missing`,
        );
      }
      if (activeRevision.revisionNumber !== parsed.baseRevision) {
        return this.failStaleBatch(manager, run, {
          code: "PLANNER_BASE_STALE",
          reason: `Planner proposal baseRevision ${parsed.baseRevision} is stale: active plan revision is ${activeRevision.revisionNumber}`,
        });
      }

      const { patch, verifierStepId } = compileIterationPlanPatch(
        run.config,
        parsed,
        input.iterationNumber,
        run.workspace ?? undefined,
      );
      // M9-S7: EXACT pending proposal identity. When a previous activation
      // was intercepted (policy REQUIRE_APPROVAL), its durable proposal id
      // is persisted on the iteration. Reconciliation re-activates THAT
      // SAME proposal — never a new one — so approval binds the same
      // proposal exactly once and no proposal storm can form.
      let proposalId = iteration.pendingPlanProposalId ?? null;
      if (!proposalId) {
        const proposal = await this.planProposals.proposeWithManager(
          manager,
          run.executionId,
          patch,
          "planner",
        );
        proposalId = proposal.id;
      }
      const outcome = await this.planProposals.activateWithManager(
        manager,
        proposalId,
      );
      if (outcome.decision !== "ACCEPTED") {
        if (outcome.decision === "PENDING") {
          // Approval required: persist the exact proposal identity so the
          // next reconcile/approve resumes THIS proposal, exactly once.
          iteration.pendingPlanProposalId = proposalId;
          await iterations.save(iteration);
          return { outcome: "PENDING", revisionNumber: 0 };
        }
        // REJECTED (policy deny) or STALE (base revision moved): the batch
        // is deterministically terminal — bounded failure evidence, no
        // partial materialization and no retry loop. The run AND its
        // execution fail together (the engine's step-failure net cannot
        // fire here: the planner step succeeded, nothing else exists).
        return this.failStaleBatch(manager, run, {
          code: outcome.decision,
          reason: outcome.reason,
        });
      }

      const revision = await manager
        .getRepository(ExecutionPlanRevisionEntity)
        .findOne({
          where: { executionId: run.executionId },
          order: { revisionNumber: "DESC" },
        });
      if (!revision) {
        throw new CoordinationRunError(
          "RUN_NOT_FOUND",
          "Activated revision is missing",
        );
      }

      // Bind the iteration: frozen proposal, planner attempt, revision,
      // worker manifest (taskId -> materialized LogicalStep id). The
      // pending marker is cleared: this proposal is now consumed.
      const manifest: WorkerManifestEntryV1[] = [];
      const stepRows = await manager.getRepository(LogicalStepEntity).find({
        where: { executionId: run.executionId },
      });
      const stepIdToRow = new Map(stepRows.map((row) => [row.stepId, row]));
      for (const task of parsed.tasks) {
        const row = stepIdToRow.get(task.taskId);
        if (!row) {
          throw new CoordinationRunError(
            "RUN_NOT_FOUND",
            `Materialized step "${task.taskId}" is missing after activation`,
          );
        }
        manifest.push({
          taskId: task.taskId,
          logicalStepId: row.id,
          required: task.required,
        });
      }
      iteration.plannerProposal = parsed;
      iteration.plannerAttemptId = input.plannerAttemptId;
      iteration.acceptedPlanRevisionId = revision.id;
      iteration.workerManifest = manifest;
      iteration.verifierStepId = verifierStepId;
      iteration.pendingPlanProposalId = null;
      await iterations.save(iteration);

      run.cumulativeWorkers += parsed.tasks.length;
      run.phase = applyPhaseTransition(run.phase, "plannerProposed");
      run.phase = applyPhaseTransition(run.phase, "batchValidated");
      run.version += 1;
      await manager.getRepository(CoordinationRunEntity).save(run);
      return { outcome: "ACCEPTED", revisionNumber: revision.revisionNumber };
    });
  }

  /** M9-S4: is the given logical step a Coordinator-owned Verifier step? */
  async isVerifierStep(executionId: string, stepId: string): Promise<boolean> {
    const run = await this.dataSource
      .getRepository(CoordinationRunEntity)
      .findOne({ where: { executionId }, select: ["id"] });
    if (!run) return false;
    const iteration = await this.dataSource
      .getRepository(CoordinationIterationEntity)
      .findOne({
        where: { coordinationRunId: run.id, verifierStepId: stepId },
        select: ["id"],
      });
    return iteration !== null;
  }

  /**
   * M9-S4: builds the bounded Verifier aggregation at claim time (the
   * attempt freezes it; later outcomes can never change a frozen input).
   * Explicit selection only: worker status/failure codes, bounded
   * summaries, per-field-capped output, bounded artifact refs, limits,
   * and the prior decision — never raw logs, chain of thought, or secrets.
   */
  async buildVerifierInput(
    executionId: string,
    stepId: string,
  ): Promise<VerifierContextV1> {
    const { run, iterations } = await this.recoverRun(executionId);
    const iteration = iterations.find(
      (candidate) => candidate.verifierStepId === stepId,
    );
    if (!iteration) {
      throw new CoordinationRunError(
        "ITERATION_NOT_FOUND",
        `No iteration owns verifier step "${stepId}"`,
      );
    }
    const workers: WorkerOutcomeSummaryV1[] = [];
    for (const entry of iteration.workerManifest) {
      const step = await this.dataSource
        .getRepository(LogicalStepEntity)
        .findOne({ where: { id: entry.logicalStepId } });
      const attempt = step ? await this.terminalAttempt(step.id) : null;
      const outcome: WorkerOutcomeSummaryV1 = {
        taskId: entry.taskId,
        status: attemptStatus(attempt),
        ...(attempt?.error ? { failureCode: attempt.error.slice(0, 255) } : {}),
        ...(attempt?.result !== null && attempt?.result !== undefined
          ? { selectedFields: boundedFields(attempt.result) }
          : {}),
        artifactRefs: boundedArtifactRefs(attempt?.result),
      };
      workers.push(outcome);
    }
    const prior = iterations
      .filter(
        (candidate) =>
          candidate.iterationNumber < iteration.iterationNumber &&
          candidate.decision !== null,
      )
      .sort((left, right) => right.iterationNumber - left.iterationNumber)[0];
    const remainingDeadlineMs = Math.max(
      0,
      run.loopDeadlineAt.getTime() - Date.now(),
    );
    return buildVerifierContext({
      iterationId: iteration.id,
      iterationNumber: iteration.iterationNumber,
      workers,
      executionStateKeys: {},
      ...(prior?.decision
        ? {
            priorDecision: {
              action: prior.decision.action,
              reason: prior.decision.reason,
            },
          }
        : {}),
      limits: {
        maxIterations: run.config.maxIterations,
        maxTotalWorkers: run.config.maxTotalWorkers,
        cumulativeWorkers: run.cumulativeWorkers,
        remainingDeadlineMs,
        ...(run.config.budgetAccountId
          ? { remainingBudget: await this.remainingBudget(run) }
          : {}),
      },
      evidence: [],
      selectedStateKeys: [],
      ...(run.workspace ? { workspace: run.workspace } : {}),
    });
  }

  /**
   * M9-S4: deterministic loop reconciliation — the Coordinator's
   * autonomous decisions from PostgreSQL alone. Returns true when a
   * decision was made (the engine re-runs the pass so new work schedules).
   */
  async reconcileCoordination(executionId: string): Promise<boolean> {
    const run = await this.dataSource
      .getRepository(CoordinationRunEntity)
      .findOne({ where: { executionId } });
    if (!run || TERMINAL_COORDINATION_PHASES.includes(run.phase)) return false;
    const execution = await this.dataSource
      .getRepository(ExecutionEntity)
      .findOne({ where: { id: executionId } });
    if (!execution) return false;
    if (execution.status === "CANCELLED") {
      await this.transitionRun(run.id, "cancel");
      return true;
    }
    if (execution.status === "FAILED") {
      await this.transitionRun(run.id, "fail");
      return true;
    }
    if (execution.status !== "RUNNING") return false;
    // M9-S5: the loop wall-clock budget expires deterministically in any
    // live phase — no more workers, terminal LIMIT_REACHED evidence.
    if (this.deadlineExceeded(run)) {
      await this.transitionRun(run.id, "deadline");
      return true;
    }

    switch (run.phase) {
      case "PLANNING": {
        const iterationNumber = run.currentIterationNumber;
        const stepId = `planner-${iterationNumber}`;
        const step = await this.dataSource
          .getRepository(LogicalStepEntity)
          .findOne({ where: { executionId, stepId } });
        if (!step) {
          // The Coordinator owns Planner step creation: entering PLANNING
          // with a new iteration materializes the trusted Planner step.
          await this.createPlannerStep(run.id);
          return true;
        }
        const attempt = await this.terminalAttempt(step.id);
        if (!attempt) return false;
        if (attempt.status !== "SUCCESS") {
          await this.transitionRun(run.id, "fail");
          return true;
        }
        try {
          const proposal = parseTaskBatchProposal(attempt.result);
          const outcome = await this.submitIterationBatch({
            runId: run.id,
            iterationNumber,
            proposal,
            plannerAttemptId: attempt.id,
          });
          return outcome.outcome === "ACCEPTED";
        } catch (error) {
          if (error instanceof CoordinationError) {
            await this.failRunAndExecution(run.id);
            return true;
          }
          if (error instanceof CoordinationRunError) {
            // Deterministic run-level rejection (e.g. stale iteration
            // identity): fail the run instead of re-throwing on every
            // recovery tick.
            await this.failRunAndExecution(run.id);
            return true;
          }
          throw error;
        }
      }
      case "WORKING": {
        const iteration = await this.activeIteration(run);
        if (!iteration) return false;
        const statuses = new Map<string, StepAttemptStatus>();
        for (const entry of iteration.workerManifest) {
          const step = await this.dataSource
            .getRepository(LogicalStepEntity)
            .findOne({ where: { id: entry.logicalStepId } });
          const attempt = step ? await this.terminalAttempt(step.id) : null;
          // A step mid-retry (RETRYING) is NOT terminally failed: the frozen
          // retry policy still owns the next attempt. Reading the attempt
          // alone would terminalize the run between a required worker's
          // failed attempt and its retry claim.
          const status =
            step?.status === "RETRYING"
              ? "RUNNING"
              : (attempt?.status ?? "CREATED");
          statuses.set(entry.taskId, status);
        }
        const requiredFailed = iteration.workerManifest.some(
          (entry) => entry.required && statuses.get(entry.taskId) === "FAILED",
        );
        if (requiredFailed) {
          await this.transitionRun(run.id, "fail");
          return true;
        }
        const allTerminal = iteration.workerManifest.every((entry) =>
          TERMINAL_ATTEMPT_STATUSES.includes(
            statuses.get(entry.taskId) as StepAttemptStatus,
          ),
        );
        if (allTerminal) {
          await this.transitionRun(run.id, "workersFinished");
          return true;
        }
        return false;
      }
      case "VERIFYING": {
        const iteration = await this.activeIteration(run);
        if (!iteration?.verifierStepId) return false;
        const step = await this.dataSource
          .getRepository(LogicalStepEntity)
          .findOne({
            where: { executionId, stepId: iteration.verifierStepId },
          });
        if (!step) return false;
        const attempt = await this.terminalAttempt(step.id);
        if (!attempt) return false;
        if (attempt.status !== "SUCCESS") {
          await this.transitionRun(run.id, "fail");
          return true;
        }
        try {
          const decision = parseVerifierDecision(attempt.result);
          const outcome = await this.consumeDecision(
            run.id,
            decision,
            attempt.id,
          );
          return outcome.outcome === "consumed";
        } catch (error) {
          if (error instanceof CoordinationError) {
            await this.failRunAndExecution(run.id);
            return true;
          }
          throw error;
        }
      }
      default:
        return false;
    }
  }

  /**
   * M9-S4: explicit WAIT resolution. Approve rechecks the run-level hard
   * limits and continues the loop; deny terminalizes FAILED. Budget,
   * deadline, policy, and connection rechecks land with slice 5.
   */
  async resolveWait(
    runId: string,
    approve: boolean,
  ): Promise<CoordinationPhase> {
    return this.dataSource.transaction((manager) =>
      this.resolveWaitWithManager(manager, runId, approve),
    );
  }

  /** P1/M10: manager-passable WAIT resolution (caller-owned transaction). */
  async resolveWaitWithManager(
    manager: EntityManager,
    runId: string,
    approve: boolean,
  ): Promise<CoordinationPhase> {
    const runs = manager.getRepository(CoordinationRunEntity);
    const run = await lockRun(manager, runId);
    if (run.phase !== "WAITING_FOR_HUMAN") {
      throw new CoordinationRunError(
        "RUN_NOT_FOUND",
        `Coordination run "${runId}" is not WAITING_FOR_HUMAN`,
      );
    }
    let next: CoordinationPhase;
    if (!approve) {
      next = applyPhaseTransition(run.phase, "approvalDenied");
      run.activeIterationId = null;
    } else {
      const allowed = continueAllowed(
        run.config,
        run.currentIterationNumber,
        run.cumulativeWorkers,
        1,
      );
      // M9-S5/S7 + P1: approval rechecks current authority — wall clock,
      // budget account, role connections (revoked planner/verifier
      // connections deny the next iteration) and the frozen executor
      // allowlist for the role selections.
      const exhausted =
        this.deadlineExceeded(run) || (await this.budgetExhausted(run));
      let rolesOk = true;
      try {
        await this.assertRoleConnectionsClaimable(run.config, manager);
        await this.assertRoleExecutorsAllowed(run.config, manager);
      } catch (error) {
        rolesOk = false;
        void error;
      }
      if (!allowed || exhausted || !rolesOk) {
        next = applyPhaseTransition(run.phase, "limitReached");
        run.activeIterationId = null;
      } else {
        await this.createNextIterationLocked(manager, run);
        next = applyPhaseTransition(run.phase, "approvalGranted");
        next = applyPhaseTransition(next, "continue");
      }
    }
    run.phase = next;
    run.waitReason = null;
    run.version += 1;
    await runs.save(run);
    return next;
  }

  private async activeIteration(
    run: CoordinationRunEntity,
  ): Promise<CoordinationIterationEntity | null> {
    if (!run.activeIterationId) return null;
    return this.dataSource
      .getRepository(CoordinationIterationEntity)
      .findOne({ where: { id: run.activeIterationId } });
  }

  private async terminalAttempt(
    logicalStepId: string,
  ): Promise<StepAttemptEntity | null> {
    const attempt = await this.dataSource
      .getRepository(StepAttemptEntity)
      .findOne({
        where: { logicalStepId },
        order: { attemptNumber: "DESC" },
      });
    return attempt && TERMINAL_ATTEMPT_STATUSES.includes(attempt.status)
      ? attempt
      : null;
  }

  /** Creates the next iteration row under the run lock (used for iteration 1
   *  at loop start and re-exposed for tests/slices; CONTINUE reuses the
   *  locked internal path). Exactly-once via UNIQUE (run, number). */
  async createNextIteration(
    runId: string,
  ): Promise<CoordinationIterationEntity> {
    return this.dataSource.transaction((manager) =>
      this.createNextIterationWithManager(manager, runId),
    );
  }

  /** P1/M10: manager-passable next-iteration (caller-owned transaction). */
  async createNextIterationWithManager(
    manager: EntityManager,
    runId: string,
  ): Promise<CoordinationIterationEntity> {
    const run = await lockRun(manager, runId);
    if (TERMINAL_COORDINATION_PHASES.includes(run.phase)) {
      throw new CoordinationRunError(
        "RUN_NOT_FOUND",
        `Coordination run "${runId}" is terminal; no new iteration`,
      );
    }
    return this.createNextIterationLocked(manager, run);
  }

  private async createNextIterationLocked(
    manager: EntityManager,
    run: CoordinationRunEntity,
  ): Promise<CoordinationIterationEntity> {
    const next = run.currentIterationNumber + 1;
    const created = await manager
      .getRepository(CoordinationIterationEntity)
      .save(
        manager.getRepository(CoordinationIterationEntity).create({
          coordinationRunId: run.id,
          iterationNumber: next,
          workerManifest: [],
        }),
      );
    run.currentIterationNumber = next;
    run.activeIterationId = created.id;
    run.version += 1;
    await manager.getRepository(CoordinationRunEntity).save(run);
    return created;
  }

  /** Guarded phase transition under the run lock (deterministic machine). */
  async transitionRun(
    runId: string,
    event: Parameters<typeof applyPhaseTransition>[1],
  ): Promise<CoordinationPhase> {
    return this.dataSource.transaction(async (manager) => {
      const runs = manager.getRepository(CoordinationRunEntity);
      const run = await lockRun(manager, runId);
      const next = applyPhaseTransition(run.phase, event);
      run.phase = next;
      run.version += 1;
      if (event !== "wait") run.waitReason = null;
      await runs.save(run);
      return next;
    });
  }

  /**
   * M9-S7: run FAILED + execution FAILED together, atomically. The
   * engine's step-failure net cannot fire for Coordinator-owned failures
   * (batch rejected, decision invalid) because the responsible step may
   * have SUCCEEDED — the loop authority must terminalize the execution
   * itself, exactly once.
   */
  private async failRunAndExecution(runId: string): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const run = await lockRun(manager, runId);
      const next = applyPhaseTransition(run.phase, "fail");
      run.phase = next;
      run.version += 1;
      run.activeIterationId = null;
      await manager.getRepository(CoordinationRunEntity).save(run);
      const execution = await manager
        .getRepository(ExecutionEntity)
        .createQueryBuilder("execution")
        .setLock("pessimistic_write")
        .where('execution."id" = :id', { id: run.executionId })
        .getOne();
      if (execution && execution.status === "RUNNING") {
        execution.status = "FAILED";
        execution.endTime = new Date();
        execution.terminationReason = "Supervised team run failed";
        await manager.getRepository(ExecutionEntity).save(execution);
      }
    });
  }

  /** Restart/read-only recovery projection: run + all iterations. */
  async recoverRun(executionId: string): Promise<{
    run: CoordinationRunEntity;
    iterations: CoordinationIterationEntity[];
  }> {
    const run = await this.dataSource
      .getRepository(CoordinationRunEntity)
      .findOne({ where: { executionId } });
    if (!run) {
      throw new CoordinationRunError(
        "RUN_NOT_FOUND",
        `No coordination run for execution "${executionId}"`,
      );
    }
    const iterations = await this.dataSource
      .getRepository(CoordinationIterationEntity)
      .find({
        where: { coordinationRunId: run.id },
        order: { iterationNumber: "ASC" },
      });
    return { run, iterations };
  }

  /** Completion hold: a non-terminal run prevents the generic engine from
   *  marking the Execution COMPLETED. ACCEPTED releases the hold. */
  async isCompletionHeld(executionId: string): Promise<boolean> {
    const run = await this.dataSource
      .getRepository(CoordinationRunEntity)
      .findOne({
        where: { executionId },
        select: ["phase"],
      });
    return run !== null && !TERMINAL_COORDINATION_PHASES.includes(run.phase);
  }

  /**
   * Atomically consumes ONE Verifier decision under the run lock.
   *
   * - identical decision (canonical hash) already consumed -> idempotent;
   * - same iteration, different payload -> conflict, nothing changes;
   * - ACCEPT -> run ACCEPTED (completion hold released);
   * - FAIL -> FAILED; WAIT_FOR_HUMAN -> WAITING_FOR_HUMAN (+ waitReason);
   * - CONTINUE -> if hard limits allow, phase PLANNING and the next
   *   iteration row is created exactly once; otherwise LIMIT_REACHED.
   *
   * The decision's iteration identity must match the run's active iteration.
   */
  async consumeDecision(
    runId: string,
    decision: VerifierDecisionV1,
    verifierAttemptId?: string,
  ): Promise<ConsumeDecisionOutcome> {
    const parsed = parseVerifierDecision(decision);
    const hash = canonicalDecisionHash(parsed);
    return this.dataSource.transaction(async (manager) => {
      const runs = manager.getRepository(CoordinationRunEntity);
      const run = await lockRun(manager, runId);
      const currentPhase = run.phase;
      if (TERMINAL_COORDINATION_PHASES.includes(currentPhase)) {
        return { outcome: "idempotent", phase: currentPhase };
      }
      // Phase VERIFYING -> DECIDING on first consumption (idempotent for
      // repeat deliveries of an already-consumed decision).
      const decidingPhase =
        currentPhase === "VERIFYING"
          ? applyPhaseTransition(currentPhase, "verifierProposed")
          : currentPhase;

      const iterations = manager.getRepository(CoordinationIterationEntity);
      const iteration = await iterations.findOne({
        where: {
          coordinationRunId: runId,
          iterationNumber: parsed.iterationNumber,
        },
      });
      if (!iteration) {
        throw new CoordinationRunError(
          "ITERATION_NOT_FOUND",
          `Iteration ${parsed.iterationNumber} does not exist for run "${runId}"`,
        );
      }
      if (iteration.id !== parsed.iterationId) {
        throw new CoordinationRunError(
          "DECISION_STALE",
          `Decision references iteration "${parsed.iterationId}" but the run's iteration ${parsed.iterationNumber} is "${iteration.id}"`,
        );
      }
      if (iteration.decisionHash === hash) {
        return { outcome: "idempotent", phase: run.phase };
      }
      if (iteration.decisionHash !== null) {
        return { outcome: "conflict", phase: run.phase };
      }
      if (decidingPhase !== "DECIDING") {
        // A decision only applies from VERIFYING/DECIDING; anything else is
        // a stale delivery that changes nothing.
        return { outcome: "conflict", phase: run.phase };
      }

      // One-winner guard: consume only if still unconsumed.
      const consumed = await iterations
        .createQueryBuilder()
        .update(CoordinationIterationEntity)
        .set({
          decision: parsed,
          decisionHash: hash,
          ...(verifierAttemptId ? { verifierAttemptId } : {}),
        })
        .where('"id" = :id', { id: iteration.id })
        .andWhere('"decisionHash" IS NULL')
        .execute();
      if (consumed.affected !== 1) {
        return { outcome: "conflict", phase: run.phase };
      }

      const nextPhase = await this.applyDecision(
        manager,
        run,
        parsed,
        iteration.iterationNumber,
      );
      run.phase = nextPhase;
      run.version += 1;
      await runs.save(run);
      return { outcome: "consumed", phase: nextPhase };
    });
  }

  /** Applies the action transition + next-iteration creation under the
   *  already-held run lock (lock order: run, then iteration insert). */
  private async applyDecision(
    manager: EntityManager,
    run: CoordinationRunEntity,
    decision: VerifierDecisionV1,
    iterationNumber: number,
  ): Promise<CoordinationPhase> {
    switch (decision.action) {
      case "ACCEPT":
        run.activeIterationId = null;
        return applyPhaseTransition("DECIDING", "accept");
      case "FAIL":
        run.activeIterationId = null;
        return applyPhaseTransition("DECIDING", "fail");
      case "WAIT_FOR_HUMAN":
        run.waitReason = decision.reason;
        return applyPhaseTransition("DECIDING", "wait");
      case "CONTINUE": {
        const allowed = continueAllowed(
          run.config,
          iterationNumber,
          run.cumulativeWorkers,
          1,
        );
        // M9-S5/S7: CONTINUE is only a proposal — current authority (hard
        // limits, loop deadline, run-level budget, role connections) is
        // rechecked here.
        const exhausted =
          this.deadlineExceeded(run) || (await this.budgetExhausted(run));
        let rolesOk = true;
        try {
          await this.assertRoleConnectionsClaimable(run.config, manager);
          await this.assertRoleExecutorsAllowed(run.config, manager);
        } catch (error) {
          rolesOk = false;
          void error;
        }
        if (!allowed || exhausted || !rolesOk) {
          run.activeIterationId = null;
          return applyPhaseTransition("DECIDING", "limitReached");
        }
        await this.createNextIterationLocked(manager, run);
        return applyPhaseTransition("DECIDING", "continue");
      }
    }
  }

  /** Binds an existing Planner proposal (slice 3 wiring) — persists the
   *  validated batch and its plan revision on the iteration row. */
  /**
   * M9-S8: Planner attempt ownership gate. Proves the referenced StepAttempt
   * is the successful terminal attempt of THIS run's Coordinator-owned
   * Planner step for the given iteration:
   *   - exists;
   *   - belongs to the same execution;
   *   - belongs to this run's iteration Planner step (logical step row);
   *   - has the required successful terminal status;
   *   - carries a frozen plan revision (never null).
   * Returns the attempt plus its frozen revision number so admission can
   * verify the proposal's baseRevision against it.
   */
  private async verifyPlannerAttempt(
    manager: EntityManager,
    run: CoordinationRunEntity,
    iteration: CoordinationIterationEntity,
    plannerAttemptId: string,
  ): Promise<{ attempt: StepAttemptEntity; frozenRevisionNumber: number }> {
    const attempts = manager.getRepository(StepAttemptEntity);
    const attempt = await attempts.findOne({ where: { id: plannerAttemptId } });
    if (!attempt || attempt.executionId !== run.executionId) {
      throw new CoordinationRunError(
        "PLANNER_BASE_REVISION_MISMATCH",
        `Planner attempt "${plannerAttemptId}" does not exist for execution "${run.executionId}"`,
      );
    }
    if (!iteration.plannerStepId) {
      throw new CoordinationRunError(
        "PLANNER_BASE_REVISION_MISMATCH",
        `Iteration ${iteration.iterationNumber} has no Coordinator-owned Planner step`,
      );
    }
    const plannerStep = await manager.getRepository(LogicalStepEntity).findOne({
      where: {
        executionId: run.executionId,
        stepId: iteration.plannerStepId,
      },
    });
    if (
      !plannerStep ||
      plannerStep.executionId !== run.executionId ||
      attempt.logicalStepId !== plannerStep.id
    ) {
      throw new CoordinationRunError(
        "PLANNER_BASE_REVISION_MISMATCH",
        `Planner attempt "${plannerAttemptId}" does not belong to this run's iteration-${iteration.iterationNumber} Planner step`,
      );
    }
    if (attempt.status !== "SUCCESS") {
      throw new CoordinationRunError(
        "PLANNER_BASE_REVISION_MISMATCH",
        `Planner attempt "${plannerAttemptId}" has status ${attempt.status}; only a successful Planner attempt admits a batch`,
      );
    }
    if (!attempt.planRevisionId) {
      throw new CoordinationRunError(
        "PLANNER_BASE_REVISION_MISMATCH",
        `Planner attempt "${plannerAttemptId}" has no frozen plan revision`,
      );
    }
    const frozen = await manager
      .getRepository(ExecutionPlanRevisionEntity)
      .findOne({ where: { id: attempt.planRevisionId } });
    if (!frozen) {
      throw new CoordinationRunError(
        "PLANNER_BASE_REVISION_MISMATCH",
        `Planner attempt "${plannerAttemptId}" references missing frozen plan revision`,
      );
    }
    return { attempt, frozenRevisionNumber: frozen.revisionNumber };
  }

  /**
   * Deterministic terminal disposition for a rejected/stale Planner batch:
   * the run transitions to FAILED with the decision reason as bounded
   * evidence, the RUNNING execution fails together, and nothing is
   * materialized. The stale proposal/result remains persisted on the
   * iteration as evidence — it is never silently rebased or activated.
   */
  private async failStaleBatch(
    manager: EntityManager,
    run: CoordinationRunEntity,
    evidence: { code: string; reason: string },
  ): Promise<{ outcome: "FAILED"; revisionNumber: 0 }> {
    run.phase = applyPhaseTransition(run.phase, "fail");
    run.version += 1;
    await manager.getRepository(CoordinationRunEntity).save(run);
    const executionRepository = manager.getRepository(ExecutionEntity);
    const execution = await executionRepository
      .createQueryBuilder("execution")
      .setLock("pessimistic_write")
      .where('execution."id" = :id', { id: run.executionId })
      .getOne();
    if (execution && execution.status === "RUNNING") {
      execution.status = "FAILED";
      execution.endTime = new Date();
      execution.terminationReason = `Planner batch rejected: ${evidence.code} — ${evidence.reason}`;
      await executionRepository.save(execution);
    }
    return { outcome: "FAILED", revisionNumber: 0 };
  }

  /** Binds an existing Planner proposal (slice 3 wiring) — persists the
   *  validated batch and its plan revision on the iteration row. Enforces
   *  the same Planner-attempt ownership gate as `submitIterationBatch`: an
   *  arbitrary unrelated attempt id is never accepted. */
  async bindPlannerProposal(
    runId: string,
    iterationNumber: number,
    proposal: TaskBatchProposalV1,
    plannerAttemptId: string,
    acceptedPlanRevisionId: string,
  ): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const run = await lockRun(manager, runId);
      const iterations = manager.getRepository(CoordinationIterationEntity);
      const iteration = await iterations.findOne({
        where: { coordinationRunId: runId, iterationNumber },
      });
      if (!iteration) {
        throw new CoordinationRunError(
          "ITERATION_NOT_FOUND",
          `Iteration ${iterationNumber} does not exist for run "${runId}"`,
        );
      }
      if (iteration.plannerProposal !== null) {
        return; // idempotent: already bound
      }
      await this.verifyPlannerAttempt(
        manager,
        run,
        iteration,
        plannerAttemptId,
      );
      iteration.plannerProposal = proposal;
      iteration.plannerAttemptId = plannerAttemptId;
      iteration.acceptedPlanRevisionId = acceptedPlanRevisionId;
      await iterations.save(iteration);
      if (run.phase === "PLANNING") {
        run.phase = applyPhaseTransition(run.phase, "plannerProposed");
        run.version += 1;
        await manager.getRepository(CoordinationRunEntity).save(run);
      }
    });
  }
}

async function lockRun(
  manager: EntityManager,
  runId: string,
): Promise<CoordinationRunEntity> {
  const run = await manager
    .getRepository(CoordinationRunEntity)
    .createQueryBuilder("run")
    .setLock("pessimistic_write")
    .where('run."id" = :runId', { runId })
    .getOne();
  if (!run) {
    throw new CoordinationRunError(
      "RUN_NOT_FOUND",
      `Coordination run "${runId}" does not exist`,
    );
  }
  return run;
}

function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof QueryFailedError &&
    (error as { driverError?: { code?: string } }).driverError?.code === "23505"
  );
}

export function isCoordinationError(
  error: unknown,
): error is CoordinationError {
  return error instanceof CoordinationError;
}
