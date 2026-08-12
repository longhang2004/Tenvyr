import { createHmac } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import type { AddressInfo } from "node:net";
import type { AgentInvocationV1 } from "@tenvyr/contracts";

/**
 * M3-S3: real end-to-end proof for the local executor host.
 *
 * Spawns the BUILT host (dist/main.js) with a fixture agent, POSTs canonical
 * run requests over real HTTP, and receives the signed canonical callback.
 * Covers: success, non-zero failure, wall-time deadline kill, env secret
 * resolution, and host-log secret redaction.
 */

const node = process.execPath;
const HOST_MAIN = path.resolve(__dirname, "../dist/main.js");
const CALLBACK_SECRET = "host-callback-secret";
const BEARER_TOKEN = "host-token";
const CHILD_SECRET_VALUE = "super-secret-child-value";

const spawnedHosts: ChildProcess[] = [];
const openServers: http.Server[] = [];

type HostFixture = {
  hostProcess: ChildProcess;
  hostPort: number;
  callbackPort: number;
  stateDir: string;
  hostLogs: () => string;
};

const startHost = async (
  agentScript: string,
  callbackPort: number,
): Promise<HostFixture> => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "tenvyr-host-it-"));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tenvyr-host-root-it-"));
  const hostPort = await freePort();

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    EXECUTOR_HOST_ALLOWED_ROOT: root,
    EXECUTOR_HOST_STATE_DIR: stateDir,
    EXECUTOR_HOST_CALLBACK_ALLOWED_ORIGINS: `http://127.0.0.1:${callbackPort}`,
    EXECUTOR_HOST_CALLBACK_KEYS: JSON.stringify({ "host-v1": CALLBACK_SECRET }),
    EXECUTOR_HOST_CALLBACK_ALLOW_INSECURE: "true",
    EXECUTOR_HOST_AGENTS: JSON.stringify({
      "local-echo": {
        command: node,
        args: ["-e", agentScript],
        cwd: root,
        secrets: { CHILD_SECRET: "HOST_CHILD_SECRET_ENV" },
        wallTimeMs: 5_000,
        maxStdoutBytes: 65_536,
        maxStderrBytes: 65_536,
        port: hostPort,
        bearerTokenEnv: "HOST_TOKEN",
      },
    }),
    HOST_TOKEN: BEARER_TOKEN,
    HOST_CHILD_SECRET_ENV: CHILD_SECRET_VALUE,
  };

  let logs = "";
  const hostProcess = spawn(node, [HOST_MAIN], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  spawnedHosts.push(hostProcess);
  hostProcess.stdout?.on("data", (chunk) => (logs += chunk.toString()));
  hostProcess.stderr?.on("data", (chunk) => (logs += chunk.toString()));

  // Wait for the agent to accept connections.
  await waitFor(
    async () => {
      try {
        const response = await fetchWithTimeout(
          `http://127.0.0.1:${hostPort}/health/ready`,
          500,
        );
        return response?.ok === true;
      } catch {
        return false;
      }
    },
    10_000,
    `host did not become ready; logs:\n${logs}`,
  );

  return {
    hostProcess,
    hostPort,
    callbackPort,
    stateDir,
    hostLogs: () => logs,
  };
};

const fetchWithTimeout = async (
  url: string,
  timeoutMs: number,
): Promise<Response | undefined> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
};

const freePort = async (): Promise<number> => {
  const server = http.createServer();
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", resolve),
  );
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
};

const waitFor = async (
  check: () => Promise<boolean>,
  timeoutMs: number,
  message: string,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(message);
};

const invocation = (suffix: string, agent = "local-echo"): AgentInvocationV1 => ({
  schemaVersion: "1",
  invocationId: `local-host-it:${suffix}`,
  executionId: `execution-local-host-${suffix}`,
  stepExecutionId: `step-local-host-${suffix}`,
  stepId: "local-step",
  target: { agent },
  input: { fixture: suffix },
  attempt: 1,
  createdAt: new Date().toISOString(),
  trace: {
    traceId: `execution-local-host-${suffix}`,
    correlationId: `local-host-it:${suffix}`,
  },
});

const submit = async (
  hostPort: number,
  inv: AgentInvocationV1,
  callbackUrl: string,
): Promise<Response> => {
  const response = await fetch(`http://127.0.0.1:${hostPort}/v1/runs`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: `Bearer ${BEARER_TOKEN}`,
      "Idempotency-Key": inv.invocationId,
    },
    body: JSON.stringify({
      schemaVersion: "1",
      invocation: inv,
      resultDelivery: {
        mode: "callback",
        callbackUrl,
        authentication: { scheme: "hmac-sha256", keyId: "host-v1" },
      },
    }),
  });
  if (!response.ok) {
    throw new Error(
      `submit rejected with HTTP ${response.status}: ${await response.text()}`,
    );
  }
  return response;
};

type CallbackCapture = {
  body: unknown;
  keyId: string | undefined;
  timestamp: string | undefined;
  deliveryId: string | undefined;
  signature: string | undefined;
};

const startCallbackReceiver = (): Promise<{
  port: number;
  captures: CallbackCapture[];
  waitForCallback: (count?: number) => Promise<CallbackCapture>;
}> => {
  const captures: CallbackCapture[] = [];
  const listeners: Array<() => void> = [];
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const raw = Buffer.concat(chunks);
      captures.push({
        body: JSON.parse(raw.toString("utf8")),
        keyId: singleHeader(request.headers["x-agentweave-key-id"]),
        timestamp: singleHeader(request.headers["x-agentweave-timestamp"]),
        deliveryId: singleHeader(request.headers["x-agentweave-delivery-id"]),
        signature: singleHeader(request.headers["x-agentweave-signature"]),
      });
      listeners.forEach((listener) => listener());
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end("{}");
    });
  });
  openServers.push(server);
  const waitForCallback = (count = 1) =>
    new Promise<CallbackCapture>((resolve, reject) => {
      const deadline = Date.now() + 10_000;
      const poll = () => {
        // The worker may deliver heartbeat EVENTS first; wait for a
        // result-shaped payload (canonical AgentResultV1 carries status).
        const results = captures.filter(
          (capture) =>
            typeof capture.body === "object" &&
            capture.body !== null &&
            typeof (capture.body as Record<string, unknown>).status ===
              "string",
        );
        if (results.length >= count) {
          resolve(results[count - 1]);
          return;
        }
        if (Date.now() > deadline) {
          reject(
            new Error(
              `result callback not received within 10s (got ${captures.length} callbacks)`,
            ),
          );
          return;
        }
        listeners.push(poll);
      };
      poll();
    });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        port: (server.address() as AddressInfo).port,
        captures,
        waitForCallback,
      });
    });
  });
};

const singleHeader = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value[0] : value;

describe("local executor host (real process, real HTTP)", () => {
  let fixture: HostFixture;
  let receiver: Awaited<ReturnType<typeof startCallbackReceiver>>;

  afterEach(() => {
    fixture?.hostProcess.kill("SIGKILL");
  });

  afterAll(() => {
    for (const host of spawnedHosts) host.kill("SIGKILL");
    for (const server of openServers) server.close();
  });

  it("runs the fixed command, delivers the canonical signed result, and never logs the child secret", async () => {
    // The fixture echoes its resolved secret and prints a marker.
    receiver = await startCallbackReceiver();
    fixture = await startHost(
      "console.log('marker-' + process.env.CHILD_SECRET)",
      receiver.port,
    );
    const callbackUrl = `http://127.0.0.1:${receiver.port}/internal/callback`;
    const inv = invocation("success");

    const accepted = await submit(fixture.hostPort, inv, callbackUrl);
    expect(accepted.status).toBe(202);
    const capture = await receiver.waitForCallback();

    // The canonical result is materialized and the HMAC signature verifies.
    expect(capture.body).toMatchObject({
      schemaVersion: "1",
      invocationId: inv.invocationId,
      executionId: inv.executionId,
      stepExecutionId: inv.stepExecutionId,
      status: "succeeded",
      output: {
        exitCode: 0,
        stdout: `marker-${CHILD_SECRET_VALUE}\n`,
      },
    });
    expect(capture.keyId).toBe("host-v1");
    expect(capture.signature).toBe(
      `v1=${createHmac("sha256", CALLBACK_SECRET)
        .update(capture.timestamp as string)
        .update(".")
        .update(capture.deliveryId as string)
        .update(".")
        .update(Buffer.from(JSON.stringify(capture.body)))
        .digest("hex")}`,
    );

    // The secret reached the CHILD (proven by its output) but never the host
    // logs — the host redacts environment values and never logs output.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(fixture.hostLogs()).not.toContain(CHILD_SECRET_VALUE);
    expect(fixture.hostLogs()).toContain("local-echo");
  });

  it("materializes a failed result for a non-zero exit", async () => {
    receiver = await startCallbackReceiver();
    fixture = await startHost("console.error('boom'); process.exit(7)", receiver.port);
    const inv = invocation("failure");

    const accepted = await submit(
      fixture.hostPort,
      inv,
      `http://127.0.0.1:${receiver.port}/internal/callback`,
    );
    expect(accepted.status).toBe(202);
    const capture = await receiver.waitForCallback();

    expect(capture.body).toMatchObject({
      schemaVersion: "1",
      invocationId: inv.invocationId,
      status: "failed",
      error: {
        code: "EXECUTOR_HOST_PROCESS_FAILED",
        message: "boom\n",
        retryable: false,
      },
    });
  });

  it("kills the process group at the wall clock and reports the deadline failure", async () => {
    receiver = await startCallbackReceiver();
    fixture = await startHost("setInterval(() => {}, 1000)", receiver.port);
    const inv = invocation("timeout");

    const accepted = await submit(
      fixture.hostPort,
      inv,
      `http://127.0.0.1:${receiver.port}/internal/callback`,
    );
    expect(accepted.status).toBe(202);
    const capture = await receiver.waitForCallback();

    expect(capture.body).toMatchObject({
      schemaVersion: "1",
      invocationId: inv.invocationId,
      status: "failed",
      error: {
        code: "EXECUTOR_HOST_DEADLINE",
        retryable: true,
      },
    });
  });
});
