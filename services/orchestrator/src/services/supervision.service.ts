import type { AgentResultV1 } from "@tenvyr/contracts";
import { Inject, Injectable } from "@nestjs/common";
import { Repository } from "typeorm";
import { StepAttemptEntity } from "../entities/step-attempt.entity";
import { EngineService } from "./engine.service";
import { ResultInboxService } from "./result-inbox.service";
import {
  SupervisionConfigService,
  type HeartbeatExpectation,
} from "./supervision-config.service";

const SUPERVISION_BATCH = 100;
const SUPERVISION_ADAPTER = "supervision";

/**
 * Deterministic supervision rules, evaluated from durable facts only and
 * terminalized through ResultInboxService.apply — exactly like persisted
 * deadline recovery — so one canonical terminal result, cancel/watchdog race
 * correctness, workflow retry policy, and replica deduplication all hold.
 *
 * Synthetic results are deterministic across replicas: the completion
 * timestamp is derived from PERSISTED timestamps (dispatch time + configured
 * grace, or last server-received heartbeat + staleAfter), never the current
 * recovery tick time. Server receivedAt timestamps are the liveness clock;
 * worker occurredAt is never used for deadlines.
 *
 * Error codes (documented in docs/architecture/control-plane.md):
 *   AGENT_ACCEPTANCE_TIMEOUT — dispatch recorded, no worker event, grace elapsed
 *   AGENT_HEARTBEAT_STALE    — heartbeat received, silence longer than staleAfter
 */
@Injectable()
export class SupervisionService {
  constructor(
    @Inject("STEP_ATTEMPT_REPOSITORY")
    private readonly attempts: Repository<StepAttemptEntity>,
    private readonly config: SupervisionConfigService,
    private readonly inbox: ResultInboxService,
    private readonly engine: EngineService,
  ) {}

  /**
   * Rule A (acceptance timeout) + Rule B (stale heartbeat) in one bounded
   * pass over agents that opted into event supervision. Per-attempt error
   * isolation: one malformed attempt cannot stop unrelated candidates.
   * Multi-replica safety comes from ResultInbox deduplication.
   */
  async evaluate(now = new Date()): Promise<void> {
    const expected = this.config.expectedAgents();
    if (Object.keys(expected).length === 0) return; // M0-compatible fast path

    const rows = await this.attempts
      .createQueryBuilder("attempt")
      .where('attempt."status" IN (:...active)', {
        active: ["DISPATCHED", "RUNNING"],
      })
      .andWhere("attempt.\"executorSnapshot\"->>'agent' IN (:...agents)", {
        agents: Object.keys(expected),
      })
      .orderBy("attempt.dispatchedAt", "ASC")
      .addOrderBy("attempt.lastEventReceivedAt", "ASC")
      .addOrderBy("attempt.id", "ASC")
      .take(SUPERVISION_BATCH)
      .getMany();

    for (const row of rows) {
      try {
        const result = this.syntheticResult(row, expected, now);
        if (!result) continue; // not due yet under this agent's expectation
        const applied = await this.inbox.apply(result, {
          adapter: SUPERVISION_ADAPTER,
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
        console.warn("Deferred supervision candidate", {
          attemptId: row.id,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  /**
   * Builds the deterministic synthetic terminal result, or null when the
   * attempt is not yet due under its agent's expectation.
   */
  private syntheticResult(
    attempt: StepAttemptEntity,
    expected: Record<string, HeartbeatExpectation>,
    now: Date,
  ): AgentResultV1 | null {
    const agent = String(attempt.executorSnapshot?.agent ?? "");
    const expectation = expected[agent];
    if (!expectation) return null;

    if (
      attempt.status === "DISPATCHED" &&
      attempt.lastEventReceivedAt === null &&
      attempt.dispatchedAt !== null &&
      attempt.dispatchedAt.getTime() + expectation.startupGraceMs <= now.getTime()
    ) {
      // Deterministic completion time: persisted dispatch time + configured
      // grace, so every replica constructs the identical payload hash.
      const completedAt = new Date(
        attempt.dispatchedAt.getTime() + expectation.startupGraceMs,
      );
      return {
        schemaVersion: "1",
        invocationId: attempt.invocationId,
        executionId: attempt.executionId,
        stepExecutionId: attempt.logicalStepId,
        status: "timed_out",
        error: {
          code: "AGENT_ACCEPTANCE_TIMEOUT",
          message: `Agent "${agent}" did not emit an event within ${expectation.startupGraceMs}ms of dispatch`,
          retryable: true,
        },
        completedAt: completedAt.toISOString(),
      };
    }

    if (attempt.status === "RUNNING") {
      // Staleness baseline: the last SERVER-received heartbeat; if the agent
      // never emitted a heartbeat (only accepted/progress events), fall back
      // to the last received event so a RUNNING attempt cannot evade
      // supervision by never heartbeating. Both baselines are persisted
      // receivedAt timestamps, so the synthetic result stays deterministic.
      const baseline =
        attempt.lastHeartbeatReceivedAt ?? attempt.lastEventReceivedAt;
      if (
        baseline !== null &&
        baseline.getTime() + expectation.staleAfterMs <= now.getTime()
      ) {
        const completedAt = new Date(
          baseline.getTime() + expectation.staleAfterMs,
        );
        return {
          schemaVersion: "1",
          invocationId: attempt.invocationId,
          executionId: attempt.executionId,
          stepExecutionId: attempt.logicalStepId,
          status: "timed_out",
          error: {
            code: "AGENT_HEARTBEAT_STALE",
            message:
              attempt.lastHeartbeatReceivedAt === null
                ? `Agent "${agent}" never heartbeated; no event received for more than ${expectation.staleAfterMs}ms`
                : `Agent "${agent}" heartbeat stale for more than ${expectation.staleAfterMs}ms`,
            retryable: true,
          },
          completedAt: completedAt.toISOString(),
        };
      }
    }
    return null;
  }
}
