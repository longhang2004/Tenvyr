import type { AgentEventV1 } from "@tenvyr/contracts";
import { Inject, Injectable } from "@nestjs/common";
import { DataSource, type EntityManager, Repository } from "typeorm";
import type {
  AgentEventMessage,
  AgentTransportMetadata,
} from "../agent-adapters/agent-adapter.types";
import { canonicalJson, sha256Json } from "../domain/canonical-json";
import { durableTransportIdentity } from "../domain/transport-identity";
import { AgentEventConflictEntity } from "../entities/agent-event-conflict.entity";
import { AgentEventEntity } from "../entities/agent-event.entity";
import { StepAttemptEntity } from "../entities/step-attempt.entity";

const MAX_EVENT_CANONICAL_BYTES = 64 * 1024;

/** Permanent rejection: the payload exceeds the bounded canonical limit. */
export class EventPayloadTooLargeError extends Error {
  constructor(limit: number) {
    super(`AgentEvent payload exceeds ${limit} bytes canonical limit`);
    this.name = "EventPayloadTooLargeError";
  }
}
const TERMINAL_ATTEMPT_STATUSES = [
  "SUCCESS",
  "FAILED",
  "TIMED_OUT",
  "CANCELLED",
];

export type EventApplication =
  | { disposition: "applied" }
  | { disposition: "duplicate" }
  | { disposition: "conflict" }
  | { disposition: "ignored" };

export type EventListQuery = {
  stepAttemptId?: string;
  type?: string;
  limit: number;
  /** keyset cursor: only events strictly after (receivedAt, id). */
  after?: { receivedAt: Date; id: string };
};

/**
 * Application-layer AgentEvent semantics. Events are durable operational
 * evidence, never authoritative lifecycle state: they can project liveness
 * fields on a non-terminal attempt, and events that prove execution activity
 * (heartbeat/progress/log/artifact) transition DISPATCHED -> RUNNING — but
 * events can never terminalize an attempt, change a LogicalStep outcome, or
 * create a StepAttempt. `accepted` proves worker ownership, not handler
 * execution, so it projects acceptedAt without transitioning. AgentResult
 * remains the only worker-originated terminal authority.
 */
@Injectable()
export class AgentEventService {
  constructor(
    @Inject("DATA_SOURCE") private readonly dataSource: DataSource,
    @Inject("AGENT_EVENT_REPOSITORY")
    private readonly events: Repository<AgentEventEntity>,
  ) {}

  /**
   * Application-layer entry point used by the transport handler seam.
   * Validation/parsing already happened in the adapter; the service owns
   * application semantics only.
   */
  async handle(message: AgentEventMessage): Promise<void> {
    await this.apply(message.event, message.transport);
  }

  /**
   * Applies one canonical validated event. The event row, liveness projection,
   * and guarded DISPATCHED->RUNNING transition commit together.
   */
  async apply(
    event: AgentEventV1,
    transport: AgentTransportMetadata,
  ): Promise<EventApplication> {
    const canonical = canonicalJson(event);
    if (Buffer.byteLength(canonical, "utf8") > MAX_EVENT_CANONICAL_BYTES) {
      throw new EventPayloadTooLargeError(MAX_EVENT_CANONICAL_BYTES);
    }
    const payloadHash = sha256Json(event);
    const receivedAt = new Date(
      transport.receivedAt ?? new Date().toISOString(),
    );
    const source = this.source(transport);

    return this.dataSource.transaction(async (manager) => {
      const attempt = await manager
        .getRepository(StepAttemptEntity)
        .createQueryBuilder("attempt")
        .setLock("pessimistic_write")
        .where('attempt."invocationId" = :invocationId', {
          invocationId: event.invocationId,
        })
        .getOne();
      if (
        !attempt ||
        attempt.executionId !== event.executionId ||
        attempt.logicalStepId !== event.stepExecutionId
      ) {
        // Unknown or mismatched correlation: never trust worker-supplied
        // correlation without verification against the resolved attempt.
        return { disposition: "ignored" };
      }

      const eventRepository = manager.getRepository(AgentEventEntity);

      // 1. Canonical identity check (pessimistic, so concurrent identical
      //    deliveries serialize here instead of racing the insert).
      const canonicalRow = await eventRepository
        .createQueryBuilder("event")
        .setLock("pessimistic_write")
        .where('event."stepAttemptId" = :stepAttemptId', {
          stepAttemptId: attempt.id,
        })
        .andWhere('event."eventId" = :eventId', { eventId: event.eventId })
        .getOne();
      if (canonicalRow) {
        if (canonicalRow.payloadHash === payloadHash) {
          return { disposition: "duplicate" };
        }
        await this.recordConflict(
          manager,
          attempt.id,
          event,
          payloadHash,
          source,
          "event_id_payload",
        );
        return { disposition: "conflict" };
      }

      // 2. Sequence ownership check for a different eventId.
      const sequenceOwner = await eventRepository
        .createQueryBuilder("event")
        .where('event."stepAttemptId" = :stepAttemptId', {
          stepAttemptId: attempt.id,
        })
        .andWhere('event."sequence" = :sequence', { sequence: event.sequence })
        .getOne();
      if (sequenceOwner) {
        await this.recordConflict(
          manager,
          attempt.id,
          event,
          payloadHash,
          source,
          "sequence_owner",
        );
        return { disposition: "conflict" };
      }

      // 3. Insert; identity/sequence/transport uniqueness may still win the
      //    race with a concurrent transaction, in which case the insert is a
      //    silent no-op.
      await eventRepository
        .createQueryBuilder()
        .insert()
        .into(AgentEventEntity)
        .values({
          stepAttemptId: attempt.id,
          invocationId: event.invocationId,
          executionId: event.executionId,
          logicalStepId: event.stepExecutionId,
          eventId: event.eventId,
          sequence: event.sequence,
          type: event.type,
          payload: event.payload,
          metadata: event.metadata ?? null,
          trace: event.trace,
          payloadHash,
          occurredAt: new Date(event.occurredAt),
          receivedAt,
          sourceAdapter: source.adapter,
          sourceScope: source.scope,
          sourceMessageId: source.messageId,
        })
        .orIgnore()
        .execute();

      // 4. Re-read the canonical row: our own insert (or an identical
      //    concurrent insert that won) means applied; a different payload
      //    means an eventId race; no row means a sequence race.
      const after = await eventRepository
        .createQueryBuilder("event")
        .where('event."stepAttemptId" = :stepAttemptId', {
          stepAttemptId: attempt.id,
        })
        .andWhere('event."eventId" = :eventId', { eventId: event.eventId })
        .getOne();
      if (after && after.payloadHash === payloadHash) {
        await this.projectLiveness(manager, attempt.id, event, receivedAt);
        return { disposition: "applied" };
      }
      if (after) {
        await this.recordConflict(
          manager,
          attempt.id,
          event,
          payloadHash,
          source,
          "event_id_payload",
        );
        return { disposition: "conflict" };
      }
      await this.recordConflict(
        manager,
        attempt.id,
        event,
        payloadHash,
        source,
        "sequence_owner",
      );
      return { disposition: "conflict" };
    });
  }

  /** Bounded, deterministic event history: (receivedAt, id) ordering. */
  async list(
    executionId: string,
    query: EventListQuery,
  ): Promise<{
    events: AgentEventEntity[];
    next?: { receivedAt: Date; id: string };
  }> {
    const builder = this.events
      .createQueryBuilder("event")
      .where('event."executionId" = :executionId', { executionId })
      .orderBy('event."receivedAt"', "ASC")
      .addOrderBy('event."id"', "ASC")
      .take(query.limit + 1);
    if (query.stepAttemptId) {
      builder.andWhere('event."stepAttemptId" = :stepAttemptId', {
        stepAttemptId: query.stepAttemptId,
      });
    }
    if (query.type) {
      builder.andWhere('event."type" = :type', { type: query.type });
    }
    if (query.after) {
      builder.andWhere(
        '(event."receivedAt" > :receivedAt OR (event."receivedAt" = :receivedAt AND event."id" > :id))',
        { receivedAt: query.after.receivedAt, id: query.after.id },
      );
    }
    const rows = await builder.getMany();
    const hasMore = rows.length > query.limit;
    const events = hasMore ? rows.slice(0, query.limit) : rows;
    const last = events[events.length - 1];
    return {
      events,
      next:
        hasMore && last
          ? { receivedAt: last.receivedAt, id: last.id }
          : undefined,
    };
  }

  /**
   * Server-received liveness projection, only while the attempt is
   * non-terminal. Late events after a terminal result are still append-only
   * evidence but never touch these columns.
   *
   * `accepted` proves the Worker durably owns the invocation (e.g. it was
   * enqueued behind a busy execution slot) but NOT that the handler has begun
   * executing, so it projects `acceptedAt` without transitioning the attempt.
   * Only events that prove actual execution activity (`heartbeat`,
   * `progress`, `log`, `artifact`) transition a DISPATCHED attempt to
   * RUNNING exactly once (guarded by the status predicate); `startTime` is
   * preserved if already set.
   *
   * Arrival order between `completed`/`failed` and the terminal AgentResult
   * is NOT execution authority: official Workers prioritize AgentResult and
   * emit the terminal operational event only after the result callback
   * completes, while a third-party runtime may deliver in any order. In every
   * case AgentResult is terminal authority and the terminal event is
   * append-only evidence, so `completed`/`failed` never transition the
   * attempt and never terminalize it.
   */
  private async projectLiveness(
    manager: EntityManager,
    stepAttemptId: string,
    event: AgentEventV1,
    receivedAt: Date,
  ): Promise<void> {
    const update: Record<string, unknown> = {
      lastEventReceivedAt: receivedAt,
    };
    if (event.type === "accepted") update.acceptedAt = receivedAt;
    if (event.type === "heartbeat") update.lastHeartbeatReceivedAt = receivedAt;
    if (event.type === "progress") update.lastProgressReceivedAt = receivedAt;

    const attemptRepository = manager.getRepository(StepAttemptEntity);
    await attemptRepository
      .createQueryBuilder()
      .update(StepAttemptEntity)
      .set(update)
      .where('"id" = :id', { id: stepAttemptId })
      .andWhere('"status" NOT IN (:...terminal)', {
        terminal: TERMINAL_ATTEMPT_STATUSES,
      })
      .execute();
    if (["heartbeat", "progress", "log", "artifact"].includes(event.type)) {
      await attemptRepository
        .createQueryBuilder()
        .update(StepAttemptEntity)
        .set({
          status: "RUNNING",
          startTime: () => 'COALESCE("startTime", now())',
        })
        .where('"id" = :id', { id: stepAttemptId })
        .andWhere("\"status\" = 'DISPATCHED'")
        .execute();
    }
  }

  private async recordConflict(
    manager: EntityManager,
    stepAttemptId: string,
    event: AgentEventV1,
    payloadHash: string,
    source: { adapter: string; scope: string | null; messageId: string | null },
    conflictKind: "event_id_payload" | "sequence_owner",
  ): Promise<void> {
    await manager
      .getRepository(AgentEventConflictEntity)
      .createQueryBuilder()
      .insert()
      .into(AgentEventConflictEntity)
      .values({
        stepAttemptId,
        invocationId: event.invocationId,
        eventId: event.eventId,
        sequence: event.sequence,
        conflictKind,
        payloadHash,
        payload: event.payload,
        sourceAdapter: source.adapter,
        sourceScope: source.scope,
        sourceMessageId: source.messageId,
        receivedAt: new Date(),
      })
      .orIgnore()
      .execute();
  }

  private source(transport: AgentTransportMetadata): {
    adapter: string;
    scope: string | null;
    messageId: string | null;
  } {
    // Durable transport identity, shared with ResultInboxService: the
    // bounded storage constraints (varchar columns) are encoded once in
    // durableTransportIdentity, and Kafka scopes are deterministically
    // bounded when a long topic would overflow.
    return durableTransportIdentity(transport);
  }
}
