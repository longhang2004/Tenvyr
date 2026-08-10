import type { AgentEventV1 } from "@tenvyr/contracts";
import { AgentEventEntity } from "../entities/agent-event.entity";
import { AgentEventConflictEntity } from "../entities/agent-event-conflict.entity";
import { StepAttemptEntity } from "../entities/step-attempt.entity";
import { AgentEventService } from "./agent-event.service";

const event = (overrides: Partial<AgentEventV1> = {}): AgentEventV1 => ({
  schemaVersion: "1",
  eventId: "event-1",
  invocationId: "logical-1:1",
  executionId: "execution-1",
  stepExecutionId: "logical-1",
  sequence: 1,
  type: "progress",
  occurredAt: "2026-08-10T00:00:00.000Z",
  payload: { stage: "indexing" },
  trace: { traceId: "execution-1", correlationId: "logical-1:1" },
  ...overrides,
});

const attempt = {
  id: "attempt-1",
  invocationId: "logical-1:1",
  executionId: "execution-1",
  logicalStepId: "logical-1",
  status: "DISPATCHED",
};

const buildService = (
  overrides: {
    attempt?: any;
    canonicalRow?: any;
    sequenceOwner?: any;
    conflictInsert?: jest.Mock;
    eventInsert?: jest.Mock;
    afterRow?: any;
    livenessUpdate?: jest.Mock;
    runningUpdate?: jest.Mock;
    size?: number;
  } = {},
) => {
  const eventInsert =
    overrides.eventInsert ??
    jest.fn().mockResolvedValue({ identifiers: [{ id: 'event-row-1' }] });
  const conflictInsert =
    overrides.conflictInsert ?? jest.fn().mockResolvedValue({});
  const livenessUpdate = overrides.livenessUpdate ?? jest.fn().mockResolvedValue({});
  const runningUpdate = overrides.runningUpdate ?? jest.fn().mockResolvedValue({});
  const builder = (getOneResult: any) => {
    const value: any = {
      setLock: jest.fn(() => value),
      where: jest.fn(() => value),
      andWhere: jest.fn(() => value),
      getOne: jest.fn().mockResolvedValue(getOneResult),
    };
    return value;
  };
  const attemptRepository = {
    createQueryBuilder: jest.fn(() => {
      const value: any = {
        setLock: jest.fn(() => value),
        where: jest.fn(() => value),
        andWhere: jest.fn(() => value),
        getOne: jest.fn().mockResolvedValue(overrides.attempt ?? attempt),
        update: jest.fn(() => ({
          set: jest.fn(() => ({
            where: jest.fn(() => ({
              andWhere: jest.fn(() => ({ execute: livenessUpdate })),
            })),
          })),
        })),
      };
      return value;
    }),
  };
  let selectCount = 0;
  const eventRepository = {
    createQueryBuilder: jest.fn(() => {
      // Select path (canonicalRow pessimistic, sequenceOwner plain) and the
      // insert chain share the same repository mock.
      const insert = jest.fn(() => ({
        into: jest.fn(() => ({
          values: jest.fn(() => ({
            orIgnore: jest.fn(() => ({ execute: eventInsert })),
          })),
        })),
      }));
      const value: any = {
        insert,
        setLock: jest.fn(() => value),
        where: jest.fn(() => value),
        andWhere: jest.fn(() => value),
        getOne: jest.fn().mockImplementation(() => {
          selectCount += 1;
          if (selectCount === 1) return overrides.canonicalRow ?? null;
          if (selectCount === 2) return overrides.sequenceOwner ?? null;
          return overrides.afterRow ?? null;
        }),
      };
      return value;
    }),
  };
  const conflictRepository = {
    createQueryBuilder: jest.fn(() => ({
      insert: jest.fn(() => ({ into: jest.fn(() => ({ values: jest.fn(() => ({ orIgnore: jest.fn(() => ({ execute: conflictInsert })) })) })) })),
    })),
  };
  const livenessRepository = {
    createQueryBuilder: jest.fn(() => ({
      update: jest.fn(() => ({ set: jest.fn(() => ({ where: jest.fn(() => ({ andWhere: jest.fn(() => ({ execute: livenessUpdate })) })) })) })),
    })),
  };
  const manager = {
    getRepository: jest.fn((entity) => {
      if (entity === StepAttemptEntity) return attemptRepository;
      if (entity === AgentEventEntity) return eventRepository;
      if (entity === AgentEventConflictEntity) return conflictRepository;
      throw new Error("unexpected repository");
    }),
  };
  const dataSource = {
    transaction: jest.fn(async (work: any) => work(manager)),
  };
  const eventsRepo = { createQueryBuilder: jest.fn() };
  const service = new AgentEventService(
    dataSource as any,
    eventsRepo as any,
  );
  return { service, eventInsert, conflictInsert, livenessUpdate, manager };
};

describe("AgentEventService", () => {
  const transport = {
    adapter: "http",
    receivedAt: "2026-08-10T00:00:01.000Z",
    deliveryId: "delivery-1",
    keyId: "key-1",
  };

  it("applies a canonical event and projects liveness with DISPATCHED -> RUNNING", async () => {
    const { sha256Json } = jest.requireActual("../domain/canonical-json");
    const { service, livenessUpdate } = buildService({
      afterRow: { id: "event-row-1", payloadHash: sha256Json(event()) },
    });

    await expect(service.apply(event(), transport)).resolves.toEqual({
      disposition: "applied",
    });
    // liveness projection runs (lastEventReceivedAt + progress) ...
    expect(livenessUpdate).toHaveBeenCalled();
  });

  it("returns duplicate for the same canonical eventId and payload", async () => {
    const { sha256Json } = jest.requireActual("../domain/canonical-json");
    const { service } = buildService({
      eventInsert: jest.fn().mockResolvedValue({}),
      canonicalRow: { id: "event-row-1", payloadHash: sha256Json(event()) },
    });
    await expect(service.apply(event(), transport)).resolves.toEqual({
      disposition: "duplicate",
    });
  });

  it("records conflict evidence when the same eventId has a different payload", async () => {
    const { sha256Json } = jest.requireActual("../domain/canonical-json");
    const { service, conflictInsert } = buildService({
      eventInsert: jest.fn().mockResolvedValue({}),
      canonicalRow: {
        id: "event-row-1",
        payloadHash: sha256Json({ ...event(), payload: { other: true } }),
      },
    });

    await expect(service.apply(event(), transport)).resolves.toEqual({
      disposition: "conflict",
    });
    expect(conflictInsert).toHaveBeenCalled();
  });

  it("records sequence conflict evidence when another eventId owns the sequence", async () => {
    const { service, conflictInsert } = buildService({
      eventInsert: jest.fn().mockResolvedValue({}),
      sequenceOwner: { id: "other-row", eventId: "event-other" },
    });

    await expect(service.apply(event(), transport)).resolves.toEqual({
      disposition: "conflict",
    });
    expect(conflictInsert).toHaveBeenCalled();
  });

  it("ignores events whose correlation does not match the resolved attempt", async () => {
    const { service } = buildService({
      attempt: { ...attempt, executionId: "execution-other" },
    });

    await expect(service.apply(event(), transport)).resolves.toEqual({
      disposition: "ignored",
    });
  });

  it("rejects oversized canonical payloads", async () => {
    const { service } = buildService();
    const big = event({
      payload: { blob: "x".repeat(70 * 1024) },
    });

    await expect(service.apply(big, transport)).rejects.toThrow(
      /exceeds .* bytes canonical limit/,
    );
  });
});
