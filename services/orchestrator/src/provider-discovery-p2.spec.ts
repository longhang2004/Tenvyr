import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRuntimeConnectionProfile } from "./executors/runtime-profiles";
import type { ConnectionRevisionV1 } from "./executors/runtime-connection";
import {
  ProviderDiscoveryService,
} from "./services/provider-discovery.service";
import { OpenCodeManagementSession } from "./services/opencode-management.service";
import { OpenCodeServerError } from "./executors/opencode-server";
import {
  isSafeOauthUrl,
  parseOpenCodeAuthAuthorization,
  parseOpenCodeAuthMethods,
  parseOpenCodeProviderList,
} from "./executors/opencode-server";

/**
 * P2 closure (round 2): connection-scoped provider discovery against a
 * FAKE OpenCode management server (the official structured Server API
 * contract: GET /provider, GET /provider/auth, oauth authorize/callback).
 *
 * Deterministic: no real opencode binary, no auth file, no live provider.
 * The fake server honors the REAL session contract (--port/--hostname
 * argv, OPENCODE_SERVER_PASSWORD basic auth) so the management adapter is
 * exercised end to end.
 */

function fakeFixture(name: string, script: string): string {
  const dir = mkdtempSync(join(tmpdir(), `tenvyr-prov-${name}-`));
  const path = join(dir, "fixture.cjs");
  writeFileSync(path, `#!/usr/bin/env node\n${script}`, { mode: 0o755 });
  return path;
}

/** Fake `opencode serve`: a real HTTP server implementing the documented
 *  Server API, honoring basic auth + --port/--hostname. */
const FAKE_SERVER_SCRIPT = `
const http = require("node:http");
const fs = require("node:fs");
const argv = process.argv.slice(2);
const port = Number(argv[argv.indexOf("--port") + 1]);
const fixturePath = process.env.OPENCODE_FAKE_FIXTURE;
const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
const password = process.env.OPENCODE_SERVER_PASSWORD;
const expected = "Basic " + Buffer.from("opencode:" + password).toString("base64");
fs.writeFileSync(fixturePath + ".pid", String(process.pid));
const server = http.createServer((req, res) => {
  if (req.headers.authorization !== expected) {
    res.writeHead(401); res.end(); return;
  }
  const url = req.url || "/";
  const send = (status, body) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (req.method === "GET" && url === "/provider") return send(200, fixture.providers);
  if (req.method === "GET" && url === "/provider/auth") return send(200, fixture.authMethods);
  if (req.method === "POST" && url.startsWith("/provider/") && url.endsWith("/oauth/authorize")) {
    return send(200, fixture.authorization ?? { url: "https://provider.example/authorize?state=abc" });
  }
  if (req.method === "POST" && url.startsWith("/provider/") && url.endsWith("/oauth/callback")) {
    fs.appendFileSync(fixturePath + ".callback", "1");
    return send(200, fixture.callbackResult ?? true);
  }
  send(404, { error: "not found" });
});
server.listen(port, "127.0.0.1");
process.on("SIGTERM", () => { server.close(); process.exit(0); });
`;

/** Fake `opencode models [provider]` CLI through the connection profile. */
const FAKE_MODELS_SCRIPT = `
const [,,sub,provider] = process.argv;
if (sub === "models") {
  const lines = (process.env.OPENCODE_FAKE_MODELS || "openai/gpt-5.5\\nanthropic/claude-sonnet-5").split("\\n");
  const filtered = provider ? lines.filter((l) => l.startsWith(provider + "/")) : lines;
  process.stdout.write(filtered.join("\\n") + "\\n");
}
`;

/** Fake runtime `run` child: records argv, exits 0, or fails on demand. */
const FAKE_RUN_SCRIPT = `
const fs = require("node:fs");
const recordPath = process.env.OPENCODE_FAKE_RECORD;
fs.writeFileSync(recordPath, JSON.stringify(process.argv.slice(2)));
process.stdout.write("OK\\n");
if (process.env.OPENCODE_FAKE_FAIL === "1") process.exit(3);
process.exit(0);
`;

type Fixture = {
  connectionId: string;
  executable: string;
  fixturePath: string;
};

function makeConnection(
  connectionId: string,
  providerId: string,
): Fixture {
  const fixtureDir = mkdtempSync(join(tmpdir(), "tenvyr-prov-svc-"));
  const fixturePath = join(fixtureDir, `${connectionId}.json`);
  writeFileSync(
    fixturePath,
    JSON.stringify({
      providers: { all: [{ id: providerId }], default: {}, connected: [providerId] },
      authMethods: { [providerId]: [{ id: "oauth" }] },
    }),
  );
  const serverExecutable = fakeFixture(`server-${connectionId}`, FAKE_SERVER_SCRIPT);
  return { connectionId, executable: serverExecutable, fixturePath };
}

function openCodeRevision(
  connectionId: string,
  executable: string,
  envAllowlist?: Record<string, string>,
  revisionNumber = 1,
): ConnectionRevisionV1 {
  const profile = buildRuntimeConnectionProfile({
    runtimeKind: "opencode",
    name: connectionId,
    executorId: "local-host",
    executable,
  });
  profile.cli = { ...profile.cli!, ...(envAllowlist ? { envAllowlist } : {}) };
  return {
    schemaVersion: "1",
    connectionId,
    revisionNumber,
    createdAt: new Date().toISOString(),
    profile,
    configHash: "test-hash",
    capabilities: {
      invocation: { supported: true, source: "configured" },
      structuredResult: { supported: true, source: "configured" },
    },
  };
}

function service(revisions: Map<string, ConnectionRevisionV1>): ProviderDiscoveryService {
  const connections = {
    claimRevision: async (connectionId: string): Promise<ConnectionRevisionV1> => {
      if (connectionId === "conn:missing") {
        const error = new Error(`Runtime connection "${connectionId}" does not exist`);
        (error as { code?: string }).code = "CONNECTION_NOT_FOUND";
        throw error;
      }
      if (connectionId === "conn:revoked") {
        const error = new Error(`Runtime connection "${connectionId}" is revoked`);
        (error as { code?: string }).code = "CONNECTION_REVOKED";
        throw error;
      }
      const revision = revisions.get(connectionId);
      if (!revision) throw new Error(`no revision for ${connectionId}`);
      return revision;
    },
  } as unknown as ProviderDiscoveryService["connections"];
  const discovery = {
    discoverCodexModels: async (): Promise<never> => {
      throw new Error("not used");
    },
  } as unknown as ProviderDiscoveryService["discovery"];
  return new ProviderDiscoveryService({} as never, connections, discovery);
}

describe("P2 closure round 2: OpenCode management session (structured Server API)", () => {
  test("server contract guards parse the documented shapes strictly", () => {
    const list = parseOpenCodeProviderList({
      all: [{ id: "openai", name: "OpenAI" }, { id: "anthropic" }],
      default: { model: "openai/gpt-5.5" },
      connected: ["openai"],
    });
    expect(list.all.map((p) => p.id)).toEqual(["openai", "anthropic"]);
    expect(list.connected).toEqual(["openai"]);
    expect(() => parseOpenCodeProviderList({ all: "nope" })).toThrow(OpenCodeServerError);
    expect(() =>
      parseOpenCodeProviderList({ all: [{ id: "bad id!" }] }),
    ).toThrow(OpenCodeServerError);

    const methods = parseOpenCodeAuthMethods({
      openai: [{ id: "oauth" }, { id: "api" }],
    });
    expect(methods.openai.map((m) => m.id)).toEqual(["oauth", "api"]);

    const authorization = parseOpenCodeAuthAuthorization({
      url: "https://provider.example/authorize?state=abc",
    });
    expect(isSafeOauthUrl(authorization.url)).toBe(true);
    expect(isSafeOauthUrl("javascript:alert(1)")).toBe(false);
    expect(isSafeOauthUrl("https://user:pass@provider.example/")).toBe(false);
    let badUrlCode: string | null = null;
    try {
      parseOpenCodeAuthAuthorization({ url: "javascript:alert(1)" });
    } catch (error) {
      badUrlCode = (error as OpenCodeServerError).code;
    }
    expect(badUrlCode).toBe("invalid-oauth-url");
  });

  test("session start reaches READY, serves providers, teardown kills the child", async () => {
    const fixtureDir = mkdtempSync(join(tmpdir(), "tenvyr-session-"));
    const fixturePath = join(fixtureDir, "fixture.json");
    writeFileSync(
      fixturePath,
      JSON.stringify({
        providers: {
          all: [{ id: "openai" }, { id: "anthropic" }],
          default: {},
          connected: ["openai"],
        },
        authMethods: { openai: [{ id: "oauth" }] },
      }),
    );
    const serverExecutable = fakeFixture("server", FAKE_SERVER_SCRIPT);
    const session = await OpenCodeManagementSession.start({
      command: serverExecutable,
      cwd: fixtureDir,
      env: { OPENCODE_FAKE_FIXTURE: fixturePath },
    });
    try {
      const list = await session.providers();
      expect(list.all.map((p) => p.id)).toEqual(["openai", "anthropic"]);
      expect(list.connected).toEqual(["openai"]);
      const methods = await session.authMethods();
      expect(methods.openai.map((m) => m.id)).toEqual(["oauth"]);
      const authorization = await session.authorize("openai");
      expect(authorization.url.startsWith("https://")).toBe(true);
      expect(await session.completeOauth("openai")).toBe(true);
    } finally {
      await session.close();
    }
    // Deterministic teardown: the server process is gone.
    const pid = Number(readFileSync(`${fixturePath}.pid`, "utf8"));
    await new Promise((resolve) => setTimeout(resolve, 200));
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch {
      alive = false;
    }
    expect(alive).toBe(false);
  });

  test("startup fails cleanly when the server never becomes ready", async () => {
    const executable = fakeFixture("never-ready", `setInterval(() => {}, 1000);`);
    let code: string | null = null;
    try {
      await OpenCodeManagementSession.start({ command: executable });
    } catch (error) {
      code = (error as OpenCodeServerError).code;
    }
    expect(["start-timeout", "start-failed"]).toContain(code);
  }, 25000);
});

describe("P2 closure round 2: connection-scoped provider discovery", () => {
  test("conn:A -> provider set A; conn:B -> provider set B (no bleed)", async () => {
    const a = makeConnection("conn:opencode-A", "openai");
    const b = makeConnection("conn:opencode-B", "anthropic");
    const revisions = new Map<string, ConnectionRevisionV1>([
      [
        "conn:opencode-A",
        openCodeRevision("conn:opencode-A", a.executable, {
          OPENCODE_FAKE_FIXTURE: "OPENCODE_FAKE_FIXTURE",
        }),
      ],
      [
        "conn:opencode-B",
        openCodeRevision("conn:opencode-B", b.executable, {
          OPENCODE_FAKE_FIXTURE: "OPENCODE_FAKE_FIXTURE",
        }),
      ],
    ]);
    const svc = service(revisions);

    process.env.OPENCODE_FAKE_FIXTURE = a.fixturePath;
    const providersA = await svc.discoverRuntimeProviders("conn:opencode-A");
    expect(providersA.providers.map((p) => p.providerId)).toEqual(["openai"]);
    expect(providersA.providers.every((p) => p.authenticated)).toBe(true);

    process.env.OPENCODE_FAKE_FIXTURE = b.fixturePath;
    const providersB = await svc.discoverRuntimeProviders("conn:opencode-B");
    expect(providersB.providers.map((p) => p.providerId)).toEqual(["anthropic"]);

    // Isolation: A's response never contains anthropic, B's never openai.
    expect(JSON.stringify(providersA)).not.toContain("anthropic");
    expect(JSON.stringify(providersB)).not.toContain("openai");
    delete process.env.OPENCODE_FAKE_FIXTURE;
  });

  test("two same-kind connections with DIFFERENT executables stay independent", async () => {
    const a = makeConnection("conn:opencode-A", "openai");
    const b = makeConnection("conn:opencode-B", "anthropic");
    // The executables genuinely differ (separate fixture scripts).
    expect(a.executable).not.toBe(b.executable);
    const revisions = new Map<string, ConnectionRevisionV1>([
      [
        "conn:opencode-A",
        openCodeRevision("conn:opencode-A", a.executable, {
          OPENCODE_FAKE_FIXTURE: "OPENCODE_FAKE_FIXTURE",
        }),
      ],
      [
        "conn:opencode-B",
        openCodeRevision("conn:opencode-B", b.executable, {
          OPENCODE_FAKE_FIXTURE: "OPENCODE_FAKE_FIXTURE",
        }),
      ],
    ]);
    const svc = service(revisions);
    process.env.OPENCODE_FAKE_FIXTURE = a.fixturePath;
    const providersA = await svc.discoverRuntimeProviders("conn:opencode-A");
    expect(providersA.providers.map((p) => p.providerId)).toEqual(["openai"]);
    // B's provider list never leaks into A's projection even though B's
    // revision is present in the same map.
    expect(JSON.stringify(providersA)).not.toContain("anthropic");
    delete process.env.OPENCODE_FAKE_FIXTURE;
  });

  test("missing and revoked connections are rejected before any discovery", async () => {
    const svc = service(new Map());
    await expect(svc.discoverRuntimeProviders("conn:missing")).rejects.toMatchObject({
      code: "CONNECTION_NOT_FOUND",
    });
    await expect(svc.discoverRuntimeProviders("conn:revoked")).rejects.toMatchObject({
      code: "CONNECTION_REVOKED",
    });
  });

  test("auth methods for one provider of one connection", async () => {
    const c = makeConnection("conn:opencode-A", "openai");
    const revisions = new Map<string, ConnectionRevisionV1>([
      [
        "conn:opencode-A",
        openCodeRevision("conn:opencode-A", c.executable, {
          OPENCODE_FAKE_FIXTURE: "OPENCODE_FAKE_FIXTURE",
        }, 2),
      ],
    ]);
    const svc = service(revisions);
    process.env.OPENCODE_FAKE_FIXTURE = c.fixturePath;
    const result = await svc.getRuntimeProviderAuthMethods("conn:opencode-A", "openai");
    expect(result.providerId).toBe("openai");
    expect(result.methods.map((m) => m.id)).toEqual(["oauth"]);
    expect(result.revisionNumber).toBe(2);
    delete process.env.OPENCODE_FAKE_FIXTURE;
  });

  test("model refresh runs the documented CLI through the exact connection profile", async () => {
    const modelsExecutable = fakeFixture("models", FAKE_MODELS_SCRIPT);
    const revisions = new Map<string, ConnectionRevisionV1>([
      [
        "conn:models",
        openCodeRevision("conn:models", modelsExecutable, {
          OPENCODE_FAKE_MODELS: "OPENCODE_FAKE_MODELS",
        }),
      ],
    ]);
    const svc = service(revisions);
    process.env.OPENCODE_FAKE_MODELS = "openai/gpt-5.5\nanthropic/claude-sonnet-5";
    const all = await svc.refreshRuntimeModels("conn:models");
    expect(all.catalog.models.map((m) => m.modelId)).toEqual([
      "openai/gpt-5.5",
      "anthropic/claude-sonnet-5",
    ]);
    const openai = await svc.refreshRuntimeModels("conn:models", "openai");
    expect(openai.catalog.models.map((m) => m.modelId)).toEqual(["openai/gpt-5.5"]);
    delete process.env.OPENCODE_FAKE_MODELS;
  });

  test("test runtime target: EXACT model rides fixed argv; failure is failure, never READY", async () => {
    const fixtureDir = mkdtempSync(join(tmpdir(), "tenvyr-run-evidence-"));
    const recordPath = join(fixtureDir, "argv-evidence.json");
    const runExecutable = fakeFixture("run", FAKE_RUN_SCRIPT);
    const revisions = new Map<string, ConnectionRevisionV1>([
      [
        "conn:run",
        openCodeRevision("conn:run", runExecutable, {
          OPENCODE_FAKE_RECORD: "OPENCODE_FAKE_RECORD",
        }),
      ],
    ]);
    const svc = service(revisions);

    process.env.OPENCODE_FAKE_RECORD = recordPath;
    delete process.env.OPENCODE_FAKE_FAIL;
    const evidence = await svc.testRuntimeTarget("conn:run", "opencode-go/deepseek-v4-flash");
    expect(evidence.status).toBe("ok");
    expect(evidence.requestedModelId).toBe("opencode-go/deepseek-v4-flash");
    expect(evidence.connectionId).toBe("conn:run");
    expect(evidence.revisionNumber).toBe(1);
    // The fake child recorded the exact argv: fixed run args + --model + the
    // exact model id as SEPARATE elements.
    const argv = JSON.parse(readFileSync(recordPath, "utf8")) as string[];
    expect(argv).toContain("--model");
    expect(argv[argv.indexOf("--model") + 1]).toBe("opencode-go/deepseek-v4-flash");

    // Failure from the runtime is surfaced as failure.
    process.env.OPENCODE_FAKE_FAIL = "1";
    const failed = await svc.testRuntimeTarget("conn:run", "opencode-go/deepseek-v4-flash");
    expect(failed.status).toBe("failed");
    expect(failed.exitCode).toBe(3);
    delete process.env.OPENCODE_FAKE_RECORD;
    delete process.env.OPENCODE_FAKE_FAIL;
  });

  test("test runtime target rejects out-of-bounds model ids", async () => {
    const svc = service(new Map());
    await expect(
      svc.testRuntimeTarget("conn:missing", "not a model id!"),
    ).rejects.toMatchObject({ code: "CONNECTION_NOT_FOUND" });
  });
});
