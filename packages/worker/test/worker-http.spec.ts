import { createHmac } from "crypto";
import { createServer, type Server } from "http";
import { connect, type AddressInfo, type Socket } from "net";
import type {
  AgentInvocationV1,
  AgentResultV1,
  HttpAgentRunRequestV1,
} from "@tenvyr/contracts";
import { createTenvyrWorker, defineAgent, type TenvyrWorker } from "../src";

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

describe("Tenvyr Worker HTTP server", () => {
  let callbackServer: Server;
  let callbackOrigin: string;
  let callbackRequests: CallbackRequest[];
  let callbackStatus: number;
  let worker: TenvyrWorker | undefined;

  beforeEach(async () => {
    callbackRequests = [];
    callbackStatus = 204;
    callbackServer = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      callbackRequests.push({
        headers: request.headers,
        body: Buffer.concat(chunks),
      });
      response.writeHead(callbackStatus);
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
      maxRequestBytes?: number;
      concurrency?: number;
      maxQueuedRuns?: number;
      timeoutMs?: number;
      shutdownGraceMs?: number;
      maxEntries?: number;
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
        keys: {
          "callback-v1": "callback-secret",
          "callback-v2": "callback-secret-v2",
        },
      },
      callbackPolicy: {
        allowedOrigins: [callbackOrigin],
        allowInsecureHttp: true,
        maxResponseBytes: 1024,
      },
      execution: {
        timeoutMs: options.timeoutMs ?? 1000,
        concurrency: options.concurrency ?? 1,
        maxQueuedRuns: options.maxQueuedRuns ?? 1,
      },
      callbackDelivery: {
        maxAttempts: options.callbackMaxAttempts ?? 2,
        initialDelayMs: 1,
        maxDelayMs: 2,
        jitterRatio: 0,
        requestTimeoutMs: 1000,
      },
      server: {
        maxRequestBytes: options.maxRequestBytes ?? 4096,
        shutdownGraceMs: options.shutdownGraceMs ?? 100,
      },
      idempotency: {
        ttlMs: 1000,
        maxEntries: options.maxEntries ?? 100,
      },
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

  it("serves live/ready health and starts idempotently", async () => {
    const target = makeWorker().worker;
    const first = await target.start({ host: "127.0.0.1", port: 0 });
    const second = await target.start({ host: "0.0.0.0", port: 9999 });
    const baseUrl = `http://${first.host}:${first.port}`;

    expect(second).toEqual(first);
    await expect(
      fetch(`${baseUrl}/health/live`).then((response) => response.json()),
    ).resolves.toEqual({
      status: "ok",
    });
    expect((await fetch(`${baseUrl}/health/ready`)).status).toBe(200);
    expect(target.getState()).toBe("running");
  });

  it("returns 202 before handler completion then sends one signed canonical callback", async () => {
    let release!: () => void;
    const execute = jest.fn(
      async () =>
        new Promise<{ echoed: boolean }>((resolve) => {
          release = () => resolve({ echoed: true });
        }),
    );
    const baseUrl = await start(makeWorker({ execute }).worker);

    const response = await submit(baseUrl, JSON.stringify(runRequest()));
    const accepted = await response.json();

    expect(response.status).toBe(202);
    expect(accepted).toMatchObject({
      schemaVersion: "1",
      invocationId: "invocation-1",
      status: "accepted",
    });
    expect(Date.parse(accepted.acceptedAt)).not.toBeNaN();
    expect(callbackRequests).toHaveLength(0);
    release();
    await waitFor(() => callbackRequests.length === 1);

    const callback = callbackRequests[0];
    const result = JSON.parse(callback.body.toString("utf8")) as AgentResultV1;
    expect(result).toMatchObject({
      invocationId: "invocation-1",
      executionId: "execution-1",
      stepExecutionId: "step-execution-1",
      status: "succeeded",
      output: { echoed: true },
    });
    const timestamp = callback.headers["x-agentweave-timestamp"] as string;
    const deliveryId = callback.headers["x-agentweave-delivery-id"] as string;
    expect(callback.headers["x-agentweave-key-id"]).toBe("callback-v1");
    expect(callback.headers["x-agentweave-signature"]).toBe(
      `v1=${createHmac("sha256", "callback-secret")
        .update(`${timestamp}.${deliveryId}.`)
        .update(callback.body)
        .digest("hex")}`,
    );
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      "wrong target agent",
      404,
      (request: any) => (request.invocation.target.agent = "other-agent"),
    ],
    [
      "missing idempotency key",
      400,
      () => undefined,
      { "Idempotency-Key": "" },
    ],
    [
      "mismatched idempotency key",
      400,
      () => undefined,
      { "Idempotency-Key": "different" },
    ],
    [
      "unknown callback key",
      400,
      (request: any) =>
        (request.resultDelivery.authentication.keyId = "unknown"),
    ],
    [
      "disallowed callback origin",
      400,
      (request: any) =>
        (request.resultDelivery.callbackUrl = "https://attacker.test/callback"),
    ],
    [
      "callback credentials",
      400,
      (request: any) =>
        (request.resultDelivery.callbackUrl = `http://user:pass@127.0.0.1:${
          (callbackServer.address() as AddressInfo).port
        }/callback`),
    ],
    [
      "callback fragment",
      400,
      (request: any) =>
        (request.resultDelivery.callbackUrl = `${callbackOrigin}/callback#fragment`),
    ],
  ])(
    "rejects %s with %i",
    async (
      _case,
      status,
      mutate,
      extraHeaders: Record<string, string> = {},
    ) => {
      const { worker: target, execute } = makeWorker();
      const baseUrl = await start(target);
      const request = runRequest();
      mutate(request);

      const response = await submit(
        baseUrl,
        JSON.stringify(request),
        extraHeaders,
      );

      expect(response.status).toBe(status);
      expect(execute).not.toHaveBeenCalled();
    },
  );

  it("rejects unauthenticated requests before processing body and returns challenge header", async () => {
    const { worker: target, execute } = makeWorker();
    const baseUrl = await start(target);

    const response = await fetch(`${baseUrl}/v1/runs?token=worker-token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        bearerToken: "worker-token",
        malformed: BigInt.prototype.toString,
      }),
    });

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe("Bearer");
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([
    ["unsupported media type", "text/plain", "{}", 415],
    ["invalid JSON", "application/json", "{not-json", 400],
    ["invalid contract", "application/json", "{}", 400],
  ])("rejects %s", async (_case, contentType, body, status) => {
    const { worker: target, execute } = makeWorker();
    const baseUrl = await start(target);

    const response = await submit(baseUrl, body, {
      "Content-Type": contentType,
    });

    expect(response.status).toBe(status);
    expect(execute).not.toHaveBeenCalled();
  });

  it("rejects oversized bodies with 413", async () => {
    const { worker: target, execute } = makeWorker({ maxRequestBytes: 32 });
    const baseUrl = await start(target);

    const response = await submit(baseUrl, JSON.stringify(runRequest()));

    expect(response.status).toBe(413);
    expect(execute).not.toHaveBeenCalled();
  });

  it("deduplicates semantic JSON with reordered properties and preserves acceptance", async () => {
    const { worker: target, execute } = makeWorker();
    const baseUrl = await start(target);
    const request = runRequest();
    const first = await submit(baseUrl, JSON.stringify(request));
    const secondBody = JSON.stringify({
      resultDelivery: request.resultDelivery,
      invocation: {
        ...request.invocation,
        input: { message: "hello" },
      },
      schemaVersion: "1",
    });
    const second = await submit(baseUrl, secondBody);

    expect(second.status).toBe(202);
    expect(await second.json()).toEqual(await first.json());
    await waitFor(() => callbackRequests.length === 1);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      "different input",
      (request: HttpAgentRunRequestV1) =>
        (request.invocation.input = { message: "changed" }),
    ],
    [
      "different callback URL",
      (request: HttpAgentRunRequestV1) =>
        (request.resultDelivery.callbackUrl = `${callbackOrigin}/other`),
    ],
    [
      "different callback key",
      (request: HttpAgentRunRequestV1) => {
        request.resultDelivery.authentication.keyId = "callback-v2";
      },
    ],
  ])("returns 409 for duplicate invocation with %s", async (_case, mutate) => {
    const { worker: target, execute } = makeWorker();
    const baseUrl = await start(target);
    await submit(baseUrl, JSON.stringify(runRequest()));
    const changed = runRequest();
    mutate(changed);

    const response = await submit(baseUrl, JSON.stringify(changed));

    expect(response.status).toBe(409);
    await waitFor(() => execute.mock.calls.length === 1);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("returns 429 when active and queued capacity are full", async () => {
    const releases: Array<() => void> = [];
    const execute = jest.fn(
      async () =>
        new Promise<void>((resolve) => {
          releases.push(resolve);
        }),
    );
    const baseUrl = await start(
      makeWorker({ execute, concurrency: 1, maxQueuedRuns: 1 }).worker,
    );
    const first = runRequest();
    const second = runRequest(
      invocation({
        invocationId: "invocation-2",
        stepExecutionId: "step-execution-2",
        trace: { traceId: "trace-2", correlationId: "invocation-2" },
      }),
    );
    const third = runRequest(
      invocation({
        invocationId: "invocation-3",
        stepExecutionId: "step-execution-3",
        trace: { traceId: "trace-3", correlationId: "invocation-3" },
      }),
    );

    expect((await submit(baseUrl, JSON.stringify(first))).status).toBe(202);
    expect(
      (
        await submit(baseUrl, JSON.stringify(second), {
          "Idempotency-Key": "invocation-2",
        })
      ).status,
    ).toBe(202);
    expect(
      (
        await submit(baseUrl, JSON.stringify(third), {
          "Idempotency-Key": "invocation-3",
        })
      ).status,
    ).toBe(429);
    await waitFor(() => releases.length === 1);
    releases[0]();
    await waitFor(() => releases.length === 2);
    releases[1]();
  });

  it("returns 429 rather than evicting an active idempotency record at store capacity", async () => {
    let release!: () => void;
    const execute = jest.fn(
      async () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const baseUrl = await start(
      makeWorker({ execute, maxEntries: 1, concurrency: 2 }).worker,
    );
    await submit(baseUrl, JSON.stringify(runRequest()));
    const second = runRequest(
      invocation({
        invocationId: "invocation-2",
        stepExecutionId: "step-execution-2",
        trace: { traceId: "trace-2", correlationId: "invocation-2" },
      }),
    );

    const response = await submit(baseUrl, JSON.stringify(second), {
      "Idempotency-Key": "invocation-2",
    });

    expect(response.status).toBe(429);
    release();
  });

  it("does not rerun after callback failure and invokes a safe failure hook once", async () => {
    callbackStatus = 400;
    const hook = jest.fn();
    const { worker: target, execute } = makeWorker({
      callbackMaxAttempts: 1,
      onCallbackDeliveryFailed: hook,
    });
    const baseUrl = await start(target);
    const first = await submit(baseUrl, JSON.stringify(runRequest()));
    await waitFor(() => hook.mock.calls.length === 1);

    const duplicate = await submit(baseUrl, JSON.stringify(runRequest()));

    expect(duplicate.status).toBe(202);
    expect(await duplicate.json()).toEqual(await first.json());
    expect(execute).toHaveBeenCalledTimes(1);
    expect(callbackRequests).toHaveLength(1);
    expect(hook).toHaveBeenCalledWith({
      agent: "echo-agent",
      invocationId: "invocation-1",
      runId: expect.any(String),
      deliveryId: expect.any(String),
      attempts: 1,
      callbackHost: expect.stringMatching(/^127\.0\.0\.1:/),
      httpStatus: 400,
      reason: "non-retryable-http-status",
    });
    expect(JSON.stringify(hook.mock.calls)).not.toContain("callback-secret");
  });

  it("contains callback failure hook errors without crashing the Worker", async () => {
    callbackStatus = 400;
    const logger = {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    };
    const hook = jest.fn().mockRejectedValue(new Error("hook failed"));
    const { worker: target } = makeWorker({
      callbackMaxAttempts: 1,
      onCallbackDeliveryFailed: hook,
      logger,
    });
    const baseUrl = await start(target);

    expect((await submit(baseUrl, JSON.stringify(runRequest()))).status).toBe(
      202,
    );
    await waitFor(() =>
      logger.error.mock.calls.some(
        ([message]) => message === "Callback delivery failure hook failed",
      ),
    );

    expect(target.getState()).toBe("running");
  });

  it("isolates throwing user loggers from execution and callback delivery", async () => {
    const throwing = () => {
      throw new Error("logger failed");
    };
    const logger = {
      debug: jest.fn(throwing),
      info: jest.fn(throwing),
      warn: jest.fn(throwing),
      error: jest.fn(throwing),
    };
    const { worker: target, execute } = makeWorker({
      logger,
      execute: jest.fn(async (context) => {
        context.logger.warn("handler warning");
        throw new Error("handler failed");
      }),
    });
    const baseUrl = await start(target);

    expect((await submit(baseUrl, JSON.stringify(runRequest()))).status).toBe(
      202,
    );
    await waitFor(() => callbackRequests.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(callbackRequests).toHaveLength(1);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(JSON.parse(callbackRequests[0].body.toString("utf8"))).toMatchObject(
      {
        status: "failed",
        error: { code: "AGENT_EXECUTION_FAILED" },
      },
    );
    expect(logger.error).toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
  });

  it("bounds a never-settling callback failure hook during shutdown", async () => {
    callbackStatus = 400;
    const hook = jest.fn(() => new Promise<void>(() => undefined));
    const target = makeWorker({
      callbackMaxAttempts: 1,
      onCallbackDeliveryFailed: hook,
      shutdownGraceMs: 10,
    }).worker;
    const baseUrl = await start(target);
    await submit(baseUrl, JSON.stringify(runRequest()));
    await waitFor(() => hook.mock.calls.length === 1);

    const stopped = target.stop({ graceMs: 10 }).then(() => true);
    const timed = new Promise<false>((resolve) =>
      setTimeout(() => resolve(false), 500),
    );

    await expect(Promise.race([stopped, timed])).resolves.toBe(true);
    expect(target.getState()).toBe("stopped");
  });

  it("releases a scheduler slot after timeout", async () => {
    const execute = jest
      .fn()
      .mockImplementationOnce(async () => new Promise<void>(() => undefined))
      .mockResolvedValueOnce("second-completed");
    const baseUrl = await start(
      makeWorker({ execute, timeoutMs: 10, concurrency: 1, maxQueuedRuns: 1 })
        .worker,
    );
    await submit(baseUrl, JSON.stringify(runRequest()));
    await submit(
      baseUrl,
      JSON.stringify(
        runRequest(
          invocation({
            invocationId: "invocation-2",
            stepExecutionId: "step-execution-2",
            trace: { traceId: "trace-2", correlationId: "invocation-2" },
          }),
        ),
      ),
      { "Idempotency-Key": "invocation-2" },
    );

    await waitFor(() => callbackRequests.length === 2);

    expect(execute).toHaveBeenCalledTimes(2);
    expect(
      callbackRequests
        .map(
          (request) =>
            JSON.parse(request.body.toString("utf8")) as AgentResultV1,
        )
        .map((callbackResult) => callbackResult.status),
    ).toEqual(["timed_out", "succeeded"]);
  });

  it("waits for active work that finishes within the shutdown grace period", async () => {
    let release!: () => void;
    const execute = jest.fn(
      async () =>
        new Promise<string>((resolve) => {
          release = () => resolve("completed-before-grace");
        }),
    );
    const target = makeWorker({ execute, shutdownGraceMs: 200 }).worker;
    const baseUrl = await start(target);
    await submit(baseUrl, JSON.stringify(runRequest()));
    await waitFor(() => execute.mock.calls.length === 1);
    let stopped = false;
    const stopping = target.stop({ graceMs: 200 }).then(() => {
      stopped = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(stopped).toBe(false);
    release();
    await stopping;
    await waitFor(() => callbackRequests.length === 1);
    expect(JSON.parse(callbackRequests[0].body.toString("utf8"))).toMatchObject(
      {
        status: "succeeded",
        output: "completed-before-grace",
      },
    );
  });

  it("turns readiness off and rejects new runs while stopping", async () => {
    let release!: () => void;
    const execute = jest.fn(
      async () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const target = makeWorker({ execute, shutdownGraceMs: 200 }).worker;
    const baseUrl = await start(target);
    await submit(baseUrl, JSON.stringify(runRequest()));
    await waitFor(() => execute.mock.calls.length === 1);

    const stopping = target.stop({ graceMs: 200 });
    const unavailableStatus = async (request: Promise<Response>) => {
      try {
        return (await request).status;
      } catch {
        return 0;
      }
    };
    const [ready, rejected] = await Promise.all([
      unavailableStatus(fetch(`${baseUrl}/health/ready`)),
      unavailableStatus(
        submit(
          baseUrl,
          JSON.stringify(
            runRequest(
              invocation({
                invocationId: "invocation-2",
                stepExecutionId: "step-execution-2",
                trace: {
                  traceId: "trace-2",
                  correlationId: "invocation-2",
                },
              }),
            ),
          ),
          { "Idempotency-Key": "invocation-2" },
        ),
      ),
    ]);

    expect([0, 503]).toContain(ready);
    expect([0, 503]).toContain(rejected);
    release();
    await stopping;
  });

  it("enters failed state and releases the listener after a partial start failure", async () => {
    const first = makeWorker().worker;
    const address = await first.start({ host: "127.0.0.1", port: 0 });
    const second = makeWorker().worker;

    await expect(
      second.start({ host: address.host, port: address.port }),
    ).rejects.toBeDefined();

    expect(second.getState()).toBe("failed");
    await second.stop();
    await first.stop();
  });

  it("stops cleanly when stop races with listener startup", async () => {
    const target = makeWorker().worker;
    const starting = target.start({ host: "127.0.0.1", port: 0 });
    const stopping = target.stop({ graceMs: 100 });
    const address = await starting;

    await stopping;

    expect(target.getState()).toBe("stopped");
    await expect(
      fetch(`http://${address.host}:${address.port}/health/live`),
    ).rejects.toBeDefined();
    await expect(target.start()).rejects.toThrow(/stopped/i);
  });

  it("forces an incomplete HTTP request closed at the grace deadline", async () => {
    const target = makeWorker().worker;
    const address = await target.start({ host: "127.0.0.1", port: 0 });
    let socket: Socket | undefined;
    try {
      socket = connect(address.port, address.host);
      await new Promise<void>((resolve, reject) => {
        socket?.once("connect", resolve);
        socket?.once("error", reject);
      });
      socket.write(
        "POST /v1/runs HTTP/1.1\r\n" +
          `Host: ${address.host}:${address.port}\r\n` +
          "Content-Type: application/json\r\n" +
          "Authorization: Bearer worker-token\r\n" +
          "Content-Length: 1000\r\n\r\n" +
          "{",
      );

      const stopped = target.stop({ graceMs: 20 }).then(() => true);
      const timed = new Promise<false>((resolve) =>
        setTimeout(() => resolve(false), 500),
      );

      await expect(Promise.race([stopped, timed])).resolves.toBe(true);
      expect(target.getState()).toBe("stopped");
    } finally {
      socket?.destroy();
    }
  });

  it("does not automatically log invocation input or result output", async () => {
    const logger = {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    };
    const baseUrl = await start(
      makeWorker({
        logger,
        execute: jest.fn(async () => ({ value: "TOP_SECRET_OUTPUT" })),
      }).worker,
    );
    const request = runRequest(
      invocation({ input: { value: "TOP_SECRET_INPUT" } }),
    );

    await submit(baseUrl, JSON.stringify(request));
    await waitFor(() => callbackRequests.length === 1);

    const logged = JSON.stringify(
      Object.values(logger).flatMap((mock) => mock.mock.calls),
    );
    expect(logged).not.toContain("TOP_SECRET_INPUT");
    expect(logged).not.toContain("TOP_SECRET_OUTPUT");
    expect(logged).not.toContain("worker-token");
    expect(logged).not.toContain("callback-secret");
  });

  it("gracefully stops, cancels queued work, aborts active work at grace expiry, and is one-shot", async () => {
    const observedAbort = jest.fn();
    const logger = {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    };
    const execute = jest.fn(
      async (context) =>
        new Promise<void>(() => {
          context.signal.addEventListener("abort", observedAbort);
        }),
    );
    const target = makeWorker({
      execute,
      concurrency: 1,
      maxQueuedRuns: 1,
      shutdownGraceMs: 100,
      logger,
    }).worker;
    const baseUrl = await start(target);
    await submit(baseUrl, JSON.stringify(runRequest()));
    await submit(
      baseUrl,
      JSON.stringify(
        runRequest(
          invocation({
            invocationId: "invocation-2",
            stepExecutionId: "step-execution-2",
            trace: { traceId: "trace-2", correlationId: "invocation-2" },
          }),
        ),
      ),
      { "Idempotency-Key": "invocation-2" },
    );
    await waitFor(() => execute.mock.calls.length === 1);

    await target.stop({ graceMs: 100 });
    await target.stop();

    expect(target.getState()).toBe("stopped");
    expect(observedAbort).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(1);
    await expect(target.start()).rejects.toThrow(/stopped/i);
    await waitFor(() => callbackRequests.length === 1);
    expect(
      callbackRequests
        .map(
          (request) =>
            JSON.parse(request.body.toString("utf8")) as AgentResultV1,
        )
        .map((callbackResult) => callbackResult.status)
        .sort(),
    ).toEqual(["cancelled"]);
    expect(logger.warn).toHaveBeenCalledWith(
      "Agent callback skipped during forced Worker shutdown",
      expect.objectContaining({ invocationId: "invocation-1" }),
    );
  });

  it("does not install process signal handlers", async () => {
    const before = {
      sigterm: process.listenerCount("SIGTERM"),
      sigint: process.listenerCount("SIGINT"),
    };
    const target = makeWorker().worker;
    await target.start({ host: "127.0.0.1", port: 0 });

    expect(process.listenerCount("SIGTERM")).toBe(before.sigterm);
    expect(process.listenerCount("SIGINT")).toBe(before.sigint);
  });
});

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 1000,
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
