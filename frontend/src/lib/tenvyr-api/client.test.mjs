import { test, describe, mock } from "node:test";
import assert from "node:assert/strict";
import { TenvyrApiClient } from "./client.ts";
import { TenvyrApiError } from "./errors.ts";
import { parseConnectionTestResult } from "./guards.ts";

describe("TenvyrApiClient", () => {
  const fakeBaseUrl = "http://fake-gateway.local";

  test("getRuntimeOnboarding fetches runtime kind status", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock.fn(async (url) => {
      assert.equal(url, `${fakeBaseUrl}/api/workbench/onboarding/codex`);
      return new Response(
        JSON.stringify({
          status: {
            runtimeKind: "codex",
            detected: true,
            executable: "/usr/local/bin/codex",
            version: "0.2.0",
            pinnedVersion: "0.2.0",
            authReady: true,
            guidance: [],
            docUrl: "https://tenvyr.dev",
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    try {
      const client = new TenvyrApiClient(fakeBaseUrl);
      const res = await client.getRuntimeOnboarding("codex");
      assert.equal(res.status.runtimeKind, "codex");
      assert.equal(res.status.detected, true);
      assert.equal(res.status.version, "0.2.0");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("startTeamRun sends payload with idempotency key", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock.fn(async (url, options) => {
      assert.equal(url, `${fakeBaseUrl}/api/workbench/commands/start-team-run`);
      assert.equal(options.method, "POST");
      const body = JSON.parse(options.body);
      assert.equal(body.goal, "Fix authentication bug");
      assert.equal(body.idempotencyKey, "test-idempotency-key");
      return new Response(
        JSON.stringify({
          outcome: "executed",
          action: "start-team-run",
          result: { executionId: "exec-123", workspace: "/srv/work" },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    try {
      const client = new TenvyrApiClient(fakeBaseUrl);
      const res = await client.startTeamRun({
        idempotencyKey: "test-idempotency-key",
        goal: "Fix authentication bug",
        config: {
          schemaVersion: 1,
          planner: { kind: "agent", name: "planner" },
          verifier: { kind: "agent", name: "verifier" },
          allowedWorkers: [{ kind: "agent", name: "codex" }],
          maxIterations: 3,
          maxWorkersPerIteration: 4,
          maxTotalWorkers: 12,
          loopDeadlineMs: 3600000,
          delegationDepthMax: 2,
          allowedExecutors: ["local-host"],
        },
      });
      assert.equal(res.outcome, "executed");
      assert.equal(res.result?.executionId, "exec-123");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("normalizes HTTP error responses into TenvyrApiError", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock.fn(async () => {
      return new Response(
        JSON.stringify({
          error: {
            code: "EXECUTION_NOT_FOUND",
            message: "Execution does not exist",
          },
        }),
        { status: 404, headers: { "Content-Type": "application/json" } },
      );
    });

    try {
      const client = new TenvyrApiClient(fakeBaseUrl);
      await assert.rejects(
        () => client.getWorkbenchExecution("nonexistent-id"),
        (err) => {
          assert(err instanceof TenvyrApiError);
          assert.equal(err.status, 404);
          assert.equal(err.code, "EXECUTION_NOT_FOUND");
          assert.match(err.message, /Execution does not exist/);
          return true;
        },
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("testConnection surfaces the nested AUTH_REQUIRED receipt (P2 regression: never READY)", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock.fn(async (url, options) => {
      assert.equal(url, `${fakeBaseUrl}/api/connections/conn%3Acodex/test`);
      assert.equal(options.method, "POST");
      return new Response(
        JSON.stringify({
          success: true,
          data: {
            action: "test-connection",
            idempotencyKey: "key-1",
            outcome: "executed",
            result: {
              connectionId: "conn:codex",
              receipt: {
                connectionId: "conn:codex",
                revisionNumber: 3,
                testedAt: "2026-08-15T00:00:00.000Z",
                state: "AUTH_REQUIRED",
                reasonCode: "auth-required",
                durationMs: 42,
              },
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    try {
      const client = new TenvyrApiClient(fakeBaseUrl);
      const res = await client.testConnection("conn:codex");
      const parsed = parseConnectionTestResult(res.data);
      assert.equal(parsed.result.receipt.state, "AUTH_REQUIRED");
      // The top-level envelope has no status/state; the old page code
      // would have fallen through to the "READY" literal here.
      assert.equal(res.data.status, undefined);
      assert.equal(res.data.state, undefined);
      assert.notEqual(parsed.result.receipt.state, "READY");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("handles gateway offline / network failure gracefully", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock.fn(async () => {
      throw new Error("ECONNREFUSED");
    });

    try {
      const client = new TenvyrApiClient(fakeBaseUrl);
      await assert.rejects(
        () => client.getHealth(),
        (err) => {
          assert(err instanceof TenvyrApiError);
          assert.equal(err.code, "NETWORK_ERROR");
          assert.match(err.message, /Failed to reach Tenvyr Gateway/);
          return true;
        },
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
