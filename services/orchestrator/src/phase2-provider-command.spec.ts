import { DataSource, type DataSourceOptions } from "typeorm";
import type { INestApplication } from "@nestjs/common";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { databaseOptions } from "./database/database.provider";
import { ModelSourceService } from "./services/model-source.service";
import { WorkbenchCommandService } from "./services/workbench-command.service";
import { ModelSourcesController } from "./model-sources.controller";
import { ProviderDiscoveryService } from "./services/provider-discovery.service";
import { ProviderDiscoveryController } from "./provider-discovery.controller";

/**
 * P2 closure regressions for the THREE functional bugs:
 *
 * 1. DI: the controller -> command -> service path runs with the REAL
 *    ModelSourceService injected into WorkbenchCommandService (no mock) —
 *    a missing dependency crashed every model-source command.
 * 2. M10 atomicity: authority mutation + OperatorAction evidence + stored
 *    outcome commit in ONE transaction. Fault injection: a test-only
 *    PostgreSQL trigger aborts the outcome update AFTER the authority
 *    mutation — the WHOLE transaction must roll back (no model_sources
 *    row, no operator_actions row). Inverse: an executed audit row exists
 *    IFF the matching authority row committed.
 * 3. The command envelope the gateway/frontend consume
 *    ({ action, outcome, result } nested under data) is asserted here at
 *    the source.
 */
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithPostgres = TEST_DATABASE_URL ? describe : describe.skip;

const assertDisposableTarget = (url: string | undefined): void => {
  if (!url) return;
  const database = decodeURIComponent(
    new URL(url).pathname.replace(/^\/+/, "").replace(/\/+$/, ""),
  );
  if (!database || database.toLowerCase() === configuredDatabaseName.toLowerCase()) {
    throw new Error(
      "TEST_DATABASE_URL must name a disposable database, never the configured one",
    );
  }
};

const configuredDatabaseName = String(databaseOptions().database);

describeWithPostgres(
  "P2 closure: model-source commands through the REAL controller -> command -> service -> PostgreSQL path",
  () => {
    jest.setTimeout(120_000);

    let dataSource: DataSource;
    let controller: ModelSourcesController;
    let service: ModelSourceService;

    const genericSource = (overrides: Record<string, unknown> = {}) => ({
      sourceId: "src:generic",
      kind: "openai-compatible",
      displayName: "Generic endpoint",
      baseUrl: "https://example.com/v1",
      ...overrides,
    });

    const tableCount = async (table: string, where = "1=1"): Promise<number> => {
      const rows: Array<{ n: string }> = await dataSource.query(
        `SELECT count(*)::text AS n FROM "${table}" WHERE ${where}`,
      );
      return Number(rows[0].n);
    };

    /** Test-only fault: abort the OperatorAction outcome update for one
     *  action — simulates an evidence-commit failure AFTER the authority
     *  mutation succeeded inside the same transaction. */
    const installOutcomeFault = async (action: string): Promise<void> => {
      await dataSource.query(`
        CREATE OR REPLACE FUNCTION tenvyr_test_fail_outcome() RETURNS trigger AS $$
        BEGIN
          RAISE EXCEPTION 'injected outcome commit failure (test fault)';
        END;
        $$ LANGUAGE plpgsql;
        CREATE OR REPLACE TRIGGER tenvyr_test_outcome_fault
        BEFORE UPDATE ON operator_actions
        FOR EACH ROW
        WHEN (NEW.action = '${action}' AND OLD.outcome @> '{"pending": true}'::jsonb)
        EXECUTE FUNCTION tenvyr_test_fail_outcome();
      `);
    };

    const removeOutcomeFault = async (): Promise<void> => {
      await dataSource
        .query(`DROP TRIGGER IF EXISTS tenvyr_test_outcome_fault ON operator_actions`)
        .catch(() => undefined);
      await dataSource
        .query(`DROP FUNCTION IF EXISTS tenvyr_test_fail_outcome()`)
        .catch(() => undefined);
    };

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

      // The REAL dependency chain — no mocks anywhere. The service is
      // injected explicitly so the audit assertion below is an identity
      // check on the EXACT instance the commands use.
      service = new ModelSourceService(dataSource);
      const commands = new WorkbenchCommandService(
        dataSource,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        service,
      );
      controller = new ModelSourcesController(service, commands);
      // Prove the DI wiring: the command service really holds a usable
      // ModelSourceService (the P2 bug was an unassigned field).
      expect((commands as unknown as { modelSources: unknown }).modelSources).toBe(
        service,
      );
    });

    afterAll(async () => {
      await removeOutcomeFault();
      await dataSource?.destroy();
    });

    beforeEach(async () => {
      await removeOutcomeFault();
      await dataSource.query(
        `TRUNCATE "operator_actions", "model_sources", "executions",
         "execution_plan_revisions", "step_executions", "step_attempts",
         "pipelines", "coordination_runs", "coordination_iterations" CASCADE`,
      );
    });

    it("real path: create commits BOTH the authority row and the audit row atomically (DI regression)", async () => {
      const response = await controller.create({
        idempotencyKey: "key-create-1",
        source: genericSource(),
      });
      // The envelope the gateway/frontend consume: nested under data.
      expect(response).toMatchObject({ success: true });
      const command = (response as { data: Record<string, unknown> }).data;
      expect(command.action).toBe("model-source-create");
      expect(command.outcome).toBe("executed");
      expect((command.result as { source: { sourceId: string } }).source.sourceId).toBe(
        "src:generic",
      );

      // Inverse invariant: audit row exists IFF the authority row exists.
      expect(await tableCount("model_sources", `"sourceId" = 'src:generic'`)).toBe(1);
      expect(
        await tableCount(
          "operator_actions",
          `"action" = 'model-source-create' AND "idempotencyKey" = 'key-create-1'`,
        ),
      ).toBe(1);
      const audit: Array<{ outcome: Record<string, unknown> }> = await dataSource.query(
        `SELECT outcome FROM operator_actions WHERE "idempotencyKey" = 'key-create-1'`,
      );
      expect(audit[0].outcome.pending).not.toBe(true);
      // The stored outcome is the command's result payload (the secret-free
      // authority projection), committed in the same transaction.
      expect(audit[0].outcome).toMatchObject({
        source: { sourceId: "src:generic" },
      });
    });

    it("idempotent replay: same key returns duplicate and never double-commits", async () => {
      await controller.create({
        idempotencyKey: "key-dup-1",
        source: genericSource(),
      });
      const duplicate = await controller.create({
        idempotencyKey: "key-dup-1",
        source: genericSource(),
      });
      const command = (duplicate as { data: Record<string, unknown> }).data;
      expect(command.outcome).toBe("duplicate");
      expect(await tableCount("model_sources")).toBe(1);
      expect(await tableCount("operator_actions", `"idempotencyKey" = 'key-dup-1'`)).toBe(1);
    });

    it("update and delete mutate through the SAME transaction as the audit evidence", async () => {
      await controller.create({
        idempotencyKey: "key-crud-1",
        source: genericSource(),
      });
      const updated = await controller.update("src:generic", {
        idempotencyKey: "key-upd-1",
        patch: { displayName: "Renamed endpoint" },
      });
      expect((updated as { data: Record<string, unknown> }).data.outcome).toBe("executed");
      const rows: Array<{ displayName: string }> = await dataSource.query(
        `SELECT "displayName" FROM model_sources WHERE "sourceId" = 'src:generic'`,
      );
      expect(rows[0].displayName).toBe("Renamed endpoint");
      expect(
        await tableCount("operator_actions", `"action" = 'model-source-update'`),
      ).toBe(1);

      const deleted = await controller.remove("src:generic", {
        idempotencyKey: "key-del-1",
      });
      expect((deleted as { data: Record<string, unknown> }).data.outcome).toBe("executed");
      expect(await tableCount("model_sources")).toBe(0);
      expect(await tableCount("operator_actions", `"action" = 'model-source-delete'`)).toBe(1);
    });

    it("fault injection: outcome-commit failure rolls back the WHOLE transaction — no authoritative row remains", async () => {
      await installOutcomeFault("model-source-create");
      await expect(
        controller.create({
          idempotencyKey: "key-fault-1",
          source: genericSource({ sourceId: "src:fault" }),
        }),
      ).rejects.toThrow(/injected outcome commit failure/);

      // The authority mutation was inside the same transaction as the
      // evidence: BOTH rolled back.
      expect(await tableCount("model_sources", `"sourceId" = 'src:fault'`)).toBe(0);
      expect(await tableCount("operator_actions", `"idempotencyKey" = 'key-fault-1'`)).toBe(0);
    });

    it("fault injection on update: no partial revision of the authority row", async () => {
      await controller.create({
        idempotencyKey: "key-fault-upd-0",
        source: genericSource(),
      });
      await installOutcomeFault("model-source-update");
      await expect(
        controller.update("src:generic", {
          idempotencyKey: "key-fault-upd-1",
          patch: { displayName: "Must not land" },
        }),
      ).rejects.toThrow(/injected outcome commit failure/);

      const rows: Array<{ displayName: string }> = await dataSource.query(
        `SELECT "displayName" FROM model_sources WHERE "sourceId" = 'src:generic'`,
      );
      expect(rows[0].displayName).toBe("Generic endpoint");
      expect(await tableCount("operator_actions", `"idempotencyKey" = 'key-fault-upd-1'`)).toBe(0);
    });

    it("rejected payloads surface as command errors without any side effect", async () => {
      // Malformed source (invalid kind) is rejected by the domain BEFORE
      // any mutation; the command layer reports the error.
      await expect(
        controller.create({
          idempotencyKey: "key-bad-1",
          source: { sourceId: "src:bad", kind: "ninerouter", displayName: "9Router" },
        }),
      ).rejects.toThrow();
      expect(await tableCount("model_sources")).toBe(0);
      expect(await tableCount("operator_actions", `"idempotencyKey" = 'key-bad-1'`)).toBe(0);
    });
  },
);

describeWithPostgres(
  "P2 closure round 2: audited provider commands through the REAL controller -> command -> PostgreSQL path",
  () => {
    jest.setTimeout(120_000);

    let dataSource: DataSource;
    let commands: WorkbenchCommandService;
    let controller: ReturnType<typeof makeProviderController>;

    const fixtureDir = mkdtempSync(join(tmpdir(), "tenvyr-p2c-"));

    const writeFixture = (name: string, script: string): string => {
      const path = join(fixtureDir, name);
      writeFileSync(path, `#!/usr/bin/env node\n${script}`, { mode: 0o755 });
      return path;
    };

    // Fake `opencode run` child: records argv, exits 0 or fails on demand.
    const runScript = `
      const fs = require("node:fs");
      try {
        fs.writeFileSync(process.env.P2C_RECORD, JSON.stringify(process.argv.slice(2)));
        process.stdout.write("OK\\n");
        if (process.env.P2C_FAIL === "1") process.exit(3);
        process.exit(0);
      } catch (error) {
        try { fs.writeFileSync(process.env.P2C_RECORD, "CRASH: " + error.message); } catch {}
        process.exit(1);
      }
    `;

    // Fake `opencode serve`: the REAL OpenCode auth contract — methods are
    // {type,label} by list index; authorize receives {method} and returns
    // {url, method, instructions}; callback receives {method, code?} and
    // fails unless authorize happened on THIS instance.
    const serveScript = `
      const http = require("node:http");
      const argv = process.argv.slice(2);
      const port = Number(argv[argv.indexOf("--port") + 1]);
      const password = process.env.OPENCODE_SERVER_PASSWORD;
      const expected = "Basic " + Buffer.from("opencode:" + password).toString("base64");
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
          const connected = (process.env.P2C_CONNECTED === undefined ? "deepseek" : process.env.P2C_CONNECTED).split(",").filter(Boolean);
          if (req.method === "GET" && url === "/provider") return send(200, { all: [{ id: "deepseek" }, { id: "other" }], default: {}, connected });
          if (req.method === "GET" && url === "/provider/auth") return send(200, { deepseek: [{ type: "oauth", label: "OAuth" }, { type: "api", label: "API Key" }] });
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

    const makeProviderController = () => {
      const discovery = new ProviderDiscoveryService(dataSource);
      return new ProviderDiscoveryController(discovery, commands);
    };

    beforeAll(async () => {
      dataSource = new DataSource({
        ...databaseOptions(),
        type: "postgres" as const,
        url: TEST_DATABASE_URL,
      } as DataSourceOptions);
      assertDisposableTarget(TEST_DATABASE_URL);
      await dataSource.initialize();
      await dataSource.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
      await dataSource.runMigrations();
      commands = new WorkbenchCommandService(dataSource);
      controller = makeProviderController();
    });

    afterAll(async () => {
      await dataSource?.destroy();
    });

    const errorCodeOf = async (action: () => Promise<unknown>): Promise<string> => {
      try {
        await action();
      } catch (error) {
        // Direct command errors carry the code on the error; controller
        // errors carry it in the HttpException response body.
        const direct = String((error as { code?: string }).code ?? "");
        if (direct) return direct;
        const response = (error as { getResponse?: () => unknown }).getResponse?.();
        return String((response as { error?: { code?: string } })?.error?.code ?? "");
      }
      return "NO_ERROR";
    };

    const profileWith = (command: string, envAllowlist: Record<string, string> = {}) => ({
      name: "p2c-connection",
      runtimeKind: "opencode",
      executorId: "local-host",
      credentialRefs: [],
      declaredCapabilities: {
        invocation: { supported: true, source: "configured" as const },
        structuredResult: { supported: true, source: "configured" as const },
      },
      cli: {
        command,
        args: ["run"],
        probe: { args: ["--version"], expectsVersion: false },
        ...(Object.keys(envAllowlist).length > 0 ? { envAllowlist } : {}),
      },
    });

    const createConnection = async (connectionId: string, command: string, envAllowlist: Record<string, string> = {}) => {
      const result = await commands.createConnection({
        idempotencyKey: `p2c-create-${connectionId}`,
        connectionId,
        profile: profileWith(command, envAllowlist) as never,
      });
      expect(result.outcome).toBe("executed");
    };

    it("test-runtime-target executes a REAL bounded invocation through the connection and records an audited operator action", async () => {
      const recordPath = join(fixtureDir, "p2c-argv.json");
      const runExecutable = writeFixture("run.cjs", runScript);
      await createConnection("conn:p2c-run", runExecutable, {
        P2C_RECORD: "P2C_RECORD",
      });
      process.env.P2C_RECORD = recordPath;
      delete process.env.P2C_FAIL;

      const response = await controller.testTarget({
        idempotencyKey: "p2c-test-1",
        connectionId: "conn:p2c-run",
        modelId: "deepseek/deepseek-v4",
      });
      const envelope = (response as { data: Record<string, unknown> }).data;
      expect(envelope.outcome).toBe("executed");
      const evidence = (envelope.result as { evidence: Record<string, unknown> }).evidence;
      expect(evidence.status).toBe("ok");
      expect(evidence.requestedModelId).toBe("deepseek/deepseek-v4");
      expect(evidence.connectionId).toBe("conn:p2c-run");
      expect(evidence.revisionNumber).toBe(1);

      // The exact model rode the fixed argv.
      const argv = JSON.parse(readFileSync(recordPath, "utf8")) as string[];
      expect(argv[argv.indexOf("--model") + 1]).toBe("deepseek/deepseek-v4");

      // Audited: the operator action row exists with the evidence outcome.
      expect(
        await dataSource.query(
          `SELECT outcome FROM operator_actions WHERE "idempotencyKey" = 'p2c-test-1'`,
        ),
      ).toHaveLength(1);
      delete process.env.P2C_RECORD;
    });

    it("test-runtime-target surfaces RUNTIME FAILURE as failure — never READY", async () => {
      const recordPath = join(fixtureDir, "p2c-argv-fail.json");
      process.env.P2C_RECORD = recordPath;
      process.env.P2C_FAIL = "1";
      const response = await controller.testTarget({
        idempotencyKey: "p2c-test-fail-1",
        connectionId: "conn:p2c-run",
        modelId: "deepseek/deepseek-v4",
      });
      const envelope = (response as { data: Record<string, unknown> }).data;
      const evidence = (envelope.result as { evidence: Record<string, unknown> }).evidence;
      expect(evidence.status).toBe("failed");
      expect(evidence.exitCode).toBe(3);
      expect(evidence.status).not.toBe("ok");
      delete process.env.P2C_RECORD;
      delete process.env.P2C_FAIL;
    });

    it("opencode oauth begin + complete are audited; the method index travels; same live session", async () => {
      const serveExecutable = writeFixture("serve.cjs", serveScript);
      await createConnection("conn:p2c-serve", serveExecutable);

      const begun = await controller.oauthBegin({
        idempotencyKey: "p2c-oauth-begin-1",
        connectionId: "conn:p2c-serve",
        providerId: "deepseek",
        methodIndex: 1,
      });
      const beginEnvelope = (begun as { data: Record<string, unknown> }).data;
      expect(beginEnvelope.outcome).toBe("executed");
      const beginResult = beginEnvelope.result as {
        authFlowId: string;
        url: string;
        method: string;
        instructions: string | null;
        connectionRevision: number;
      };
      expect(beginResult.authFlowId).toMatch(/^[0-9a-f]{32}$/);
      expect(beginResult.url.startsWith("https://")).toBe(true);
      expect(beginResult.method).toBe("auto");
      expect(beginResult.connectionRevision).toBe(1);
      expect(
        await dataSource.query(
          `SELECT outcome FROM operator_actions WHERE "idempotencyKey" = 'p2c-oauth-begin-1'`,
        ),
      ).toHaveLength(1);

      const completed = await controller.oauthComplete({
        idempotencyKey: "p2c-oauth-complete-1",
        authFlowId: beginResult.authFlowId,
      });
      const completeEnvelope = (completed as { data: Record<string, unknown> }).data;
      expect(completeEnvelope.outcome).toBe("executed");
      expect(
        (completeEnvelope.result as { connected: boolean }).connected,
      ).toBe(true);
      expect(
        await dataSource.query(
          `SELECT outcome FROM operator_actions WHERE "idempotencyKey" = 'p2c-oauth-complete-1'`,
        ),
      ).toHaveLength(1);
    });

    it("oauth complete with an unknown/expired authFlowId fails closed", async () => {
      const code = await errorCodeOf(() =>
        controller.oauthComplete({
          idempotencyKey: "p2c-oauth-complete-missing",
          authFlowId: "0".repeat(32),
        }),
      );
      expect(code).toBe("AUTH_FLOW_NOT_FOUND");
    });

    it("server-side enforcement: startTeamRun BLOCKS an explicit opencode model when ZERO providers are connected", async () => {
      const serveExecutable = writeFixture("serve-zero.cjs", serveScript);
      await createConnection("conn:p2c-zero", serveExecutable);
      process.env.P2C_CONNECTED = "";
      try {
        const code = await errorCodeOf(() =>
          commands.startTeamRun({
            idempotencyKey: "p2c-zero-launch-1",
            name: "zero-connected",
            goal: "test",
            config: {
              schemaVersion: 1,
              planner: { kind: "connection", name: "conn:p2c-zero", agent: "planner" },
              verifier: { kind: "connection", name: "conn:p2c-zero", agent: "verifier" },
              allowedTargets: [{ connectionId: "conn:p2c-zero", modelId: "deepseek/deepseek-v4" }],
              allowedWorkers: [{ kind: "connection", name: "conn:p2c-zero", agent: "worker" }],
              maxIterations: 1,
              maxWorkersPerIteration: 1,
              maxTotalWorkers: 1,
              loopDeadlineMs: 60000,
              delegationDepthMax: 1,
              allowedExecutors: ["local-host"],
            },
          }),
        );
        expect(code).toBe("PROVIDER_NOT_AUTHENTICATED");
        // The validation runs BEFORE the authority transaction: no audit
        // row, no execution.
        expect(
          await dataSource.query(
            `SELECT count(*)::text AS n FROM operator_actions WHERE "idempotencyKey" = 'p2c-zero-launch-1'`,
          ),
        ).toEqual([{ n: "0" }]);
      } finally {
        delete process.env.P2C_CONNECTED;
      }
    });

    it("server-side enforcement: provider A connected, model from provider B -> BLOCK (direct backend bypass)", async () => {
      const serveExecutable = writeFixture("serve-mixed.cjs", serveScript);
      await createConnection("conn:p2c-mixed", serveExecutable);
      process.env.P2C_CONNECTED = "deepseek";
      try {
        const code = await errorCodeOf(() =>
          commands.startTeamRun({
            idempotencyKey: "p2c-mixed-launch-1",
            name: "mixed",
            goal: "test",
            config: {
              schemaVersion: 1,
              planner: { kind: "connection", name: "conn:p2c-mixed", agent: "planner" },
              verifier: { kind: "connection", name: "conn:p2c-mixed", agent: "verifier" },
              allowedTargets: [{ connectionId: "conn:p2c-mixed", modelId: "other/not-connected-model" }],
              allowedWorkers: [{ kind: "connection", name: "conn:p2c-mixed", agent: "worker" }],
              maxIterations: 1,
              maxWorkersPerIteration: 1,
              maxTotalWorkers: 1,
              loopDeadlineMs: 60000,
              delegationDepthMax: 1,
              allowedExecutors: ["local-host"],
            },
          }),
        );
        expect(code).toBe("PROVIDER_NOT_AUTHENTICATED");
        expect(
          await dataSource.query(
            `SELECT count(*)::text AS n FROM operator_actions WHERE "idempotencyKey" = 'p2c-mixed-launch-1'`,
          ),
        ).toEqual([{ n: "0" }]);
      } finally {
        delete process.env.P2C_CONNECTED;
      }
    });

    it("server-side enforcement: connected provider/model -> launch succeeds", async () => {
      const serveExecutable = writeFixture("serve-ok.cjs", serveScript);
      await createConnection("conn:p2c-ok", serveExecutable);
      process.env.P2C_CONNECTED = "deepseek";
      try {
        const result = await commands.startTeamRun({
          idempotencyKey: "p2c-ok-launch-1",
          name: "connected-ok",
          goal: "test",
          config: {
            schemaVersion: 1,
            planner: { kind: "connection", name: "conn:p2c-ok", agent: "planner" },
            verifier: { kind: "connection", name: "conn:p2c-ok", agent: "verifier" },
            allowedTargets: [{ connectionId: "conn:p2c-ok", modelId: "deepseek/deepseek-v4" }],
            allowedWorkers: [{ kind: "connection", name: "conn:p2c-ok", agent: "worker" }],
            maxIterations: 1,
            maxWorkersPerIteration: 1,
            maxTotalWorkers: 1,
            loopDeadlineMs: 60000,
            delegationDepthMax: 1,
            allowedExecutors: ["local-host"],
          },
        });
        expect(result.outcome).toBe("executed");
        // The audited launch committed.
        expect(
          await dataSource.query(
            `SELECT outcome FROM operator_actions WHERE "idempotencyKey" = 'p2c-ok-launch-1'`,
          ),
        ).toHaveLength(1);
      } finally {
        delete process.env.P2C_CONNECTED;
      }
    });

    it("test-runtime-target on a revoked connection is DENIED", async () => {
      await commands.revokeConnection({
        idempotencyKey: "p2c-revoke-1",
        connectionId: "conn:p2c-serve",
      });
      let errorCode: string | null = null;
      try {
        await controller.testTarget({
          idempotencyKey: "p2c-test-revoked-1",
          connectionId: "conn:p2c-serve",
          modelId: "deepseek/deepseek-v4",
        });
      } catch (error) {
        const response = (error as { getResponse?: () => unknown }).getResponse?.();
        errorCode = String((response as { error?: { code?: string } })?.error?.code ?? "");
      }
      expect(errorCode).toBe("CONNECTION_REVOKED");
    });
  },
);
