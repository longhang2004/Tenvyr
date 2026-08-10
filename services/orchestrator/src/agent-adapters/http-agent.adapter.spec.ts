import {
  ContractValidationError,
  type AgentInvocationV1,
  type AgentResultV1,
} from "@tenvyr/contracts";
import { EventPayloadTooLargeError } from "../services/agent-event.service";
import {
  AgentTransportConfigService,
  parseAgentTransportConfiguration,
} from "./agent-transport-config.service";
import { createHttpCallbackSignature } from "./http-callback-auth";
import { HttpAgentAdapter } from "./http-agent.adapter";

const invocation: AgentInvocationV1 = {
  schemaVersion: "1",
  invocationId: "step-execution-1:1",
  executionId: "execution-1",
  stepExecutionId: "step-execution-1",
  stepId: "security-review",
  target: { agent: "remote-security-reviewer" },
  input: { code: "TOP_SECRET_INPUT" },
  attempt: 1,
  createdAt: "2026-07-26T00:00:00.000Z",
  trace: {
    traceId: "execution-1",
    correlationId: "step-execution-1:1",
  },
};

const result: AgentResultV1 = {
  schemaVersion: "1",
  invocationId: invocation.invocationId,
  executionId: invocation.executionId,
  stepExecutionId: invocation.stepExecutionId,
  status: "succeeded",
  output: { score: 100 },
  completedAt: "2026-07-26T00:00:02.000Z",
};

const environment = (overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  AGENT_TRANSPORT_CONFIG: JSON.stringify({
    "remote-security-reviewer": {
      kind: "http",
      submitUrl: "https://security-agent.internal/v1/runs",
      outboundAuthentication: {
        type: "bearer",
        tokenEnv: "SECURITY_AGENT_TOKEN",
      },
      callbackAuthentication: {
        keyId: "security-agent-v1",
        secretEnv: "SECURITY_AGENT_CALLBACK_SECRET",
      },
      requestTimeoutMs: 100,
      maxResponseBytes: 1024,
    },
  }),
  HTTP_AGENT_CALLBACK_BASE_URL: "https://orchestrator.example",
  SECURITY_AGENT_TOKEN: "bearer-secret",
  SECURITY_AGENT_CALLBACK_SECRET: "callback-secret",
  ...overrides,
});

const acceptedResponse = (
  overrides: Record<string, unknown> = {},
  status = 202,
) =>
  new Response(
    JSON.stringify({
      schemaVersion: "1",
      invocationId: invocation.invocationId,
      runId: "remote-run-123",
      status: "accepted",
      acceptedAt: "2026-07-26T00:00:01.000Z",
      ...overrides,
    }),
    {
      status,
      headers: { "Content-Type": "application/json" },
    },
  );

describe("HttpAgentAdapter", () => {
  let adapter: HttpAgentAdapter;
  let handler: jest.Mock;
  let fetchMock: jest.SpyInstance;

  beforeEach(() => {
    const config = new AgentTransportConfigService(
      parseAgentTransportConfiguration(environment()),
    );
    adapter = new HttpAgentAdapter(config);
    handler = jest.fn().mockResolvedValue(undefined);
    fetchMock = jest
      .spyOn(global, "fetch")
      .mockResolvedValue(acceptedResponse());
  });

  afterEach(() => {
    fetchMock.mockRestore();
    jest.restoreAllMocks();
  });

  describe("lifecycle", () => {
    it("exposes a stable kind and starts/stops idempotently", async () => {
      expect(adapter.kind).toBe("http");
      const handlers = { result: handler, event: jest.fn() };
      await adapter.start(handlers);
      await adapter.start(handlers);
      await adapter.stop();
      await adapter.stop();
      await expect(adapter.invoke(invocation)).rejects.toMatchObject({
        code: "ADAPTER_NOT_STARTED",
      });
    });

    it("rejects a different handler while already started", async () => {
      await adapter.start({ result: handler, event: jest.fn() });

      await expect(adapter.start({ result: jest.fn(), event: jest.fn() })).rejects.toMatchObject({
        code: "ADAPTER_START_FAILED",
      });
    });
  });

  describe("outbound", () => {
    let eventHandler: jest.Mock;

    beforeEach(async () => {
      eventHandler = jest.fn().mockResolvedValue(undefined);
      await adapter.start({ result: handler, event: eventHandler });
    });

    it("submits the canonical callback request with authentication and idempotency headers", async () => {
      await adapter.invoke(invocation);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("https://security-agent.internal/v1/runs");
      expect(init.method).toBe("POST");
      expect(init.headers).toMatchObject({
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: "Bearer bearer-secret",
        "Idempotency-Key": invocation.invocationId,
        "User-Agent": "Tenvyr-Orchestrator/0.1.0",
      });
      expect(
        Object.keys(init.headers as Record<string, string>).some((header) =>
          /^x-tenvyr-/i.test(header),
        ),
      ).toBe(false);
      expect(JSON.parse(init.body as string)).toEqual({
        schemaVersion: "1",
        invocation,
        resultDelivery: {
          mode: "callback",
          callbackUrl:
            "https://orchestrator.example/internal/agent-callbacks/http/remote-security-reviewer",
          authentication: {
            scheme: "hmac-sha256",
            keyId: "security-agent-v1",
          },
        },
      });
      expect(init.body).not.toContain("callback-secret");
    });

    it("omits Authorization for explicit none authentication", async () => {
      const config = new AgentTransportConfigService(
        parseAgentTransportConfiguration(
          environment({
            AGENT_TRANSPORT_CONFIG: JSON.stringify({
              "remote-security-reviewer": {
                kind: "http",
                submitUrl: "https://security-agent.internal/v1/runs",
                outboundAuthentication: { type: "none" },
                callbackAuthentication: {
                  keyId: "security-agent-v1",
                  secretEnv: "SECURITY_AGENT_CALLBACK_SECRET",
                },
                requestTimeoutMs: 100,
                maxResponseBytes: 1024,
              },
            }),
          }),
        ),
      );
      const noAuthAdapter = new HttpAgentAdapter(config);
      await noAuthAdapter.start({ result: handler, event: jest.fn() });

      await noAuthAdapter.invoke(invocation);

      expect(
        (fetchMock.mock.calls[0][1] as RequestInit).headers,
      ).not.toHaveProperty("Authorization");
    });

    it("returns a correlated receipt with the remote run ID", async () => {
      const receipt = await adapter.invoke(invocation);

      expect(receipt).toMatchObject({
        adapter: "http",
        invocationId: invocation.invocationId,
        dispatchId: "remote-run-123",
      });
      expect(Date.parse(receipt.dispatchedAt)).not.toBeNaN();
    });

    it("rejects invalid invocation before the request", async () => {
      await expect(
        adapter.invoke({ ...invocation, attempt: 0 }),
      ).rejects.toBeInstanceOf(ContractValidationError);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("rejects a response invocation mismatch", async () => {
      fetchMock.mockResolvedValue(
        acceptedResponse({ invocationId: "different:1" }),
      );

      await expect(adapter.invoke(invocation)).rejects.toMatchObject({
        code: "HTTP_INVOCATION_MISMATCH",
        retryable: false,
      });
    });

    it.each([
      [200, false],
      [400, false],
      [401, false],
      [403, false],
      [404, false],
      [408, true],
      [429, true],
      [500, true],
      [503, true],
    ])(
      "maps HTTP %i rejection with retryable=%s",
      async (status, retryable) => {
        fetchMock.mockResolvedValue(acceptedResponse({}, status));

        await expect(adapter.invoke(invocation)).rejects.toMatchObject({
          code: "HTTP_REJECTED",
          httpStatus: status,
          retryable,
        });
        expect(fetchMock).toHaveBeenCalledTimes(1);
      },
    );

    it("maps connection failure as retryable without retrying", async () => {
      fetchMock.mockRejectedValue(
        new Error("connect ECONNREFUSED bearer-secret"),
      );

      await expect(adapter.invoke(invocation)).rejects.toMatchObject({
        code: "HTTP_CONNECTION_FAILED",
        retryable: true,
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("aborts timed-out requests without retrying", async () => {
      fetchMock.mockImplementation(
        async (_url, init) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              const error = new Error("aborted");
              error.name = "AbortError";
              reject(error);
            });
          }),
      );

      await expect(adapter.invoke(invocation)).rejects.toMatchObject({
        code: "HTTP_REQUEST_TIMEOUT",
        retryable: true,
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("rejects oversized responses", async () => {
      fetchMock.mockResolvedValue(
        new Response("x".repeat(1025), {
          status: 202,
          headers: { "Content-Type": "application/json" },
        }),
      );

      await expect(adapter.invoke(invocation)).rejects.toMatchObject({
        code: "HTTP_RESPONSE_TOO_LARGE",
        retryable: false,
      });
    });

    it.each([
      [
        "invalid JSON",
        new Response("{no-json", {
          status: 202,
          headers: { "Content-Type": "application/json" },
        }),
      ],
      [
        "invalid accepted response",
        acceptedResponse({
          runId: "",
        }),
      ],
      [
        "invalid content type",
        new Response("{}", {
          status: 202,
          headers: { "Content-Type": "text/plain" },
        }),
      ],
    ])("rejects %s", async (_case, response) => {
      fetchMock.mockResolvedValue(response);

      await expect(adapter.invoke(invocation)).rejects.toMatchObject({
        code: "HTTP_INVALID_RESPONSE",
        retryable: false,
      });
    });

    it("does not log input, bearer token, callback secret, or response body", async () => {
      const log = jest.spyOn(console, "log").mockImplementation();
      const error = jest.spyOn(console, "error").mockImplementation();
      fetchMock.mockResolvedValue(
        new Response("TOP_SECRET_RESPONSE", {
          status: 500,
          headers: { "Content-Type": "text/plain" },
        }),
      );

      await expect(adapter.invoke(invocation)).rejects.toBeDefined();

      const logged = JSON.stringify([...log.mock.calls, ...error.mock.calls]);
      expect(logged).not.toContain("TOP_SECRET_INPUT");
      expect(logged).not.toContain("bearer-secret");
      expect(logged).not.toContain("callback-secret");
      expect(logged).not.toContain("TOP_SECRET_RESPONSE");
    });
  });

  describe("callback delivery", () => {
    const timestamp = "1785024000";
    const rawBody = Buffer.from(JSON.stringify(result));
    const callback = (overrides: Record<string, unknown> = {}) => ({
      agent: "remote-security-reviewer",
      keyId: "security-agent-v1",
      timestamp,
      deliveryId: "delivery-1",
      signature: createHttpCallbackSignature(
        "callback-secret",
        timestamp,
        "delivery-1",
        rawBody,
      ),
      rawBody,
      remoteAddress: "127.0.0.1",
      nowMs: Number(timestamp) * 1000,
      ...overrides,
    });

    let eventHandler: jest.Mock;

    beforeEach(async () => {
      eventHandler = jest.fn().mockResolvedValue(undefined);
      await adapter.start({ result: handler, event: eventHandler });
    });

    it("authenticates, validates, and delivers a canonical result with HTTP metadata", async () => {
      await expect(adapter.handleCallback(callback())).resolves.toBe(
        "processed",
      );

      expect(handler).toHaveBeenCalledWith({
        result,
        transport: expect.objectContaining({
          adapter: "http",
          deliveryId: "delivery-1",
          keyId: "security-agent-v1",
          remoteAddress: "127.0.0.1",
        }),
      });
    });

    it("returns duplicate without calling the handler twice", async () => {
      await adapter.handleCallback(callback());
      await expect(adapter.handleCallback(callback())).resolves.toBe(
        "duplicate",
      );

      expect(handler).toHaveBeenCalledTimes(1);
    });

    it("routes an in-flight duplicate through the durable handler", async () => {
      let resolveHandler!: (value: unknown) => void;
      handler.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveHandler = resolve;
          }),
      );

      const first = adapter.handleCallback(callback());
      // A concurrent retry with the same deliveryId lands while the first
      // delivery is still in-flight. It must not be rejected: the durable
      // ResultInbox is the authoritative deduplicator, so both deliveries are
      // accepted and the worker stops retrying.
      const second = adapter.handleCallback(callback());
      await expect(second).resolves.toBe("processed");
      expect(handler).toHaveBeenCalledTimes(2);

      resolveHandler(undefined);
      await expect(first).resolves.toBe("processed");

      // Once the delivery completed, a later replay is a fast-path duplicate.
      await expect(adapter.handleCallback(callback())).resolves.toBe(
        "duplicate",
      );
      expect(handler).toHaveBeenCalledTimes(2);
    });

    it.each([
      ["unknown agent", { agent: "unknown" }],
      ["unknown key ID", { keyId: "unknown" }],
      ["invalid signature", { signature: `v1=${"0".repeat(64)}` }],
    ])("rejects %s before result delivery", async (_case, overrides) => {
      await expect(
        adapter.handleCallback(callback(overrides)),
      ).rejects.toMatchObject({
        code: "CALLBACK_UNAUTHORIZED",
      });
      expect(handler).not.toHaveBeenCalled();
    });

    it("rejects invalid JSON after authentication", async () => {
      const invalidBody = Buffer.from("{not-json");
      const request = callback({
        rawBody: invalidBody,
        signature: createHttpCallbackSignature(
          "callback-secret",
          timestamp,
          "delivery-1",
          invalidBody,
        ),
      });

      await expect(adapter.handleCallback(request)).rejects.toMatchObject({
        code: "CALLBACK_INVALID",
      });
      expect(handler).not.toHaveBeenCalled();
    });

    it("rejects invalid result contracts", async () => {
      const invalidBody = Buffer.from(
        JSON.stringify({ ...result, stepExecutionId: "" }),
      );
      const request = callback({
        rawBody: invalidBody,
        signature: createHttpCallbackSignature(
          "callback-secret",
          timestamp,
          "delivery-1",
          invalidBody,
        ),
      });

      await expect(adapter.handleCallback(request)).rejects.toBeInstanceOf(
        ContractValidationError,
      );
      expect(handler).not.toHaveBeenCalled();
    });

    it("returns unavailable when no result handler is registered", async () => {
      await adapter.stop();

      await expect(adapter.handleCallback(callback())).rejects.toMatchObject({
        code: "CALLBACK_HANDLER_UNAVAILABLE",
      });
    });

    it("allows retry after handler failure", async () => {
      handler
        .mockRejectedValueOnce(new Error("temporary result failure"))
        .mockResolvedValueOnce(undefined);

      await expect(adapter.handleCallback(callback())).rejects.toMatchObject({
        code: "RESULT_HANDLER_FAILED",
      });
      await expect(adapter.handleCallback(callback())).resolves.toBe(
        "processed",
      );
      expect(handler).toHaveBeenCalledTimes(2);
    });

    it("does not log the full result body or raw signature", async () => {
      const log = jest.spyOn(console, "log").mockImplementation();
      const error = jest.spyOn(console, "error").mockImplementation();
      const request = callback();

      await adapter.handleCallback(request);

      const logged = JSON.stringify([...log.mock.calls, ...error.mock.calls]);
      expect(logged).not.toContain(JSON.stringify(result));
      expect(logged).not.toContain(request.signature);
    });

    it("delivers a signed canonical AgentEvent to the event handler with safe metadata", async () => {
      const eventBody = {
        schemaVersion: "1",
        eventId: "event-1",
        invocationId: "step-execution-1:1",
        executionId: "execution-1",
        stepExecutionId: "step-execution-1",
        sequence: 3,
        type: "progress",
        occurredAt: "2026-08-10T00:00:00.000Z",
        payload: { stage: "indexing" },
        trace: { traceId: "execution-1", correlationId: "step-execution-1:1" },
      };
      const raw = Buffer.from(JSON.stringify(eventBody));
      const request = callback({
        deliveryId: "delivery-event-1",
        rawBody: raw,
        signature: createHttpCallbackSignature(
          "callback-secret",
          timestamp,
          "delivery-event-1",
          raw,
        ),
      });

      await expect(adapter.handleCallback(request)).resolves.toBe("processed");

      expect(eventHandler).toHaveBeenCalledWith({
        event: expect.objectContaining({
          eventId: "event-1",
          sequence: 3,
          type: "progress",
        }),
        transport: expect.objectContaining({
          adapter: "http",
          deliveryId: "delivery-event-1",
          keyId: "security-agent-v1",
        }),
      });
      expect(handler).not.toHaveBeenCalled();
    });

    it("rejects a signed body that matches both result and event shapes", async () => {
      const ambiguous = {
        schemaVersion: "1",
        status: "succeeded",
        completedAt: "2026-08-10T00:00:00.000Z",
        eventId: "event-1",
        sequence: 1,
        type: "progress",
        invocationId: "step-execution-1:1",
        executionId: "execution-1",
        stepExecutionId: "step-execution-1",
        occurredAt: "2026-08-10T00:00:00.000Z",
        payload: {},
        trace: { traceId: "execution-1", correlationId: "step-execution-1:1" },
      };
      const raw = Buffer.from(JSON.stringify(ambiguous));
      const request = callback({
        deliveryId: "delivery-ambiguous",
        rawBody: raw,
        signature: createHttpCallbackSignature(
          "callback-secret",
          timestamp,
          "delivery-ambiguous",
          raw,
        ),
      });

      await expect(adapter.handleCallback(request)).rejects.toMatchObject({
        code: "CALLBACK_AMBIGUOUS",
        retryable: false,
      });
      expect(handler).not.toHaveBeenCalled();
      expect(eventHandler).not.toHaveBeenCalled();
    });

    it("rejects an invalid AgentEvent as a bad request", async () => {
      const invalid = {
        schemaVersion: "1",
        eventId: "event-1",
        invocationId: "step-execution-1:1",
        executionId: "execution-1",
        stepExecutionId: "step-execution-1",
        sequence: "not-a-number",
        type: "progress",
        occurredAt: "2026-08-10T00:00:00.000Z",
        payload: {},
        trace: { traceId: "execution-1", correlationId: "step-execution-1:1" },
      };
      const raw = Buffer.from(JSON.stringify(invalid));
      const request = callback({
        deliveryId: "delivery-invalid",
        rawBody: raw,
        signature: createHttpCallbackSignature(
          "callback-secret",
          timestamp,
          "delivery-invalid",
          raw,
        ),
      });

      await expect(adapter.handleCallback(request)).rejects.toBeInstanceOf(
        ContractValidationError,
      );
      expect(eventHandler).not.toHaveBeenCalled();
    });

    it("rejects an event with an invalid signature", async () => {
      const eventBody = {
        schemaVersion: "1",
        eventId: "event-1",
        invocationId: "step-execution-1:1",
        executionId: "execution-1",
        stepExecutionId: "step-execution-1",
        sequence: 1,
        type: "heartbeat",
        occurredAt: "2026-08-10T00:00:00.000Z",
        payload: {},
        trace: { traceId: "execution-1", correlationId: "step-execution-1:1" },
      };
      const raw = Buffer.from(JSON.stringify(eventBody));
      const request = callback({
        deliveryId: "delivery-bad-signature",
        rawBody: raw,
        signature: "v1=deadbeef",
      });

      await expect(adapter.handleCallback(request)).rejects.toMatchObject({
        code: "CALLBACK_UNAUTHORIZED",
      });
      expect(eventHandler).not.toHaveBeenCalled();
    });

    it("propagates a durable event handler failure as retryable so the worker retries", async () => {
      const eventBody = {
        schemaVersion: "1",
        eventId: "event-1",
        invocationId: "step-execution-1:1",
        executionId: "execution-1",
        stepExecutionId: "step-execution-1",
        sequence: 1,
        type: "heartbeat",
        occurredAt: "2026-08-10T00:00:00.000Z",
        payload: {},
        trace: { traceId: "execution-1", correlationId: "step-execution-1:1" },
      };
      const raw = Buffer.from(JSON.stringify(eventBody));
      const request = callback({
        deliveryId: "delivery-db-down",
        rawBody: raw,
        signature: createHttpCallbackSignature(
          "callback-secret",
          timestamp,
          "delivery-db-down",
          raw,
        ),
      });
      eventHandler.mockRejectedValueOnce(new Error("database unavailable"));

      await expect(adapter.handleCallback(request)).rejects.toMatchObject({
        code: "EVENT_HANDLER_FAILED",
        retryable: true,
      });
      // The replay-cache entry must not be marked completed before durable
      // handling succeeds: the retry re-runs the handler instead of getting a
      // fast-path duplicate ack.
      await expect(adapter.handleCallback(request)).resolves.toBe("processed");
      expect(eventHandler).toHaveBeenCalledTimes(2);
    });

    it("permanently rejects an oversized event payload (non-retryable)", async () => {
      const eventBody = {
        schemaVersion: "1",
        eventId: "event-oversized",
        invocationId: "step-execution-1:1",
        executionId: "execution-1",
        stepExecutionId: "step-execution-1",
        sequence: 1,
        type: "progress",
        occurredAt: "2026-08-10T00:00:00.000Z",
        payload: { blob: "x".repeat(70 * 1024) },
        trace: { traceId: "execution-1", correlationId: "step-execution-1:1" },
      };
      const raw = Buffer.from(JSON.stringify(eventBody));
      const request = callback({
        deliveryId: "delivery-oversized",
        rawBody: raw,
        signature: createHttpCallbackSignature(
          "callback-secret",
          timestamp,
          "delivery-oversized",
          raw,
        ),
      });
      eventHandler.mockRejectedValueOnce(
        new EventPayloadTooLargeError(65536),
      );

      await expect(adapter.handleCallback(request)).rejects.toMatchObject({
        code: "EVENT_HANDLER_FAILED",
        retryable: false,
      });
    });

    it("deduplicates an event replay across a simulated replay-cache reset through PostgreSQL", async () => {
      const eventBody = {
        schemaVersion: "1",
        eventId: "event-1",
        invocationId: "step-execution-1:1",
        executionId: "execution-1",
        stepExecutionId: "step-execution-1",
        sequence: 1,
        type: "progress",
        occurredAt: "2026-08-10T00:00:00.000Z",
        payload: { stage: "indexing" },
        trace: { traceId: "execution-1", correlationId: "step-execution-1:1" },
      };
      const raw = Buffer.from(JSON.stringify(eventBody));
      const request = callback({
        deliveryId: "delivery-replay",
        rawBody: raw,
        signature: createHttpCallbackSignature(
          "callback-secret",
          timestamp,
          "delivery-replay",
          raw,
        ),
      });

      await adapter.handleCallback(request);
      // Simulate a process restart: the in-memory replay cache is gone, the
      // durable AgentEventService still sees the same delivery and dedupes.
      adapter.stop();
      await adapter.start({ result: handler, event: eventHandler });
      await expect(adapter.handleCallback(request)).resolves.toBe("processed");
      expect(eventHandler).toHaveBeenCalledTimes(2);
    });
  });
});
