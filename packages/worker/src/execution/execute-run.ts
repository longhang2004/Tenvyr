import {
  parseAgentResult,
  type AgentInvocationV1,
  type AgentResultV1,
  type JsonValue,
} from "@agentweave/contracts";
import { AgentExecutionError } from "../public/errors";
import type {
  AgentDefinition,
  AgentExecutionSuccess,
  WorkerLogger,
} from "../public/types";
import { runLogger } from "../observability/safe-logger";
import {
  createExecutionContext,
  isStructuredSuccess,
} from "./execution-context";
import { asJsonValue } from "./json-value";

type ExecuteAgentInput<TInput, TOutput> = {
  agent: AgentDefinition<TInput, TOutput>;
  invocation: AgentInvocationV1;
  runId: string;
  timeoutMs: number;
  logger: WorkerLogger;
  now?: () => number;
  shutdownSignal?: AbortSignal;
};

type HandlerOutcome<TOutput> =
  | { kind: "returned"; value: TOutput | AgentExecutionSuccess<TOutput> }
  | { kind: "threw"; error: unknown };

export async function executeAgent<TInput, TOutput>({
  agent,
  invocation,
  runId,
  timeoutMs,
  logger,
  now = Date.now,
  shutdownSignal,
}: ExecuteAgentInput<TInput, TOutput>): Promise<AgentResultV1> {
  const startedAt = new Date(now()).toISOString();
  const controller = new AbortController();
  const scopedLogger = runLogger(logger, {
    agent: agent.name,
    invocationId: invocation.invocationId,
    executionId: invocation.executionId,
    stepExecutionId: invocation.stepExecutionId,
    runId,
    attempt: invocation.attempt,
  });

  let input: TInput;
  try {
    input = agent.inputParser
      ? parseWith(agent.inputParser, invocation.input)
      : (invocation.input as unknown as TInput);
  } catch {
    return failedResult(invocation, startedAt, now, {
      code: "AGENT_INPUT_INVALID",
      message: "Agent input validation failed",
      retryable: false,
    });
  }

  const context = createExecutionContext({
    invocation,
    runId,
    signal: controller.signal,
    logger: scopedLogger,
  });
  const handler: Promise<HandlerOutcome<TOutput>> = Promise.resolve()
    .then(() => agent.execute(context, input))
    .then(
      (value): HandlerOutcome<TOutput> => ({ kind: "returned", value }),
      (error): HandlerOutcome<TOutput> => ({ kind: "threw", error }),
    );

  let timeoutHandle: NodeJS.Timeout | undefined;
  let shutdownListener: (() => void) | undefined;
  const timeout = new Promise<{ kind: "timeout" }>((resolve) => {
    timeoutHandle = setTimeout(() => {
      resolve({ kind: "timeout" });
      controller.abort();
    }, timeoutMs);
  });
  const shutdown = shutdownSignal
    ? new Promise<{ kind: "shutdown" }>((resolve) => {
        shutdownListener = () => {
          resolve({ kind: "shutdown" });
          controller.abort();
        };
        if (shutdownSignal.aborted) shutdownListener();
        else
          shutdownSignal.addEventListener("abort", shutdownListener, {
            once: true,
          });
      })
    : new Promise<never>(() => undefined);

  const outcome = await Promise.race([handler, timeout, shutdown]);
  if (timeoutHandle) clearTimeout(timeoutHandle);
  if (shutdownSignal && shutdownListener)
    shutdownSignal.removeEventListener("abort", shutdownListener);

  if (outcome.kind === "timeout") {
    void handler.then(() =>
      scopedLogger.warn("Ignoring late agent completion after timeout"),
    );
    return terminalError(invocation, startedAt, now, "timed_out", {
      code: "AGENT_EXECUTION_TIMEOUT",
      message: "Agent execution exceeded its configured timeout",
      retryable: true,
    });
  }
  if (outcome.kind === "shutdown") {
    void handler.then(() =>
      scopedLogger.warn("Ignoring late agent completion after shutdown"),
    );
    return terminalError(invocation, startedAt, now, "cancelled", {
      code: "WORKER_SHUTDOWN",
      message: "Worker shutdown cancelled the execution",
      retryable: true,
    });
  }
  if (outcome.kind === "threw") {
    if (outcome.error instanceof AgentExecutionError) {
      return failedResult(invocation, startedAt, now, outcome.error.failure);
    }
    scopedLogger.error("Agent execution failed", {
      errorName:
        outcome.error instanceof Error
          ? outcome.error.name
          : typeof outcome.error,
    });
    return failedResult(invocation, startedAt, now, {
      code: "AGENT_EXECUTION_FAILED",
      message: "Agent execution failed",
      retryable: false,
    });
  }

  try {
    const structured = isStructuredSuccess<TOutput>(outcome.value);
    const success = structured
      ? (outcome.value as AgentExecutionSuccess<TOutput>)
      : undefined;
    const candidate = structured ? success?.output : (outcome.value as TOutput);
    const hasOutput = structured
      ? Object.prototype.hasOwnProperty.call(success, "output")
      : candidate !== undefined;
    const parsedOutput =
      hasOutput && agent.outputParser
        ? parseWith(agent.outputParser, candidate)
        : candidate;
    const result: AgentResultV1 = {
      schemaVersion: "1",
      invocationId: invocation.invocationId,
      executionId: invocation.executionId,
      stepExecutionId: invocation.stepExecutionId,
      status: "succeeded",
      ...(hasOutput ? { output: asJsonValue(parsedOutput) } : {}),
      ...(success?.usage ? { usage: success.usage } : {}),
      ...(success?.artifacts ? { artifacts: success.artifacts } : {}),
      ...(success?.metadata ? { metadata: success.metadata } : {}),
      startedAt,
      completedAt: new Date(now()).toISOString(),
    };
    return parseAgentResult(result);
  } catch {
    return failedResult(invocation, startedAt, now, {
      code: "AGENT_OUTPUT_INVALID",
      message: "Agent output validation failed",
      retryable: false,
    });
  }
}

function parseWith<T>(
  parser: { parse(value: unknown): T } | ((value: unknown) => T),
  value: unknown,
): T {
  return typeof parser === "function" ? parser(value) : parser.parse(value);
}

function failedResult(
  invocation: AgentInvocationV1,
  startedAt: string,
  now: () => number,
  error: AgentExecutionError["failure"],
): AgentResultV1 {
  return terminalError(invocation, startedAt, now, "failed", error);
}

function terminalError(
  invocation: AgentInvocationV1,
  startedAt: string,
  now: () => number,
  status: "failed" | "cancelled" | "timed_out",
  error: {
    code: string;
    message: string;
    retryable: boolean;
    details?: Record<string, JsonValue>;
  },
): AgentResultV1 {
  return parseAgentResult({
    schemaVersion: "1",
    invocationId: invocation.invocationId,
    executionId: invocation.executionId,
    stepExecutionId: invocation.stepExecutionId,
    status,
    error,
    startedAt,
    completedAt: new Date(now()).toISOString(),
  });
}
