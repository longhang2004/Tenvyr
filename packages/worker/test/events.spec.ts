import { createHmac } from "crypto";
import { createServer, type Server } from "http";
import type { AddressInfo } from "net";
import {
  parseAgentEvent,
  type AgentEventV1,
  type AgentInvocationV1,
  type AgentResultV1,
  type HttpAgentRunRequestV1,
  type JsonValue,
} from "@tenvyr/contracts";
import { createTenvyrWorker, defineAgent, type TenvyrWorker } from "../src";
import { parseWorkerConfig } from "../src/config/worker-config.validation";
import {
  MAX_EVENT_PAYLOAD_BYTES,
  RunEventEmitter,
} from "../src/events/event-emitter";
import { createExecutionContext } from "../src/execution/execution-context";
import { noOpLogger } from "../src/observability/safe-logger";

type CallbackRequest = {
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
};

const invocation = (
  overrides: Partial<AgentInvocationV1> = {},
): AgentInvocationV1 => ({
  schemaVersion: "1",
  invocationId: "invocation-1",
  executionId: "execution-1",
  stepExecutionId: "step-execution-1",
  stepId: "echo",
  target: { agent: "echo-agent" },
  input: { message: "hello" },
  attempt: 1,
  createdAt: "2026-07-26T00:00:00.000Z",
  trace: { traceId: "trace-1", correlationId: "invocation-1" },
  ...overrides,
});

const validConfig = () => ({
  agent: defineAgent({
    name: "echo-agent",
    async execute(_context, input: unknown) {
      return input;
    },
  }),
  authentication: { bearerToken: "worker-token" },
  callbackAuthentication: { keys: { "callback-v1": "callback-secret" } },
  callbackPolicy: { allowedOrigins: ["https://orchestrator.example"] },
});

describe("events configuration", () => {
  it("defaults to disabled with a bounded heartbeat interval", () => {
    expect(parseWorkerConfig(validConfig()).events).toEqual({
      enabled: false,
      heartbeatIntervalMs: 60_000,
    });
  });

  it("accepts an explicitly enabled configuration", () => {
    expect(
      parseWorkerConfig({
        ...validConfig(),
        events: { enabled: true, heartbeatIntervalMs: 5000 },
      }).events,
    ).toEqual({ enabled: true, heartbeatIntervalMs: 5000 });
  });

  it.each([
    ["below the minimum", { heartbeatIntervalMs: 999 }],
    ["above the maximum", { heartbeatIntervalMs: 3_600_001 }],
    ["non-integer", { heartbeatIntervalMs: 1500.5 }],
    ["not a number", { heartbeatIntervalMs: "5000" }],
  ])("rejects a heartbeat interval %s", (_case, events) => {
    expect(() =>
      parseWorkerConfig({ ...validConfig(), events } as never),
    ).toThrow(/heartbeat interval/i);
  });
});

describe("run event emitter", () => {
  const fixedNow = Date.parse("2026-07-26T00:00:01.000Z");
  const makeEmitter = (options: {
    enabled?: boolean;
    deliver?: (event: AgentEventV1, rawBody: Buffer) => void;
    logger?: typeof noOpLogger;
  } = {}) => {
    const delivered: Array<{ event: AgentEventV1; rawBody: Buffer }> = [];
    const emitter = new RunEventEmitter({
      invocation: invocation(),
      runId: "run-1",
      enabled: options.enabled ?? true,
      logger: options.logger ?? noOpLogger,
      now: () => fixedNow,
      deliver: options.deliver ?? ((event, rawBody) => {
        delivered.push({ event, rawBody });
      }),
    });
    return { emitter, delivered };
  };

  it("assigns sequence 0, 1, 2 with deterministic eventIds and captured occurredAt/trace", () => {
    const { emitter, delivered } = makeEmitter();
    emitter.emit("accepted", { acceptedAt: "2026-07-26T00:00:00.000Z" });
    emitter.emit("progress", { step: 1 });
    emitter.emit("completed", { status: "succeeded" });

    expect(delivered.map(({ event }) => event.sequence)).toEqual([0, 1, 2]);
    expect(delivered.map(({ event }) => event.eventId)).toEqual([
      "invocation-1:0",
      "invocation-1:1",
      "invocation-1:2",
    ]);
    for (const { event } of delivered) {
      expect(event.schemaVersion).toBe("1");
      expect(event.occurredAt).toBe("2026-07-26T00:00:01.000Z");
      expect(event.trace).toEqual({
        traceId: "trace-1",
        correlationId: "invocation-1",
      });
      expect(event.metadata).toEqual({ runId: "run-1" });
      expect(event.invocationId).toBe("invocation-1");
      expect(event.executionId).toBe("execution-1");
      expect(event.stepExecutionId).toBe("step-execution-1");
    }
    expect(delivered[0].event.type).toBe("accepted");
    expect(delivered[0].event.payload).toEqual({
      acceptedAt: "2026-07-26T00:00:00.000Z",
    });
    expect(delivered[2].event.payload).toEqual({ status: "succeeded" });
  });

  it("builds the event body once and reuses the same bytes across retries", () => {
    const { emitter, delivered } = makeEmitter();
    emitter.emit("progress", { step: 1 });

    const { event, rawBody } = delivered[0];
    expect(rawBody.toString("utf8")).toBe(JSON.stringify(event));
    expect(parseAgentEvent(JSON.parse(rawBody.toString("utf8")))).toEqual(
      event,
    );
    // The same body is what the delivery layer replays on every retry attempt.
    expect(delivered[0].rawBody).toBe(rawBody);
    expect(Buffer.isBuffer(rawBody)).toBe(true);
  });

  it("is a no-op when disabled and notes it exactly once", () => {
    const debug = jest.fn();
    const { emitter, delivered } = makeEmitter({
      enabled: false,
      logger: { ...noOpLogger, debug },
    });

    emitter.emit("progress", { step: 1 });
    emitter.emit("progress", { step: 2 });

    expect(delivered).toHaveLength(0);
    expect(debug).toHaveBeenCalledTimes(1);
  });

  it("rejects non-JSON and non-finite payloads with clear errors", () => {
    const { emitter } = makeEmitter();
    const invalid = [
      ["NaN", { n: NaN }],
      ["Infinity", { n: Infinity }],
      ["unsafe integer", { n: Number.MAX_SAFE_INTEGER + 1 }],
      ["function value", { f: () => undefined }],
      ["undefined value", { u: undefined }],
      ["non-object payload", "text"],
      ["array payload", [1, 2]],
    ] as const;

    for (const [label, payload] of invalid) {
      expect(() =>
        emitter.emit(
          "progress",
          payload as unknown as Record<string, JsonValue>,
        ),
      ).toThrow();
      expect(() =>
        emitter.emit(
          "progress",
          payload as unknown as Record<string, JsonValue>,
        ),
      ).toThrow(/Agent event payload/);
    }
  });

  it("rejects circular payloads", () => {
    const { emitter } = makeEmitter();
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() =>
      emitter.emit("progress", circular as never),
    ).toThrow(/circular/);
  });

  it("rejects payloads whose canonical JSON exceeds 64 KiB", () => {
    const { emitter } = makeEmitter();
    const oversized = { data: "x".repeat(MAX_EVENT_PAYLOAD_BYTES) };
    expect(() => emitter.emit("progress", oversized)).toThrow(
      /exceeds the 65536-byte limit/,
    );

    const acceptable = { data: "x".repeat(1024) };
    expect(() => emitter.emit("progress", acceptable)).not.toThrow();
  });

  it("rejects agent attempts to emit system-owned event types", () => {
    const { emitter } = makeEmitter();
    const context = createExecutionContext({
      invocation: invocation(),
      runId: "run-1",
      signal: new AbortController().signal,
      logger: noOpLogger,
      eventEmitter: emitter,
    });

    for (const type of ["accepted", "heartbeat", "completed", "failed"]) {
      expect(() =>
        context.event(
          type as "progress",
          {},
        ),
      ).toThrow(
        `Agent events of type "${type}" are reserved for the Worker runtime`,
      );
    }
  });
});

describe("Tenvyr Worker agent events", () => {
  let callbackServer: Server;
  let callbackOrigin: string;
  let callbackRequests: CallbackRequest[];
  let statusFor: (body: Buffer) => number;
  let worker: TenvyrWorker | undefined;

  beforeEach(async () => {
    callbackRequests = [];
    statusFor = () => 204;
    callbackServer = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks);
      callbackRequests.push({ headers: request.headers, body });
      response.writeHead(statusFor(body));
      response.end();
    });
    await listen(callbackServer);
    callbackOrigin = `http://127.0.0.1:${(callbackServer.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await worker?.stop({ graceMs: 100 });
    await close(callbackServer);
  });

  function makeWorker(
    options: {
      execute?: ReturnType<typeof jest.fn>;
      eventsEnabled?: boolean;
      heartbeatIntervalMs?: number;
      timeoutMs?: number;
      callbackMaxAttempts?: number;
      logger?: {
        debug: jest.Mock;
        info: jest.Mock;
        warn: jest.Mock;
        error: jest.Mock;
      };
      onCallbackDeliveryFailed?: jest.Mock;
    } = {},
  ) {
    const execute =
      options.execute ?? jest.fn(async (_context, input) => input);
    worker = createTenvyrWorker({
      agent: defineAgent({
        name: "echo-agent",
        execute,
      }),
      authentication: { bearerToken: "worker-token" },
      callbackAuthentication: {
        keys: { "callback-v1": "callback-secret" },
      },
      callbackPolicy: {
        allowedOrigins: [callbackOrigin],
        allowInsecureHttp: true,
        maxResponseBytes: 4096,
      },
      execution: {
        timeoutMs: options.timeoutMs ?? 1000,
        concurrency: 1,
        maxQueuedRuns: 1,
      },
      callbackDelivery: {
        maxAttempts: options.callbackMaxAttempts ?? 2,
        initialDelayMs: 1,
        maxDelayMs: 2,
        jitterRatio: 0,
        requestTimeoutMs: 1000,
      },
      server: { maxRequestBytes: 4096, shutdownGraceMs: 100 },
      idempotency: { ttlMs: 1000, maxEntries: 100 },
      ...(options.eventsEnabled === undefined
        ? {}
        : {
            events: {
              enabled: options.eventsEnabled,
              ...(options.heartbeatIntervalMs === undefined
                ? {}
                : { heartbeatIntervalMs: options.heartbeatIntervalMs }),
            },
          }),
      logger: options.logger,
      onCallbackDeliveryFailed: options.onCallbackDeliveryFailed,
    });
    return { worker, execute };
  }

  function runRequest(
    invocationValue = invocation(),
    callbackUrl = `${callbackOrigin}/callback`,
  ): HttpAgentRunRequestV1 {
    return {
      schemaVersion: "1",
      invocation: invocationValue,
      resultDelivery: {
        mode: "callback",
        callbackUrl,
        authentication: { scheme: "hmac-sha256", keyId: "callback-v1" },
      },
    };
  }

  async function start(target = makeWorker().worker): Promise<string> {
    const address = await target.start({ host: "127.0.0.1", port: 0 });
    return `http://${address.host}:${address.port}`;
  }

  function submit(
    baseUrl: string,
    body: string,
    headers: Record<string, string> = {},
  ): Promise<Response> {
    return fetch(`${baseUrl}/v1/runs`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer worker-token",
        "Idempotency-Key": "invocation-1",
        ...headers,
      },
      body,
    });
  }

  const eventBodies = (): AgentEventV1[] =>
    callbackRequests
      .filter((request) =>
        request.body.toString("utf8").includes('"eventId"'),
      )
      .map((request) =>
        parseAgentEvent(JSON.parse(request.body.toString("utf8"))),
      );

  const resultBodies = (): AgentResultV1[] =>
    callbackRequests
      .filter(
        (request) => !request.body.toString("utf8").includes('"eventId"'),
      )
      .map((request) => JSON.parse(request.body.toString("utf8")));

  it("keeps the old behavior when events are disabled: no event callbacks and an unchanged result", async () => {
    const execute = jest.fn(async (context) => {
      context.progress({ step: 1 });
      context.log("ignored when disabled");
      context.artifact({ id: "a1", name: "f.txt" });
      return { echoed: true };
    });
    const baseUrl = await start(makeWorker({ execute }).worker);

    expect((await submit(baseUrl, JSON.stringify(runRequest()))).status).toBe(
      202,
    );
    await waitFor(() => callbackRequests.length === 1);

    expect(eventBodies()).toHaveLength(0);
    expect(callbackRequests).toHaveLength(1);
    expect(resultBodies()[0]).toMatchObject({
      status: "succeeded",
      output: { echoed: true },
    });
  });

  it("emits accepted at sequence 0 and progress events with monotonically increasing sequences", async () => {
    const execute = jest.fn(async (context) => {
      context.progress({ step: 1 });
      context.progress({ step: 2 });
      return "done";
    });
    const baseUrl = await start(
      makeWorker({ execute, eventsEnabled: true }).worker,
    );
    const accepted = (await (
      await submit(baseUrl, JSON.stringify(runRequest()))
    ).json()) as { runId: string };

    await waitFor(() =>
      eventBodies().filter((event) => event.type === "progress").length === 2,
    );
    await waitFor(() =>
      eventBodies().some((event) => event.type === "accepted"),
    );
    await waitFor(() => resultBodies().length === 1);

    const events = eventBodies().sort((a, b) => a.sequence - b.sequence);
    // accepted (0), progress (1), progress (2); a completed (3) may already
    // have been delivered by the time we look.
    expect(events.slice(0, 3).map((event) => event.sequence)).toEqual([
      0, 1, 2,
    ]);
    expect(events.slice(0, 3).map((event) => event.eventId)).toEqual([
      "invocation-1:0",
      "invocation-1:1",
      "invocation-1:2",
    ]);
    expect(events.slice(0, 3).map((event) => event.type)).toEqual([
      "accepted",
      "progress",
      "progress",
    ]);
    expect(events[0].payload).toEqual({
      acceptedAt: expect.any(String),
    });
    expect(events[1].payload).toEqual({ step: 1 });
    expect(events[2].payload).toEqual({ step: 2 });
    for (const event of events) {
      expect(event.trace).toEqual({
        traceId: "trace-1",
        correlationId: "invocation-1",
      });
      expect(event.metadata?.runId).toBe(accepted.runId);
      expect(Date.parse(event.occurredAt)).not.toBeNaN();
    }
    expect(resultBodies()[0]).toMatchObject({ status: "succeeded" });
  });

  it("emits heartbeats on the interval while the run is executing", async () => {
    let release!: () => void;
    const execute = jest.fn(
      async () =>
        new Promise<string>((resolve) => {
          release = () => resolve("slow");
        }),
    );
    const baseUrl = await start(
      makeWorker({
        execute,
        eventsEnabled: true,
        heartbeatIntervalMs: 1000,
        timeoutMs: 5000,
      }).worker,
    );

    expect((await submit(baseUrl, JSON.stringify(runRequest()))).status).toBe(
      202,
    );
    await waitFor(
      () => eventBodies().some((event) => event.type === "heartbeat"),
      3000,
    );
    release();
    await waitFor(() => resultBodies().length === 1);
    await waitFor(() =>
      eventBodies().some((event) => event.type === "completed"),
    );

    const events = eventBodies().sort((a, b) => a.sequence - b.sequence);
    const heartbeats = events.filter((event) => event.type === "heartbeat");
    const accepted = events.find((event) => event.type === "accepted");
    const completed = events.find((event) => event.type === "completed");
    expect(heartbeats.length).toBeGreaterThanOrEqual(1);
    for (const heartbeat of heartbeats) {
      expect(heartbeat.payload).toEqual({});
      expect(heartbeat.sequence).toBeGreaterThan(
        accepted?.sequence as number,
      );
      expect(heartbeat.sequence).toBeLessThan(completed?.sequence as number);
    }
    expect(completed?.sequence).toBeGreaterThan(0);
  });

  it("keeps eventId and body stable across callback retries while each delivery operation gets its own deliveryId", async () => {
    const seenEventIds = new Set<string>();
    statusFor = (body) => {
      const value = JSON.parse(body.toString("utf8")) as {
        eventId?: string;
      };
      if (!value.eventId) return 204;
      if (seenEventIds.has(value.eventId)) return 204;
      seenEventIds.add(value.eventId);
      return 500;
    };
    const execute = jest.fn(async (context) => {
      context.progress({ step: 1 });
      return "done";
    });
    const baseUrl = await start(
      makeWorker({ execute, eventsEnabled: true }).worker,
    );

    expect((await submit(baseUrl, JSON.stringify(runRequest()))).status).toBe(
      202,
    );
    await waitFor(() => resultBodies().length === 1);
    await waitFor(() =>
      eventBodies().some((event) => event.eventId === "invocation-1:1"),
    );

    const requests = callbackRequests.filter((request) =>
      request.body.toString("utf8").includes('"eventId"'),
    );
    const retried = requests.filter(
      (request) =>
        (JSON.parse(request.body.toString("utf8")) as AgentEventV1)
          .eventId === "invocation-1:0",
    );
    expect(retried).toHaveLength(2);
    // Same body on both attempts: eventId, occurredAt, and payload are stable.
    expect(retried[0].body.equals(retried[1].body)).toBe(true);
    const first = JSON.parse(retried[0].body.toString("utf8")) as AgentEventV1;
    expect(first.eventId).toBe("invocation-1:0");
    // One delivery operation = one deliveryId, shared across its retries.
    const retriedDeliveryIds = retried.map(
      (request) => request.headers["x-agentweave-delivery-id"],
    );
    expect(retriedDeliveryIds[0]).toBe(retriedDeliveryIds[1]);
    expect(retriedDeliveryIds[0]).toEqual(expect.any(String));
    // Signature content is derived from the same body, deliveryId, and timestamp.
    for (const request of retried) {
      const timestamp = request.headers["x-agentweave-timestamp"] as string;
      const deliveryId = request.headers[
        "x-agentweave-delivery-id"
      ] as string;
      expect(request.headers["x-agentweave-signature"]).toBe(
        `v1=${createHmac("sha256", "callback-secret")
          .update(`${timestamp}.${deliveryId}.`)
          .update(request.body)
          .digest("hex")}`,
      );
    }
    // A later event is a separate delivery operation with a new deliveryId.
    const progress = requests.find(
      (request) =>
        (JSON.parse(request.body.toString("utf8")) as AgentEventV1)
          .eventId === "invocation-1:1",
    );
    expect(progress?.headers["x-agentweave-delivery-id"]).not.toBe(
      retried[0].headers["x-agentweave-delivery-id"],
    );
    expect(progress?.headers["x-agentweave-delivery-id"]).toBeDefined();
  });

  it("gives independent runs independent sequence counters", async () => {
    const execute = jest.fn(async (context) => {
      context.progress({ step: 1 });
      return "done";
    });
    const baseUrl = await start(
      makeWorker({ execute, eventsEnabled: true }).worker,
    );
    const second = runRequest(
      invocation({
        invocationId: "invocation-2",
        executionId: "execution-2",
        stepExecutionId: "step-execution-2",
        trace: { traceId: "trace-2", correlationId: "invocation-2" },
      }),
    );

    expect((await submit(baseUrl, JSON.stringify(runRequest()))).status).toBe(
      202,
    );
    expect(
      (
        await submit(baseUrl, JSON.stringify(second), {
          "Idempotency-Key": "invocation-2",
        })
      ).status,
    ).toBe(202);
    await waitFor(() =>
      eventBodies().filter((event) => event.type === "progress").length === 2,
    );

    const byInvocation = (invocationId: string) =>
      eventBodies()
        .filter(
          (event) =>
            event.invocationId === invocationId &&
            (event.type === "accepted" || event.type === "progress"),
        )
        .sort((a, b) => a.sequence - b.sequence);
    expect(byInvocation("invocation-1").map((event) => event.eventId)).toEqual(
      ["invocation-1:0", "invocation-1:1"],
    );
    expect(byInvocation("invocation-2").map((event) => event.eventId)).toEqual(
      ["invocation-2:0", "invocation-2:1"],
    );
    expect(
      byInvocation("invocation-2").map((event) => event.type),
    ).toEqual(["accepted", "progress"]);
  });

  it("delivers the AgentResult callback before the completed event and never replaces it", async () => {
    const baseUrl = await start(
      makeWorker({ eventsEnabled: true }).worker,
    );

    expect((await submit(baseUrl, JSON.stringify(runRequest()))).status).toBe(
      202,
    );
    await waitFor(() => resultBodies().length === 1);
    await waitFor(() =>
      eventBodies().some((event) => event.type === "completed"),
    );

    const results = resultBodies();
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ status: "succeeded" });

    const resultIndex = callbackRequests.findIndex(
      (request) => !request.body.toString("utf8").includes('"eventId"'),
    );
    const completedIndex = callbackRequests.findIndex(
      (request) =>
        request.body.toString("utf8").includes('"eventId"') &&
        (JSON.parse(request.body.toString("utf8")) as AgentEventV1).type ===
          "completed",
    );
    expect(resultIndex).toBeGreaterThanOrEqual(0);
    expect(completedIndex).toBeGreaterThan(resultIndex);
    const completed = eventBodies().find(
      (event) => event.type === "completed",
    ) as AgentEventV1;
    expect(completed.eventId).toBe("invocation-1:1");
    expect(completed.payload).toEqual({ status: "succeeded" });
  });

  it("does not let event delivery failure prevent the AgentResult callback", async () => {
    statusFor = (body) =>
      body.toString("utf8").includes('"eventId"') ? 500 : 204;
    const hook = jest.fn();
    const logger = {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    };
    const execute = jest.fn(async (context) => {
      context.progress({ step: 1 });
      return "done";
    });
    const baseUrl = await start(
      makeWorker({
        execute,
        eventsEnabled: true,
        onCallbackDeliveryFailed: hook,
        logger,
      }).worker,
    );

    expect((await submit(baseUrl, JSON.stringify(runRequest()))).status).toBe(
      202,
    );
    await waitFor(() => resultBodies().length === 1);
    await waitFor(() => hook.mock.calls.length >= 1);

    expect(resultBodies()[0]).toMatchObject({
      status: "succeeded",
      output: "done",
    });
    expect(hook).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: "echo-agent",
        invocationId: "invocation-1",
        runId: expect.any(String),
        deliveryId: expect.any(String),
        attempts: 2,
        callbackHost: expect.stringMatching(/^127\.0\.0\.1:/),
        httpStatus: 500,
        reason: "retryable-http-status",
      }),
    );
    expect(JSON.stringify(hook.mock.calls)).not.toContain("callback-secret");
    expect(
      logger.warn.mock.calls.some(
        ([message]) => message === "Agent event delivery failed",
      ),
    ).toBe(true);
    expect(worker?.getState()).toBe("running");
  });

  it("fails the run loudly when the agent emits an invalid or reserved event", async () => {
    const execute = jest.fn(async (context) => {
      context.progress({ n: NaN });
      return "done";
    });
    const baseUrl = await start(
      makeWorker({ execute, eventsEnabled: true }).worker,
    );

    expect((await submit(baseUrl, JSON.stringify(runRequest()))).status).toBe(
      202,
    );
    await waitFor(() => resultBodies().length === 1);

    expect(resultBodies()[0]).toMatchObject({
      status: "failed",
      error: { code: "AGENT_EXECUTION_FAILED" },
    });
    // Only the accepted and failed terminal events are emitted; the invalid
    // progress payload never becomes an event.
    const events = eventBodies().sort((a, b) => a.sequence - b.sequence);
    expect(events.map((event) => event.type)).toEqual(["accepted", "failed"]);
  });

  it("shapes log and artifact events and reports failure details in the failed terminal event", async () => {
    const execute = jest.fn(async (context) => {
      context.log("plain message");
      context.log({ level: "info", detail: "structured" });
      context.artifact({ id: "a1", name: "report.pdf", uri: "s3://bucket" });
      throw new Error("boom");
    });
    const baseUrl = await start(
      makeWorker({ execute, eventsEnabled: true }).worker,
    );

    expect((await submit(baseUrl, JSON.stringify(runRequest()))).status).toBe(
      202,
    );
    await waitFor(() => resultBodies().length === 1);
    await waitFor(() =>
      eventBodies().some((event) => event.type === "failed"),
    );

    const events = eventBodies().sort((a, b) => a.sequence - b.sequence);
    expect(events.map((event) => event.type)).toEqual([
      "accepted",
      "log",
      "log",
      "artifact",
      "failed",
    ]);
    expect(events[1].payload).toEqual({ message: "plain message" });
    expect(events[2].payload).toEqual({ level: "info", detail: "structured" });
    expect(events[3].payload).toEqual({
      id: "a1",
      name: "report.pdf",
      uri: "s3://bucket",
    });
    expect(events[4].payload).toMatchObject({
      status: "failed",
      code: "AGENT_EXECUTION_FAILED",
      retryable: false,
    });
    expect(resultBodies()[0]).toMatchObject({
      status: "failed",
      error: { code: "AGENT_EXECUTION_FAILED" },
    });
  });

  it("uses the same HMAC headers for event callbacks as for result callbacks", async () => {
    const baseUrl = await start(
      makeWorker({ eventsEnabled: true }).worker,
    );

    expect((await submit(baseUrl, JSON.stringify(runRequest()))).status).toBe(
      202,
    );
    await waitFor(() => eventBodies().length >= 1);
    await waitFor(() => resultBodies().length === 1);

    const eventRequests = callbackRequests.filter((request) =>
      request.body.toString("utf8").includes('"eventId"'),
    );
    expect(eventRequests.length).toBeGreaterThanOrEqual(1);
    for (const request of eventRequests) {
      expect(
        Object.keys(request.headers)
          .filter((header) => header.startsWith("x-agentweave-"))
          .sort(),
      ).toEqual([
        "x-agentweave-delivery-id",
        "x-agentweave-key-id",
        "x-agentweave-signature",
        "x-agentweave-timestamp",
      ]);
      expect(request.headers["x-agentweave-key-id"]).toBe("callback-v1");
      expect(request.headers["user-agent"]).toBe("Tenvyr-Worker/0.1.0");
      const timestamp = request.headers["x-agentweave-timestamp"] as string;
      const deliveryId = request.headers[
        "x-agentweave-delivery-id"
      ] as string;
      expect(request.headers["x-agentweave-signature"]).toBe(
        `v1=${createHmac("sha256", "callback-secret")
          .update(`${timestamp}.${deliveryId}.`)
          .update(request.body)
          .digest("hex")}`,
      );
      expect(
        Object.keys(request.headers).some((header) =>
          header.startsWith("x-tenvyr-"),
        ),
      ).toBe(false);
    }
  });

  it("never logs callback secrets while delivering events", async () => {
    const logger = {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    };
    const execute = jest.fn(async (context) => {
      context.progress({ step: 1 });
      return "done";
    });
    const baseUrl = await start(
      makeWorker({ execute, eventsEnabled: true, logger }).worker,
    );

    expect((await submit(baseUrl, JSON.stringify(runRequest()))).status).toBe(
      202,
    );
    await waitFor(() => resultBodies().length === 1);
    await waitFor(() =>
      logger.info.mock.calls.some(
        ([message]) => message === "Agent event delivered",
      ),
    );

    const logged = JSON.stringify(
      Object.values(logger).flatMap((mock) => mock.mock.calls),
    );
    expect(logged).not.toContain("callback-secret");
    expect(logged).not.toContain("worker-token");
  });
});

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline)
      throw new Error("Timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function close(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
