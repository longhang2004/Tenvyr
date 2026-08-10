import {
  AgentResultV1,
  ContractValidationError,
  normalizeLegacyResult,
  parseAgentEvent,
  parseAgentInvocation,
  parseAgentResult,
} from "@tenvyr/contracts";
import { Injectable } from "@nestjs/common";
import type { EachMessagePayload } from "kafkajs";
import { ExecutionService } from "../services/execution.service";
import { EventPayloadTooLargeError } from "../services/agent-event.service";
import { KafkaService } from "../services/kafka.service";
import { AgentAdapterError } from "./agent-adapter.errors";
import type {
  AgentAdapter,
  AgentAdapterHandlers,
  AgentDispatchReceipt,
  AgentTransportMetadata,
} from "./agent-adapter.types";

@Injectable()
export class KafkaAgentAdapter implements AgentAdapter {
  readonly kind = "kafka";

  private started = false;
  private handlers?: AgentAdapterHandlers;
  private eventTopicSet = new Set<string>();

  constructor(
    private readonly kafka: KafkaService,
    private readonly executionService: ExecutionService,
  ) {}

  async start(handlers: AgentAdapterHandlers): Promise<void> {
    if (this.started) return;

    this.handlers = handlers;
    const resultTopics = this.resultTopics();
    const eventTopics = this.eventTopics();
    this.eventTopicSet = new Set(eventTopics);
    const topics = [...new Set([...resultTopics, ...eventTopics])];
    let connected = false;
    try {
      await this.kafka.connect();
      connected = true;
      await this.kafka.subscribe(topics, async (payload) =>
        this.handleKafkaMessage(payload),
      );
      this.started = true;
      console.log("Kafka agent adapter started", {
        adapter: this.kind,
        resultTopics,
        eventTopics,
      });
    } catch (cause) {
      this.handlers = undefined;
      if (connected) {
        try {
          await this.kafka.disconnect();
        } catch {
          // Preserve the startup failure as the actionable error.
        }
      }
      throw new AgentAdapterError(
        "ADAPTER_START_FAILED",
        this.kind,
        "Kafka agent adapter failed to start",
        {
          retryable: true,
          cause,
        },
      );
    }
  }

  async stop(): Promise<void> {
    if (!this.started) return;

    try {
      await this.kafka.disconnect();
      this.started = false;
      this.handlers = undefined;
      this.eventTopicSet = new Set();
    } catch (cause) {
      throw new AgentAdapterError(
        "ADAPTER_STOP_FAILED",
        this.kind,
        "Kafka agent adapter failed to stop",
        {
          retryable: true,
          cause,
        },
      );
    }
  }

  async invoke(
    invocation: Parameters<AgentAdapter["invoke"]>[0],
  ): Promise<AgentDispatchReceipt> {
    if (!this.started) {
      throw new AgentAdapterError(
        "ADAPTER_NOT_STARTED",
        this.kind,
        "Kafka agent adapter is not started",
        {
          invocationId: invocation.invocationId,
          retryable: true,
        },
      );
    }

    const payload = parseAgentInvocation(invocation);
    let value: string;
    try {
      value = JSON.stringify(payload);
    } catch (cause) {
      throw new AgentAdapterError(
        "SERIALIZATION_FAILED",
        this.kind,
        "Agent invocation could not be serialized",
        {
          invocationId: payload.invocationId,
          retryable: false,
          cause,
        },
      );
    }

    const topic = `agentweave.agent.${payload.target.agent}.task`;
    try {
      await this.kafka.publish({
        topic,
        key: payload.executionId,
        value,
      });
    } catch (cause) {
      const error = new AgentAdapterError(
        "DISPATCH_FAILED",
        this.kind,
        "Kafka agent invocation dispatch failed",
        {
          invocationId: payload.invocationId,
          retryable: true,
          cause,
        },
      );
      console.error("Agent invocation dispatch failed", {
        adapter: this.kind,
        errorCode: error.code,
        retryable: error.retryable,
        invocationId: payload.invocationId,
        executionId: payload.executionId,
        stepExecutionId: payload.stepExecutionId,
        agent: payload.target.agent,
        attempt: payload.attempt,
      });
      throw error;
    }

    const dispatchedAt = new Date().toISOString();
    console.log("Agent invocation dispatched", {
      adapter: this.kind,
      invocationId: payload.invocationId,
      executionId: payload.executionId,
      stepExecutionId: payload.stepExecutionId,
      agent: payload.target.agent,
      attempt: payload.attempt,
    });
    return {
      adapter: this.kind,
      invocationId: payload.invocationId,
      dispatchedAt,
      messageKey: payload.executionId,
    };
  }

  private async handleKafkaMessage({
    topic,
    partition,
    message,
  }: EachMessagePayload): Promise<void> {
    if (!message.value) return;

    const transport: AgentTransportMetadata = {
      adapter: this.kind,
      receivedAt: new Date().toISOString(),
      messageKey: message.key?.toString(),
      topic,
      partition,
      offset: message.offset,
    };
    let payload: unknown;

    try {
      payload = JSON.parse(message.value.toString());
      // Event topics ingest ONLY canonical AgentEventV1 — no legacy event
      // normalization exists, and routing is by explicit topic membership so
      // custom ORCHESTRATOR_EVENT_TOPICS cannot be misrouted to result
      // parsing. Result topics keep the existing behavior (including legacy
      // result normalization).
      if (this.eventTopicSet.has(topic)) {
        const event = parseAgentEvent(payload);
        console.log("Agent event received from transport", {
          adapter: this.kind,
          invocationId: event.invocationId,
          executionId: event.executionId,
          stepExecutionId: event.stepExecutionId,
          eventId: event.eventId,
          type: event.type,
          sequence: event.sequence,
          messageKey: transport.messageKey,
          topic,
          partition,
          offset: message.offset,
        });
        if (!this.handlers) {
          throw new AgentAdapterError(
            "EVENT_HANDLER_FAILED",
            this.kind,
            "Agent event handler is unavailable",
            {
              invocationId: event.invocationId,
              retryable: true,
            },
          );
        }
        try {
          await this.handlers.event({ event, transport });
        } catch (cause) {
          throw new AgentAdapterError(
            "EVENT_HANDLER_FAILED",
            this.kind,
            "Agent event handler failed",
            {
              invocationId: event.invocationId,
              // Oversized payloads are permanent poison: ack, never redeliver.
              retryable: !(cause instanceof EventPayloadTooLargeError),
              cause,
            },
          );
        }
        return;
      }

      const result = await this.normalizeResult(payload, message.timestamp);
      if (!result) return;

      console.log("Agent result received from transport", {
        adapter: this.kind,
        invocationId: result.invocationId,
        executionId: result.executionId,
        stepExecutionId: result.stepExecutionId,
        status: result.status,
        messageKey: transport.messageKey,
        topic,
        partition,
        offset: message.offset,
      });

      if (!this.handlers) {
        throw new AgentAdapterError(
          "RESULT_HANDLER_FAILED",
          this.kind,
          "Agent result handler is unavailable",
          {
            invocationId: result.invocationId,
            retryable: true,
          },
        );
      }

      try {
        await this.handlers.result({ result, transport });
      } catch (cause) {
        throw new AgentAdapterError(
          "RESULT_HANDLER_FAILED",
          this.kind,
          "Agent result handler failed",
          {
            invocationId: result.invocationId,
            retryable: true,
            cause,
          },
        );
      }
    } catch (error) {
      this.logInboundError(error, transport, payload);
      // KafkaJS only has a chance to redeliver when the handler rejects. Schema
      // failures are poison records and are logged/acknowledged; durable result
      // application failures are retryable and must escape this callback.
      if (!(error instanceof AgentAdapterError)) return;
      if (!error.retryable) return;
      throw error;
    }
  }

  private async normalizeResult(
    value: unknown,
    kafkaTimestamp: string,
  ): Promise<AgentResultV1 | null> {
    if (this.isRecord(value) && value.schemaVersion === "1") {
      return parseAgentResult(value);
    }

    const executionId = this.stringField(value, "executionId");
    const stepId = this.stringField(value, "stepId");
    if (!executionId || !stepId) {
      throw new ContractValidationError("LegacyAgentResult", [
        {
          path: !executionId ? "/executionId" : "/stepId",
          message: "must be a non-empty string",
          keyword: "type",
        },
      ]);
    }

    const stepExecution = await this.executionService.getStepExecution(
      executionId,
      stepId,
    );
    if (!stepExecution) {
      console.warn("Ignoring legacy result for unknown step", {
        adapter: this.kind,
        executionId,
        stepId,
      });
      return null;
    }

    const attempt =
      this.isRecord(value) && typeof value.attempt === "number"
        ? value.attempt
        : stepExecution.attempt;
    const completedAt =
      (this.isRecord(value) &&
        typeof value.timestamp === "string" &&
        value.timestamp) ||
      this.kafkaTimestamp(kafkaTimestamp);

    return normalizeLegacyResult(value, {
      invocationId: `${stepExecution.id}:${attempt}`,
      executionId,
      stepExecutionId: stepExecution.id,
      completedAt,
    });
  }

  /**
   * agentweave.agent.<agent>.event is a compatibility wire identifier (not
   * active product branding), consistent with the task/result topic
   * convention. ORCHESTRATOR_EVENT_TOPICS allows explicit additions without
   * overloading result topics.
   */
  private eventTopics(): string[] {
    const configured = (process.env.ORCHESTRATOR_EVENT_TOPICS ?? "")
      .split(",")
      .map((topic) => topic.trim())
      .filter(Boolean);
    return [
      ...this.agentNames().map((agent) => `agentweave.agent.${agent}.event`),
      ...configured,
    ];
  }

  private resultTopics(): string[] {
    const explicitTopics = (process.env.ORCHESTRATOR_RESULT_TOPICS || "")
      .split(",")
      .map((topic) => topic.trim())
      .filter(Boolean);

    return Array.from(
      new Set([
        ...this.agentNames().map((agent) => `agentweave.agent.${agent}.result`),
        ...explicitTopics,
      ]),
    );
  }

  private agentNames(): string[] {
    return (process.env.ORCHESTRATOR_AGENT_NAMES || "code-reviewer,observability")
      .split(",")
      .map((agent) => agent.trim())
      .filter(Boolean);
  }

  private kafkaTimestamp(timestamp: string): string {
    const milliseconds = Number(timestamp);
    if (!Number.isFinite(milliseconds)) {
      throw new ContractValidationError("LegacyAgentResult", [
        {
          path: "/completedAt",
          message: "cannot be inferred from the Kafka timestamp",
          keyword: "format",
        },
      ]);
    }
    return new Date(milliseconds).toISOString();
  }

  private logInboundError(
    error: unknown,
    transport: AgentTransportMetadata,
    payload: unknown,
  ): void {
    const context = {
      adapter: this.kind,
      invocationId: this.stringField(payload, "invocationId"),
      executionId: this.stringField(payload, "executionId"),
      stepExecutionId: this.stringField(payload, "stepExecutionId"),
      messageKey: transport.messageKey,
      topic: transport.topic,
      partition: transport.partition,
      offset: transport.offset,
    };

    if (error instanceof AgentAdapterError) {
      console.error("Agent result handling failed", {
        ...context,
        errorCode: error.code,
        retryable: error.retryable,
      });
      return;
    }
    if (error instanceof ContractValidationError) {
      console.error("Rejected invalid agent result", {
        ...context,
        contract: error.contract,
        issues: error.issues,
      });
      return;
    }
    console.error("Rejected unreadable agent result", {
      ...context,
      contract: "AgentResultV1",
      issues: [
        {
          path: "/",
          message: "message is not valid JSON",
        },
      ],
    });
  }

  private stringField(value: unknown, field: string): string | undefined {
    return this.isRecord(value) && typeof value[field] === "string"
      ? value[field]
      : undefined;
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }
}
