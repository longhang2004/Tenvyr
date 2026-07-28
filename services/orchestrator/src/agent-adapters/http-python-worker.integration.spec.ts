import type { AgentInvocationV1 } from "@tenvyr/contracts";
import { type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { type ChildProcess, spawn } from "child_process";
import type { AddressInfo } from "net";
import { resolve } from "path";
import {
  AgentTransportConfigService,
  parseAgentTransportConfiguration,
} from "./agent-transport-config.service";
import { HttpAgentCallbackController } from "./http-agent-callback.controller";
import { HttpAgentAdapter } from "./http-agent.adapter";

type LifecycleEvent = {
  event: string;
  host?: string;
  port?: number;
  executions?: number;
};

const invocation: AgentInvocationV1 = {
  schemaVersion: "1",
  invocationId: "step-execution-python-worker-loopback:1",
  executionId: "execution-python-worker-loopback",
  stepExecutionId: "step-execution-python-worker-loopback",
  stepId: "remote-echo",
  target: { agent: "remote-echo-agent" },
  input: { message: "hello from orchestrator" },
  attempt: 1,
  createdAt: "2026-07-28T00:00:00.000Z",
  trace: {
    traceId: "execution-python-worker-loopback",
    correlationId: "step-execution-python-worker-loopback:1",
  },
};

describe("real Orchestrator to Python Worker loopback", () => {
  let app: INestApplication;
  let adapter: HttpAgentAdapter;
  let workerProcess: ChildProcess;
  let resultHandler: jest.Mock;
  let processOutput: ProcessOutput;
  const callbackHeaders: Array<Record<string, string | string[] | undefined>> =
    [];

  beforeAll(async () => {
    const pythonExecutable = process.env.TENVYR_PYTHON_EXECUTABLE;
    if (!pythonExecutable) {
      throw new Error("TENVYR_PYTHON_EXECUTABLE is required");
    }

    const parsedConfig = parseAgentTransportConfiguration({
      AGENT_TRANSPORT_CONFIG: JSON.stringify({
        "remote-echo-agent": {
          kind: "http",
          submitUrl: "http://127.0.0.1:1/v1/runs",
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
      HTTP_AGENT_CALLBACK_BASE_URL: "http://127.0.0.1:1",
      HTTP_AGENT_ALLOW_INSECURE: "true",
      LOOPBACK_WORKER_TOKEN: "loopback-worker-token",
      LOOPBACK_CALLBACK_SECRET: "loopback-callback-secret",
    });
    const config = new AgentTransportConfigService(parsedConfig);
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
    await app.listen(0, "127.0.0.1");
    const callbackPort = (app.getHttpServer().address() as AddressInfo).port;
    const callbackOrigin = `http://127.0.0.1:${callbackPort}`;
    parsedConfig.callbackBaseUrl = callbackOrigin;

    const fixture = resolve(
      __dirname,
      "../../../../sdks/python-worker/tests/fixtures/orchestrator_loopback_worker.py",
    );
    workerProcess = spawn(pythonExecutable, [fixture], {
      env: {
        ...process.env,
        PYTHONPATH: "",
        TENVYR_WORKER_TOKEN: "loopback-worker-token",
        TENVYR_CALLBACK_KEY_ID: "loopback-v1",
        TENVYR_CALLBACK_SECRET: "loopback-callback-secret",
        TENVYR_CALLBACK_ORIGIN: callbackOrigin,
        TENVYR_ALLOW_INSECURE_HTTP: "true",
        TENVYR_WORKER_HOST: "127.0.0.1",
        TENVYR_WORKER_PORT: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    processOutput = new ProcessOutput(workerProcess);
    const ready = await processOutput.waitFor("tenvyr.worker.ready");
    if (typeof ready.host !== "string" || typeof ready.port !== "number") {
      throw new Error("Python Worker emitted an invalid ready event");
    }
    const workerConfig = parsedConfig.agents.get("remote-echo-agent");
    if (!workerConfig || workerConfig.kind !== "http") {
      throw new Error("Python Worker HTTP configuration is unavailable");
    }
    workerConfig.submitUrl = `http://${ready.host}:${ready.port}/v1/runs`;

    adapter = module.get(HttpAgentAdapter);
    resultHandler = jest.fn().mockResolvedValue(undefined);
    await adapter.start(resultHandler);
  });

  afterAll(async () => {
    if (adapter) await adapter.stop();
    if (app) await app.close();
    if (workerProcess && workerProcess.exitCode === null) {
      workerProcess.kill("SIGTERM");
      const stopped = await processOutput.waitFor("tenvyr.worker.stopped");
      expect(stopped.executions).toBe(1);
      await expect(processExit(workerProcess)).resolves.toBe(0);
    }
  });

  it("retries a signed callback and deduplicates without rerunning Python", async () => {
    const firstReceipt = await adapter.invoke(invocation);
    await waitFor(() => resultHandler.mock.calls.length === 1);
    const duplicateReceipt = await adapter.invoke(invocation);

    expect(duplicateReceipt.dispatchId).toBe(firstReceipt.dispatchId);
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
    expect(callbackHeaders[0]["x-agentweave-key-id"]).toBe("loopback-v1");
    expect(
      Number(callbackHeaders[0]["x-agentweave-timestamp"]),
    ).toBeGreaterThan(0);
    expect(callbackHeaders[1]["x-agentweave-signature"]).toMatch(
      /^v1=[a-f0-9]{64}$/,
    );
  });
});

class ProcessOutput {
  private buffer = "";
  private readonly events: LifecycleEvent[] = [];
  private readonly stderr: string[] = [];

  constructor(private readonly child: ChildProcess) {
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => this.consume(chunk));
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => this.stderr.push(chunk));
  }

  async waitFor(eventName: string, timeoutMs = 5000): Promise<LifecycleEvent> {
    let match: LifecycleEvent | undefined;
    await waitFor(() => {
      match = this.events.find((event) => event.event === eventName);
      if (this.child.exitCode !== null && !match) {
        throw new Error(
          `Python Worker exited before ${eventName}: ${this.stderr.join("")}`,
        );
      }
      return match !== undefined;
    }, timeoutMs);
    return match as LifecycleEvent;
  }

  private consume(chunk: string): void {
    this.buffer += chunk;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line.trim()) this.events.push(JSON.parse(line) as LifecycleEvent);
    }
  }
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline)
      throw new Error("Timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function processExit(child: ChildProcess): Promise<number | null> {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve) => child.once("exit", resolve));
}
