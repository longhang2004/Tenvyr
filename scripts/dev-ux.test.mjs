import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bannerText,
  DEV_LINE_PATTERN,
  formatServiceLine,
  isDevLine,
  runLauncher,
  statusMark,
  useColor,
  wrapForeignLine,
} from "./dev.mjs";

const ANSI = /\u001b\[[0-9;]*m/;

describe("dev launcher formatter", () => {
  test("formatServiceLine: compact time service level message; NO_COLOR => no ANSI", () => {
    const line = formatServiceLine({
      time: "15:24:02",
      service: "orchestrator",
      level: "INFO",
      message: "Team run started · run_93fe",
      color: true,
    });
    // ANSI dim codes may prefix the time; the visible payload must be intact.
    assert.match(line.replace(/\u001b\[[0-9;]*m/g, ""), /^15:24:02\s{2}orchestrator\s{2}INFO\s{2,}Team run started/);
    assert.match(line, ANSI); // colored
    const plain = formatServiceLine({
      time: "15:24:02",
      service: "orchestrator",
      level: "ERROR",
      message: "boom",
      color: false,
    });
    assert.doesNotMatch(plain, ANSI);
  });

  test("levels get semantic colors (WARN yellow, ERROR red, INFO neutral)", () => {
    const warn = formatServiceLine({ service: "g", level: "WARN", message: "x", color: true });
    const error = formatServiceLine({ service: "g", level: "ERROR", message: "x", color: true });
    const info = formatServiceLine({ service: "g", level: "INFO", message: "x", color: true });
    assert.match(warn, /\u001b\[33m/); // yellow
    assert.match(error, /\u001b\[31m/); // red
    assert.doesNotMatch(info, /\u001b\[33m/);
    assert.doesNotMatch(info, /\u001b\[31m/);
  });

  test("multiline messages are collapsed to one line", () => {
    const line = formatServiceLine({ service: "g", level: "INFO", message: "a\nb\nc", color: false });
    assert.equal(line.split("\n").length, 1);
    assert.match(line, /a …$/);
  });

  test("isDevLine recognizes the in-app logger format; foreign lines are tagged with a level guess", () => {
    assert.equal(isDevLine("15:24:02  orchestrator  INFO   hello"), true);
    assert.equal(isDevLine("15:24:02  gateway  ERROR  boom"), true);
    assert.equal(isDevLine("[RouterExplorer] Mapped route"), false);
    assert.equal(isDevLine("pnpm > services/gateway start:dev:"), false);

    assert.equal(wrapForeignLine("something failed badly", "gateway", false).includes("ERROR"), true);
    assert.equal(wrapForeignLine("caught a warning", "gateway", false).includes("WARN"), true);
    assert.equal(wrapForeignLine("compiled successfully", "workbench", false).includes("INFO"), true);
    assert.equal(wrapForeignLine("  \n", "workbench", false), null);
  });

  test("banner is small (<= 3 lines) and never a giant figlet", () => {
    const banner = bannerText(false);
    assert.ok(banner.length <= 3);
    assert.match(banner[0], /TENVYR/);
  });

  test("statusMark: ready/disabled/failed marks", () => {
    assert.equal(statusMark("ready", false), "✓");
    assert.equal(statusMark("disabled", false), "○");
    assert.equal(statusMark("failed", false), "✕");
    assert.match(statusMark("ready", true), ANSI); // green check
    assert.doesNotMatch(statusMark("disabled", false), ANSI);
  });

  test("useColor: NO_COLOR disables, FORCE_COLOR=1 forces, CI disables, non-TTY disables", () => {
    assert.equal(useColor({ NO_COLOR: "1" }, { isTTY: true }), false);
    // The NO_COLOR spec: empty string does NOT disable (presence + non-empty).
    assert.equal(useColor({ NO_COLOR: "" }, { isTTY: true }), true);
    assert.equal(useColor({ FORCE_COLOR: "1" }, { isTTY: false }), true);
    assert.equal(useColor({ CI: "true" }, { isTTY: true }), false);
    assert.equal(useColor({}, { isTTY: false }), false);
    assert.equal(useColor({}, { isTTY: true }), true);
  });
});

describe("dev launcher lifecycle (fake children)", () => {
  const fixtureDir = mkdtempSync(join(tmpdir(), "tenvyr-devux-"));
  let markerFile = "";

  const fakeHealthServer = (port, script = "") =>
    `const http = require("node:http");
const port = ${port};
const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ success: true, data: { status: "UP" } }));
});
server.listen(port, "127.0.0.1");
process.on("SIGTERM", () => { server.close(); process.exit(0); });
${script}
`;

  const fakeLineChild = (marker, port) =>
    `const http = require("node:http");
const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(marker)}, "started");
const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ success: true, data: { status: "UP" } }));
});
server.listen(${port}, "127.0.0.1");
process.stdout.write("15:24:02  fakeapp  INFO   already formatted line\\n");
process.stdout.write("[RouterExplorer] Mapped {/api/x, GET} route\\n");
setInterval(() => {}, 1000);
process.on("SIGTERM", () => {
  fs.appendFileSync(${JSON.stringify(marker)}, "\\nSIGTERM");
  process.exit(0);
});
`;

  const writeFixture = (name, content) => {
    const path = join(fixtureDir, name);
    writeFileSync(path, `#!/usr/bin/env node\n${content}`, { mode: 0o755 });
    return path;
  };

  const capturedIo = () => {
    const buffer = [];
    return {
      write: (text) => buffer.push(text),
      color: false,
      log: () => undefined,
      mode: "normal",
      isInteractive: false,
      buffer,
    };
  };

  const manifestFor = (services) => ({
    services,
    infraServices: [],
    root: fixtureDir,
  });

  test("startup: ready services + optional kafka disabled => summary, NOT failure", async () => {
    markerFile = join(fixtureDir, "line-child.marker");
    const healthBin = writeFixture("health.cjs", fakeHealthServer(43110));
    const lineBin = writeFixture("line.cjs", fakeLineChild(markerFile, 43111));
    const io = { ...capturedIo(), readinessTimeoutMs: 3_000 };
    const run = runLauncher(
      manifestFor([
        {
          name: "fakeapp",
          label: "FakeApp",
          port: 43110,
          url: "http://127.0.0.1:43110",
          health: "/health",
          command: "node",
          args: [healthBin],
          env: process.env,
        },
        {
          name: "lineapp",
          label: "LineApp",
          port: 43111,
          url: "http://127.0.0.1:43111",
          health: "/health",
          command: "node",
          args: [lineBin],
          env: process.env,
        },
      ]),
      io,
    );
    // Wait for the ready line, THEN request shutdown while it runs.
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && !/Tenvyr is ready\./.test(io.buffer.join(""))) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.match(io.buffer.join(""), /Tenvyr is ready\./);
    process.emit("SIGINT");
    const result = await run;
    const output = io.buffer.join("");
    assert.equal(result.exitCode, 0);
    assert.match(output, /FakeApp ready/);
    // Ready IS printed because every required gate passed.
    assert.match(output, /Tenvyr is ready\./);
    // Optional capability shows disabled, not failure.
    assert.match(output, /Kafka\s+disabled/);
    assert.match(output, /├─ LineApp\s+ready/);
    // Foreign framework lines get tagged; dev-format lines pass through.
    assert.match(output, /RouterExplorer/);
    assert.match(output, /already formatted line/);
    // Process cleanup: the line child was never SIGTERMed (no shutdown).
    // Non-TTY: no ANSI anywhere.
    assert.doesNotMatch(output, ANSI);
  });

  test("readiness: process alive but /health unavailable => NOT ready, no ready line, exit 1", async () => {
    // The child starts and runs, but its health endpoint never answers.
    const neverReady = writeFixture(
      "never-ready.cjs",
      `setInterval(() => {}, 1000);\nprocess.on("SIGTERM", () => process.exit(0));\n`,
    );
    const io = { ...capturedIo(), readinessTimeoutMs: 1_500 };
    const result = await runLauncher(
      manifestFor([
        {
          name: "stuck",
          label: "Stuck",
          port: 43112,
          url: "http://127.0.0.1:43112",
          health: "/health",
          command: "node",
          args: [neverReady],
          env: process.env,
        },
      ]),
      { ...io, mode: "normal" },
    );
    const output = io.buffer.join("");
    assert.equal(result.exitCode, 1);
    assert.doesNotMatch(output, /Tenvyr is ready\./);
    assert.match(output, /Tenvyr did not start successfully\./);
    assert.match(output, /Stuck\s+failed/);
  });

  test("failure: a required service exits => launcher exits non-zero and never prints ready", async () => {
    const crasher = writeFixture("crasher.cjs", `console.error("fatal: db refused");\nprocess.exit(1);\n`);
    const healthBin = writeFixture("health2.cjs", fakeHealthServer(43114));
    const io = { ...capturedIo(), readinessTimeoutMs: 1_500 };
    const result = await runLauncher(
      manifestFor([
        {
          name: "crash",
          label: "Crash",
          port: 43113,
          url: "http://127.0.0.1:43113",
          health: "/health",
          command: "node",
          args: [crasher],
          env: process.env,
        },
        {
          name: "ok",
          label: "Ok",
          port: 43114,
          url: "http://127.0.0.1:43114",
          health: "/health",
          command: "node",
          args: [healthBin],
          env: process.env,
        },
      ]),
      io,
    );
    const output = io.buffer.join("");
    assert.equal(result.exitCode, 1);
    assert.doesNotMatch(output, /Tenvyr is ready\./);
    assert.match(output, /Crash\s+failed/);
    assert.match(output, /Tenvyr did not start successfully\./);
  });

  test("shutdown: SIGINT => children receive SIGTERM and exit; clean stop message", async () => {
    markerFile = join(fixtureDir, "shutdown-child.marker");
    const healthBin = writeFixture("health3.cjs", fakeHealthServer(43115));
    const termChild = writeFixture("term-child.cjs", fakeLineChild(markerFile, 43116));
    const io = { ...capturedIo(), readinessTimeoutMs: 3_000 };
    const run = runLauncher(
      manifestFor([
        {
          name: "sigapp",
          label: "SigApp",
          port: 43115,
          url: "http://127.0.0.1:43115",
          health: "/health",
          command: "node",
          args: [healthBin],
          env: process.env,
        },
        {
          name: "termapp",
          label: "TermApp",
          port: 43116,
          url: "http://127.0.0.1:43116",
          health: "/health",
          command: "node",
          args: [termChild],
          env: process.env,
        },
      ]),
      io,
    );
    // Wait for readiness to be reached, then request shutdown.
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && !/Tenvyr is ready\./.test(io.buffer.join(""))) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.match(io.buffer.join(""), /Tenvyr is ready\./);
    process.emit("SIGINT");
    const result = await run;
    const output = io.buffer.join("");
    assert.equal(result.exitCode, 0);
    assert.match(output, /Stopping Tenvyr\.\.\./);
    // The child received SIGTERM (its handler wrote the marker).
    assert.equal(existsSync(markerFile), true);
    assert.match(readFileSync(markerFile, "utf8"), /SIGTERM/);
    assert.match(output, /SigApp stopped/);
    assert.match(output, /TermApp stopped/);
    assert.match(output, /Tenvyr stopped cleanly\./);
  });
});
