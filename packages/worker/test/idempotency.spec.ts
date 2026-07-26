import type { HttpAgentRunRequestV1 } from "@agentweave/contracts";
import {
  canonicalJson,
  requestFingerprint,
} from "../src/invocation/canonical-json";
import { InMemoryIdempotencyStore } from "../src/invocation/idempotency-store";

const request = (): HttpAgentRunRequestV1 => ({
  schemaVersion: "1",
  invocation: {
    schemaVersion: "1",
    invocationId: "invocation-1",
    executionId: "execution-1",
    stepExecutionId: "step-execution-1",
    stepId: "echo",
    target: { agent: "echo-agent" },
    input: { b: 2, a: 1 },
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

describe("canonical request fingerprint", () => {
  it("sorts object keys recursively while preserving array order", () => {
    expect(canonicalJson({ z: [{ b: 2, a: 1 }], a: true })).toBe(
      '{"a":true,"z":[{"a":1,"b":2}]}',
    );
  });

  it("treats semantically equal property order as the same request", () => {
    const reordered = request();
    reordered.invocation.input = { a: 1, b: 2 };

    expect(requestFingerprint(request(), "invocation-1")).toBe(
      requestFingerprint(reordered, "invocation-1"),
    );
  });

  it("changes for input, callback URL, callback key, or idempotency key changes", () => {
    const baseline = requestFingerprint(request(), "invocation-1");
    const changedInput = request();
    changedInput.invocation.input = { a: 2 };
    const changedUrl = request();
    changedUrl.resultDelivery.callbackUrl =
      "https://orchestrator.example/other";
    const changedKey = request();
    changedKey.resultDelivery.authentication.keyId = "callback-v2";

    expect(requestFingerprint(changedInput, "invocation-1")).not.toBe(baseline);
    expect(requestFingerprint(changedUrl, "invocation-1")).not.toBe(baseline);
    expect(requestFingerprint(changedKey, "invocation-1")).not.toBe(baseline);
    expect(requestFingerprint(request(), "different")).not.toBe(baseline);
  });
});

describe("bounded idempotency store", () => {
  it("returns duplicate/conflict without replacing the original acceptance", () => {
    const store = new InMemoryIdempotencyStore({ ttlMs: 1000, maxEntries: 2 });
    const record = store.create({
      invocationId: "invocation-1",
      requestFingerprint: "fingerprint-1",
      runId: "run-1",
      acceptedAt: "2026-07-26T00:00:00.000Z",
      nowMs: 100,
    });

    expect(store.lookup("invocation-1", "fingerprint-1", 200)).toEqual({
      kind: "duplicate",
      record,
    });
    expect(store.lookup("invocation-1", "different", 200)).toEqual({
      kind: "conflict",
      record,
    });
  });

  it("does not evict active or unexpired terminal records at capacity", () => {
    const store = new InMemoryIdempotencyStore({ ttlMs: 1000, maxEntries: 1 });
    store.create({
      invocationId: "invocation-1",
      requestFingerprint: "fingerprint-1",
      runId: "run-1",
      acceptedAt: "2026-07-26T00:00:00.000Z",
      nowMs: 100,
    });

    expect(() =>
      store.create({
        invocationId: "invocation-2",
        requestFingerprint: "fingerprint-2",
        runId: "run-2",
        acceptedAt: "2026-07-26T00:00:01.000Z",
        nowMs: 200,
      }),
    ).toThrow(/capacity/i);
    expect(store.get("invocation-1")).toBeDefined();
  });

  it("cleans only expired terminal records", () => {
    const store = new InMemoryIdempotencyStore({ ttlMs: 1000, maxEntries: 2 });
    const terminal = store.create({
      invocationId: "terminal",
      requestFingerprint: "terminal-fingerprint",
      runId: "run-terminal",
      acceptedAt: "2026-07-26T00:00:00.000Z",
      nowMs: 0,
    });
    store.create({
      invocationId: "active",
      requestFingerprint: "active-fingerprint",
      runId: "run-active",
      acceptedAt: "2026-07-26T00:00:00.000Z",
      nowMs: 0,
    });
    store.updateState(terminal, "delivered", 100);

    store.cleanup(1100);

    expect(store.get("terminal")).toBeUndefined();
    expect(store.get("active")).toBeDefined();
  });

  it("stores no callback secret", () => {
    const store = new InMemoryIdempotencyStore({ ttlMs: 1000, maxEntries: 1 });
    store.create({
      invocationId: "invocation-1",
      requestFingerprint: "fingerprint-1",
      runId: "run-1",
      acceptedAt: "2026-07-26T00:00:00.000Z",
      nowMs: 0,
    });

    expect(JSON.stringify(store.get("invocation-1"))).not.toContain(
      "callback-secret",
    );
  });
});
