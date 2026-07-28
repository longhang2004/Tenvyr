import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "http";
import type { AddressInfo, Socket } from "net";
import type {
  AgentInvocationV1,
  HttpAgentRunRequestV1,
} from "@tenvyr/contracts";
import { createTenvyrWorker, defineAgent, type TenvyrWorker } from "../src";

type Deferred = {
  promise: Promise<void>;
  resolve(): void;
};

const deferred = (): Deferred => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

describe("Worker lifecycle and concurrency hardening", () => {
  let callbackServer: Server;
  let callbackOrigin: string;
  let callbackSockets: Set<Socket>;
  let worker: TenvyrWorker | undefined;

  afterEach(async () => {
    await worker?.stop({ graceMs: 100 });
    for (const socket of callbackSockets ?? []) socket.destroy();
    await close(callbackServer);
  });

  async function startCallbackServer(
    handler: (request: IncomingMessage, response: ServerResponse) => void,
  ): Promise<void> {
    callbackSockets = new Set();
    callbackServer = createServer(handler);
    callbackServer.on("connection", (socket) => {
      callbackSockets.add(socket);
      socket.once("close", () => callbackSockets.delete(socket));
    });
    await listen(callbackServer);
    callbackOrigin = `http://127.0.0.1:${(callbackServer.address() as AddressInfo).port}`;
  }

  function makeWorker(options: {
    execute: ReturnType<typeof jest.fn>;
    concurrency?: number;
    maxQueuedRuns?: number;
    maxRequestBytes?: number;
    callbackInitialDelayMs?: number;
    callbackMaxAttempts?: number;
    callbackRequestTimeoutMs?: number;
  }): TenvyrWorker {
    worker = createTenvyrWorker({
      agent: defineAgent({ name: "echo-agent", execute: options.execute }),
      authentication: { bearerToken: "worker-token" },
      callbackAuthentication: { keys: { "callback-v1": "callback-secret" } },
      callbackPolicy: {
        allowedOrigins: [callbackOrigin],
        allowInsecureHttp: true,
        maxResponseBytes: 64,
      },
      execution: {
        concurrency: options.concurrency ?? 1,
        maxQueuedRuns: options.maxQueuedRuns ?? 1,
        timeoutMs: 10_000,
      },
      callbackDelivery: {
        maxAttempts: options.callbackMaxAttempts ?? 1,
        initialDelayMs: options.callbackInitialDelayMs ?? 1,
        maxDelayMs: options.callbackInitialDelayMs ?? 1,
        jitterRatio: 0,
        requestTimeoutMs: options.callbackRequestTimeoutMs ?? 10_000,
      },
      server: {
        maxRequestBytes: options.maxRequestBytes ?? 16_384,
        shutdownGraceMs: 100,
      },
      idempotency: { ttlMs: 60_000, maxEntries: 200 },
    });
    return worker;
  }

  async function start(target: TenvyrWorker): Promise<string> {
    const address = await target.start({ host: "127.0.0.1", port: 0 });
    return `http://${address.host}:${address.port}`;
  }

  it("aborts and settles a callback created after force shutdown begins", async () => {
    const callbackClosed = deferred();
    let callbackCount = 0;
    let callbackWasAborted = false;
    await startCallbackServer(async (request, response) => {
      for await (const _chunk of request) {
        // Consume the request body, then intentionally never send a response.
      }
      callbackCount += 1;
      response.once("close", () => {
        callbackWasAborted = !response.writableEnded;
        callbackClosed.resolve();
      });
    });
    const executeStarted = deferred();
    const execute = jest.fn(async () => {
      executeStarted.resolve();
      return new Promise<never>(() => undefined);
    });
    const target = makeWorker({ execute });
    const baseUrl = await start(target);
    expect((await submit(baseUrl, runRequest(callbackOrigin))).status).toBe(
      202,
    );
    await executeStarted.promise;

    const firstStop = target.stop({ graceMs: 0 });
    const repeatedStop = target.stop({ graceMs: 0 });
    expect(repeatedStop).toBe(firstStop);
    await firstStop;

    expect(callbackCount === 0 || callbackWasAborted).toBe(true);
    if (callbackCount > 0)
      await expect(callbackClosed.promise).resolves.toBeUndefined();
    expect(target.getState()).toBe("stopped");
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("aborts an in-flight callback socket before stop resolves", async () => {
    const callbackStarted = deferred();
    const callbackClosed = deferred();
    let callbackWasAborted = false;
    await startCallbackServer(async (request, response) => {
      for await (const _chunk of request) {
        // Consume the callback, then hold the response open.
      }
      response.once("close", () => {
        callbackWasAborted = !response.writableEnded;
        callbackClosed.resolve();
      });
      callbackStarted.resolve();
    });
    const execute = jest.fn(async () => ({ ok: true }));
    const target = makeWorker({ execute });
    const baseUrl = await start(target);
    expect((await submit(baseUrl, runRequest(callbackOrigin))).status).toBe(
      202,
    );
    await callbackStarted.promise;

    await target.stop({ graceMs: 0 });

    await expect(callbackClosed.promise).resolves.toBeUndefined();
    expect(callbackWasAborted).toBe(true);
    expect(target.getState()).toBe("stopped");
  });

  it("deduplicates 100 concurrent semantic requests into one execution and callback", async () => {
    const callbackReceived = deferred();
    let callbackCount = 0;
    await startCallbackServer(async (request, response) => {
      for await (const _chunk of request) {
        // Drain callback request.
      }
      callbackCount += 1;
      response.writeHead(204);
      response.end();
      callbackReceived.resolve();
    });
    const release = deferred();
    const execute = jest.fn(async () => {
      await release.promise;
      return { ok: true };
    });
    const baseUrl = await start(makeWorker({ execute }));
    const semanticRequest = runRequest(callbackOrigin);
    semanticRequest.invocation.input = JSON.parse(
      '{"__proto__":{"safe":true},"constructor":{"safe":true},"prototype":{"safe":true},"message":"hello"}',
    );

    const responses = await Promise.all(
      Array.from({ length: 100 }, (_, index) =>
        submit(
          baseUrl,
          index % 2 === 0
            ? semanticRequest
            : ({
                resultDelivery: semanticRequest.resultDelivery,
                invocation: {
                  ...semanticRequest.invocation,
                  input: JSON.parse(
                    '{"message":"hello","prototype":{"safe":true},"constructor":{"safe":true},"__proto__":{"safe":true}}',
                  ),
                },
                schemaVersion: "1",
              } as HttpAgentRunRequestV1),
        ),
      ),
    );
    const acceptances = await Promise.all(
      responses.map(async (response) => ({
        status: response.status,
        body: await response.json(),
      })),
    );
    release.resolve();
    await callbackReceived.promise;

    expect(acceptances.every(({ status }) => status === 202)).toBe(true);
    expect(
      new Set(acceptances.map(({ body }) => (body as { runId: string }).runId))
        .size,
    ).toBe(1);
    expect(
      new Set(
        acceptances.map(
          ({ body }) => (body as { acceptedAt: string }).acceptedAt,
        ),
      ).size,
    ).toBe(1);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(callbackCount).toBe(1);
  });

  it("reserves one winner across 100 conflicting concurrent requests", async () => {
    const callbackReceived = deferred();
    let callbackCount = 0;
    await startCallbackServer(async (request, response) => {
      for await (const _chunk of request) {
        // Drain callback request.
      }
      callbackCount += 1;
      response.writeHead(204);
      response.end();
      callbackReceived.resolve();
    });
    const release = deferred();
    const execute = jest.fn(async () => {
      await release.promise;
      return { ok: true };
    });
    const baseUrl = await start(makeWorker({ execute }));

    const responses = await Promise.all(
      Array.from({ length: 100 }, (_, index) => {
        const value = runRequest(callbackOrigin);
        value.invocation.input = { winnerGroup: index % 2 };
        return submit(baseUrl, value);
      }),
    );
    const statuses = responses.map((response) => response.status);
    release.resolve();
    await callbackReceived.promise;

    expect(statuses.filter((status) => status === 202)).toHaveLength(50);
    expect(statuses.filter((status) => status === 409)).toHaveLength(50);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(callbackCount).toBe(1);
  });

  it("accepts only one active and one queued run across 20 concurrent requests", async () => {
    let callbackCount = 0;
    await startCallbackServer(async (request, response) => {
      for await (const _chunk of request) {
        // Drain callback request.
      }
      callbackCount += 1;
      response.writeHead(204);
      response.end();
    });
    const gates = [deferred(), deferred()];
    const executed = new Map<string, number>();
    const execute = jest.fn(async (context) => {
      const id = context.invocation.invocationId;
      executed.set(id, (executed.get(id) ?? 0) + 1);
      const gate = gates[execute.mock.calls.length - 1];
      if (gate) await gate.promise;
      return { id };
    });
    const baseUrl = await start(
      makeWorker({ execute, concurrency: 1, maxQueuedRuns: 1 }),
    );
    const requests = Array.from({ length: 20 }, (_, index) =>
      runRequest(callbackOrigin, index + 1),
    );

    const responses = await Promise.all(
      requests.map((value) => submit(baseUrl, value)),
    );
    const acceptedIndexes = responses.flatMap((response, index) =>
      response.status === 202 ? [index] : [],
    );
    const rejectedIndexes = responses.flatMap((response, index) =>
      response.status === 429 ? [index] : [],
    );
    expect(acceptedIndexes).toHaveLength(2);
    expect(rejectedIndexes).toHaveLength(18);

    gates[0].resolve();
    await waitFor(() => execute.mock.calls.length === 2);
    gates[1].resolve();
    await waitFor(() => callbackCount === 2);

    const retryIndex = rejectedIndexes[0];
    expect((await submit(baseUrl, requests[retryIndex])).status).toBe(202);
    await waitFor(() => callbackCount === 3);
    expect(execute).toHaveBeenCalledTimes(3);
    expect([...executed.values()].every((count) => count === 1)).toBe(true);
  });

  it("rejects a chunked request as soon as it crosses the streaming limit", async () => {
    let callbackCount = 0;
    await startCallbackServer(async (request, response) => {
      for await (const _chunk of request) {
        // Drain callback request.
      }
      callbackCount += 1;
      response.writeHead(204);
      response.end();
    });
    const execute = jest.fn(async () => ({ ok: true }));
    const value = runRequest(callbackOrigin);
    const body = JSON.stringify(value);
    const target = makeWorker({
      execute,
      maxRequestBytes: Buffer.byteLength(body),
    });
    const address = await target.start({ host: "127.0.0.1", port: 0 });

    const oversizedStatus = await submitChunked(
      address.host,
      address.port,
      value.invocation.invocationId,
      [body, " "],
    );

    expect(oversizedStatus).toBe(413);
    expect(execute).not.toHaveBeenCalled();
    expect(
      (await submit(`http://${address.host}:${address.port}`, value)).status,
    ).toBe(202);
    await waitFor(() => callbackCount === 1);
    expect(execute).toHaveBeenCalledTimes(1);
  });
});

function runRequest(
  callbackOrigin: string,
  sequence = 1,
): HttpAgentRunRequestV1 {
  const invocationId = `invocation-${sequence}`;
  const invocation: AgentInvocationV1 = {
    schemaVersion: "1",
    invocationId,
    executionId: `execution-${sequence}`,
    stepExecutionId: `step-execution-${sequence}`,
    stepId: "echo",
    target: { agent: "echo-agent" },
    input: { message: "hello" },
    attempt: 1,
    createdAt: "2026-07-26T00:00:00.000Z",
    trace: { traceId: `trace-${sequence}`, correlationId: invocationId },
  };
  return {
    schemaVersion: "1",
    invocation,
    resultDelivery: {
      mode: "callback",
      callbackUrl: `${callbackOrigin}/callback`,
      authentication: { scheme: "hmac-sha256", keyId: "callback-v1" },
    },
  };
}

function submit(
  baseUrl: string,
  value: HttpAgentRunRequestV1,
): Promise<Response> {
  return fetch(`${baseUrl}/v1/runs`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer worker-token",
      "Idempotency-Key": value.invocation.invocationId,
    },
    body: JSON.stringify(value),
  });
}

function submitChunked(
  host: string,
  port: number,
  invocationId: string,
  chunks: string[],
): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        host,
        port,
        path: "/v1/runs",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer worker-token",
          "Idempotency-Key": invocationId,
          "Transfer-Encoding": "chunked",
        },
      },
      (response) => {
        response.resume();
        response.once("end", () => resolve(response.statusCode ?? 0));
      },
    );
    request.once("error", reject);
    for (const chunk of chunks) request.write(chunk);
    request.end();
  });
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline)
      throw new Error("Timed out waiting for condition");
    await new Promise((resolve) => setImmediate(resolve));
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

function close(server: Server | undefined): Promise<void> {
  if (!server?.listening) return Promise.resolve();
  return new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
