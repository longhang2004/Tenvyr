import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { once } from "node:events";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(
  new URL("../frontend/package.json", import.meta.url),
);
const { io } = require("socket.io-client");
const upstream = createServer((req, res) => {
  res.setHeader("Content-Type", "application/json");
  res.end(
    JSON.stringify({
      success: true,
      data: { id: "live-client", status: "COMPLETED" },
    }),
  );
});
upstream.listen(0, "127.0.0.1");
await once(upstream, "listening");
const reserve = createServer();
reserve.listen(0, "127.0.0.1");
await once(reserve, "listening");
const port = reserve.address().port;
await new Promise((resolve) => reserve.close(resolve));
const gateway = spawn(
  process.env.TENVYR_JAVA_EXECUTABLE || "java",
  [
    "-cp",
    "backend/gateway/target/classes:backend/gateway/target/dependency/*",
    "io.tenvyr.gateway.Gateway",
  ],
  {
    cwd: root,
    env: {
      ...process.env,
      GATEWAY_PORT: String(port),
      ORCHESTRATOR_URL: `http://127.0.0.1:${upstream.address().port}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  },
);
let diagnostics = "";
gateway.stdout.on("data", (chunk) => {
  diagnostics += chunk;
});
gateway.stderr.on("data", (chunk) => {
  diagnostics += chunk;
});
const base = `http://127.0.0.1:${port}`;
const sockets = [];
const bounded = (promise, label, ms = 8000) =>
  Promise.race([
    promise,
    delay(ms, undefined, { ref: false }).then(() => {
      throw new Error(`${label} timed out\n${diagnostics}`);
    }),
  ]);
try {
  for (let attempt = 0; ; attempt++) {
    if (gateway.exitCode !== null || attempt > 100)
      throw new Error(`Gateway did not start\n${diagnostics}`);
    try {
      if ((await fetch(`${base}/health`)).ok) break;
    } catch {}
    await delay(50);
  }
  for (const transports of [
    ["polling"],
    ["websocket"],
    ["polling", "websocket"],
  ]) {
    const socket = io(base, {
      transports,
      forceNew: true,
      extraHeaders: { Origin: "http://localhost:4000" },
      reconnectionDelay: 50,
    });
    sockets.push(socket);
    await bounded(once(socket, "connect"), `${transports} connect`);
    if (
      transports.length === 2 &&
      socket.io.engine.transport.name !== "websocket"
    )
      await bounded(once(socket.io.engine, "upgrade"), "polling upgrade");
    assert.equal(socket.io.engine.transport.name, transports.at(-1));
    const update = once(socket, "execution-update");
    assert.equal(
      (
        await fetch(`${base}/api/webhooks/execution-update`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ executionId: "live-client" }),
        })
      ).status,
      201,
    );
    const [event] = await bounded(update, "broadcast");
    assert.equal(event.executionId, "live-client");
    const reconnect = once(socket, "connect");
    socket.io.engine.close();
    await bounded(reconnect, "reconnect");
  }
  // Keep actual v4 clients connected across the production 25-second ping interval.
  await delay(27000);
  for (const socket of sockets)
    assert.equal(socket.connected, true, "client survives heartbeat");
  console.log(
    "Socket.IO v4 client PASS: polling, WebSocket, upgrade, broadcast, reconnect, heartbeat",
  );
} finally {
  for (const socket of sockets) socket.close();
  gateway.kill("SIGTERM");
  await bounded(once(gateway, "exit"), "gateway shutdown");
  await new Promise((resolve) => upstream.close(resolve));
}
