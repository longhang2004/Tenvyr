import { createHmac } from "crypto";
import { readFileSync } from "fs";
import { createServer, type Server } from "http";
import type { AddressInfo } from "net";
import { resolve } from "path";
import type { AgentResultV1 } from "@tenvyr/contracts";
import { createCallbackSignature } from "../src/callback/callback-signer";
import {
  classifyCallbackResponse,
  deliverCallback,
  type CallbackDeliveryConfig,
} from "../src/callback/callback-delivery";
import { noOpLogger } from "../src/observability/safe-logger";

type SignatureVector = {
  name: string;
  secret: string;
  timestamp: string;
  deliveryId: string;
  rawBodyUtf8: string;
  expectedSignature: string;
};

const callbackStatusCases = JSON.parse(
  readFileSync(
    resolve(
      __dirname,
      "../../../contracts/conformance/protocol/callback-status-cases.json",
    ),
    "utf8",
  ),
) as Array<{
  status: number;
  outcome: "delivered" | "retry" | "do-not-retry";
}>;

const result: AgentResultV1 = {
  schemaVersion: "1",
  invocationId: "invocation-1",
  executionId: "execution-1",
  stepExecutionId: "step-execution-1",
  status: "succeeded",
  output: { echoed: true },
  completedAt: "2026-07-26T00:00:02.000Z",
};

const config: CallbackDeliveryConfig = {
  maxAttempts: 3,
  initialDelayMs: 10,
  maxDelayMs: 1000,
  jitterRatio: 0,
  requestTimeoutMs: 1000,
  maxResponseBytes: 32,
};

describe("callback signer", () => {
  const vectors = JSON.parse(
    readFileSync(
      resolve(
        __dirname,
        "../../../contracts/conformance/callback-signatures/vectors.json",
      ),
      "utf8",
    ),
  ) as SignatureVector[];

  it.each(vectors)("matches exact raw bytes for $name", (vector) => {
    expect(
      createCallbackSignature(
        vector.secret,
        vector.timestamp,
        vector.deliveryId,
        Buffer.from(vector.rawBodyUtf8, "utf8"),
      ),
    ).toBe(vector.expectedSignature);
  });
});

describe("callback response classification", () => {
  it.each(callbackStatusCases)(
    "classifies HTTP $status as $outcome",
    ({ status, outcome }) => {
      expect(classifyCallbackResponse(status)).toBe(outcome);
    },
  );
});

describe("callback delivery", () => {
  let server: Server;
  let callbackUrl: string;
  let statuses: number[];
  let retryAfter: string | undefined;
  let responseBody = "";
  let requests: Array<{
    headers: Record<string, string | string[] | undefined>;
    body: Buffer;
  }>;

  beforeEach(async () => {
    statuses = [204];
    retryAfter = undefined;
    responseBody = "";
    requests = [];
    server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      requests.push({ headers: request.headers, body: Buffer.concat(chunks) });
      response.writeHead(statuses.shift() ?? 204, {
        ...(retryAfter ? { "Retry-After": retryAfter } : {}),
        "Content-Type": "text/plain",
      });
      response.end(responseBody);
    });
    await listen(server);
    callbackUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/callback`;
  });

  afterEach(async () => {
    await close(server);
  });

  it("retries transient failure with stable delivery ID, fresh timestamp/signature, and exact body", async () => {
    statuses = [500, 204];
    const times = [1785024000_000, 1785024001_000];
    const delays: number[] = [];

    const outcome = await deliverCallback(
      {
        agent: "echo-agent",
        runId: "run-1",
        result,
        callbackUrl,
        keyId: "callback-v1",
        secret: "callback-secret",
        config,
        logger: noOpLogger,
      },
      {
        id: () => "delivery-1",
        now: () => times.shift() as number,
        random: () => 0.5,
        sleep: async (delay) => {
          delays.push(delay);
        },
      },
    );

    expect(outcome).toEqual({
      delivered: true,
      deliveryId: "delivery-1",
      attempts: 2,
      httpStatus: 204,
    });
    expect(delays).toEqual([10]);
    expect(requests).toHaveLength(2);
    expect(requests[0].body.equals(requests[1].body)).toBe(true);
    expect(requests[0].body.toString("utf8")).toBe(JSON.stringify(result));
    expect(
      Object.keys(requests[0].headers)
        .filter((header) => header.startsWith("x-"))
        .sort(),
    ).toEqual(
      [
        "x-agentweave-delivery-id",
        "x-agentweave-key-id",
        "x-agentweave-signature",
        "x-agentweave-timestamp",
      ].sort(),
    );
    expect(
      requests.map((request) => request.headers["x-agentweave-delivery-id"]),
    ).toEqual(["delivery-1", "delivery-1"]);
    expect(
      requests.map((request) => request.headers["x-agentweave-timestamp"]),
    ).toEqual(["1785024000", "1785024001"]);
    for (const request of requests) {
      expect(request.headers["user-agent"]).toBe("Tenvyr-Worker/1.0.0");
      expect(
        Object.keys(request.headers).some((header) =>
          header.startsWith("x-tenvyr-"),
        ),
      ).toBe(false);
      const timestamp = request.headers["x-agentweave-timestamp"] as string;
      const expected = `v1=${createHmac("sha256", "callback-secret")
        .update(`${timestamp}.delivery-1.`)
        .update(request.body)
        .digest("hex")}`;
      expect(request.headers["x-agentweave-signature"]).toBe(expected);
    }
  });

  it("does not retry an accepted callback when the user logger throws", async () => {
    const throwing = () => {
      throw new Error("logger failed");
    };
    const fetchRequest = jest.fn(
      async () => new Response(null, { status: 204 }),
    );

    const outcome = await deliverCallback(
      {
        agent: "echo-agent",
        runId: "run-1",
        result,
        callbackUrl,
        keyId: "callback-v1",
        secret: "callback-secret",
        config,
        logger: {
          debug: throwing,
          info: throwing,
          warn: throwing,
          error: throwing,
        },
      },
      {
        id: () => "delivery-1",
        now: () => 1785024000_000,
        fetch: fetchRequest,
      },
    );

    expect(outcome).toEqual({
      delivered: true,
      deliveryId: "delivery-1",
      attempts: 1,
      httpStatus: 204,
    });
    expect(fetchRequest).toHaveBeenCalledTimes(1);
  });

  it("absorbs rejected async logger promises after callback delivery", async () => {
    const fetchRequest = jest.fn(
      async () => new Response(null, { status: 204 }),
    );
    const reject = async () => {
      throw new Error("async logger failed");
    };

    await expect(
      deliverCallback(
        {
          agent: "echo-agent",
          runId: "run-1",
          result,
          callbackUrl,
          keyId: "callback-v1",
          secret: "callback-secret",
          config,
          logger: {
            debug: reject,
            info: reject,
            warn: reject,
            error: reject,
          },
        },
        {
          id: () => "delivery-1",
          now: () => 1785024000_000,
          fetch: fetchRequest,
        },
      ),
    ).resolves.toMatchObject({ delivered: true, attempts: 1 });
    await new Promise((resolve) => setImmediate(resolve));
    expect(fetchRequest).toHaveBeenCalledTimes(1);
  });

  it("honors and caps delta-seconds Retry-After", async () => {
    statuses = [429, 204];
    retryAfter = "5";
    const delays: number[] = [];

    await deliverCallback(
      {
        agent: "echo-agent",
        runId: "run-1",
        result,
        callbackUrl,
        keyId: "callback-v1",
        secret: "callback-secret",
        config,
        logger: noOpLogger,
      },
      {
        id: () => "delivery-1",
        now: () => 1785024000_000,
        random: () => 0.5,
        sleep: async (delay) => {
          delays.push(delay);
        },
      },
    );

    expect(delays).toEqual([1000]);
  });

  it("retries a network failure without exceeding max attempts", async () => {
    let attempts = 0;
    const outcome = await deliverCallback(
      {
        agent: "echo-agent",
        runId: "run-1",
        result,
        callbackUrl,
        keyId: "callback-v1",
        secret: "callback-secret",
        config: { ...config, maxAttempts: 2 },
        logger: noOpLogger,
      },
      {
        id: () => "delivery-1",
        now: () => 1785024000_000,
        random: () => 0.5,
        sleep: async () => undefined,
        fetch: async (...args) => {
          attempts += 1;
          if (attempts === 1) throw new Error("connection failed");
          return fetch(...args);
        },
      },
    );

    expect(outcome.delivered).toBe(true);
    expect(attempts).toBe(2);
  });

  it.each([
    [0, 8],
    [1, 12],
  ])("bounds jitter for random=%s", async (randomValue, expectedDelay) => {
    const delays: number[] = [];
    let attempts = 0;
    await deliverCallback(
      {
        agent: "echo-agent",
        runId: "run-1",
        result,
        callbackUrl,
        keyId: "callback-v1",
        secret: "callback-secret",
        config: { ...config, jitterRatio: 0.2 },
        logger: noOpLogger,
      },
      {
        id: () => "delivery-1",
        now: () => 1785024000_000,
        random: () => randomValue,
        sleep: async (delay) => {
          delays.push(delay);
        },
        fetch: async () => {
          attempts += 1;
          return attempts === 1
            ? new Response("", { status: 500 })
            : new Response(null, { status: 204 });
        },
      },
    );

    expect(delays).toEqual([expectedDelay]);
  });

  it("retries a request timeout", async () => {
    let attempts = 0;
    const outcome = await deliverCallback(
      {
        agent: "echo-agent",
        runId: "run-1",
        result,
        callbackUrl,
        keyId: "callback-v1",
        secret: "callback-secret",
        config: { ...config, requestTimeoutMs: 5 },
        logger: noOpLogger,
      },
      {
        id: () => "delivery-1",
        now: () => 1785024000_000,
        random: () => 0.5,
        sleep: async () => undefined,
        fetch: async (_url, init) => {
          attempts += 1;
          if (attempts === 2) return new Response(null, { status: 204 });
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener(
              "abort",
              () => reject(new Error("aborted")),
              { once: true },
            );
          });
        },
      },
    );

    expect(outcome).toMatchObject({ delivered: true, attempts: 2 });
  });

  it("aborts retry backoff during Worker shutdown", async () => {
    const controller = new AbortController();
    const delivery = deliverCallback(
      {
        agent: "echo-agent",
        runId: "run-1",
        result,
        callbackUrl,
        keyId: "callback-v1",
        secret: "callback-secret",
        config: { ...config, initialDelayMs: 1000 },
        logger: noOpLogger,
        signal: controller.signal,
      },
      {
        id: () => "delivery-1",
        now: () => 1785024000_000,
        random: () => 0.5,
        fetch: async () => new Response("", { status: 500 }),
      },
    );
    setTimeout(() => controller.abort(), 5);

    await expect(delivery).resolves.toMatchObject({
      delivered: false,
      reason: "worker-shutdown",
    });
  });

  it("aborts network-error backoff during Worker shutdown", async () => {
    const controller = new AbortController();
    const delivery = deliverCallback(
      {
        agent: "echo-agent",
        runId: "run-1",
        result,
        callbackUrl,
        keyId: "callback-v1",
        secret: "callback-secret",
        config: { ...config, initialDelayMs: 1000 },
        logger: noOpLogger,
        signal: controller.signal,
      },
      {
        id: () => "delivery-1",
        now: () => 1785024000_000,
        random: () => 0.5,
        fetch: async () => {
          throw new Error("connection failed");
        },
      },
    );
    setTimeout(() => controller.abort(), 5);

    await expect(delivery).resolves.toMatchObject({
      delivered: false,
      attempts: 1,
      reason: "worker-shutdown",
    });
  });

  it("does not follow or retry redirects", async () => {
    const fetchMock = jest.fn(
      async (_url: string | URL | Request, init?: RequestInit) => {
        expect(init?.redirect).toBe("manual");
        return new Response("", {
          status: 302,
          headers: { Location: "https://attacker.test" },
        });
      },
    );

    const outcome = await deliverCallback(
      {
        agent: "echo-agent",
        runId: "run-1",
        result,
        callbackUrl,
        keyId: "callback-v1",
        secret: "callback-secret",
        config,
        logger: noOpLogger,
      },
      {
        id: () => "delivery-1",
        now: () => 1785024000_000,
        random: () => 0.5,
        sleep: async () => undefined,
        fetch: fetchMock,
      },
    );

    expect(outcome).toMatchObject({
      delivered: false,
      attempts: 1,
      httpStatus: 302,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects an oversized response without retrying", async () => {
    statuses = [500];
    responseBody = "x".repeat(33);

    const outcome = await deliverCallback(
      {
        agent: "echo-agent",
        runId: "run-1",
        result,
        callbackUrl,
        keyId: "callback-v1",
        secret: "callback-secret",
        config,
        logger: noOpLogger,
      },
      {
        id: () => "delivery-1",
        now: () => 1785024000_000,
        random: () => 0.5,
        sleep: async () => undefined,
      },
    );

    expect(outcome).toMatchObject({
      delivered: false,
      attempts: 1,
      reason: "response-too-large",
    });
    expect(requests).toHaveLength(1);
  });

  it("cancels a declared oversized response body before rejecting it", async () => {
    const cancelled = jest.fn();
    const body = new ReadableStream({
      cancel: cancelled,
    });

    const outcome = await deliverCallback(
      {
        agent: "echo-agent",
        runId: "run-1",
        result,
        callbackUrl,
        keyId: "callback-v1",
        secret: "callback-secret",
        config,
        logger: noOpLogger,
      },
      {
        id: () => "delivery-1",
        now: () => 1785024000_000,
        fetch: async () =>
          new Response(body, {
            status: 500,
            headers: { "Content-Length": "33" },
          }),
      },
    );

    expect(outcome).toMatchObject({
      delivered: false,
      attempts: 1,
      reason: "response-too-large",
    });
    expect(cancelled).toHaveBeenCalledTimes(1);
  });

  it("never sends or logs the callback secret outside the derived signature", async () => {
    const logger = {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    };
    await deliverCallback(
      {
        agent: "echo-agent",
        runId: "run-1",
        result,
        callbackUrl,
        keyId: "callback-v1",
        secret: "TOP_SECRET_CALLBACK",
        config,
        logger,
      },
      {
        id: () => "delivery-1",
        now: () => 1785024000_000,
        random: () => 0.5,
        sleep: async () => undefined,
      },
    );

    expect(JSON.stringify(requests)).not.toContain("TOP_SECRET_CALLBACK");
    expect(
      JSON.stringify(Object.values(logger).flatMap((mock) => mock.mock.calls)),
    ).not.toContain("TOP_SECRET_CALLBACK");
  });
});

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
  return new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
