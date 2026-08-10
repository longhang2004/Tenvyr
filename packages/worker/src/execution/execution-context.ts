import type { AgentInvocationV1, JsonValue } from "@tenvyr/contracts";
import { AgentExecutionError } from "../public/errors";
import type {
  AgentExecutionContext,
  AgentExecutionSuccess,
  AgentFailureOptions,
  WorkerLogger,
} from "../public/types";
import type { RunEventEmitter } from "../events/event-emitter";

const structuredSuccess = Symbol("TenvyrStructuredSuccess");

type BrandedSuccess<TOutput> = AgentExecutionSuccess<TOutput> & {
  [structuredSuccess]: true;
};

const agentEventTypes = new Set(["progress", "log", "artifact"]);

export function createExecutionContext(input: {
  invocation: AgentInvocationV1;
  runId: string;
  signal: AbortSignal;
  logger: WorkerLogger;
  eventEmitter?: RunEventEmitter;
}): AgentExecutionContext {
  const emitter = input.eventEmitter;
  return {
    ...input,
    success<TOutput>(
      value: AgentExecutionSuccess<TOutput> = {},
    ): AgentExecutionSuccess<TOutput> {
      const result = { ...value } as BrandedSuccess<TOutput>;
      Object.defineProperty(result, structuredSuccess, { value: true });
      return result;
    },
    fail(options: AgentFailureOptions): never {
      throw new AgentExecutionError(options);
    },
    progress(payload: Record<string, JsonValue>): void {
      emitter?.emit("progress", payload);
    },
    log(messageOrPayload: string | Record<string, JsonValue>): void {
      const payload =
        typeof messageOrPayload === "string"
          ? { message: messageOrPayload }
          : messageOrPayload;
      emitter?.emit("log", payload);
    },
    artifact(metadata: Record<string, JsonValue>): void {
      emitter?.emit("artifact", metadata);
    },
    event(
      type: "progress" | "log" | "artifact",
      payload: Record<string, JsonValue>,
    ): void {
      if (!agentEventTypes.has(type)) {
        throw new Error(
          `Agent events of type "${String(type)}" are reserved for the Worker runtime`,
        );
      }
      emitter?.emit(type, payload);
    },
  };
}

export function isStructuredSuccess<TOutput>(
  value: unknown,
): value is AgentExecutionSuccess<TOutput> {
  return Boolean(
    value &&
    typeof value === "object" &&
    (value as Partial<BrandedSuccess<TOutput>>)[structuredSuccess] === true,
  );
}
