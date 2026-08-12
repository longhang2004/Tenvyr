import { Test } from "@nestjs/testing";
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { INestApplication } from "@nestjs/common";
import type { AddressInfo } from "net";
import type { AgentInvocationV1 } from "@tenvyr/contracts";
import { HttpAgentCallbackController } from "./http-agent-callback.controller";
import { HttpAgentAdapter } from "./http-agent.adapter";
import {
  AgentTransportConfigService,
  parseAgentTransportConfiguration,
} from "./agent-transport-config.service";

/**
 * M3-S3: real Orchestrator to local-executor-host loopback.
 *
 * Requires the host to be BUILT: set EXECUTOR_HOST_MAIN to
 * services/local-executor-host/dist/main.js (or run
 * `pnpm --filter @tenvyr/local-executor-host build` first). Skipped when
 * unset.
 */
const EXECUTOR_HOST_MAIN = process.env.EXECUTOR_HOST_MAIN;
const describeWithHost = EXECUTOR_HOST_MAIN ? describe : describe.skip;
const HOST_SECRET_VALUE = "host-loopback-secret-value";

const invocation: AgentInvocationV1 = {
  schemaVersion: "1",
  invocationId: "step-execution-local-host-loopback:1",
  executionId: "execution-local-host-loopback",
  stepExecutionId: "step-execution-local-host-loopback",
  stepId: "local-step",
  target: { agent: "local-echo" },
  input: { fixture: true },
  attempt: 1,
  createdAt: "2026-08-11T00:00:00.000Z",
  trace: {
    traceId: "execution-local-host-loopback",
    correlationId: "step-execution-local-host-loopback:1",
  },
};

describeWithHost("real Orchestrator to local executor host loopback", () => {
  let app: INestApplication;
  let adapter: HttpAgentAdapter;
  let hostProcess: ChildProcess;
  let resultHandler: jest.Mock;
  let hostLogs = "";
  let hostPort: number;

  beforeAll(async () => {
    const parsedConfig = parseAgentTransportConfiguration({
      AGENT_TRANSPORT_CONFIG: JSON.stringify({
        "local-echo": {
          kind: "http",
          submitUrl: "http://127.0.0.1:1/v1/runs",
          outboundAuthentication: {
            type: "bearer",
            tokenEnv: "LOOPBACK_HOST_TOKEN",
          },
          callbackAuthentication: {
            keyId: "host-loopback-v1",
            secretEnv: "LOOPBACK_CALLBACK_SECRET",
          },
          requestTimeoutMs: 1000,
          maxResponseBytes: 4096,
        },
      }),
      HTTP_AGENT_CALLBACK_BASE_URL: "http://127.0.0.1:1",
      HTTP_AGENT_ALLOW_INSECURE: "true",
      LOOPBACK_CALLBACK_SECRET: "loopback-callback-secret",
      LOOPBACK_HOST_TOKEN: "host-token",
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
    await app.listen(0, "127.0.0.1");
    const callbackOrigin = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
    parsedConfig.callbackBaseUrl = callbackOrigin;

    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "tenvyr-host-loopback-"));
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tenvyr-host-loopback-root-"));
    hostPort = await freePort();
    hostProcess = spawn(process.execPath, [EXECUTOR_HOST_MAIN as string], {
      env: {
        ...process.env,
        EXECUTOR_HOST_ALLOWED_ROOT: root,
        EXECUTOR_HOST_STATE_DIR: stateDir,
        EXECUTOR_HOST_CALLBACK_ALLOWED_ORIGINS: callbackOrigin,
        EXECUTOR_HOST_CALLBACK_KEYS: JSON.stringify({
          "host-loopback-v1": "loopback-callback-secret",
        }),
        EXECUTOR_HOST_CALLBACK_ALLOW_INSECURE: "true",
        EXECUTOR_HOST_AGENTS: JSON.stringify({
          "local-echo": {
            command: process.execPath,
            args: [
              "-e",
              "console.log('host-loopback-ran-' + process.env.CHILD_SECRET)",
            ],
            cwd: root,
            secrets: { CHILD_SECRET: "HOST_CHILD_SECRET_ENV" },
            wallTimeMs: 10_000,
            maxStdoutBytes: 65_536,
            maxStderrBytes: 65_536,
            port: hostPort,
            bearerTokenEnv: "HOST_TOKEN",
          },
        }),
        HOST_TOKEN: "host-token",
        HOST_CHILD_SECRET_ENV: HOST_SECRET_VALUE,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    hostProcess.stdout?.on("data", (chunk) => (hostLogs += chunk.toString()));
    hostProcess.stderr?.on("data", (chunk) => (hostLogs += chunk.toString()));
    await waitForHostReady(hostPort);

    const agentConfig = parsedConfig.agents.get("local-echo");
    if (!agentConfig || agentConfig.kind !== "http") {
      throw new Error("local-echo HTTP configuration is unavailable");
    }
    agentConfig.submitUrl = `http://127.0.0.1:${hostPort}/v1/runs`;

    adapter = module.get(HttpAgentAdapter);
    resultHandler = jest.fn().mockResolvedValue(undefined);
    await adapter.start({ result: resultHandler, event: jest.fn() });
  }, 30_000);

  afterAll(async () => {
    if (adapter) await adapter.stop();
    if (app) await app.close();
    if (hostProcess && hostProcess.exitCode === null) hostProcess.kill("SIGKILL");
  });

  it("dispatches to the local host, the fixed command runs, and the signed callback applies the canonical result", async () => {
    const receipt = await adapter.invoke(invocation);

    expect(receipt).toMatchObject({
      adapter: "http",
      invocationId: invocation.invocationId,
    });

    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if (resultHandler.mock.calls.length > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(resultHandler).toHaveBeenCalledTimes(1);
    const message = resultHandler.mock.calls[0][0];
    expect(message.result).toMatchObject({
      schemaVersion: "1",
      invocationId: invocation.invocationId,
      executionId: invocation.executionId,
      stepExecutionId: invocation.stepExecutionId,
      status: "succeeded",
      output: {
        exitCode: 0,
        stdout: `host-loopback-ran-${HOST_SECRET_VALUE}\n`,
      },
    });
    expect(message.transport).toMatchObject({
      adapter: "http",
      keyId: "host-loopback-v1",
    });

    // The child secret reached the command (proven by its output) but never
    // the host's own logs.
    expect(hostLogs).not.toContain(HOST_SECRET_VALUE);
  });
});

const freePort = async (): Promise<number> => {
  const server = require("node:http").createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
};

const waitForHostReady = async (port: number): Promise<void> => {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health/ready`);
      if (response.ok) return;
    } catch {
      // Not up yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`local executor host did not become ready on port ${port}`);
};
