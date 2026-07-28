export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type AgentInvocationV1 = {
  schemaVersion: "1";
  invocationId: string;
  executionId: string;
  stepExecutionId: string;
  stepId: string;
  target: {
    agent: string;
  };
  input: JsonValue;
  context?: Record<string, JsonValue>;
  attempt: number;
  createdAt: string;
  deadlineAt?: string;
  trace: {
    traceId: string;
    correlationId: string;
  };
  metadata?: Record<string, JsonValue>;
};

export type AgentResultStatus =
  | "succeeded"
  | "failed"
  | "cancelled"
  | "timed_out";

export type AgentResultV1 = {
  schemaVersion: "1";
  invocationId: string;
  executionId: string;
  stepExecutionId: string;
  status: AgentResultStatus;
  output?: JsonValue;
  error?: {
    code: string;
    message: string;
    retryable: boolean;
    details?: Record<string, JsonValue>;
  };
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    costUsd?: number;
  };
  artifacts?: Array<{
    id: string;
    name: string;
    mediaType?: string;
    uri?: string;
    metadata?: Record<string, JsonValue>;
  }>;
  startedAt?: string;
  completedAt: string;
  metadata?: Record<string, JsonValue>;
};

export type AgentEventType =
  | "accepted"
  | "progress"
  | "log"
  | "heartbeat"
  | "artifact"
  | "completed"
  | "failed";

export type AgentEventV1 = {
  schemaVersion: "1";
  eventId: string;
  invocationId: string;
  executionId: string;
  stepExecutionId: string;
  sequence: number;
  type: AgentEventType;
  occurredAt: string;
  payload: Record<string, JsonValue>;
  trace: {
    traceId: string;
    correlationId: string;
  };
  metadata?: Record<string, JsonValue>;
};

export type LegacyInvocationDefaults = {
  invocationId: string;
  executionId: string;
  stepExecutionId: string;
  stepId: string;
  agent: string;
  attempt: number;
  traceId: string;
  correlationId: string;
  createdAt: string;
  deadlineAt?: string;
};

export type LegacyResultDefaults = {
  invocationId: string;
  executionId: string;
  stepExecutionId: string;
  completedAt: string;
  startedAt?: string;
};
