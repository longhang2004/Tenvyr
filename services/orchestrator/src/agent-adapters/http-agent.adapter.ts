import {
  parseAgentEvent,
  parseAgentInvocation,
  parseAgentResult,
  parseHttpAgentRunAccepted,
  parseHttpAgentRunRequest,
} from "@tenvyr/contracts";
import { Injectable } from "@nestjs/common";
import { createHash } from "node:crypto";
import { AgentAdapterError } from "./agent-adapter.errors";

/**
 * M7-S4: deterministic W3C traceparent (`00-<traceId>-<spanId>-01`).
 * The trace id is the invocation's execution-scoped trace id normalized
 * to 32 hex chars; the span id is a stable derivation of the invocation
 * id (never a random value, so redeliveries and replicas agree). Returns
 * null when the invocation carries no trace identity. Outbound-only:
 * inbound trace headers are never trusted.
 */
export function w3cTraceparent(invocation: {
  trace?: { traceId?: string; correlationId?: string };
  invocationId?: string;
}): string | null {
  const traceId = invocation.trace?.traceId;
  const invocationId = invocation.invocationId;
  if (!traceId || !invocationId) return null;
  const normalized = traceId.replace(/-/g, "").toLowerCase();
  // W3C forbids an all-zero trace id; reject it like any malformed value.
  if (!/^[0-9a-f]{32}$/.test(normalized) || normalized === "0".repeat(32)) {
    return null;
  }
  const spanId = createHash("sha256").update(invocationId).digest("hex").slice(0, 16);
  return `00-${normalized}-${spanId}-01`;
}
import type {
  AgentAdapter,
  AgentAdapterHandlers,
  AgentDispatchReceipt,
  AgentTransportMetadata,
} from "./agent-adapter.types";
import { AgentTransportConfigService } from "./agent-transport-config.service";
import { verifyHttpCallbackSignature } from "./http-callback-auth";
import { EventPayloadTooLargeError } from "../services/agent-event.service";
import type { ExecutorDescriptorV1 } from "../executors/executor-descriptor";

type HttpCallbackRequest = {
  agent: string;
  keyId?: string;
  timestamp?: string;
  deliveryId?: string;
  signature?: string;
  rawBody: Buffer;
  remoteAddress?: string;
  nowMs?: number;
};

type ReplayEntry = {
  state: "in-flight" | "completed";
  expiresAt: number;
};

@Injectable()
export class HttpAgentAdapter implements AgentAdapter {
  readonly kind = "http";

  private handlers?: AgentAdapterHandlers;
  private replayCleanupTimer?: NodeJS.Timeout;
  private readonly replayEntries = new Map<string, ReplayEntry>();
  private readonly activeRequests = new Set<AbortController>();

  constructor(private readonly config: AgentTransportConfigService) {}

  async start(handlers: AgentAdapterHandlers): Promise<void> {
    if (this.handlers) {
      if (this.handlers === handlers) return;
      throw new AgentAdapterError(
        "ADAPTER_START_FAILED",
        this.kind,
        "HTTP agent adapter already has handlers",
        {
          retryable: false,
        },
      );
    }

    this.handlers = handlers;
    const { replayTtlMs } = this.config.callbackSettings();
    this.replayCleanupTimer = setInterval(
      () => this.cleanupReplayEntries(Date.now()),
      replayTtlMs,
    );
    this.replayCleanupTimer.unref();
  }

  async stop(): Promise<void> {
    if (!this.handlers && !this.replayCleanupTimer) return;

    this.handlers = undefined;
    if (this.replayCleanupTimer) clearInterval(this.replayCleanupTimer);
    this.replayCleanupTimer = undefined;
    this.replayEntries.clear();
    for (const controller of this.activeRequests) controller.abort();
    this.activeRequests.clear();
  }

  async invoke(
    invocation: Parameters<AgentAdapter["invoke"]>[0],
    pinned?: ExecutorDescriptorV1,
  ): Promise<AgentDispatchReceipt> {
    if (!this.handlers) {
      throw new AgentAdapterError(
        "ADAPTER_NOT_STARTED",
        this.kind,
        "HTTP agent adapter is not started",
        {
          invocationId: invocation.invocationId,
          retryable: true,
        },
      );
    }

    const payload = parseAgentInvocation(invocation);
    const configuration = this.config.httpForAgent(payload.target.agent);
    if (pinned && !configuration) {
      // M3: the attempt is pinned to an HTTP executor whose live profile is
      // missing or rotated (agent removed or no longer HTTP). Deterministic
      // safe failure — never an automatic fallback to another executor.
      throw new AgentAdapterError(
        "EXECUTOR_PROFILE_MISMATCH",
        this.kind,
        `Pinned HTTP executor profile for agent "${payload.target.agent}" no longer matches live configuration`,
        {
          invocationId: payload.invocationId,
          retryable: false,
        },
      );
    }
    if (!configuration) {
      throw new AgentAdapterError(
        "HTTP_AGENT_NOT_CONFIGURED",
        this.kind,
        "HTTP agent transport is not configured",
        {
          invocationId: payload.invocationId,
          retryable: false,
        },
      );
    }
    if (pinned && !pinned.httpProfile) {
      // The router already guards this; keep the adapter strict so a direct
      // caller can never fall back to live routing behind a pinned request.
      throw new AgentAdapterError(
        "EXECUTOR_PROFILE_MISMATCH",
        this.kind,
        "Pinned HTTP executor descriptor is missing its routing profile",
        {
          invocationId: payload.invocationId,
          retryable: false,
        },
      );
    }

    // M3: routing facts come from the frozen descriptor when pinned; the live
    // configuration only contributes secret values (bearer token, callback
    // credentials) for that exact profile.
    const submitUrl = pinned?.httpProfile?.submitUrl ?? configuration.submitUrl;
    const requestTimeoutMs =
      pinned?.httpProfile?.requestTimeoutMs ?? configuration.requestTimeoutMs;
    const maxResponseBytes =
      pinned?.httpProfile?.maxResponseBytes ?? configuration.maxResponseBytes;

    const request = parseHttpAgentRunRequest({
      schemaVersion: "1",
      invocation: payload,
      resultDelivery: {
        mode: "callback",
        callbackUrl: this.config.callbackUrlFor(payload.target.agent),
        authentication: {
          scheme: "hmac-sha256",
          keyId: configuration.callbackAuthentication.keyId,
        },
      },
    });

    let body: string;
    try {
      body = JSON.stringify(request);
    } catch (cause) {
      throw new AgentAdapterError(
        "SERIALIZATION_FAILED",
        this.kind,
        "HTTP invocation could not be serialized",
        {
          invocationId: payload.invocationId,
          retryable: false,
          cause,
        },
      );
    }

    const startedAt = Date.now();
    const submitHost = new URL(submitUrl).host;
    const controller = new AbortController();
    this.activeRequests.add(controller);
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, requestTimeoutMs);

    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        Accept: "application/json",
        "Idempotency-Key": payload.invocationId,
        "User-Agent": "Tenvyr-Orchestrator/0.1.0",
      };
      if (configuration.outboundAuthentication.type === "bearer") {
        headers.Authorization = `Bearer ${configuration.outboundAuthentication.token}`;
      }

      // M7-S4: outbound-only W3C trace context. The orchestrator never
      // TRUSTS inbound trace headers — this header is derived
      // deterministically from the invocation's own trace identity, so
      // foreign trace/baggage can never widen authority or capture.
      const traceparent = w3cTraceparent(payload);
      if (traceparent) {
        headers.traceparent = traceparent;
      }

      const response = await fetch(submitUrl, {
        method: "POST",
        headers,
        body,
        signal: controller.signal,
      });
      if (response.status !== 202) {
        throw new AgentAdapterError(
          "HTTP_REJECTED",
          this.kind,
          "Remote HTTP agent rejected the invocation",
          {
            invocationId: payload.invocationId,
            retryable:
              response.status === 408 ||
              response.status === 429 ||
              response.status >= 500,
            httpStatus: response.status,
          },
        );
      }
      if (
        !response.headers
          .get("content-type")
          ?.toLowerCase()
          .includes("application/json")
      ) {
        throw invalidResponse(payload.invocationId);
      }

      const responseBody = await this.readResponse(
        response,
        maxResponseBytes,
        payload.invocationId,
      );
      let acceptedValue: unknown;
      try {
        acceptedValue = JSON.parse(responseBody);
      } catch (cause) {
        throw invalidResponse(payload.invocationId, cause);
      }

      let accepted;
      try {
        accepted = parseHttpAgentRunAccepted(acceptedValue);
      } catch (cause) {
        throw invalidResponse(payload.invocationId, cause);
      }
      if (accepted.invocationId !== payload.invocationId) {
        throw new AgentAdapterError(
          "HTTP_INVOCATION_MISMATCH",
          this.kind,
          "Remote HTTP acceptance did not match the invocation",
          {
            invocationId: payload.invocationId,
            retryable: false,
          },
        );
      }

      console.log("HTTP agent invocation accepted", {
        adapter: this.kind,
        agent: payload.target.agent,
        invocationId: payload.invocationId,
        executionId: payload.executionId,
        stepExecutionId: payload.stepExecutionId,
        attempt: payload.attempt,
        submitHost,
        remoteRunId: accepted.runId,
        durationMs: Date.now() - startedAt,
      });
      return {
        adapter: this.kind,
        invocationId: payload.invocationId,
        dispatchedAt: new Date().toISOString(),
        dispatchId: accepted.runId,
      };
    } catch (cause) {
      const error =
        cause instanceof AgentAdapterError
          ? cause
          : new AgentAdapterError(
              timedOut ? "HTTP_REQUEST_TIMEOUT" : "HTTP_CONNECTION_FAILED",
              this.kind,
              timedOut
                ? "HTTP agent request timed out"
                : "HTTP agent connection failed",
              {
                invocationId: payload.invocationId,
                retryable: true,
                cause,
              },
            );
      console.error("HTTP agent invocation failed", {
        adapter: this.kind,
        agent: payload.target.agent,
        invocationId: payload.invocationId,
        errorCode: error.code,
        retryable: error.retryable,
        httpStatus: error.httpStatus,
        submitHost,
        durationMs: Date.now() - startedAt,
      });
      throw error;
    } finally {
      clearTimeout(timeout);
      this.activeRequests.delete(controller);
    }
  }

  async handleCallback(
    request: HttpCallbackRequest,
  ): Promise<"processed" | "duplicate"> {
    const configuration = this.config.httpForAgent(request.agent);
    if (
      !configuration ||
      !request.keyId ||
      request.keyId !== configuration.callbackAuthentication.keyId
    ) {
      throw callbackUnauthorized();
    }
    const settings = this.config.callbackSettings();
    verifyHttpCallbackSignature({
      secret: configuration.callbackAuthentication.secret,
      timestamp: request.timestamp,
      deliveryId: request.deliveryId,
      signature: request.signature,
      rawBody: request.rawBody,
      maxSkewSeconds: settings.callbackMaxSkewSeconds,
      nowMs: request.nowMs,
    });
    // The delivery id is authenticated (it is covered by the HMAC) but
    // unbounded by the protocol, and it is persisted into varchar(255)
    // transport columns on both the event and result paths. Bound it at this
    // trust boundary so an authenticated-but-malformed value is a permanent
    // 400 rejection, never a DB overflow misclassified as retryable
    // infrastructure failure.
    if ((request.deliveryId as string).length > 255) {
      throw new AgentAdapterError(
        "CALLBACK_INVALID",
        this.kind,
        "HTTP callback delivery id exceeds the durable 255-character bound",
        {
          retryable: false,
        },
      );
    }
    if (!this.handlers) {
      throw new AgentAdapterError(
        "CALLBACK_HANDLER_UNAVAILABLE",
        this.kind,
        "HTTP callback handlers are unavailable",
        {
          retryable: true,
        },
      );
    }

    const deliveryId = request.deliveryId as string;
    const now = request.nowMs ?? Date.now();
    const replayKey = `${request.agent}\0${request.keyId}\0${deliveryId}`;
    this.cleanupReplayEntries(now);
    const existing = this.replayEntries.get(replayKey);
    if (existing && existing.state === "completed") {
      console.warn("Ignoring duplicate HTTP callback delivery", {
        adapter: this.kind,
        agent: request.agent,
        deliveryId,
        keyId: request.keyId,
      });
      return "duplicate";
    }
    if (!existing) {
      // An in-flight duplicate (same deliveryId processed concurrently) is
      // routed through the durable result handler; the ResultInbox, not this
      // process-local map, is the authoritative deduplicator across replicas.
      this.reserveReplayEntry(
        replayKey,
        now + settings.replayTtlMs,
        settings.replayMaxEntries,
      );
    }

    let value: unknown;
    try {
      value = JSON.parse(request.rawBody.toString("utf8"));
    } catch (cause) {
      this.replayEntries.delete(replayKey);
      throw new AgentAdapterError(
        "CALLBACK_INVALID",
        this.kind,
        "HTTP callback body is invalid JSON",
        {
          retryable: false,
          cause,
        },
      );
    }

    // Explicit shape discrimination after authentication and signature
    // verification: a canonical AgentResult carries status+completedAt, a
    // canonical AgentEvent carries eventId+sequence+type. Payloads that look
    // like both are ambiguous and rejected rather than guessed at.
    const record = value as Record<string, unknown>;
    const resultShape =
      typeof record.status === "string" &&
      typeof record.completedAt === "string";
    const eventShape =
      typeof record.eventId === "string" &&
      typeof record.sequence === "number" &&
      typeof record.type === "string";
    if (resultShape && eventShape) {
      this.replayEntries.delete(replayKey);
      throw new AgentAdapterError(
        "CALLBACK_AMBIGUOUS",
        this.kind,
        "HTTP callback body matches both AgentResult and AgentEvent shapes",
        {
          retryable: false,
        },
      );
    }

    const transport: AgentTransportMetadata = {
      adapter: this.kind,
      receivedAt: new Date().toISOString(),
      deliveryId,
      keyId: request.keyId,
      remoteAddress: request.remoteAddress,
    };

    if (eventShape) {
      let event;
      try {
        event = parseAgentEvent(value);
      } catch (cause) {
        this.replayEntries.delete(replayKey);
        throw cause;
      }
      try {
        await this.handlers.event({ event, transport });
      } catch (cause) {
        this.replayEntries.delete(replayKey);
        throw new AgentAdapterError(
          "EVENT_HANDLER_FAILED",
          this.kind,
          "HTTP callback event handler failed",
          {
            invocationId: event.invocationId,
            // Oversized payloads are permanently rejected: the worker must
            // drop them, not retry forever.
            retryable: !(cause instanceof EventPayloadTooLargeError),
            cause,
          },
        );
      }
      this.replayEntries.set(replayKey, {
        state: "completed",
        expiresAt: now + settings.replayTtlMs,
      });
      console.log("HTTP agent event processed", {
        adapter: this.kind,
        agent: request.agent,
        invocationId: event.invocationId,
        executionId: event.executionId,
        stepExecutionId: event.stepExecutionId,
        eventId: event.eventId,
        type: event.type,
        sequence: event.sequence,
        deliveryId,
        keyId: request.keyId,
      });
      return "processed";
    }

    let result;
    try {
      result = parseAgentResult(value);
    } catch (cause) {
      this.replayEntries.delete(replayKey);
      throw cause;
    }
    try {
      await this.handlers.result({ result, transport });
    } catch (cause) {
      this.replayEntries.delete(replayKey);
      throw new AgentAdapterError(
        "RESULT_HANDLER_FAILED",
        this.kind,
        "HTTP callback result handler failed",
        {
          invocationId: result.invocationId,
          retryable: true,
          cause,
        },
      );
    }

    this.replayEntries.set(replayKey, {
      state: "completed",
      expiresAt: now + settings.replayTtlMs,
    });
    console.log("HTTP agent result processed", {
      adapter: this.kind,
      agent: request.agent,
      invocationId: result.invocationId,
      executionId: result.executionId,
      stepExecutionId: result.stepExecutionId,
      status: result.status,
      deliveryId,
      keyId: request.keyId,
    });
    return "processed";
  }

  private async readResponse(
    response: Response,
    limit: number,
    invocationId: string,
  ): Promise<string> {
    const contentLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > limit)
      throw responseTooLarge(invocationId);
    if (!response.body) return "";

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw responseTooLarge(invocationId);
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString("utf8");
  }

  private cleanupReplayEntries(now: number): void {
    for (const [key, entry] of this.replayEntries) {
      if (entry.expiresAt <= now) this.replayEntries.delete(key);
    }
  }

  private reserveReplayEntry(
    key: string,
    expiresAt: number,
    maxEntries: number,
  ): void {
    if (this.replayEntries.size >= maxEntries) {
      const oldestKey = this.replayEntries.keys().next().value;
      if (oldestKey !== undefined) this.replayEntries.delete(oldestKey);
    }
    this.replayEntries.set(key, { state: "in-flight", expiresAt });
  }
}

function invalidResponse(
  invocationId: string,
  cause?: unknown,
): AgentAdapterError {
  return new AgentAdapterError(
    "HTTP_INVALID_RESPONSE",
    "http",
    "Remote HTTP agent returned an invalid response",
    {
      invocationId,
      retryable: false,
      cause,
    },
  );
}

function responseTooLarge(invocationId: string): AgentAdapterError {
  return new AgentAdapterError(
    "HTTP_RESPONSE_TOO_LARGE",
    "http",
    "Remote HTTP agent response exceeded the limit",
    {
      invocationId,
      retryable: false,
    },
  );
}

function callbackUnauthorized(): AgentAdapterError {
  return new AgentAdapterError(
    "CALLBACK_UNAUTHORIZED",
    "http",
    "HTTP callback authentication failed",
    {
      retryable: false,
    },
  );
}
