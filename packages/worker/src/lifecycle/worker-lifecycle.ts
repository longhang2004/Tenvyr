import { randomUUID } from "crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "http";
import type { AddressInfo } from "net";
import {
  parseAgentResult,
  parseHttpAgentRunAccepted,
  parseHttpAgentRunRequest,
  type AgentInvocationV1,
  type AgentResultV1,
  type HttpAgentRunRequestV1,
} from "@tenvyr/contracts";
import { authenticateBearer } from "../auth/bearer-auth";
import { validateCallbackUrl } from "../auth/callback-policy";
import { deliverCallback } from "../callback/callback-delivery";
import type { ParsedWorkerConfig } from "../config/worker-config.validation";
import { executeAgent } from "../execution/execute-run";
import { errorResponse, jsonResponse } from "../http/response";
import { readRequestBody } from "../http/request-body";
import { requestFingerprint } from "../invocation/canonical-json";
import {
  InMemoryIdempotencyStore,
  type RunRecord,
} from "../invocation/idempotency-store";
import { RunScheduler } from "../invocation/run-scheduler";
import { noOpLogger, safeLogger } from "../observability/safe-logger";
import type {
  TenvyrWorker,
  CallbackDeliveryFailedEvent,
  WorkerAddress,
  WorkerLifecycleState,
} from "../public/types";

export class TenvyrWorkerRuntime<TInput, TOutput> implements TenvyrWorker {
  readonly agentName: string;

  private state: WorkerLifecycleState = "created";
  private server?: Server;
  private address?: WorkerAddress;
  private startPromise?: Promise<WorkerAddress>;
  private stopPromise?: Promise<void>;
  private cleanupTimer?: NodeJS.Timeout;
  private readonly store: InMemoryIdempotencyStore;
  private readonly scheduler: RunScheduler;
  private readonly shutdownController = new AbortController();
  private readonly executionControllers = new Set<AbortController>();
  private readonly callbackControllers = new Set<AbortController>();
  private readonly callbackWork = new Set<Promise<void>>();

  constructor(private readonly config: ParsedWorkerConfig<TInput, TOutput>) {
    this.agentName = config.agent.name;
    this.store = new InMemoryIdempotencyStore(config.idempotency);
    this.scheduler = new RunScheduler(config.execution);
  }

  getState(): WorkerLifecycleState {
    return this.state;
  }

  start(
    options: { host?: string; port?: number } = {},
  ): Promise<WorkerAddress> {
    if (this.state === "running" && this.address)
      return Promise.resolve(this.address);
    if (this.state === "starting" && this.startPromise)
      return this.startPromise;
    if (this.state !== "created") {
      return Promise.reject(
        new Error(`Tenvyr Worker cannot start from ${this.state} state`),
      );
    }
    this.state = "starting";
    this.startPromise = this.bind(
      options.host ?? "127.0.0.1",
      options.port ?? 8080,
    );
    return this.startPromise;
  }

  stop(options: { graceMs?: number } = {}): Promise<void> {
    if (this.state === "stopped") return Promise.resolve();
    if (this.state === "stopping" && this.stopPromise) return this.stopPromise;
    if (this.state === "created" || this.state === "failed") {
      this.state = "stopped";
      return Promise.resolve();
    }
    this.state = "stopping";
    const graceMs = options.graceMs ?? this.config.server.shutdownGraceMs;
    this.stopPromise =
      this.startPromise && !this.address
        ? this.stopAfterStart(graceMs)
        : this.shutdown(graceMs);
    return this.stopPromise;
  }

  private async bind(host: string, port: number): Promise<WorkerAddress> {
    const server = createServer((request, response) => {
      void this.handleRequest(request, response).catch((error) => {
        this.config.logger?.error("Worker HTTP request failed", {
          errorName: error instanceof Error ? error.name : typeof error,
        });
        if (!response.headersSent) {
          errorResponse(
            response,
            500,
            "INTERNAL_ERROR",
            "Worker could not process the request",
          );
        } else {
          response.end();
        }
      });
    });
    this.server = server;
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => {
          server.off("listening", onListening);
          reject(error);
        };
        const onListening = () => {
          server.off("error", onError);
          resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(port, host);
      });
      const bound = server.address() as AddressInfo;
      this.address = { host, port: bound.port };
      if (this.state === "stopping") return this.address;
      this.cleanupTimer = setInterval(
        () => this.store.cleanup(Date.now()),
        Math.min(this.config.idempotency.ttlMs, 60_000),
      );
      this.cleanupTimer.unref();
      this.state = "running";
      return this.address;
    } catch (error) {
      if (this.state !== "stopping") this.state = "failed";
      await closeServer(server);
      throw error;
    }
  }

  private async stopAfterStart(graceMs: number): Promise<void> {
    try {
      await this.startPromise;
    } catch {
      this.state = "stopped";
      return;
    }
    await this.shutdown(graceMs);
  }

  private async handleRequest(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const path = new URL(request.url ?? "/", "http://worker.local").pathname;
    if (request.method === "GET" && path === "/health/live") {
      jsonResponse(response, 200, { status: "ok" });
      return;
    }
    if (request.method === "GET" && path === "/health/ready") {
      jsonResponse(response, this.state === "running" ? 200 : 503, {
        status: this.state === "running" ? "ok" : "unavailable",
      });
      return;
    }
    if (request.method !== "POST" || path !== "/v1/runs") {
      errorResponse(response, 404, "NOT_FOUND", "Route not found");
      return;
    }
    if (this.state !== "running") {
      request.resume();
      errorResponse(
        response,
        503,
        "WORKER_NOT_READY",
        "Worker is not accepting runs",
      );
      return;
    }
    if (!isJsonContentType(request.headers["content-type"])) {
      request.resume();
      errorResponse(
        response,
        415,
        "UNSUPPORTED_MEDIA_TYPE",
        "Content-Type must be application/json",
      );
      return;
    }
    if (
      !authenticateBearer(
        request.headers.authorization,
        this.config.authentication.bearerToken,
      )
    ) {
      request.resume();
      errorResponse(
        response,
        401,
        "UNAUTHORIZED",
        "Bearer authentication failed",
        {
          "WWW-Authenticate": "Bearer",
        },
      );
      return;
    }

    const body = await readRequestBody(
      request,
      this.config.server.maxRequestBytes,
    );
    if (body.tooLarge) {
      errorResponse(
        response,
        413,
        "REQUEST_TOO_LARGE",
        "Request body exceeded the configured limit",
      );
      return;
    }
    let value: unknown;
    try {
      value = JSON.parse((body.body as Buffer).toString("utf8"));
    } catch {
      errorResponse(
        response,
        400,
        "INVALID_JSON",
        "Request body must be valid JSON",
      );
      return;
    }

    let runRequest: HttpAgentRunRequestV1;
    try {
      runRequest = parseHttpAgentRunRequest(value);
    } catch {
      errorResponse(
        response,
        400,
        "INVALID_REQUEST",
        "Request does not match HttpAgentRunRequestV1",
      );
      return;
    }
    if (runRequest.invocation.target.agent !== this.agentName) {
      errorResponse(
        response,
        404,
        "AGENT_NOT_FOUND",
        "Target agent is not hosted by this Worker",
      );
      return;
    }
    const idempotencyKey = singleHeader(request.headers["idempotency-key"]);
    if (
      !idempotencyKey ||
      idempotencyKey !== runRequest.invocation.invocationId
    ) {
      errorResponse(
        response,
        400,
        "INVALID_IDEMPOTENCY_KEY",
        "Idempotency-Key must equal invocationId",
      );
      return;
    }
    const keyId = runRequest.resultDelivery.authentication.keyId;
    if (
      !Object.prototype.hasOwnProperty.call(
        this.config.callbackAuthentication.keys,
        keyId,
      )
    ) {
      errorResponse(
        response,
        400,
        "UNKNOWN_CALLBACK_KEY",
        "Callback key ID is not configured",
      );
      return;
    }
    try {
      validateCallbackUrl(
        runRequest.resultDelivery.callbackUrl,
        this.config.callbackPolicy,
      );
    } catch {
      errorResponse(
        response,
        400,
        "CALLBACK_TARGET_REJECTED",
        "Callback URL is not allowed",
      );
      return;
    }

    const nowMs = Date.now();
    const fingerprint = requestFingerprint(runRequest, idempotencyKey);
    const existing = this.store.lookup(
      runRequest.invocation.invocationId,
      fingerprint,
      nowMs,
    );
    if (existing.kind === "duplicate") {
      jsonResponse(
        response,
        202,
        acceptance(
          existing.record.invocationId,
          existing.record.runId,
          existing.record.acceptedAt,
        ),
      );
      return;
    }
    if (existing.kind === "conflict") {
      errorResponse(
        response,
        409,
        "IDEMPOTENCY_CONFLICT",
        "Invocation ID was already used by another request",
      );
      return;
    }
    if (!this.scheduler.hasCapacity()) {
      errorResponse(response, 429, "QUEUE_FULL", "Worker run queue is full");
      return;
    }

    const acceptedAt = new Date(nowMs).toISOString();
    let record: RunRecord;
    try {
      record = this.createRecord(
        runRequest.invocation.invocationId,
        fingerprint,
        acceptedAt,
        nowMs,
      );
    } catch (error) {
      if (error instanceof CapacityError) {
        errorResponse(
          response,
          429,
          "IDEMPOTENCY_CAPACITY_FULL",
          "Worker idempotency capacity is full",
        );
        return;
      }
      throw error;
    }
    const accepted = acceptance(
      record.invocationId,
      record.runId,
      record.acceptedAt,
    );
    jsonResponse(response, 202, accepted);
    this.store.updateState(record, "queued", Date.now());
    const enqueued = this.scheduler.enqueue({
      run: async () => this.executeRun(record, runRequest),
      cancel: async () => this.cancelQueuedRun(record, runRequest),
    });
    if (!enqueued) {
      await this.cancelQueuedRun(record, runRequest);
    }
  }

  private createRecord(
    invocationId: string,
    fingerprint: string,
    acceptedAt: string,
    nowMs: number,
  ): RunRecord {
    try {
      return this.store.create({
        invocationId,
        requestFingerprint: fingerprint,
        runId: randomUUID(),
        acceptedAt,
        nowMs,
      });
    } catch {
      throw new CapacityError();
    }
  }

  private async executeRun(
    record: RunRecord,
    request: HttpAgentRunRequestV1,
  ): Promise<void> {
    this.store.updateState(record, "running", Date.now());
    const controller = new AbortController();
    this.executionControllers.add(controller);
    let result: AgentResultV1;
    try {
      result = await executeAgent({
        agent: this.config.agent,
        invocation: request.invocation,
        runId: record.runId,
        timeoutMs: this.config.execution.timeoutMs,
        logger: this.config.logger ?? noOpLogger,
        shutdownSignal: controller.signal,
      });
    } finally {
      this.executionControllers.delete(controller);
    }
    this.trackCallback(this.deliverResult(record, request, result));
  }

  private async cancelQueuedRun(
    record: RunRecord,
    request: HttpAgentRunRequestV1,
  ): Promise<void> {
    const result = shutdownResult(request.invocation);
    await this.deliverResult(record, request, result);
  }

  private async deliverResult(
    record: RunRecord,
    request: HttpAgentRunRequestV1,
    result: AgentResultV1,
  ): Promise<void> {
    this.store.updateState(record, "callback_pending", Date.now());
    const controller = new AbortController();
    const signal = AbortSignal.any([
      controller.signal,
      this.shutdownController.signal,
    ]);
    this.callbackControllers.add(controller);
    try {
      const keyId = request.resultDelivery.authentication.keyId;
      const outcome = await deliverCallback({
        agent: this.agentName,
        runId: record.runId,
        result,
        callbackUrl: request.resultDelivery.callbackUrl,
        keyId,
        secret: this.config.callbackAuthentication.keys[keyId],
        config: {
          ...this.config.callbackDelivery,
          maxResponseBytes: this.config.callbackPolicy.maxResponseBytes,
        },
        logger: this.config.logger ?? noOpLogger,
        signal,
      });
      this.store.updateState(
        record,
        outcome.delivered ? "delivered" : "callback_failed",
        Date.now(),
      );
      if (!outcome.delivered) {
        if (outcome.reason === "worker-shutdown") {
          safeLogger(this.config.logger ?? noOpLogger).warn(
            "Agent callback skipped during forced Worker shutdown",
            {
              agent: this.agentName,
              invocationId: result.invocationId,
              runId: record.runId,
              deliveryId: outcome.deliveryId,
            },
          );
        }
        await this.notifyCallbackDeliveryFailed(
          {
            agent: this.agentName,
            invocationId: result.invocationId,
            runId: record.runId,
            deliveryId: outcome.deliveryId,
            attempts: outcome.attempts,
            callbackHost: new URL(request.resultDelivery.callbackUrl).host,
            ...(outcome.httpStatus === undefined
              ? {}
              : { httpStatus: outcome.httpStatus }),
            reason: outcome.reason,
          },
          signal,
        );
      }
    } finally {
      this.callbackControllers.delete(controller);
    }
  }

  private async notifyCallbackDeliveryFailed(
    event: CallbackDeliveryFailedEvent,
    signal: AbortSignal,
  ): Promise<void> {
    const hook = this.config.onCallbackDeliveryFailed;
    if (!hook || signal.aborted) return;
    const hookOutcome = Promise.resolve()
      .then(() => hook(event))
      .then(
        () => "completed" as const,
        () => "failed" as const,
      );
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<"aborted">((resolve) => {
      onAbort = () => resolve("aborted");
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    });
    const outcome = await Promise.race([hookOutcome, aborted]);
    if (onAbort) signal.removeEventListener("abort", onAbort);
    if (outcome === "failed") {
      (this.config.logger ?? noOpLogger).error(
        "Callback delivery failure hook failed",
        {
          agent: event.agent,
          invocationId: event.invocationId,
          runId: event.runId,
          deliveryId: event.deliveryId,
        },
      );
    }
  }

  private trackCallback(work: Promise<void>): void {
    const tracked = work.catch((error) => {
      (this.config.logger ?? noOpLogger).error(
        "Callback delivery failed unexpectedly",
        {
          errorName: error instanceof Error ? error.name : typeof error,
        },
      );
    });
    this.callbackWork.add(tracked);
    void tracked.finally(() => this.callbackWork.delete(tracked));
  }

  private async shutdown(graceMs: number): Promise<void> {
    const shutdownStartedAt = Date.now();
    const close = this.server ? closeServer(this.server) : Promise.resolve();
    const cancelled = this.scheduler.stopAccepting();
    const drained = Promise.all([this.waitForDrain(cancelled), close]).then(
      () => undefined,
    );
    const remainingGraceMs = Math.max(
      0,
      graceMs - (Date.now() - shutdownStartedAt),
    );
    const completedWithinGrace = await raceWithTimeout(
      drained,
      remainingGraceMs,
    );
    if (!completedWithinGrace) {
      this.shutdownController.abort();
      for (const controller of this.executionControllers) controller.abort();
      for (const controller of this.callbackControllers) controller.abort();
      this.server?.closeAllConnections?.();
      await this.waitForDrain(cancelled);
    }
    await close;
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    this.cleanupTimer = undefined;
    this.state = "stopped";
  }

  private async waitForDrain(cancelled: Promise<void>): Promise<void> {
    await Promise.all([cancelled, this.scheduler.onIdle()]);
    while (this.callbackWork.size > 0) {
      await Promise.allSettled([...this.callbackWork]);
    }
  }
}

class CapacityError extends Error {}

function acceptance(invocationId: string, runId: string, acceptedAt: string) {
  return parseHttpAgentRunAccepted({
    schemaVersion: "1",
    invocationId,
    runId,
    status: "accepted",
    acceptedAt,
  });
}

function shutdownResult(invocation: AgentInvocationV1): AgentResultV1 {
  return parseAgentResult({
    schemaVersion: "1",
    invocationId: invocation.invocationId,
    executionId: invocation.executionId,
    stepExecutionId: invocation.stepExecutionId,
    status: "cancelled",
    error: {
      code: "WORKER_SHUTDOWN",
      message: "Worker shutdown cancelled the execution",
      retryable: true,
    },
    completedAt: new Date().toISOString(),
  });
}

function isJsonContentType(value: string | undefined): boolean {
  return (
    typeof value === "string" && /^application\/json(?:\s*;|$)/i.test(value)
  );
}

function singleHeader(
  value: string | string[] | undefined,
): string | undefined {
  return Array.isArray(value) ? undefined : value;
}

function closeServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve) => server.close(() => resolve()));
}

async function raceWithTimeout(
  work: Promise<void>,
  timeoutMs: number,
): Promise<boolean> {
  let timeout: NodeJS.Timeout | undefined;
  const result = await Promise.race([
    work.then(() => true),
    new Promise<false>((resolve) => {
      timeout = setTimeout(() => resolve(false), timeoutMs);
    }),
  ]);
  if (timeout) clearTimeout(timeout);
  return result;
}
