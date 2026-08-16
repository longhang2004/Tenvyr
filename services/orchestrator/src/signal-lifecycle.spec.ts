import { spawn, execSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DataSource, type DataSourceOptions } from "typeorm";
import { databaseOptions } from "./database/database.provider";
import { WorkbenchCommandService } from "./services/workbench-command.service";

/**
 * P2 shutdown-lifecycle closure regression: the REAL Orchestrator boot
 * path (main.ts semantics: NestFactory + enableShutdownHooks) must run
 * OnModuleDestroy -> OpenCodeAuthFlowService.closeAll on SIGTERM,
 * terminating every live management session.
 *
 * Flow: build -> create an opencode connection pointing at a fake
 * management server -> spawn `node dist/signal-boot.worker.js` (the real
 * AppModule with shutdown hooks) -> the worker begins a live auth flow
 * and writes a READY marker with the fake server PID -> prove the PID is
 * alive -> SIGTERM the Orchestrator child -> prove the child exits and
 * the management child is GONE. Bounded everywhere; no real provider
 * credentials.
 */
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithPostgres = TEST_DATABASE_URL ? describe : describe.skip;

describeWithPostgres("Orchestrator signal lifecycle (SIGTERM -> closeAll)", () => {
  let dataSource: DataSource;
  let commands: WorkbenchCommandService;
  let fixtureDir: string;
  let serveExecutable: string;
  let fixturePath: string;
  let markerPath: string;
  const workerPort = 3199;
  const runNonce = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const connectionId = `conn:signal-${runNonce}`;
  const workerPath = join(__dirname, "..", "dist", "signal-boot.worker.js");

  jest.setTimeout(240_000);

  beforeAll(async () => {
    dataSource = new DataSource({
      ...databaseOptions(),
      url: TEST_DATABASE_URL,
    } as DataSourceOptions);
    await dataSource.initialize();
    commands = new WorkbenchCommandService(dataSource);
    // Migrations + schema are provided by the suite's test database. A
    // per-run unique connection id avoids the DB's immutability guards
    // (revoked rows still exist).

    fixtureDir = mkdtempSync(join(tmpdir(), "tenvyr-signal-"));
    fixturePath = join(fixtureDir, "fixture.json");
    writeFileSync(
      fixturePath,
      JSON.stringify({
        providers: { all: [{ id: "openai" }], default: {}, connected: ["openai"] },
        authMethods: { openai: [{ type: "oauth", label: "OAuth" }] },
      }),
    );
    const serveScript = `
      const http = require("node:http");
      const fs = require("node:fs");
      const argv = process.argv.slice(2);
      const port = Number(argv[argv.indexOf("--port") + 1]);
      const fixturePath = process.env.OPENCODE_FAKE_FIXTURE;
      const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
      const password = process.env.OPENCODE_SERVER_PASSWORD;
      const expected = "Basic " + Buffer.from("opencode:" + password).toString("base64");
      fs.writeFileSync(fixturePath + ".pid", String(process.pid));
      let raw = "";
      let pending = null;
      const server = http.createServer((req, res) => {
        if (req.headers.authorization !== expected) { res.writeHead(401); res.end(); return; }
        req.on("data", (c) => { raw += c; });
        req.on("end", () => {
          const send = (status, body) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
          const url = req.url || "/";
          let body = {};
          try { body = JSON.parse(raw || "{}"); } catch {}
          if (req.method === "GET" && url === "/provider") return send(200, fixture.providers);
          if (req.method === "GET" && url === "/provider/auth") return send(200, fixture.authMethods);
          if (req.method === "POST" && url.endsWith("/oauth/authorize")) {
            pending = body;
            return send(200, { url: "https://provider.example/authorize?state=x", method: "auto", instructions: "Complete in the provider window." });
          }
          if (req.method === "POST" && url.endsWith("/oauth/callback")) {
            if (pending === null) return send(200, false);
            pending = null;
            return send(200, true);
          }
          send(404, { error: "not found" });
        });
      });
      server.listen(port, "127.0.0.1");
      process.on("SIGTERM", () => { server.close(); process.exit(0); });
    `;
    serveExecutable = join(fixtureDir, "serve.cjs");
    writeFileSync(serveExecutable, `#!/usr/bin/env node\n${serveScript}`, {
      mode: 0o755,
    });
    markerPath = join(fixtureDir, "marker.txt");

    // The REAL boot path: ensure dist is current (specs are excluded from
    // the orchestrator build; the worker is a plain src file).
    execSync("npm run build", { cwd: join(__dirname, ".."), stdio: "ignore" });
    expect(
      (() => {
        try {
          readFileSync(workerPath);
          return true;
        } catch {
          return false;
        }
      })(),
    ).toBe(true);

    await commands.createConnection({
      idempotencyKey: `signal-conn-create-${runNonce}`,
      connectionId,
      profile: {
        name: "signal-a",
        runtimeKind: "opencode",
        executorId: "local-host",
        cli: {
          command: serveExecutable,
          args: ["run"],
          probe: { args: ["--version"], expectsVersion: false },
          envAllowlist: { OPENCODE_FAKE_FIXTURE: "OPENCODE_FAKE_FIXTURE" },
        },
        declaredCapabilities: {
          invocation: { supported: true, source: "configured" },
          structuredResult: { supported: true, source: "configured" },
        },
        credentialRefs: [],
      } as never,
    });
  });

  afterAll(async () => {
    await dataSource.query(
      'DELETE FROM "runtime_connections" WHERE "connectionId" LIKE \'conn:signal-%\'',
    );
    await dataSource.query(
      'DELETE FROM "operator_actions" WHERE "action" = \'connection-create\' AND "targetId" LIKE \'conn:signal-%\'',
    );
    await dataSource.destroy();
  });

  const pidAlive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  const waitFor = async (
    predicate: () => boolean,
    timeoutMs: number,
    label: string,
  ): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`timed out waiting for ${label}`);
  };

  it("SIGTERM runs OnModuleDestroy -> closeAll and terminates the live management session", async () => {
    // 1) Boot the disposable Orchestrator child (real AppModule + hooks).
    const env: Record<string, string> = {
      ...process.env,
      POSTGRES_HOST: new URL(TEST_DATABASE_URL!).hostname,
      POSTGRES_PORT: new URL(TEST_DATABASE_URL!).port,
      POSTGRES_USER: decodeURIComponent(new URL(TEST_DATABASE_URL!).username),
      POSTGRES_PASSWORD: decodeURIComponent(new URL(TEST_DATABASE_URL!).password),
      POSTGRES_DB: decodeURIComponent(
        new URL(TEST_DATABASE_URL!).pathname.replace(/^\/+/, "").replace(/\/+$/, ""),
      ),
      ORCHESTRATOR_PORT: String(workerPort),
      LLM_PROVIDER: "mock",
      LLM_FAILURE_MODE: "mock",
      OPENCODE_FAKE_FIXTURE: fixturePath,
      SIGNAL_WORKER: "1",
      SIGNAL_CONNECTION: connectionId,
      SIGNAL_FIXTURE: fixturePath,
      SIGNAL_MARKER: markerPath,
    };
    const child = spawn("node", [workerPath], { env, stdio: ["ignore", "pipe", "pipe"] });
    let childOutput = "";
    child.stdout?.on("data", (chunk) => (childOutput += String(chunk)));
    child.stderr?.on("data", (chunk) => (childOutput += String(chunk)));

    let fakePid = -1;
    try {
      // 2) Wait for the worker to create a LIVE auth flow and report the
      //    management child PID (bounded).
      await waitFor(
        () => {
          try {
            return readFileSync(markerPath, "utf8").startsWith("READY ");
          } catch {
            return false;
          }
        },
        60_000,
        "worker READY marker",
      );
      const marker = readFileSync(markerPath, "utf8").trim().split(" ");
      fakePid = Number(marker[1]);
      expect(fakePid).toBeGreaterThan(0);

      // 3) Prove the management child is ALIVE before shutdown.
      expect(pidAlive(fakePid)).toBe(true);

      // 4) SIGTERM the Orchestrator.
      child.kill("SIGTERM");

      // 5) The child exits within a bound. A signal-terminated child
      //    reports code null + signal "SIGTERM" — either is a valid exit.
      const exit = await new Promise<{ code: number | null; signal: string | null }>(
        (resolve) => {
          const timer = setTimeout(() => resolve({ code: null, signal: null }), 60_000);
          child.once("exit", (code, signal) => {
            clearTimeout(timer);
            resolve({ code, signal });
          });
        },
      );
      expect(exit.code !== null || exit.signal === "SIGTERM").toBe(true);

      // 6) OnModuleDestroy -> closeAll terminated the management child.
      await waitFor(() => !pidAlive(fakePid), 10_000, "management child termination");
      expect(pidAlive(fakePid)).toBe(false);
    } finally {
      if (child.exitCode === null) {
        child.kill("SIGKILL");
      }
      if (fakePid > 0 && pidAlive(fakePid)) {
        try {
          process.kill(fakePid, "SIGKILL");
        } catch {
          // already gone
        }
      }
    }
    expect(childOutput).toContain("SIGNAL-WORKER-READY");
  });
});
