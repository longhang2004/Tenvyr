import type {
  AgentInvocationV1,
  AgentResultV1,
  JsonValue,
} from "@tenvyr/contracts";

export type WorkerLifecycleState =
  | "created"
  | "starting"
  | "running"
  | "stopping"
  | "stopped"
  | "failed";

export type WorkerAddress = {
  host: string;
  port: number;
};

export interface WorkerLogger {
  debug(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

export type AgentFailureOptions = {
  code: string;
  message: string;
  retryable: boolean;
  details?: Record<string, JsonValue>;
};

export type AgentExecutionSuccess<TOutput> = {
  output?: TOutput;
  usage?: AgentResultV1["usage"];
  artifacts?: AgentResultV1["artifacts"];
  metadata?: Record<string, JsonValue>;
};

type ValueParser<T> = { parse(value: unknown): T } | ((value: unknown) => T);
type AgentExecutionReturn<TOutput> = TOutput | AgentExecutionSuccess<TOutput>;

export interface AgentExecutionContext {
  readonly invocation: AgentInvocationV1;
  readonly runId: string;
  readonly signal: AbortSignal;
  readonly logger: WorkerLogger;
  success<TOutput>(
    value?: AgentExecutionSuccess<TOutput>,
  ): AgentExecutionSuccess<TOutput>;
  fail(options: AgentFailureOptions): never;
}

export type AgentDefinition<TInput = unknown, TOutput = unknown> = {
  name: string;
  version?: string;
  inputParser?: ValueParser<TInput>;
  outputParser?: ValueParser<TOutput>;
  execute(
    context: AgentExecutionContext,
    input: TInput,
  ): Promise<AgentExecutionReturn<TOutput>> | AgentExecutionReturn<TOutput>;
};

export type CallbackDeliveryFailedEvent = {
  agent: string;
  invocationId: string;
  runId: string;
  deliveryId: string;
  attempts: number;
  callbackHost: string;
  httpStatus?: number;
  reason: string;
};

export type TenvyrWorkerConfig<TInput = unknown, TOutput = unknown> = {
  agent: AgentDefinition<TInput, TOutput>;
  authentication: { bearerToken: string };
  callbackAuthentication: { keys: Record<string, string> };
  callbackPolicy: {
    allowedOrigins: string[];
    allowInsecureHttp?: boolean;
    maxResponseBytes?: number;
  };
  execution?: {
    timeoutMs?: number;
    concurrency?: number;
    maxQueuedRuns?: number;
  };
  idempotency?: {
    ttlMs?: number;
    maxEntries?: number;
  };
  callbackDelivery?: {
    maxAttempts?: number;
    initialDelayMs?: number;
    maxDelayMs?: number;
    jitterRatio?: number;
    requestTimeoutMs?: number;
  };
  server?: {
    maxRequestBytes?: number;
    shutdownGraceMs?: number;
  };
  logger?: WorkerLogger;
  onCallbackDeliveryFailed?: (
    event: CallbackDeliveryFailedEvent,
  ) => void | Promise<void>;
};

export interface TenvyrWorker {
  readonly agentName: string;
  start(options?: { host?: string; port?: number }): Promise<WorkerAddress>;
  stop(options?: { graceMs?: number }): Promise<void>;
  getState(): WorkerLifecycleState;
}
