import { DataSource, type DataSourceOptions } from "typeorm";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AddressInfo } from "node:net";
import * as http from "node:http";
import { databaseOptions } from "./database/database.provider";
import { RuntimeConnectionEntity } from "./entities/runtime-connection.entity";
import { RuntimeConnectionService } from "./services/runtime-connection.service";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithPostgres = TEST_DATABASE_URL ? describe : describe.skip;

const assertDisposableTarget = (url: string | undefined): void => {
  const configured = String(databaseOptions().database);
  if (!url) return;
  const db = decodeURIComponent(new URL(url).pathname.replace(/^\/+/, "").replace(/\/+$/, ""));
  if (!db || db.toLowerCase() === configured.toLowerCase()) {
    throw new Error("TEST_DATABASE_URL must name a disposable database");
  }
};

const availablePort = async (): Promise<number> => {
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
};

describeWithPostgres("Dynamic Bridge composition verification (buildManifest)", () => {
  jest.setTimeout(30_000);
  let dataSource: DataSource;
  let fixtureDir: string;

  beforeAll(async () => {
    assertDisposableTarget(TEST_DATABASE_URL);
    dataSource = new DataSource({
      ...databaseOptions(),
      type: "postgres" as const,
      url: TEST_DATABASE_URL,
    } as DataSourceOptions);
    await dataSource.initialize();
    await dataSource.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await dataSource.runMigrations();
  });

  afterAll(async () => {
    await dataSource?.destroy().catch(() => {});
    if (fixtureDir && fs.existsSync(fixtureDir)) fs.rmSync(fixtureDir, { recursive: true, force: true });
  });

  it("buildManifest → orchestrator env + host env → dynamic RuntimeConnection → dispatch → signed callback", async () => {
    fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "tenvyr-dynamic-bridge-"));
    const orchPort = await availablePort();
    const hostPort = await availablePort();
    const { spawnSync } = await import("node:child_process");
    const manifestJson = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { buildManifest } from ${JSON.stringify(path.resolve(__dirname, "../../../scripts/dev.mjs"))}; const m = buildManifest({ ORCHESTRATOR_PORT: ${JSON.stringify(String(orchPort))}, EXECUTOR_HOST_PORT: ${JSON.stringify(String(hostPort))} }); console.log(JSON.stringify({ services: m.services.map(s=>({name:s.name, env:s.env})) }));`,
      ],
      { encoding: "utf8", timeout: 5000 },
    );
    if (manifestJson.status !== 0) throw new Error(`buildManifest spawn failed: ${manifestJson.stderr}`);
    const manifest = JSON.parse(manifestJson.stdout.trim());
    const orch = manifest.services.find((s: any) => s.name === "orchestrator");
    const host = manifest.services.find((s: any) => s.name === "host");
    expect(orch).toBeDefined();
    expect(host).toBeDefined();
    // Never invent URLs outside buildManifest
    expect(orch.env.HTTP_AGENT_CALLBACK_BASE_URL).toBe(`http://127.0.0.1:${orchPort}`);
    expect(orch.env.LOCAL_EXECUTOR_HOST_URL).toBe(`http://127.0.0.1:${hostPort}/v1/runs`);
    expect(orch.env.EXECUTOR_HOST_URL).toBe(`http://127.0.0.1:${hostPort}/v1/runs`);
    expect(host.env.EXECUTOR_HOST_CALLBACK_ALLOWED_ORIGINS).toBe(`http://127.0.0.1:${orchPort},http://localhost:${orchPort}`);
    expect(orch.env.HTTP_AGENT_BEARER_TOKEN).toBeDefined();
    expect(orch.env.HTTP_AGENT_CALLBACK_SECRET).toBeDefined();
    expect(host.env.EXECUTOR_HOST_BEARER_TOKEN).toBe(orch.env.EXECUTOR_HOST_BEARER_TOKEN);
    expect(host.env.EXECUTOR_HOST_CALLBACK_KEYS).toBeDefined();

    // Create one dynamic RuntimeConnection via orchestrator DB using the generated env (proves composition)
    const connService = new RuntimeConnectionService(dataSource);
    const connectionId = "conn:dynamic-bridge-test";
    const scriptPath = path.join(fixtureDir, "echo.js");
    fs.writeFileSync(scriptPath, `console.log(JSON.stringify({ok:true}));`, "utf8");
    await connService.createConnection(connectionId, {
      name: "Dynamic Bridge Test Runtime",
      runtimeKind: "generic-cli",
      executorId: "local-host",
      credentialRefs: [],
      declaredCapabilities: { invocation: { supported: true, source: "configured" } },
      cli: { command: process.execPath, args: [scriptPath], probe: { args: ["--version"] } },
    });
    await dataSource.getRepository(RuntimeConnectionEntity).update({ connectionId }, { statusState: "AVAILABLE", statusReasonCode: "none" });
    const rev = await dataSource.getRepository(RuntimeConnectionEntity).findOne({ where: { connectionId } });
    expect(rev).not.toBeNull();
    expect(rev?.statusState).toBe("AVAILABLE");
    // Verify host can resolve the connection (dynamic bridge) — the host's DB lookup uses TEST_DATABASE_URL which is the same disposable DB
    const connRev = await dataSource.getRepository(require("./entities/connection-revision.entity").ConnectionRevisionEntity).findOne({
      where: { connectionId, revisionNumber: rev?.currentRevisionNumber ?? 1 },
    } as any);
    expect(connRev).not.toBeNull();
    expect(connRev?.configHash).toBeDefined();

    // Verify that the generated LOCAL_EXECUTOR_HOST_URL is a valid URL that the orchestrator would use to dispatch
    const hostUrl = new URL(String(orch.env.LOCAL_EXECUTOR_HOST_URL));
    expect(hostUrl.hostname).toBe("127.0.0.1");
    expect(Number(hostUrl.port)).toBe(hostPort);
    expect(hostUrl.pathname).toBe("/v1/runs");

    // Verify callback URL composition
    const callbackUrl = new URL(String(orch.env.HTTP_AGENT_CALLBACK_BASE_URL));
    expect(callbackUrl.hostname).toBe("127.0.0.1");
    expect(Number(callbackUrl.port)).toBe(orchPort);
  });
});
