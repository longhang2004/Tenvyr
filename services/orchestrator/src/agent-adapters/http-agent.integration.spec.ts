import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { createServer, type Server } from "http";
import type { AddressInfo } from "net";
import type { AgentInvocationV1, AgentResultV1 } from "@tenvyr/contracts";
import {
  AgentTransportConfigService,
  parseAgentTransportConfiguration,
} from "./agent-transport-config.service";
import { createHttpCallbackSignature } from "./http-callback-auth";
import { HttpAgentAdapter } from "./http-agent.adapter";
import { HttpAgentCallbackController } from "./http-agent-callback.controller";
import { EventPayloadTooLargeError } from "../services/agent-event.service";

const invocation: AgentInvocationV1 = {
  schemaVersion: "1",
  invocationId: "step-execution-1:1",
  executionId: "execution-1",
  stepExecutionId: "step-execution-1",
  stepId: "security-review",
  target: { agent: "remote-security-reviewer" },
  input: { code: "const safe = true;" },
  attempt: 1,
  createdAt: "2026-07-26T00:00:00.000Z",
  trace: {
    traceId: "execution-1",
    correlationId: "step-execution-1:1",
  },
};

describe("HTTP agent loopback integration", () => {
  let remoteAgent: Server;
  let app: INestApplication;
  let adapter: HttpAgentAdapter;
  let resultHandler: jest.Mock;
  let submittedRequest: {
    method?: string;
    headers: Record<string, string | string[] | undefined>;
    body: any;
  };

  beforeAll(async () => {
    const callbackPort = await availablePort();
    remoteAgent = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks).toString("utf8");
      submittedRequest = {
        method: request.method,
        headers: request.headers,
        body: JSON.parse(body),
      };
      response.writeHead(202, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          schemaVersion: "1",
          invocationId: submittedRequest.body.invocation.invocationId,
          runId: "remote-run-loopback",
          status: "accepted",
          acceptedAt: "2026-07-26T00:00:01.000Z",
        }),
      );
    });
    await listen(remoteAgent);
    const remotePort = (remoteAgent.address() as AddressInfo).port;
    const config = new AgentTransportConfigService(
      parseAgentTransportConfiguration({
        AGENT_TRANSPORT_CONFIG: JSON.stringify({
          "remote-security-reviewer": {
            kind: "http",
            submitUrl: `http://127.0.0.1:${remotePort}/v1/runs`,
            outboundAuthentication: {
              type: "bearer",
              tokenEnv: "LOOPBACK_AGENT_TOKEN",
            },
            callbackAuthentication: {
              keyId: "loopback-v1",
              secretEnv: "LOOPBACK_CALLBACK_SECRET",
            },
            requestTimeoutMs: 1000,
            maxResponseBytes: 4096,
          },
        }),
        HTTP_AGENT_CALLBACK_BASE_URL: `http://127.0.0.1:${callbackPort}`,
        HTTP_AGENT_ALLOW_INSECURE: "true",
        LOOPBACK_AGENT_TOKEN: "loopback-bearer",
        LOOPBACK_CALLBACK_SECRET: "loopback-callback-secret",
      }),
    );
    const module = await Test.createTestingModule({
      controllers: [HttpAgentCallbackController],
      providers: [
        { provide: AgentTransportConfigService, useValue: config },
        HttpAgentAdapter,
      ],
    }).compile();
    app = module.createNestApplication({ rawBody: true });
    await app.listen(callbackPort, "127.0.0.1");
    adapter = module.get(HttpAgentAdapter);
    resultHandler = jest.fn().mockResolvedValue(undefined);
    await adapter.start({ result: resultHandler, event: jest.fn() });
  });

  afterAll(async () => {
    await adapter.stop();
    await app.close();
    await close(remoteAgent);
  });

  it("submits to a real local agent and receives a signed callback through Nest", async () => {
    const receipt = await adapter.invoke(invocation);

    expect(receipt).toMatchObject({
      adapter: "http",
      invocationId: invocation.invocationId,
      dispatchId: "remote-run-loopback",
    });
    expect(submittedRequest).toMatchObject({
      method: "POST",
      headers: {
        authorization: "Bearer loopback-bearer",
        "idempotency-key": invocation.invocationId,
        "content-type": "application/json",
      },
      body: {
        schemaVersion: "1",
        invocation,
        resultDelivery: {
          mode: "callback",
          authentication: {
            scheme: "hmac-sha256",
            keyId: "loopback-v1",
          },
        },
      },
    });

    const result: AgentResultV1 = {
      schemaVersion: "1",
      invocationId: invocation.invocationId,
      executionId: invocation.executionId,
      stepExecutionId: invocation.stepExecutionId,
      status: "succeeded",
      output: { score: 100 },
      completedAt: "2026-07-26T00:00:02.000Z",
    };
    const rawBody = JSON.stringify(result);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const deliveryId = "loopback-delivery-1";
    const response = await fetch(
      submittedRequest.body.resultDelivery.callbackUrl,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-AgentWeave-Key-Id": "loopback-v1",
          "X-AgentWeave-Timestamp": timestamp,
          "X-AgentWeave-Delivery-Id": deliveryId,
          "X-AgentWeave-Signature": createHttpCallbackSignature(
            "loopback-callback-secret",
            timestamp,
            deliveryId,
            Buffer.from(rawBody),
          ),
        },
        body: rawBody,
      },
    );

    expect(response.status).toBe(204);
    expect(resultHandler).toHaveBeenCalledWith({
      result,
      transport: expect.objectContaining({
        adapter: "http",
        deliveryId,
        keyId: "loopback-v1",
      }),
    });
  });

  it("rejects a permanently oversized signed AgentEvent with 400 (no retry)", async () => {
    const eventHandler = jest
      .fn()
      .mockRejectedValue(new EventPayloadTooLargeError(64 * 1024));
    await adapter.stop();
    await adapter.start({ result: resultHandler, event: eventHandler });

    const event = {
      schemaVersion: "1",
      eventId: "step-execution-1:1:0",
      invocationId: invocation.invocationId,
      executionId: invocation.executionId,
      stepExecutionId: invocation.stepExecutionId,
      sequence: 0,
      type: "progress",
      occurredAt: "2026-07-26T00:00:01.000Z",
      payload: { data: "x".repeat(64 * 1024) },
      trace: { traceId: "execution-1", correlationId: "step-execution-1:1" },
      metadata: { runId: "remote-run-loopback" },
    };
    const rawBody = JSON.stringify(event);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const deliveryId = "loopback-delivery-oversized";
    const response = await fetch(
      `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}/internal/agent-callbacks/http/remote-security-reviewer`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-AgentWeave-Key-Id": "loopback-v1",
          "X-AgentWeave-Timestamp": timestamp,
          "X-AgentWeave-Delivery-Id": deliveryId,
          "X-AgentWeave-Signature": createHttpCallbackSignature(
            "loopback-callback-secret",
            timestamp,
            deliveryId,
            Buffer.from(rawBody),
          ),
        },
        body: rawBody,
      },
    );

    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain("exceeds");
    expect(eventHandler).toHaveBeenCalledTimes(1);
  });

  it("maps a transient signed AgentEvent failure to 503 (Worker retries)", async () => {
    const eventHandler = jest
      .fn()
      .mockRejectedValue(new Error("transient database failure"));
    await adapter.stop();
    await adapter.start({ result: resultHandler, event: eventHandler });

    const event = {
      schemaVersion: "1",
      eventId: "step-execution-1:1:0",
      invocationId: invocation.invocationId,
      executionId: invocation.executionId,
      stepExecutionId: invocation.stepExecutionId,
      sequence: 0,
      type: "accepted",
      occurredAt: "2026-07-26T00:00:01.000Z",
      payload: { acceptedAt: "2026-07-26T00:00:01.000Z" },
      trace: { traceId: "execution-1", correlationId: "step-execution-1:1" },
      metadata: { runId: "remote-run-loopback" },
    };
    const rawBody = JSON.stringify(event);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const deliveryId = "loopback-delivery-transient";
    const response = await fetch(
      `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}/internal/agent-callbacks/http/remote-security-reviewer`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-AgentWeave-Key-Id": "loopback-v1",
          "X-AgentWeave-Timestamp": timestamp,
          "X-AgentWeave-Delivery-Id": deliveryId,
          "X-AgentWeave-Signature": createHttpCallbackSignature(
            "loopback-callback-secret",
            timestamp,
            deliveryId,
            Buffer.from(rawBody),
          ),
        },
        body: rawBody,
      },
    );

    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("database");
    expect(eventHandler).toHaveBeenCalledTimes(1);
  });

  it("accepts a signed storage-safe boundary event (eventId 255, sequence int32 max)", async () => {
    const eventHandler = jest.fn().mockResolvedValue(undefined);
    await adapter.stop();
    await adapter.start({ result: resultHandler, event: eventHandler });

    const event = {
      schemaVersion: "1",
      eventId: "e".repeat(255),
      invocationId: invocation.invocationId,
      executionId: invocation.executionId,
      stepExecutionId: invocation.stepExecutionId,
      sequence: 2147483647,
      type: "progress",
      occurredAt: "2026-07-26T00:00:01.000Z",
      payload: { stage: "indexing" },
      trace: { traceId: "execution-1", correlationId: "step-execution-1:1" },
      metadata: { runId: "remote-run-loopback" },
    };
    const rawBody = JSON.stringify(event);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const deliveryId = "loopback-delivery-boundary";
    const response = await fetch(
      `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}/internal/agent-callbacks/http/remote-security-reviewer`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-AgentWeave-Key-Id": "loopback-v1",
          "X-AgentWeave-Timestamp": timestamp,
          "X-AgentWeave-Delivery-Id": deliveryId,
          "X-AgentWeave-Signature": createHttpCallbackSignature(
            "loopback-callback-secret",
            timestamp,
            deliveryId,
            Buffer.from(rawBody),
          ),
        },
        body: rawBody,
      },
    );

    expect(response.status).toBe(204);
    expect(eventHandler).toHaveBeenCalledTimes(1);
  });

  it("permanently rejects a signed storage-invalid event with 400 (no retry)", async () => {
    const eventHandler = jest.fn().mockResolvedValue(undefined);
    await adapter.stop();
    await adapter.start({ result: resultHandler, event: eventHandler });

    for (const overrides of [
      { eventId: "e".repeat(256) },
      { sequence: 2147483648 },
    ]) {
      const event = {
        schemaVersion: "1",
        eventId: "event-1",
        invocationId: invocation.invocationId,
        executionId: invocation.executionId,
        stepExecutionId: invocation.stepExecutionId,
        sequence: 0,
        type: "progress",
        occurredAt: "2026-07-26T00:00:01.000Z",
        payload: { stage: "indexing" },
        trace: {
          traceId: "execution-1",
          correlationId: "step-execution-1:1",
        },
        metadata: { runId: "remote-run-loopback" },
        ...overrides,
      };
      const rawBody = JSON.stringify(event);
      const timestamp = String(Math.floor(Date.now() / 1000));
      const deliveryId = `loopback-delivery-invalid-${overrides.eventId ? "id" : "seq"}`;
      const response = await fetch(
        `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}/internal/agent-callbacks/http/remote-security-reviewer`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-AgentWeave-Key-Id": "loopback-v1",
            "X-AgentWeave-Timestamp": timestamp,
            "X-AgentWeave-Delivery-Id": deliveryId,
            "X-AgentWeave-Signature": createHttpCallbackSignature(
              "loopback-callback-secret",
              timestamp,
              deliveryId,
              Buffer.from(rawBody),
            ),
          },
          body: rawBody,
        },
      );

      expect(response.status).toBe(400);
      expect(await response.text()).not.toContain("eventId");
    }
    expect(eventHandler).not.toHaveBeenCalled();
  });

  it("rejects an authenticated delivery id longer than the durable 255-char bound with 400", async () => {
    const eventHandler = jest.fn().mockResolvedValue(undefined);
    await adapter.stop();
    await adapter.start({ result: resultHandler, event: eventHandler });

    const event = {
      schemaVersion: "1",
      eventId: "event-1",
      invocationId: invocation.invocationId,
      executionId: invocation.executionId,
      stepExecutionId: invocation.stepExecutionId,
      sequence: 0,
      type: "accepted",
      occurredAt: "2026-07-26T00:00:01.000Z",
      payload: { acceptedAt: "2026-07-26T00:00:01.000Z" },
      trace: { traceId: "execution-1", correlationId: "step-execution-1:1" },
      metadata: { runId: "remote-run-loopback" },
    };
    const rawBody = JSON.stringify(event);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const deliveryId = "d".repeat(256);
    const response = await fetch(
      `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}/internal/agent-callbacks/http/remote-security-reviewer`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-AgentWeave-Key-Id": "loopback-v1",
          "X-AgentWeave-Timestamp": timestamp,
          "X-AgentWeave-Delivery-Id": deliveryId,
          "X-AgentWeave-Signature": createHttpCallbackSignature(
            "loopback-callback-secret",
            timestamp,
            deliveryId,
            Buffer.from(rawBody),
          ),
        },
        body: rawBody,
      },
    );

    expect(response.status).toBe(400);
    expect(eventHandler).not.toHaveBeenCalled();
  });
});

async function availablePort(): Promise<number> {
  const server = createServer();
  await listen(server);
  const port = (server.address() as AddressInfo).port;
  await close(server);
  return port;
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
  return new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
