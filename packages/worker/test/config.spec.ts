import { defineAgent } from "../src";
import { parseWorkerConfig } from "../src/config/worker-config.validation";

const agent = defineAgent({
  name: "echo-agent",
  async execute(_context, input: unknown) {
    return input;
  },
});

const validConfig = () => ({
  agent,
  authentication: { bearerToken: "worker-token" },
  callbackAuthentication: { keys: { "callback-v1": "callback-secret" } },
  callbackPolicy: { allowedOrigins: ["https://orchestrator.example"] },
});

describe("worker configuration", () => {
  it("applies deterministic documented defaults", () => {
    expect(parseWorkerConfig(validConfig())).toMatchObject({
      execution: {
        timeoutMs: 15 * 60 * 1000,
        concurrency: 4,
        maxQueuedRuns: 100,
      },
      idempotency: {
        ttlMs: 24 * 60 * 60 * 1000,
        maxEntries: 10_000,
      },
      callbackDelivery: {
        maxAttempts: 8,
        initialDelayMs: 500,
        maxDelayMs: 30_000,
        jitterRatio: 0.2,
        requestTimeoutMs: 10_000,
      },
      callbackPolicy: {
        allowedOrigins: ["https://orchestrator.example"],
        allowInsecureHttp: false,
        maxResponseBytes: 64 * 1024,
      },
      server: {
        maxRequestBytes: 1024 * 1024,
        shutdownGraceMs: 30_000,
      },
    });
  });

  it.each([
    ["empty bearer token", { authentication: { bearerToken: "" } }],
    ["empty callback keys", { callbackAuthentication: { keys: {} } }],
    ["empty origins", { callbackPolicy: { allowedOrigins: [] } }],
    [
      "origin path",
      {
        callbackPolicy: {
          allowedOrigins: ["https://orchestrator.example/path"],
        },
      },
    ],
    [
      "origin credentials",
      { callbackPolicy: { allowedOrigins: ["https://user@example.test"] } },
    ],
    [
      "insecure origin",
      { callbackPolicy: { allowedOrigins: ["http://127.0.0.1:3000"] } },
    ],
    ["zero concurrency", { execution: { concurrency: 0 } }],
    ["negative queue", { execution: { maxQueuedRuns: -1 } }],
    ["zero timeout", { execution: { timeoutMs: 0 } }],
    ["invalid jitter", { callbackDelivery: { jitterRatio: 1.1 } }],
    ["zero attempts", { callbackDelivery: { maxAttempts: 0 } }],
    ["zero request bytes", { server: { maxRequestBytes: 0 } }],
    ["zero response bytes", { callbackPolicy: { maxResponseBytes: 0 } }],
  ])("rejects %s", (_case, override) => {
    expect(() =>
      parseWorkerConfig({ ...validConfig(), ...override } as never),
    ).toThrow();
  });

  it("allows explicitly configured HTTP callback origins", () => {
    expect(
      parseWorkerConfig({
        ...validConfig(),
        callbackPolicy: {
          allowedOrigins: ["http://127.0.0.1:3000"],
          allowInsecureHttp: true,
        },
      }).callbackPolicy.allowedOrigins,
    ).toEqual(["http://127.0.0.1:3000"]);
  });

  it("never includes secret values in configuration errors", () => {
    const bearerToken = "TOP_SECRET_BEARER";
    const callbackSecret = "TOP_SECRET_CALLBACK";

    try {
      parseWorkerConfig({
        ...validConfig(),
        authentication: { bearerToken },
        callbackAuthentication: { keys: { "": callbackSecret } },
      });
      throw new Error("expected invalid configuration");
    } catch (error) {
      expect((error as Error).message).not.toContain(bearerToken);
      expect((error as Error).message).not.toContain(callbackSecret);
    }
  });
});
