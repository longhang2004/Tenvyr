import { createHmac } from "crypto";
import type {
  AgentResultV1,
  HttpAgentRunRequestV1,
  JsonValue,
} from "@tenvyr/contracts";
import { deliverCallback } from "../src/callback/callback-delivery";
import { asJsonValue } from "../src/execution/json-value";
import {
  canonicalJson,
  requestFingerprint,
} from "../src/invocation/canonical-json";
import { InMemoryIdempotencyStore } from "../src/invocation/idempotency-store";
import { noOpLogger } from "../src/observability/safe-logger";

const specialJson = JSON.parse(
  '{"__proto__":{"polluted":true},"constructor":{"name":"safe"},"prototype":{"kept":true},"nested":{"__proto__":{"deep":true}}}',
) as Record<string, unknown>;

const request = (input: Record<string, unknown>): HttpAgentRunRequestV1 => ({
  schemaVersion: "1",
  invocation: {
    schemaVersion: "1",
    invocationId: "invocation-1",
    executionId: "execution-1",
    stepExecutionId: "step-execution-1",
    stepId: "echo",
    target: { agent: "echo-agent" },
    input: input as JsonValue,
    attempt: 1,
    createdAt: "2026-07-26T00:00:00.000Z",
    trace: { traceId: "trace-1", correlationId: "invocation-1" },
  },
  resultDelivery: {
    mode: "callback",
    callbackUrl: "https://orchestrator.example/callback",
    authentication: { scheme: "hmac-sha256", keyId: "callback-v1" },
  },
});

describe("Worker hardening regressions", () => {
  it("preserves special JSON keys at every nesting level without changing prototypes", () => {
    const objectPrototype = Object.prototype as Record<string, unknown>;
    const before = objectPrototype.polluted;
    const normalized = asJsonValue(specialJson) as Record<string, unknown>;

    expect(Object.keys(normalized).sort()).toEqual(
      ["__proto__", "constructor", "nested", "prototype"].sort(),
    );
    expect(Object.prototype.hasOwnProperty.call(normalized, "__proto__")).toBe(
      true,
    );
    expect(
      Object.prototype.hasOwnProperty.call(
        normalized.nested as object,
        "__proto__",
      ),
    ).toBe(true);
    expect(Object.getPrototypeOf(normalized)).toBeNull();
    expect(JSON.parse(JSON.stringify(normalized))).toEqual(specialJson);
    expect(objectPrototype.polluted).toBe(before);
  });

  it("canonicalizes the full JSON value set without mutation or insertion-order dependence", () => {
    const nullPrototype = Object.assign(
      Object.create(null),
      JSON.parse('{"__proto__":{"safe":true}}'),
      {
        prototype: [],
        constructor: {},
      },
    ) as Record<string, unknown>;
    const ordered = {
      unicode: "Xin chào 🌏",
      escaped: '"\\\n',
      emptyObject: {},
      emptyArray: [],
      null: null,
      negativeZero: -0,
      safeInteger: Number.MAX_SAFE_INTEGER,
      floatingPoint: 1.25,
      nested: nullPrototype,
    };
    const reordered = {
      nested: Object.assign(
        Object.create(null),
        JSON.parse('{"__proto__":{"safe":true}}'),
        {
          constructor: {},
          prototype: [],
        },
      ),
      floatingPoint: 1.25,
      safeInteger: Number.MAX_SAFE_INTEGER,
      negativeZero: 0,
      null: null,
      emptyArray: [],
      emptyObject: {},
      escaped: '"\\\n',
      unicode: "Xin chào 🌏",
    };
    const before = JSON.stringify(ordered);

    expect(canonicalJson(ordered)).toBe(canonicalJson(reordered));
    expect(JSON.stringify(ordered)).toBe(before);
    expect(requestFingerprint(request(ordered), "invocation-1")).toBe(
      requestFingerprint(request(reordered), "invocation-1"),
    );
    const changedSpecialKey = request(reordered);
    (
      (changedSpecialKey.invocation.input as Record<string, unknown>)
        .nested as Record<string, unknown>
    )["__proto__"] = { safe: false };
    expect(requestFingerprint(changedSpecialKey, "invocation-1")).not.toBe(
      requestFingerprint(request(ordered), "invocation-1"),
    );
  });

  it("uses current Unix seconds for every retry while keeping delivery ID and body stable", async () => {
    const sent: RequestInit[] = [];
    const result: AgentResultV1 = {
      schemaVersion: "1",
      invocationId: "invocation-1",
      executionId: "execution-1",
      stepExecutionId: "step-execution-1",
      status: "succeeded",
      output: specialJson as JsonValue,
      completedAt: "2026-07-26T00:00:01.000Z",
    };

    const outcome = await deliverCallback(
      {
        agent: "echo-agent",
        runId: "run-1",
        result,
        callbackUrl: "https://orchestrator.example/callback",
        keyId: "callback-v1",
        secret: "callback-secret",
        config: {
          maxAttempts: 2,
          initialDelayMs: 0,
          maxDelayMs: 0,
          jitterRatio: 0,
          requestTimeoutMs: 1000,
          maxResponseBytes: 32,
        },
        logger: noOpLogger,
      },
      {
        id: () => "delivery-1",
        now: () => 1785024000_000,
        sleep: async () => undefined,
        fetch: async (_url, init) => {
          sent.push(init as RequestInit);
          return new Response(null, { status: sent.length === 1 ? 500 : 204 });
        },
      },
    );

    expect(outcome).toMatchObject({ delivered: true, attempts: 2 });
    expect(sent).toHaveLength(2);
    for (const request of sent) {
      const headers = request.headers as Record<string, string>;
      const body = request.body as Buffer;
      expect(headers["X-AgentWeave-Timestamp"]).toBe("1785024000");
      expect(headers["X-AgentWeave-Delivery-Id"]).toBe("delivery-1");
      expect(body.equals(sent[0].body as Buffer)).toBe(true);
      expect(headers["X-AgentWeave-Signature"]).toBe(
        `v1=${createHmac("sha256", "callback-secret")
          .update("1785024000.delivery-1.")
          .update(body)
          .digest("hex")}`,
      );
    }
    expect(
      JSON.parse((sent[0].body as Buffer).toString("utf8")).output,
    ).toEqual(specialJson);
  });

  it("expires only terminal records even when an active record is the map head", () => {
    const store = new InMemoryIdempotencyStore({
      ttlMs: 100,
      maxEntries: 3,
    });
    const create = (invocationId: string) =>
      store.create({
        invocationId,
        requestFingerprint: `${invocationId}-fingerprint`,
        runId: `${invocationId}-run`,
        acceptedAt: "2026-07-26T00:00:00.000Z",
        nowMs: 0,
      });
    const active = create("active");
    const terminal = create("terminal");
    const callbackPending = create("callback-pending");
    store.updateState(active, "running", 0);
    store.updateState(terminal, "delivered", 0);
    store.updateState(callbackPending, "callback_pending", 0);

    store.cleanup(100);

    expect(store.get("active")).toBe(active);
    expect(store.get("terminal")).toBeUndefined();
    expect(store.get("callback-pending")).toBe(callbackPending);
    expect(() => create("replacement")).not.toThrow();
  });

  it("cancels a chunked oversized callback response without retrying", async () => {
    const cancelled = jest.fn();
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(20));
      },
      cancel: cancelled,
    });
    const outcome = await deliverCallback(
      {
        agent: "echo-agent",
        runId: "run-1",
        result: {
          schemaVersion: "1",
          invocationId: "invocation-1",
          executionId: "execution-1",
          stepExecutionId: "step-execution-1",
          status: "succeeded",
          completedAt: "2026-07-26T00:00:01.000Z",
        },
        callbackUrl: "https://orchestrator.example/callback",
        keyId: "callback-v1",
        secret: "callback-secret",
        config: {
          maxAttempts: 2,
          initialDelayMs: 0,
          maxDelayMs: 0,
          jitterRatio: 0,
          requestTimeoutMs: 1000,
          maxResponseBytes: 32,
        },
        logger: noOpLogger,
      },
      {
        fetch: async () => new Response(body, { status: 500 }),
      },
    );

    expect(outcome).toMatchObject({
      delivered: false,
      attempts: 1,
      reason: "response-too-large",
    });
    expect(cancelled).toHaveBeenCalledTimes(1);
  });
});
