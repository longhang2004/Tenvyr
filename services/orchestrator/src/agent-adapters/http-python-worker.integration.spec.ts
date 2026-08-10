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
  let workerSubmitUrl: string;
  let callbackOrigin: string;
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
    callbackOrigin = `http://127.0.0.1:${callbackPort}`;
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
    workerSubmitUrl = `http://${ready.host}:${ready.port}/v1/runs`;
    workerConfig.submitUrl = workerSubmitUrl;

    adapter = module.get(HttpAgentAdapter);
    resultHandler = jest.fn().mockResolvedValue(undefined);
    await adapter.start({ result: resultHandler, event: jest.fn() });
  });

  afterAll(async () => {
    if (adapter) await adapter.stop();
    if (app) await app.close();
    if (workerProcess && workerProcess.exitCode === null) {
      workerProcess.kill("SIGTERM");
      const stopped = await processOutput.waitFor("tenvyr.worker.stopped");
      expect(stopped.executions).toBe(4);
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

  it("preserves safe integer boundaries and rejects unsafe Python output", async () => {
    const safeInvocation = withInput("safe-boundaries:1", {
      mode: "safe-boundaries",
    });
    await adapter.invoke(safeInvocation);
    await waitFor(() => resultFor(safeInvocation.invocationId) !== undefined);
    expect(resultFor(safeInvocation.invocationId)).toEqual(
      expect.objectContaining({
        status: "succeeded",
        output: {
          maximum: 9007199254740991,
          minimum: -9007199254740991,
        },
      }),
    );

    const unsafeOutputInvocation = withInput("unsafe-output:1", {
      mode: "unsafe-output",
    });
    await adapter.invoke(unsafeOutputInvocation);
    await waitFor(
      () => resultFor(unsafeOutputInvocation.invocationId) !== undefined,
    );
    expect(resultFor(unsafeOutputInvocation.invocationId)).toEqual(
      expect.objectContaining({
        status: "failed",
        error: {
          code: "AGENT_OUTPUT_INVALID",
          message: "Agent output validation failed",
          retryable: false,
        },
      }),
    );
  });

  it("rejects raw unsafe input before reserving its invocation ID", async () => {
    const invocationId = "raw-unsafe-python-worker-loopback:1";
    const rawBody =
      `{"schemaVersion":"1","invocation":{"schemaVersion":"1",` +
      `"invocationId":"${invocationId}","executionId":"raw-unsafe-execution",` +
      `"stepExecutionId":"raw-unsafe-step","stepId":"remote-echo",` +
      `"target":{"agent":"remote-echo-agent"},` +
      `"input":{"unsafe":9007199254740993},"attempt":1,` +
      `"createdAt":"2026-07-28T00:00:00.000Z",` +
      `"trace":{"traceId":"raw-unsafe-execution","correlationId":"${invocationId}"}},` +
      `"resultDelivery":{"mode":"callback",` +
      `"callbackUrl":"${callbackOrigin}/internal/agent-callbacks/http/remote-echo-agent",` +
      `"authentication":{"scheme":"hmac-sha256","keyId":"loopback-v1"}}}`;
    const response = await fetch(workerSubmitUrl, {
      method: "POST",
      headers: {
        Authorization: "Bearer loopback-worker-token",
        "Content-Type": "application/json",
        "Idempotency-Key": invocationId,
      },
      body: rawBody,
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: "INVALID_REQUEST" },
    });

    const validInvocation = withInput(invocationId, { message: "still runs" });
    await adapter.invoke(validInvocation);
    await waitFor(() => resultFor(invocationId) !== undefined);
    expect(resultFor(invocationId)).toEqual(
      expect.objectContaining({
        status: "succeeded",
        output: { echo: "still runs" },
      }),
    );
  });

  function resultFor(invocationId: string): unknown {
    const call = resultHandler.mock.calls.find(
      ([value]) => value.result.invocationId === invocationId,
    );
    return call?.[0].result;
  }
});

function withInput(
  invocationId: string,
  input: AgentInvocationV1["input"],
): AgentInvocationV1 {
  return {
    ...invocation,
    invocationId,
    executionId: `${invocationId}:execution`,
    stepExecutionId: `${invocationId}:step`,
    input,
    trace: { traceId: invocationId, correlationId: invocationId },
  };
}

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
