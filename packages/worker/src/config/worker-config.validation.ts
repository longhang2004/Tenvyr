import type { TenvyrWorkerConfig } from "../public/types";

export type ParsedWorkerConfig<TInput, TOutput> = TenvyrWorkerConfig<
  TInput,
  TOutput
> & {
  execution: Required<
    NonNullable<TenvyrWorkerConfig<TInput, TOutput>["execution"]>
  >;
  idempotency: Required<
    NonNullable<TenvyrWorkerConfig<TInput, TOutput>["idempotency"]>
  >;
  callbackDelivery: Required<
    NonNullable<TenvyrWorkerConfig<TInput, TOutput>["callbackDelivery"]>
  >;
  events: Required<NonNullable<TenvyrWorkerConfig<TInput, TOutput>["events"]>>;
  callbackPolicy: Required<
    TenvyrWorkerConfig<TInput, TOutput>["callbackPolicy"]
  >;
  server: Required<NonNullable<TenvyrWorkerConfig<TInput, TOutput>["server"]>>;
};

export function parseWorkerConfig<TInput, TOutput>(
  config: TenvyrWorkerConfig<TInput, TOutput>,
): ParsedWorkerConfig<TInput, TOutput> {
  if (!config || typeof config !== "object")
    throw invalid("Worker configuration is required");
  if (
    !config.agent ||
    typeof config.agent.execute !== "function" ||
    !config.agent.name?.trim()
  ) {
    throw invalid("Agent name and execute handler are required");
  }
  nonEmpty(config.authentication?.bearerToken, "Bearer token");

  const keys = config.callbackAuthentication?.keys;
  if (!keys || Object.keys(keys).length === 0)
    throw invalid("At least one callback key is required");
  for (const [keyId, secret] of Object.entries(keys)) {
    nonEmpty(keyId, "Callback key ID");
    nonEmpty(secret, "Callback secret");
  }

  const allowedOrigins = config.callbackPolicy?.allowedOrigins;
  if (!Array.isArray(allowedOrigins) || allowedOrigins.length === 0) {
    throw invalid("At least one callback origin is required");
  }
  const allowInsecureHttp = config.callbackPolicy.allowInsecureHttp ?? false;
  const normalizedOrigins = allowedOrigins.map((origin) =>
    normalizeOrigin(origin, allowInsecureHttp),
  );

  const parsed: ParsedWorkerConfig<TInput, TOutput> = {
    ...config,
    authentication: { bearerToken: config.authentication.bearerToken },
    callbackAuthentication: { keys: { ...keys } },
    callbackPolicy: {
      allowedOrigins: normalizedOrigins,
      allowInsecureHttp,
      maxResponseBytes: positiveInteger(
        config.callbackPolicy.maxResponseBytes ?? 64 * 1024,
        "Callback response-size limit",
      ),
    },
    execution: {
      timeoutMs: positiveInteger(
        config.execution?.timeoutMs ?? 15 * 60 * 1000,
        "Execution timeout",
      ),
      concurrency: positiveInteger(
        config.execution?.concurrency ?? 4,
        "Execution concurrency",
      ),
      maxQueuedRuns: nonNegativeInteger(
        config.execution?.maxQueuedRuns ?? 100,
        "Execution queue capacity",
      ),
    },
    idempotency: {
      ttlMs: positiveInteger(
        config.idempotency?.ttlMs ?? 24 * 60 * 60 * 1000,
        "Idempotency TTL",
      ),
      maxEntries: positiveInteger(
        config.idempotency?.maxEntries ?? 10_000,
        "Idempotency capacity",
      ),
    },
    callbackDelivery: {
      maxAttempts: positiveInteger(
        config.callbackDelivery?.maxAttempts ?? 8,
        "Callback attempts",
      ),
      initialDelayMs: positiveInteger(
        config.callbackDelivery?.initialDelayMs ?? 500,
        "Callback initial delay",
      ),
      maxDelayMs: positiveInteger(
        config.callbackDelivery?.maxDelayMs ?? 30_000,
        "Callback maximum delay",
      ),
      jitterRatio: ratio(
        config.callbackDelivery?.jitterRatio ?? 0.2,
        "Callback jitter ratio",
      ),
      requestTimeoutMs: positiveInteger(
        config.callbackDelivery?.requestTimeoutMs ?? 10_000,
        "Callback request timeout",
      ),
    },
    events: {
      enabled: config.events?.enabled === true,
      // Only meaningful when events are enabled; still validated when provided.
      heartbeatIntervalMs: boundedPositiveInteger(
        config.events?.heartbeatIntervalMs ?? 60_000,
        "Event heartbeat interval",
        1000,
        3_600_000,
      ),
    },
    server: {
      maxRequestBytes: positiveInteger(
        config.server?.maxRequestBytes ?? 1024 * 1024,
        "Request-size limit",
      ),
      shutdownGraceMs: positiveInteger(
        config.server?.shutdownGraceMs ?? 30_000,
        "Shutdown grace period",
      ),
    },
  };
  if (
    parsed.callbackDelivery.initialDelayMs > parsed.callbackDelivery.maxDelayMs
  ) {
    throw invalid("Callback initial delay must not exceed maximum delay");
  }
  const loggerLevels = ["debug", "info", "warn", "error"] as const;
  if (
    config.logger &&
    loggerLevels.some((level) => typeof config.logger?.[level] !== "function")
  ) {
    throw invalid("Logger must implement debug, info, warn, and error");
  }
  if (
    config.onCallbackDeliveryFailed &&
    typeof config.onCallbackDeliveryFailed !== "function"
  ) {
    throw invalid("Callback delivery failure hook must be a function");
  }
  return parsed;
}

function normalizeOrigin(value: unknown, allowInsecureHttp: boolean): string {
  const raw = nonEmpty(value, "Callback origin");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw invalid("Callback origin must be a valid URL origin");
  }
  if (url.username || url.password)
    throw invalid("Callback origin must not contain credentials");
  if (url.pathname !== "/" || url.search || url.hash) {
    throw invalid(
      "Callback origin must not contain a path, query, or fragment",
    );
  }
  if (
    url.protocol !== "https:" &&
    !(url.protocol === "http:" && allowInsecureHttp)
  ) {
    throw invalid(
      "Callback origin requires HTTPS unless insecure HTTP is explicitly allowed",
    );
  }
  if (url.origin !== raw.replace(/\/$/, ""))
    throw invalid("Callback origin must contain only an origin");
  return url.origin;
}

function nonEmpty(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim())
    throw invalid(`${field} must be a non-empty string`);
  return value;
}

function positiveInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw invalid(`${field} must be a positive integer`);
  }
  return value;
}

function boundedPositiveInteger(
  value: unknown,
  field: string,
  min: number,
  max: number,
): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < min ||
    value > max
  ) {
    throw invalid(`${field} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function nonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw invalid(`${field} must be a non-negative integer`);
  }
  return value;
}

function ratio(value: unknown, field: string): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > 1
  ) {
    throw invalid(`${field} must be between 0 and 1`);
  }
  return value;
}

function invalid(message: string): Error {
  return new Error(`Invalid Tenvyr Worker configuration: ${message}`);
}
