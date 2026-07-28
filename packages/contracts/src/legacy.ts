import {
  AgentInvocationV1,
  AgentResultV1,
  JsonValue,
  LegacyInvocationDefaults,
  LegacyResultDefaults,
} from "./types";
import {
  ContractValidationError,
  ContractValidationIssue,
  parseAgentInvocation,
  parseAgentResult,
} from "./validation";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function legacyError(
  contract: string,
  issues: ContractValidationIssue[],
): never {
  throw new ContractValidationError(contract, issues);
}

function requireRecord(
  value: unknown,
  contract: string,
): Record<string, unknown> {
  if (!isRecord(value)) {
    return legacyError(contract, [
      { path: "/", message: "must be an object", keyword: "type" },
    ]);
  }
  return value;
}

function assertMatches(
  payload: Record<string, unknown>,
  field: string,
  expected: string | number,
): void {
  const actual = payload[field];
  if (actual !== undefined && actual !== expected) {
    legacyError("LegacyAgentContract", [
      {
        path: `/${field}`,
        message: "does not match caller-provided orchestration context",
        keyword: "context",
      },
    ]);
  }
}

function durationMs(value: unknown): number | undefined {
  if (typeof value === "number") return value > 0 ? value : undefined;
  if (typeof value !== "string") return undefined;
  const match = value.trim().match(/^(\d+(?:\.\d+)?)(ms|s|m|h)?$/i);
  if (!match) return undefined;
  const factors: Record<string, number> = {
    ms: 1,
    s: 1_000,
    m: 60_000,
    h: 3_600_000,
  };
  return Number(match[1]) * factors[(match[2] || "ms").toLowerCase()];
}

function deriveDeadline(
  createdAt: string,
  timeout: unknown,
): string | undefined {
  const milliseconds = durationMs(timeout);
  if (!milliseconds) return undefined;
  const created = Date.parse(createdAt);
  return Number.isNaN(created)
    ? undefined
    : new Date(created + milliseconds).toISOString();
}

export function normalizeLegacyInvocation(
  value: unknown,
  defaults: LegacyInvocationDefaults,
): AgentInvocationV1 {
  if (isRecord(value) && value.schemaVersion === "1")
    return parseAgentInvocation(value);

  const payload = requireRecord(value, "LegacyAgentInvocation");
  assertMatches(payload, "executionId", defaults.executionId);
  assertMatches(payload, "stepId", defaults.stepId);
  assertMatches(payload, "agent", defaults.agent);
  assertMatches(payload, "attempt", defaults.attempt);

  const legacyMetadata: Record<string, JsonValue> = {};
  if (typeof payload.maxAttempts === "number")
    legacyMetadata.maxAttempts = payload.maxAttempts;
  if (
    typeof payload.timeout === "string" ||
    typeof payload.timeout === "number"
  ) {
    legacyMetadata.timeout = payload.timeout;
  }

  return parseAgentInvocation({
    schemaVersion: "1",
    invocationId: defaults.invocationId,
    executionId: defaults.executionId,
    stepExecutionId: defaults.stepExecutionId,
    stepId: defaults.stepId,
    target: { agent: defaults.agent },
    input: payload.input,
    attempt: defaults.attempt,
    createdAt: defaults.createdAt,
    deadlineAt:
      defaults.deadlineAt ||
      deriveDeadline(defaults.createdAt, payload.timeout),
    trace: {
      traceId: defaults.traceId,
      correlationId: defaults.correlationId,
    },
    metadata: Object.keys(legacyMetadata).length
      ? { legacy: legacyMetadata }
      : undefined,
  });
}

export function normalizeLegacyResult(
  value: unknown,
  defaults: LegacyResultDefaults,
): AgentResultV1 {
  if (isRecord(value) && value.schemaVersion === "1")
    return parseAgentResult(value);

  const payload = requireRecord(value, "LegacyAgentResult");
  assertMatches(payload, "executionId", defaults.executionId);

  if (payload.status !== "COMPLETED" && payload.status !== "FAILED") {
    return legacyError("LegacyAgentResult", [
      {
        path: "/status",
        message: "must be COMPLETED or FAILED",
        keyword: "enum",
      },
    ]);
  }
  if (typeof payload.stepId !== "string" || !payload.stepId) {
    return legacyError("LegacyAgentResult", [
      {
        path: "/stepId",
        message: "must be a non-empty string",
        keyword: "type",
      },
    ]);
  }

  const succeeded = payload.status === "COMPLETED";
  const output = payload.output !== undefined ? payload.output : payload.data;
  const message =
    typeof payload.error === "string"
      ? payload.error
      : isRecord(payload.error) && typeof payload.error.message === "string"
        ? payload.error.message
        : undefined;

  if (!succeeded && !message) {
    return legacyError("LegacyAgentResult", [
      {
        path: "/error",
        message: "is required for a failed legacy result",
        keyword: "required",
      },
    ]);
  }

  return parseAgentResult({
    schemaVersion: "1",
    invocationId: defaults.invocationId,
    executionId: defaults.executionId,
    stepExecutionId: defaults.stepExecutionId,
    status: succeeded ? "succeeded" : "failed",
    output: output as JsonValue | undefined,
    error: succeeded
      ? undefined
      : {
          code: "LEGACY_AGENT_FAILURE",
          message,
          retryable: false,
        },
    startedAt: defaults.startedAt,
    completedAt: defaults.completedAt,
    metadata: {
      legacy: {
        stepId: payload.stepId,
        ...(typeof payload.attempt === "number"
          ? { attempt: payload.attempt }
          : {}),
      },
    },
  });
}
