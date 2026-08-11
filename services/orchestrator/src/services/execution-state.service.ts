import { Inject, Injectable } from "@nestjs/common";
import { DataSource } from "typeorm";
import {
  applyStatePatch,
  EXECUTION_STATE_BOUNDS,
  type ExecutionState,
  ExecutionStateValidationError,
  jsonValueUtf8Size,
  validateStatePatch,
} from "../domain/execution-state";
import { ExecutionEntity, ExecutionStatus } from "../entities/execution.entity";

const TERMINAL_EXECUTION_STATUSES: ExecutionStatus[] = [
  "COMPLETED",
  "FAILED",
  "CANCELLED",
];

export type ExecutionStateSnapshot = {
  executionId: string;
  state: ExecutionState;
  version: number;
  updatedAt: Date | null;
};

export type ExecutionStateMutation =
  | { disposition: "applied"; version: number; state: ExecutionState }
  | { disposition: "noop"; version: number; state: ExecutionState }
  | { disposition: "conflict"; version: number }
  | { disposition: "missing" }
  | { disposition: "terminal"; status: ExecutionStatus };

/**
 * Orchestrator-internal durable ExecutionState primitive. Not exposed to
 * agents, pipeline definitions, public APIs, Gateway routes, or
 * AgentInvocation/AgentResult yet: this is the framework-neutral core later
 * ContextSnapshot and authoritative agent-result integration build on.
 *
 * `executionStateVersion` is the explicit semantic state version, incremented
 * exactly once per real mutation. TypeORM `rowVersion` keeps guarding the
 * whole row and is conceptually distinct.
 */
@Injectable()
export class ExecutionStateService {
  constructor(@Inject("DATA_SOURCE") private readonly dataSource: DataSource) {}

  /** Isolated snapshot: mutating the returned state never touches persisted data. */
  async read(executionId: string): Promise<ExecutionStateSnapshot | null> {
    const execution = await this.dataSource
      .getRepository(ExecutionEntity)
      .findOne({ where: { id: executionId } });
    if (!execution) return null;
    return {
      executionId: execution.id,
      state: structuredClone(
        (execution.executionState ?? {}) as ExecutionState,
      ),
      version: execution.executionStateVersion,
      updatedAt: execution.executionStateUpdatedAt ?? null,
    };
  }

  /**
   * Compare-and-set mutation. The owning ExecutionEntity is locked
   * pessimistically before version or status is evaluated, so concurrent
   * Orchestrator replicas serialize on the row: the first writer applies,
   * every stale writer returns `conflict` with the current semantic version.
   * Invalid patch input is validated before any database work (bounded
   * validation error, never a retry loop); final-state bounds are enforced
   * inside the transaction before saving.
   */
  async mutate(
    executionId: string,
    expectedVersion: number,
    patch: unknown,
  ): Promise<ExecutionStateMutation> {
    const validated = validateStatePatch(patch);

    return this.dataSource.transaction(async (manager) => {
      const execution = await manager
        .getRepository(ExecutionEntity)
        .createQueryBuilder("execution")
        .setLock("pessimistic_write")
        .where('execution."id" = :id', { id: executionId })
        .getOne();
      if (!execution) return { disposition: "missing" };
      if (TERMINAL_EXECUTION_STATUSES.includes(execution.status)) {
        return { disposition: "terminal", status: execution.status };
      }
      if (execution.executionStateVersion !== expectedVersion) {
        return {
          disposition: "conflict",
          version: execution.executionStateVersion,
        };
      }

      const result = applyStatePatch(
        (execution.executionState ?? {}) as ExecutionState,
        validated,
      );
      if (!result.changed) {
        return {
          disposition: "noop",
          version: expectedVersion,
          state: structuredClone(result.state),
        };
      }

      // Final-state bounds are hard ceilings; a violation is a bounded
      // validation error, so the transaction rolls back without retrying.
      const finalSize = jsonValueUtf8Size(result.state);
      if (finalSize > EXECUTION_STATE_BOUNDS.maxStateBytes) {
        throw new ExecutionStateValidationError(
          `final state exceeds ${EXECUTION_STATE_BOUNDS.maxStateBytes} bytes`,
        );
      }
      if (
        Object.keys(result.state).length > EXECUTION_STATE_BOUNDS.maxStateKeys
      ) {
        throw new ExecutionStateValidationError(
          `final state exceeds ${EXECUTION_STATE_BOUNDS.maxStateKeys} top-level keys`,
        );
      }

      // Save state, semantic version, and the state-specific timestamp
      // atomically. TypeORM bumps rowVersion on the same update; the two
      // versions stay distinct.
      const version = expectedVersion + 1;
      execution.executionState = structuredClone(result.state);
      execution.executionStateVersion = version;
      execution.executionStateUpdatedAt = new Date();
      await manager.getRepository(ExecutionEntity).save(execution);

      return {
        disposition: "applied",
        version,
        state: structuredClone(result.state),
      };
    });
  }
}
