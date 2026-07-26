import type { AgentInvocationV1 } from "@agentweave/contracts";
import {
  createAgentWeaveWorker,
  defineAgent,
  type AgentWeaveWorker,
} from "@agentweave/worker";
import { type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { createServer, type Server } from "http";
import type { AddressInfo } from "net";
import {
  AgentTransportConfigService,
  parseAgentTransportConfiguration,
} from "./agent-transport-config.service";
import { HttpAgentCallbackController } from "./http-agent-callback.controller";
import { HttpAgentAdapter } from "./http-agent.adapter";

const invocation: AgentInvocationV1 = {
  schemaVersion: "1",
  invocationId: "step-execution-worker-loopback:1",
  executionId: "execution-worker-loopback",
  stepExecutionId: "step-execution-worker-loopback",
  stepId: "remote-echo",
  target: { agent: "remote-echo-agent" },
  input: { message: "hello from orchestrator" },
  attempt: 1,
  createdAt: "2026-07-26T00:00:00.000Z",
  trace: {
    traceId: "execution-worker-loopback",
    correlationId: "step-execution-worker-loopback:1",
  },
};

describe("real Orchestrator to Worker loopback", () => {
  let app: INestApplication;
  let adapter: HttpAgentAdapter;
  let worker: AgentWeaveWorker;
  let resultHandler: jest.Mock;
  let executions: number;
  const callbackHeaders: Array<Record<string, string | string[] | undefined>> =
    [];

  beforeAll(async () => {
    const callbackPort = await availablePort();
    const callbackOrigin = `http://127.0.0.1:${callbackPort}`;
    executions = 0;
    worker = createAgentWeaveWorker({
      agent: defineAgent({
        name: "remote-echo-agent",
        async execute(context, input: { message: string }) {
          executions += 1;
          return context.success({ output: { echo: input.message } });
        },
      }),
      authentication: { bearerToken: "loopback-worker-token" },
      callbackAuthentication: {
        keys: { "loopback-v1": "loopback-callback-secret" },
      },
      callbackPolicy: {
        allowedOrigins: [callbackOrigin],
        allowInsecureHttp: true,
      },
      callbackDelivery: {
        maxAttempts: 3,
        initialDelayMs: 1,
        maxDelayMs: 2,
        jitterRatio: 0,
        requestTimeoutMs: 1000,
      },
    });
    const workerAddress = await worker.start({ host: "127.0.0.1", port: 0 });
    const config = new AgentTransportConfigService(
      parseAgentTransportConfiguration({
        AGENT_TRANSPORT_CONFIG: JSON.stringify({
          "remote-echo-agent": {
            kind: "http",
            submitUrl: `http://${workerAddress.host}:${workerAddress.port}/v1/runs`,
            outboundAuthentication: {
              type: "bearer",
              tokenEnv: "LOOPBACK_WORKER_TOKEN",
            },
            callbackAuthentication: {
              keyId: "loopback-v1",
              secretEnv: "LOOPBACK_CALLBACK_SECRET",
            },
            requestTimeoutMs: 1000,
            maxResponseBytes: 4096,
          },
        }),
        HTTP_AGENT_CALLBACK_BASE_URL: callbackOrigin,
        HTTP_AGENT_ALLOW_INSECURE: "true",
        LOOPBACK_WORKER_TOKEN: "loopback-worker-token",
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
    let callbackAttempts = 0;
    app.use(
      "/internal/agent-callbacks/http/remote-echo-agent",
      (
        request: { headers: Record<string, string | string[] | undefined> },
        response: { status(code: number): { end(): void } },
        next: () => void,
      ) => {
        callbackAttempts += 1;
        callbackHeaders.push(request.headers);
        if (callbackAttempts === 1) {
          response.status(500).end();
          return;
        }
        next();
      },
    );
    await app.listen(callbackPort, "127.0.0.1");
    adapter = module.get(HttpAgentAdapter);
    resultHandler = jest.fn().mockResolvedValue(undefined);
    await adapter.start(resultHandler);
  });

  afterAll(async () => {
    await adapter.stop();
    await app.close();
    await worker.stop();
  });

  it("submits, retries one signed callback, and deduplicates the invocation end to end", async () => {
    const firstReceipt = await adapter.invoke(invocation);
    await waitFor(() => resultHandler.mock.calls.length === 1);
    const duplicateReceipt = await adapter.invoke(invocation);

    expect(duplicateReceipt.dispatchId).toBe(firstReceipt.dispatchId);
    expect(executions).toBe(1);
    expect(resultHandler).toHaveBeenCalledTimes(1);
    expect(resultHandler).toHaveBeenCalledWith({
      result: expect.objectContaining({
        invocationId: invocation.invocationId,
        executionId: invocation.executionId,
        stepExecutionId: invocation.stepExecutionId,
        status: "succeeded",
        output: { echo: "hello from orchestrator" },
      }),
      transport: expect.objectContaining({
        adapter: "http",
        deliveryId: callbackHeaders[1]["x-agentweave-delivery-id"],
        keyId: "loopback-v1",
      }),
    });
    expect(callbackHeaders).toHaveLength(2);
    expect(callbackHeaders[0]["x-agentweave-delivery-id"]).toBe(
      callbackHeaders[1]["x-agentweave-delivery-id"],
    );
    expect(callbackHeaders[0]["x-agentweave-signature"]).not.toBe(
      callbackHeaders[1]["x-agentweave-signature"],
    );
  });
});

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 1000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline)
      throw new Error("Timed out waiting for Worker callback");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

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
