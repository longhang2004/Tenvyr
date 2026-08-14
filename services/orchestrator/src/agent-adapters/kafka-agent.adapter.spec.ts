import {
  ContractValidationError,
  type AgentInvocationV1,
  type AgentResultV1,
} from "@tenvyr/contracts";
import { KafkaAgentAdapter } from "./kafka-agent.adapter";
import { AgentTransportConfigService } from "./agent-transport-config.service";
import { parseAgentTransportConfiguration } from "./agent-transport-config.service";
import { EventPayloadTooLargeError } from "../services/agent-event.service";

const invocation: AgentInvocationV1 = {
  schemaVersion: "1",
  invocationId: "step-execution-1:1",
  executionId: "execution-1",
  stepExecutionId: "step-execution-1",
  stepId: "review",
  target: { agent: "code-reviewer" },
  input: { code: "TOP_SECRET" },
  attempt: 1,
  createdAt: "2026-07-26T00:00:00.000Z",
  deadlineAt: "2026-07-26T00:00:30.000Z",
  trace: {
    traceId: "execution-1",
    correlationId: "step-execution-1:1",
  },
};

const succeededResult: AgentResultV1 = {
  schemaVersion: "1",
  invocationId: "step-execution-1:1",
  executionId: "execution-1",
  stepExecutionId: "step-execution-1",
  status: "succeeded",
  output: { score: 100 },
  completedAt: "2026-07-26T00:00:01.000Z",
};

const kafkaMessage = (
  value: unknown,
  overrides: Record<string, unknown> = {},
) =>
  ({
    topic: "agentweave.agent.code-reviewer.result",
    partition: 2,
    message: {
      key: Buffer.from("execution-1"),
      value: Buffer.from(
        typeof value === "string" ? value : JSON.stringify(value),
      ),
      timestamp: "1785024001000",
      offset: "42",
      attributes: 0,
      headers: { secret: Buffer.from("must-not-leak") },
    },
    heartbeat: jest.fn(),
    pause: jest.fn(),
    ...overrides,
  }) as any;

describe("KafkaAgentAdapter", () => {
  let kafka: {
    connect: jest.Mock;
    disconnect: jest.Mock;
    publish: jest.Mock;
    subscribe: jest.Mock;
  };
  let executionService: {
    getStepExecution: jest.Mock;
  };
  let resultHandler: jest.Mock;
  let eventHandler: jest.Mock;
  let adapter: KafkaAgentAdapter;
  let inbound: (payload: any) => Promise<void>;

  beforeEach(() => {
    kafka = {
      connect: jest.fn().mockResolvedValue(undefined),
      disconnect: jest.fn().mockResolvedValue(undefined),
      publish: jest.fn().mockResolvedValue(undefined),
      subscribe: jest.fn().mockImplementation(async (_topics, handler) => {
        inbound = handler;
      }),
    };
    executionService = {
      getStepExecution: jest.fn(),
    };
    resultHandler = jest.fn().mockResolvedValue(undefined);
    // M11 closure: the spec exercises the CONNECTED path, so the transport
    // config must declare a Kafka agent (otherwise the adapter idles).
    adapter = new KafkaAgentAdapter(
      kafka as any,
      executionService as any,
      new AgentTransportConfigService(
        parseAgentTransportConfiguration({
          AGENT_TRANSPORT_CONFIG: JSON.stringify({
            "kafka-test-agent": { kind: "kafka" },
          }),
        }),
      ),
    );
  });

  describe("contract and lifecycle", () => {
    it("exposes a stable adapter kind", () => {
      expect(adapter.kind).toBe("kafka");
    });

    it("starts once and does not register duplicate consumers", async () => {
      await adapter.start({ result: resultHandler, event: jest.fn() });
      await adapter.start({ result: resultHandler, event: jest.fn() });

      expect(kafka.connect).toHaveBeenCalledTimes(1);
      expect(kafka.subscribe).toHaveBeenCalledTimes(1);
      expect(kafka.subscribe.mock.calls[0][0]).toEqual([
        "agentweave.agent.code-reviewer.result",
        "agentweave.agent.observability.result",
        "agentweave.agent.code-reviewer.event",
        "agentweave.agent.observability.event",
      ]);
    });

    it("stops idempotently", async () => {
      await adapter.start({ result: resultHandler, event: jest.fn() });
      await adapter.stop();
      await adapter.stop();

      expect(kafka.disconnect).toHaveBeenCalledTimes(1);
    });

    it("rejects invoke before start with a structured retryable error", async () => {
      await expect(adapter.invoke(invocation)).rejects.toMatchObject({
        code: "ADAPTER_NOT_STARTED",
        adapter: "kafka",
        invocationId: invocation.invocationId,
        retryable: true,
      });
    });

    it("maps start failures without leaking broker details", async () => {
      kafka.connect.mockRejectedValue(
        new Error("password=secret broker.internal:9092"),
      );

      await expect(
        adapter.start({ result: resultHandler, event: jest.fn() }),
      ).rejects.toMatchObject({
        code: "ADAPTER_START_FAILED",
        adapter: "kafka",
        retryable: true,
        message: "Kafka agent adapter failed to start",
      });
    });

    it("cleans up a partial start so startup can be retried", async () => {
      kafka.subscribe.mockRejectedValueOnce(new Error("subscription failed"));

      await expect(
        adapter.start({ result: resultHandler, event: jest.fn() }),
      ).rejects.toMatchObject({
        code: "ADAPTER_START_FAILED",
      });
      expect(kafka.disconnect).toHaveBeenCalledTimes(1);

      await expect(
        adapter.start({ result: resultHandler, event: jest.fn() }),
      ).resolves.toBeUndefined();
      expect(kafka.connect).toHaveBeenCalledTimes(2);
    });

    it("maps stop failures and permits a later retry", async () => {
      await adapter.start({ result: resultHandler, event: jest.fn() });
      kafka.disconnect.mockRejectedValueOnce(new Error("disconnect failed"));

      await expect(adapter.stop()).rejects.toMatchObject({
        code: "ADAPTER_STOP_FAILED",
        adapter: "kafka",
        retryable: true,
      });
      kafka.disconnect.mockResolvedValueOnce(undefined);
      await expect(adapter.stop()).resolves.toBeUndefined();
      expect(kafka.disconnect).toHaveBeenCalledTimes(2);
    });
  });

  describe("outbound", () => {
    beforeEach(async () => {
      await adapter.start({ result: resultHandler, event: jest.fn() });
    });

    it("publishes a valid invocation to the existing topic and key", async () => {
      await adapter.invoke(invocation);

      expect(kafka.publish).toHaveBeenCalledWith({
        topic: "agentweave.agent.code-reviewer.task",
        key: "execution-1",
        value: expect.any(String),
      });
    });

    it("round-trips every invocation field through JSON serialization", async () => {
      await adapter.invoke(invocation);

      expect(JSON.parse(kafka.publish.mock.calls[0][0].value)).toEqual(
        invocation,
      );
    });

    it.each([
      ["invocationId", "step-execution-1:1"],
      ["stepExecutionId", "step-execution-1"],
      ["attempt", 1],
    ])("does not change %s", async (field, expected) => {
      await adapter.invoke(invocation);

      expect(JSON.parse(kafka.publish.mock.calls[0][0].value)[field]).toBe(
        expected,
      );
    });

    it("rejects an invalid invocation before publish", async () => {
      await expect(
        adapter.invoke({ ...invocation, invocationId: "" }),
      ).rejects.toBeInstanceOf(ContractValidationError);
      expect(kafka.publish).not.toHaveBeenCalled();
    });

    it("maps serialization failures", async () => {
      const stringify = jest
        .spyOn(JSON, "stringify")
        .mockImplementationOnce(() => {
          throw new TypeError("serialization failed");
        });

      await expect(adapter.invoke(invocation)).rejects.toMatchObject({
        code: "SERIALIZATION_FAILED",
        adapter: "kafka",
        invocationId: invocation.invocationId,
        retryable: false,
      });
      stringify.mockRestore();
    });

    it("maps producer failures without swallowing them", async () => {
      kafka.publish.mockRejectedValue(new Error("broker unavailable"));

      await expect(adapter.invoke(invocation)).rejects.toMatchObject({
        code: "DISPATCH_FAILED",
        adapter: "kafka",
        invocationId: invocation.invocationId,
        retryable: true,
      });
    });

    it("returns a correlated dispatch receipt", async () => {
      const receipt = await adapter.invoke(invocation);

      expect(receipt).toMatchObject({
        adapter: "kafka",
        invocationId: invocation.invocationId,
        messageKey: invocation.executionId,
      });
      expect(Date.parse(receipt.dispatchedAt)).not.toBeNaN();
    });

    it("does not log full invocation input", async () => {
      const log = jest.spyOn(console, "log").mockImplementation();

      await adapter.invoke(invocation);

      expect(JSON.stringify(log.mock.calls)).not.toContain("TOP_SECRET");
      log.mockRestore();
    });
  });

  describe("inbound", () => {
    beforeEach(async () => {
      await adapter.start({ result: resultHandler, event: jest.fn() });
    });

    it("parses a v1 result and delivers it to the handler", async () => {
      await inbound(kafkaMessage(succeededResult));

      expect(resultHandler).toHaveBeenCalledWith(
        expect.objectContaining({ result: succeededResult }),
      );
    });

    it.each([
      ["success", "COMPLETED", undefined, "succeeded"],
      ["failure", "FAILED", "runner unavailable", "failed"],
    ])(
      "normalizes a legacy %s result",
      async (_case, status, error, expectedStatus) => {
        executionService.getStepExecution.mockResolvedValue({
          id: "step-execution-1",
          executionId: "execution-1",
          stepId: "review",
          attempt: 1,
        });

        await inbound(
          kafkaMessage({
            executionId: "execution-1",
            stepId: "review",
            status,
            ...(error ? { error } : { output: { score: 100 } }),
            attempt: 1,
            timestamp: "2026-07-26T00:00:01.000Z",
          }),
        );

        expect(resultHandler.mock.calls[0][0].result).toMatchObject({
          invocationId: "step-execution-1:1",
          stepExecutionId: "step-execution-1",
          status: expectedStatus,
        });
      },
    );

    it("preserves v1 correlation", async () => {
      await inbound(kafkaMessage(succeededResult));

      expect(resultHandler.mock.calls[0][0].result).toMatchObject({
        invocationId: succeededResult.invocationId,
        executionId: succeededResult.executionId,
        stepExecutionId: succeededResult.stepExecutionId,
      });
    });

    it("does not crash or call the handler for invalid JSON", async () => {
      await expect(inbound(kafkaMessage("{not-json"))).resolves.toBeUndefined();
      expect(resultHandler).not.toHaveBeenCalled();
    });

    it("does not call the handler for an invalid v1 result", async () => {
      await inbound(kafkaMessage({ ...succeededResult, stepExecutionId: "" }));
      expect(resultHandler).not.toHaveBeenCalled();
    });

    it("does not call the handler when legacy context cannot be resolved", async () => {
      executionService.getStepExecution.mockResolvedValue(null);

      await inbound(
        kafkaMessage({
          executionId: "execution-1",
          stepId: "missing",
          status: "COMPLETED",
          timestamp: "2026-07-26T00:00:01.000Z",
        }),
      );

      expect(resultHandler).not.toHaveBeenCalled();
    });

    it("logs malformed messages without raw payload or secrets", async () => {
      const error = jest.spyOn(console, "error").mockImplementation();

      await inbound(kafkaMessage("{TOP_SECRET:not-json"));

      const logged = JSON.stringify(error.mock.calls);
      expect(logged).toContain("AgentResultV1");
      expect(logged).not.toContain("TOP_SECRET");
      expect(logged).not.toContain("must-not-leak");
      error.mockRestore();
    });

    it("propagates retryable handler failure so Kafka can redeliver", async () => {
      const error = jest.spyOn(console, "error").mockImplementation();
      resultHandler.mockRejectedValue(new Error("processor failed"));

      await expect(
        inbound(kafkaMessage(succeededResult)),
      ).rejects.toMatchObject({
        code: "RESULT_HANDLER_FAILED",
        retryable: true,
      });

      expect(error.mock.calls.flat()).toContainEqual(
        expect.objectContaining({ errorCode: "RESULT_HANDLER_FAILED" }),
      );
      error.mockRestore();
    });

    it("maps scalar metadata without leaking a raw Kafka record", async () => {
      await inbound(kafkaMessage(succeededResult));

      const receivedTransport = resultHandler.mock.calls[0][0].transport;
      expect(receivedTransport).toMatchObject({
        adapter: "kafka",
        messageKey: "execution-1",
        topic: "agentweave.agent.code-reviewer.result",
        partition: 2,
        offset: "42",
      });
      expect(Object.keys(receivedTransport).sort()).toEqual(
        [
          "adapter",
          "messageKey",
          "offset",
          "partition",
          "receivedAt",
          "topic",
        ].sort(),
      );
    });
  });
  describe("event topic ingestion", () => {
    const eventBody = (overrides: Record<string, unknown> = {}) => ({
      schemaVersion: "1",
      eventId: "event-1",
      invocationId: "step-execution-1:1",
      executionId: "execution-1",
      stepExecutionId: "step-execution-1",
      sequence: 1,
      type: "progress",
      occurredAt: "2026-08-10T00:00:00.000Z",
      payload: { stage: "indexing" },
      trace: { traceId: "execution-1", correlationId: "step-execution-1:1" },
      ...overrides,
    });
    const eventMessage = (
      overrides: { body?: Record<string, unknown> } = {},
    ) => ({
      topic: "agentweave.agent.code-reviewer.event",
      partition: 2,
      message: {
        key: Buffer.from("execution-1"),
        value: Buffer.from(JSON.stringify(eventBody(overrides.body))),
        offset: "41",
        timestamp: "1785024000000",
      },
    });

    beforeEach(async () => {
      eventHandler = jest.fn().mockResolvedValue(undefined);
      await adapter.start({ result: resultHandler, event: eventHandler });
    });

    it("ingests a canonical AgentEvent with safe scalar transport metadata", async () => {
      await inbound(eventMessage());

      expect(eventHandler).toHaveBeenCalledWith({
        event: expect.objectContaining({
          eventId: "event-1",
          type: "progress",
          sequence: 1,
        }),
        transport: expect.objectContaining({
          adapter: "kafka",
          topic: "agentweave.agent.code-reviewer.event",
          partition: 2,
          offset: "41",
        }),
      });
      expect(resultHandler).not.toHaveBeenCalled();
    });

    it("treats an invalid event as a poison record (acknowledged, not retried)", async () => {
      const invalid = eventBody({ sequence: "nope" });
      await inbound({
        topic: "agentweave.agent.code-reviewer.event",
        partition: 0,
        message: {
          key: Buffer.from("execution-1"),
          value: Buffer.from(JSON.stringify(invalid)),
          offset: "1",
          timestamp: "1785024000000",
        },
      });

      expect(eventHandler).not.toHaveBeenCalled();
      // No throw: KafkaJS acknowledges the poison record.
    });

    it.each([
      ["eventId longer than varchar(255)", { eventId: "e".repeat(256) }],
      ["sequence beyond PostgreSQL int32", { sequence: 2147483648 }],
    ])(
      "acks a schema-valid-before-tightening but storage-invalid event (%s) as poison, never redelivered",
      async (_label, overrides) => {
        const invalid = eventBody(overrides);
        // The canonical contract rejects the event before any handler or
        // persistence path; the poison record is acknowledged, so the
        // partition is not stalled by an unbounded redelivery loop.
        await inbound({
          topic: "agentweave.agent.code-reviewer.event",
          partition: 0,
          message: {
            key: Buffer.from("execution-1"),
            value: Buffer.from(JSON.stringify(invalid)),
            offset: "3",
            timestamp: "1785024000000",
          },
        });

        expect(eventHandler).not.toHaveBeenCalled();
      },
    );

    it("acks an oversized event as poison (never redelivered)", async () => {
      eventHandler.mockRejectedValueOnce(new EventPayloadTooLargeError(65536));
      const oversized = eventBody({ payload: { blob: "x".repeat(70 * 1024) } });

      // Non-retryable handler failures are acknowledged, never rethrown, so
      // the poison record does not stall the partition.
      await expect(
        inbound({
          topic: "agentweave.agent.code-reviewer.event",
          partition: 0,
          message: {
            key: Buffer.from("execution-1"),
            value: Buffer.from(JSON.stringify(oversized)),
            offset: "5",
            timestamp: "1785024000000",
          },
        }),
      ).resolves.toBeUndefined();
      expect(eventHandler).toHaveBeenCalledTimes(1);
    });

    it("propagates durable application failures so Kafka can redeliver", async () => {
      eventHandler.mockRejectedValueOnce(new Error("database unavailable"));

      await expect(inbound(eventMessage())).rejects.toMatchObject({
        code: "EVENT_HANDLER_FAILED",
        retryable: true,
      });
    });

    it("does not normalize legacy event payloads (canonical-only ingestion)", async () => {
      const legacyShaped = {
        executionId: "execution-1",
        stepExecutionId: "step-execution-1",
        // A legacy-style result on an event topic must not be normalized.
        status: "succeeded",
        completedAt: "2026-08-10T00:00:00.000Z",
      };
      await inbound({
        topic: "agentweave.agent.code-reviewer.event",
        partition: 0,
        message: {
          key: Buffer.from("execution-1"),
          value: Buffer.from(JSON.stringify(legacyShaped)),
          offset: "2",
          timestamp: "1785024000000",
        },
      });

      expect(eventHandler).not.toHaveBeenCalled();
      expect(resultHandler).not.toHaveBeenCalled();
    });

    it("keeps result topics behaving unchanged while events flow", async () => {
      executionService.getStepExecution.mockResolvedValue({
        executionId: "execution-1",
        stepId: "code-review",
        status: "RUNNING",
      });
      await inbound({
        topic: "agentweave.agent.code-reviewer.result",
        partition: 1,
        message: {
          key: Buffer.from("execution-1"),
          value: Buffer.from(
            JSON.stringify({
              schemaVersion: "1",
              invocationId: "step-execution-1:1",
              executionId: "execution-1",
              stepExecutionId: "step-execution-1",
              status: "succeeded",
              output: { score: 100 },
              completedAt: "2026-08-10T00:00:00.000Z",
            }),
          ),
          offset: "9",
          timestamp: "1785024000000",
        },
      });

      expect(resultHandler).toHaveBeenCalledTimes(1);
      expect(eventHandler).not.toHaveBeenCalled();
    });
  });

  describe("M11 closure: HTTP-only deployments (no Kafka brokers)", () => {
    let idleAdapter: KafkaAgentAdapter;

    beforeEach(() => {
      const idleKafka = {
        connect: jest.fn(),
        subscribe: jest.fn(),
        publish: jest.fn(),
        disconnect: jest.fn(),
      };
      idleAdapter = new KafkaAgentAdapter(
        idleKafka as any,
        executionService as any,
        new AgentTransportConfigService(
          parseAgentTransportConfiguration({ AGENT_TRANSPORT_CONFIG: "{}" }),
        ),
      );
    });

    it("starts without connecting when no Kafka agents are configured", async () => {
      await idleAdapter.start({ result: jest.fn(), event: jest.fn() });
      const kafka = (idleAdapter as any).kafka;
      expect(kafka.connect).not.toHaveBeenCalled();
      expect(kafka.subscribe).not.toHaveBeenCalled();
    });

    it("dispatch of a Kafka-routed agent fails deterministically (non-retryable) on an idle transport", async () => {
      await idleAdapter.start({ result: jest.fn(), event: jest.fn() });
      await expect(
        idleAdapter.invoke({
          ...invocation,
          invocationId: "idle-inv-1",
        }),
      ).rejects.toMatchObject({
        code: "KAFKA_TRANSPORT_IDLE",
        retryable: false,
      });
    });
  });
});
