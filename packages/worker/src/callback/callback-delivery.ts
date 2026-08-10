import { randomUUID } from "crypto";
import type { AgentResultV1 } from "@tenvyr/contracts";
import { safeLogger } from "../observability/safe-logger";
import type { WorkerLogger } from "../public/types";
import { asJsonValue } from "../execution/json-value";
import { createCallbackSignature } from "./callback-signer";
import { parseRetryAfterDeltaSeconds } from "./retry-after";

export type CallbackDeliveryConfig = {
  maxAttempts: number;
  initialDelayMs: number;
  maxDelayMs: number;
  jitterRatio: number;
  requestTimeoutMs: number;
  maxResponseBytes: number;
};

export type CallbackDeliveryOutcome =
  | {
      delivered: true;
      deliveryId: string;
      attempts: number;
      httpStatus: number;
    }
  | {
      delivered: false;
      deliveryId: string;
      attempts: number;
      reason: string;
      httpStatus?: number;
    };

type DeliveryInput = {
  agent: string;
  runId: string;
  result: AgentResultV1;
  callbackUrl: string;
  keyId: string;
  secret: string;
  config: CallbackDeliveryConfig;
  logger: WorkerLogger;
  signal?: AbortSignal;
};

type SignedBodyDeliveryInput = {
  agent: string;
  runId: string;
  invocationId: string;
  /** Log subject, e.g. "Agent callback" or "Agent event". */
  subject: string;
  /** Exact bytes to POST; built once by the caller and reused across retries. */
  rawBody: Buffer<ArrayBuffer>;
  callbackUrl: string;
  keyId: string;
  secret: string;
  config: CallbackDeliveryConfig;
  logger: WorkerLogger;
  signal?: AbortSignal;
};

type DeliveryDependencies = {
  id?: () => string;
  now?: () => number;
  random?: () => number;
  sleep?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
  fetch?: typeof fetch;
};

export function classifyCallbackResponse(
  status: number,
): "delivered" | "retry" | "do-not-retry" {
  if (status >= 200 && status <= 299) return "delivered";
  if (status === 408 || status === 429 || (status >= 500 && status <= 599))
    return "retry";
  return "do-not-retry";
}

export async function deliverCallback(
  input: DeliveryInput,
  dependencies: DeliveryDependencies = {},
): Promise<CallbackDeliveryOutcome> {
  const rawBody = Buffer.from(
    JSON.stringify(asJsonValue(input.result)),
    "utf8",
  );
  return deliverSignedBody(
    {
      agent: input.agent,
      runId: input.runId,
      invocationId: input.result.invocationId,
      subject: "Agent callback",
      rawBody,
      callbackUrl: input.callbackUrl,
      keyId: input.keyId,
      secret: input.secret,
      config: input.config,
      logger: input.logger,
      signal: input.signal,
    },
    dependencies,
  );
}

/**
 * Deliver an already-serialized body with the same HMAC signing, retry,
 * backoff, and failure classification as the AgentResult callback. Each call
 * is one delivery operation with its own deliveryId; the caller-provided
 * rawBody is reused verbatim across retry attempts.
 */
export async function deliverSignedBody(
  input: SignedBodyDeliveryInput,
  dependencies: DeliveryDependencies = {},
): Promise<CallbackDeliveryOutcome> {
  const id = dependencies.id ?? randomUUID;
  const now = dependencies.now ?? Date.now;
  const random = dependencies.random ?? Math.random;
  const sleep = dependencies.sleep ?? defaultSleep;
  const fetchRequest = dependencies.fetch ?? fetch;
  const logger = safeLogger(input.logger);
  const deliveryId = id();
  const callbackHost = new URL(input.callbackUrl).host;
  let lastStatus: number | undefined;
  let lastReason = "delivery-failed";
  for (let attempt = 1; attempt <= input.config.maxAttempts; attempt += 1) {
    if (input.signal?.aborted) {
      return {
        delivered: false,
        deliveryId,
        attempts: attempt - 1,
        reason: "worker-shutdown",
      };
    }
    const timestamp = String(Math.floor(now() / 1000));
    const signature = createCallbackSignature(
      input.secret,
      timestamp,
      deliveryId,
      input.rawBody,
    );
    const startedAt = Date.now();
    const controller = new AbortController();
    const forwardAbort = () => controller.abort();
    input.signal?.addEventListener("abort", forwardAbort, { once: true });
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, input.config.requestTimeoutMs);

    try {
      const response = await fetchRequest(input.callbackUrl, {
        method: "POST",
        redirect: "manual",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "X-AgentWeave-Key-Id": input.keyId,
          "X-AgentWeave-Timestamp": timestamp,
          "X-AgentWeave-Delivery-Id": deliveryId,
          "X-AgentWeave-Signature": signature,
          "User-Agent": "Tenvyr-Worker/0.1.0",
        },
        body: input.rawBody,
      });
      lastStatus = response.status;
      try {
        await readLimitedResponse(response, input.config.maxResponseBytes);
      } catch {
        lastReason = "response-too-large";
        logger.error(`${input.subject} delivery failed`, {
          agent: input.agent,
          runId: input.runId,
          invocationId: input.invocationId,
          deliveryId,
          callbackHost,
          attempt,
          httpStatus: response.status,
          durationMs: Date.now() - startedAt,
          outcome: lastReason,
        });
        return {
          delivered: false,
          deliveryId,
          attempts: attempt,
          reason: lastReason,
          httpStatus: response.status,
        };
      }

      const classification = classifyCallbackResponse(response.status);
      if (classification === "delivered") {
        logger.info(`${input.subject} delivered`, {
          agent: input.agent,
          runId: input.runId,
          invocationId: input.invocationId,
          deliveryId,
          callbackHost,
          attempt,
          httpStatus: response.status,
          durationMs: Date.now() - startedAt,
          outcome: "delivered",
        });
        return {
          delivered: true,
          deliveryId,
          attempts: attempt,
          httpStatus: response.status,
        };
      }
      lastReason =
        classification === "retry"
          ? "retryable-http-status"
          : "non-retryable-http-status";
      if (
        classification === "do-not-retry" ||
        attempt === input.config.maxAttempts
      ) {
        return {
          delivered: false,
          deliveryId,
          attempts: attempt,
          reason: lastReason,
          httpStatus: response.status,
        };
      }
      const retryAfterSeconds = parseRetryAfterDeltaSeconds(
        response.headers.get("retry-after"),
        input.config.maxDelayMs / 1000,
      );
      const delay =
        retryAfterSeconds === undefined
          ? backoffDelay(input.config, attempt, random())
          : retryAfterSeconds * 1000;
      await sleep(delay, input.signal);
    } catch {
      if (input.signal?.aborted) {
        return {
          delivered: false,
          deliveryId,
          attempts: attempt,
          reason: "worker-shutdown",
        };
      }
      lastReason = timedOut ? "request-timeout" : "network-error";
      if (attempt === input.config.maxAttempts) {
        return {
          delivered: false,
          deliveryId,
          attempts: attempt,
          reason: lastReason,
        };
      }
      try {
        await sleep(
          backoffDelay(input.config, attempt, random()),
          input.signal,
        );
      } catch {
        return {
          delivered: false,
          deliveryId,
          attempts: attempt,
          reason: input.signal?.aborted ? "worker-shutdown" : "backoff-failed",
        };
      }
    } finally {
      clearTimeout(timeout);
      input.signal?.removeEventListener("abort", forwardAbort);
    }
  }

  return {
    delivered: false,
    deliveryId,
    attempts: input.config.maxAttempts,
    reason: lastReason,
    ...(lastStatus === undefined ? {} : { httpStatus: lastStatus }),
  };
}

function backoffDelay(
  config: CallbackDeliveryConfig,
  attempt: number,
  random: number,
): number {
  const base = Math.min(
    config.maxDelayMs,
    config.initialDelayMs * 2 ** (attempt - 1),
  );
  const factor = 1 + (random * 2 - 1) * config.jitterRatio;
  return Math.max(0, Math.min(config.maxDelayMs, Math.round(base * factor)));
}

async function readLimitedResponse(
  response: Response,
  limit: number,
): Promise<void> {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > limit) {
    try {
      await response.body?.cancel();
    } catch {
      // The response is already rejected; cancellation is best-effort cleanup.
    }
    throw new Error("response too large");
  }
  if (!response.body) return;
  const reader = response.body.getReader();
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) return;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw new Error("response too large");
    }
  }
}

function defaultSleep(delayMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("aborted"));
      return;
    }
    const onAbort = () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      reject(new Error("aborted"));
    };
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
