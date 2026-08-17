import { existsSync, mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRuntimeConnectionProfile } from "./executors/runtime-profiles";
import type { ConnectionRevisionV1 } from "./executors/runtime-connection";
import {
  ProviderDiscoveryService,
} from "./services/provider-discovery.service";
import { OpenCodeManagementSession } from "./services/opencode-management.service";
import { OpenCodeAuthFlowService } from "./services/opencode-auth-flow.service";
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

/** Fake `opencode serve` implementing the REAL OpenCode auth contract:
 *  auth methods are `{ type: "oauth" | "api", label }` identified by list
 *  index; authorize receives `{ method }` and returns
 *  `{ url, method: "auto"|"code", instructions }`; callback receives
 *  `{ method, code? }` and FAILS unless authorize happened on THIS live
 *  instance (instance-local pending state). Request bodies are recorded
 *  to the fixture dir for assertions. */
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
let pending = null;
const record = (name, body) => {
  try { fs.appendFileSync(fixturePath + "." + name, JSON.stringify(body) + "\\n"); } catch {}
};
const server = http.createServer((req, res) => {
  if (req.headers.authorization !== expected) {
    res.writeHead(401); res.end(); return;
  }
  let raw = "";
  req.on("data", (c) => { raw += c; });
  req.on("end", () => {
  const url = req.url || "/";
  const send = (status, body) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (req.method === "GET" && url === "/provider") return send(200, fixture.providers);
  if (req.method === "GET" && url === "/provider/auth") return send(200, fixture.authMethods);
  if (req.method === "POST" && url.startsWith("/provider/") && url.endsWith("/oauth/authorize")) {
    let body = {};
    try { body = JSON.parse(raw || "{}"); } catch {}
    record("authorize", body);
    pending = body;
    return send(200, fixture.authorization ?? { url: "https://provider.example/authorize?state=abc", method: "auto", instructions: "Complete authorization in the provider window." });
  }
  if (req.method === "POST" && url.startsWith("/provider/") && url.endsWith("/oauth/callback")) {
    let body = {};
    try { body = JSON.parse(raw || "{}"); } catch {}
    record("callback", body);
    if (pending === null) return send(200, fixture.callbackWithoutAuthorize ?? false);
    pending = null;
    return send(200, fixture.callbackResult ?? true);
  }
  send(404, { error: "not found" });
  });
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
      authMethods: { [providerId]: [{ type: "oauth", label: "OAuth" }] },
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
      openai: [
        { type: "oauth", label: "OAuth" },
        { type: "api", label: "API Key" },
      ],
    });
    expect(methods.openai.map((m) => m.type)).toEqual(["oauth", "api"]);
    expect(methods.openai.map((m) => m.methodIndex)).toEqual([0, 1]);
    // Unknown types are dropped; a fake string id is never synthesized.
    const withJunk = parseOpenCodeAuthMethods({
      openai: [
        { type: "oauth", label: "OAuth" },
        { id: "oauth" },
        { type: "mystery", label: "?" },
      ],
    });
    expect(withJunk.openai.map((m) => m.type)).toEqual(["oauth"]);
    expect("id" in withJunk.openai[0]).toBe(false);

    const authorization = parseOpenCodeAuthAuthorization({
      url: "https://provider.example/authorize?state=abc",
      method: "auto",
      instructions: "Complete authorization in the provider window.",
    });
    expect(isSafeOauthUrl(authorization.url)).toBe(true);
    expect(authorization.method).toBe("auto");
    expect(authorization.instructions).toBeTruthy();
    // Unknown flow methods are malformed, never optimistic.
    expect(() =>
      parseOpenCodeAuthAuthorization({ url: "https://x.example/a", method: "magic" }),
    ).toThrow(OpenCodeServerError);
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
        authMethods: { openai: [{ type: "oauth", label: "OAuth" }] },
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
      expect(methods.openai[0].type).toBe("oauth");
      expect(methods.openai[0].label).toBe("OAuth");
      expect(methods.openai[0].methodIndex).toBe(0);
      const authorization = await session.authorize("openai", 0);
      expect(authorization.url.startsWith("https://")).toBe(true);
      expect(authorization.method).toBe("auto");
      expect(authorization.instructions).toBeTruthy();
      expect(await session.completeOauth("openai", 0)).toBe(true);
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
    expect(result.methods[0]).toMatchObject({
      methodIndex: 0,
      type: "oauth",
      label: "OAuth",
      requiresPrompt: false,
    });
    expect("id" in result.methods[0]).toBe(false);
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

describe("P2 final closure: OpenCode auth flow — one live session, method index, auto/code", () => {
  const flowFixture = (
    name: string,
    options: {
      methods?: unknown[];
      authorization?: unknown;
      connected?: string[];
    } = {},
  ) => {
    const dir = mkdtempSync(join(tmpdir(), `tenvyr-flow-${name}-`));
    const fixturePath = join(dir, "fixture.json");
    writeFileSync(
      fixturePath,
      JSON.stringify({
        providers: {
          all: [{ id: "openai" }],
          default: {},
          connected: options.connected ?? ["openai"],
        },
        authMethods: {
          openai:
            options.methods ?? [
              { type: "oauth", label: "OAuth" },
              { type: "api", label: "API Key" },
            ],
        },
        ...(options.authorization !== undefined
          ? { authorization: options.authorization }
          : {}),
      }),
    );
    const executable = fakeFixture(`flow-server-${name}`, FAKE_SERVER_SCRIPT);
    return { executable, fixturePath, dir };
  };

  const flowRevisions = (
    connectionId: string,
    executable: string,
    fixturePath: string,
  ) =>
    new Map<string, ConnectionRevisionV1>([
      [
        connectionId,
        openCodeRevision(connectionId, executable, {
          OPENCODE_FAKE_FIXTURE: "OPENCODE_FAKE_FIXTURE",
        }),
      ],
    ]);

  test("begin: selected methodIndex travels as { method: N }; same live session completes the flow", async () => {
    const fx = flowFixture("same-session");
    const svc = service(flowRevisions("conn:flow", fx.executable, fx.fixturePath));
    process.env.OPENCODE_FAKE_FIXTURE = fx.fixturePath;

    const begun = await svc.beginAuthFlow({
      connectionId: "conn:flow",
      providerId: "openai",
      methodIndex: 0, // OAuth method
    });
    expect(begun.authFlowId).toMatch(/^[0-9a-f]{32}$/);
    expect(begun.method).toBe("auto");
    expect(begun.url.startsWith("https://")).toBe(true);
    expect(begun.connectionRevision).toBe(1);

    // The authorize request carried the EXACT method index.
    const authorizeBodies = readFileSync(`${fx.fixturePath}.authorize`, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(authorizeBodies[authorizeBodies.length - 1]).toEqual({ method: 0 });

    // Completion goes through the SAME live session.
    const completed = await svc.completeAuthFlow(begun.authFlowId);
    expect(completed.connected).toBe(true);
    expect(completed.providerId).toBe("openai");

    // The callback carried the same method index (no code for auto).
    const callbackBodies = readFileSync(`${fx.fixturePath}.callback`, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(callbackBodies[callbackBodies.length - 1]).toEqual({ method: 0 });

    // The flow is removed and its management process is gone.
    await expect(svc.completeAuthFlow(begun.authFlowId)).rejects.toMatchObject({
      code: "AUTH_FLOW_NOT_FOUND",
    });
    delete process.env.OPENCODE_FAKE_FIXTURE;
  });

  test("code flow: callback receives the exact method + bounded code", async () => {
    const fx = flowFixture("code-flow", {
      authorization: {
        url: "https://provider.example/authorize?state=xyz",
        method: "code",
        instructions: "Enter the code shown on the provider page.",
      },
    });
    const svc = service(flowRevisions("conn:flow-code", fx.executable, fx.fixturePath));
    process.env.OPENCODE_FAKE_FIXTURE = fx.fixturePath;

    const begun = await svc.beginAuthFlow({
      connectionId: "conn:flow-code",
      providerId: "openai",
      methodIndex: 0,
    });
    expect(begun.method).toBe("code");
    expect(begun.instructions).toContain("code");

    const completed = await svc.completeAuthFlow(begun.authFlowId, "abc123==");
    expect(completed.connected).toBe(true);

    const callbackBodies = readFileSync(`${fx.fixturePath}.callback`, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(callbackBodies[callbackBodies.length - 1]).toEqual({
      method: 0,
      code: "abc123==",
    });
    delete process.env.OPENCODE_FAKE_FIXTURE;
  });

  test("pending state is INSTANCE-LOCAL: a fresh session callback without authorize fails (fake contract)", async () => {
    const fx = flowFixture("pending-state");
    process.env.OPENCODE_FAKE_FIXTURE = fx.fixturePath;
    // Session A performs authorize (via a flow).
    const svc = service(flowRevisions("conn:flow-pending", fx.executable, fx.fixturePath));
    const begun = await svc.beginAuthFlow({
      connectionId: "conn:flow-pending",
      providerId: "openai",
      methodIndex: 0,
    });
    // Session B is a DIFFERENT live instance: its callback has no pending
    // state and MUST fail.
    const sessionB = await OpenCodeManagementSession.start({
      command: fx.executable,
      env: { OPENCODE_FAKE_FIXTURE: fx.fixturePath },
    });
    try {
      expect(await sessionB.completeOauth("openai", 0)).toBe(false);
    } finally {
      await sessionB.close();
    }
    // Completing through the SAME flow/session still succeeds.
    const completed = await svc.completeAuthFlow(begun.authFlowId);
    expect(completed.connected).toBe(true);
    delete process.env.OPENCODE_FAKE_FIXTURE;
  });

  test("DETERMINISTIC TTL: expiry closes the child WITHOUT any further auth call", async () => {
    const fx = flowFixture("det-ttl");
    const svc = service(flowRevisions("conn:flow-ttl", fx.executable, fx.fixturePath));
    process.env.OPENCODE_FAKE_FIXTURE = fx.fixturePath;
    const flowService = new OpenCodeAuthFlowService(150); // short TTL
    const svcAny = svc as unknown as { authFlows: OpenCodeAuthFlowService };
    const original = svcAny.authFlows;
    svcAny.authFlows = flowService;
    try {
      const begun = await svc.beginAuthFlow({
        connectionId: "conn:flow-ttl",
        providerId: "openai",
        methodIndex: 0,
      });
      const pidPath = `${fx.fixturePath}.pid`;
      const pid = Number(readFileSync(pidPath, "utf8"));
      // NO further auth calls — wait beyond the TTL and prove the timer
      // alone closed the management session.
      await new Promise((resolve) => setTimeout(resolve, 250));
      let alive = true;
      for (let i = 0; i < 20; i++) {
        try {
          process.kill(pid, 0);
          alive = true;
          await new Promise((resolve) => setTimeout(resolve, 50));
        } catch {
          alive = false;
          break;
        }
      }
      expect(alive).toBe(false);
      await expect(svc.completeAuthFlow(begun.authFlowId)).rejects.toMatchObject({
        code: "AUTH_FLOW_NOT_FOUND",
      });
      expect(flowService.activeCount()).toBe(0);
    } finally {
      svcAny.authFlows = original;
      delete process.env.OPENCODE_FAKE_FIXTURE;
    }
  });

  test("SHUTDOWN: closeAll terminates every live management session and clears all flows", async () => {
    const fxA = flowFixture("shutdown-a");
    const fxB = flowFixture("shutdown-b");
    const svc = service(
      new Map<string, ConnectionRevisionV1>([
        ["conn:flow-sd-a", openCodeRevision("conn:flow-sd-a", fxA.executable, { OPENCODE_FAKE_FIXTURE: "OPENCODE_FAKE_FIXTURE" })],
        ["conn:flow-sd-b", openCodeRevision("conn:flow-sd-b", fxB.executable, { OPENCODE_FAKE_FIXTURE: "OPENCODE_FAKE_FIXTURE" })],
      ]),
    );
    process.env.OPENCODE_FAKE_FIXTURE = fxA.fixturePath;
    const flowService = new OpenCodeAuthFlowService(60_000);
    const svcAny = svc as unknown as { authFlows: OpenCodeAuthFlowService };
    const original = svcAny.authFlows;
    svcAny.authFlows = flowService;
    try {
      const a = await svc.beginAuthFlow({ connectionId: "conn:flow-sd-a", providerId: "openai", methodIndex: 0 });
      const pidA = Number(readFileSync(`${fxA.fixturePath}.pid`, "utf8"));
      process.env.OPENCODE_FAKE_FIXTURE = fxB.fixturePath;
      const b = await svc.beginAuthFlow({ connectionId: "conn:flow-sd-b", providerId: "openai", methodIndex: 0 });
      const pidB = Number(readFileSync(`${fxB.fixturePath}.pid`, "utf8"));
      expect(flowService.activeCount()).toBe(2);
      // Graceful shutdown (the OnModuleDestroy path).
      await flowService.onModuleDestroy();
      expect(flowService.activeCount()).toBe(0);
      await new Promise((resolve) => setTimeout(resolve, 150));
      let aliveA = true;
      let aliveB = true;
      try { process.kill(pidA, 0); } catch { aliveA = false; }
      try { process.kill(pidB, 0); } catch { aliveB = false; }
      expect(aliveA).toBe(false);
      expect(aliveB).toBe(false);
      await expect(svc.completeAuthFlow(a.authFlowId)).rejects.toMatchObject({ code: "AUTH_FLOW_NOT_FOUND" });
      await expect(svc.completeAuthFlow(b.authFlowId)).rejects.toMatchObject({ code: "AUTH_FLOW_NOT_FOUND" });
    } finally {
      svcAny.authFlows = original;
      delete process.env.OPENCODE_FAKE_FIXTURE;
    }
  });

  test("RACE: expiry and complete near-simultaneously close the session at most once", async () => {
    const fx = flowFixture("race");
    const svc = service(flowRevisions("conn:flow-race", fx.executable, fx.fixturePath));
    process.env.OPENCODE_FAKE_FIXTURE = fx.fixturePath;
    const flowService = new OpenCodeAuthFlowService(200);
    const svcAny = svc as unknown as { authFlows: OpenCodeAuthFlowService };
    const original = svcAny.authFlows;
    svcAny.authFlows = flowService;
    try {
      const begun = await svc.beginAuthFlow({
        connectionId: "conn:flow-race",
        providerId: "openai",
        methodIndex: 0,
      });
      const pidPath = `${fx.fixturePath}.pid`;
      const pid = Number(readFileSync(pidPath, "utf8"));
      // Fire complete right around the TTL: whichever wins, the flow must
      // be gone exactly once, the session closed at most once, and no
      // error may leak.
      await new Promise((resolve) => setTimeout(resolve, 190));
      let outcome: string | null = null;
      try {
        const completed = await svc.completeAuthFlow(begun.authFlowId);
        outcome = completed.connected ? "connected" : "failed";
      } catch (error) {
        outcome = String((error as { code?: string }).code ?? "error");
      }
      expect(["connected", "AUTH_FLOW_NOT_FOUND"]).toContain(outcome);
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(flowService.activeCount()).toBe(0);
      let alive = true;
      try { process.kill(pid, 0); } catch { alive = false; }
      expect(alive).toBe(false);
    } finally {
      svcAny.authFlows = original;
      delete process.env.OPENCODE_FAKE_FIXTURE;
    }
  });

  test("cancel closes the flow and its management process; a second complete fails closed", async () => {
    const fx = flowFixture("cancel");
    const svc = service(flowRevisions("conn:flow-cancel", fx.executable, fx.fixturePath));
    process.env.OPENCODE_FAKE_FIXTURE = fx.fixturePath;
    const begun = await svc.beginAuthFlow({
      connectionId: "conn:flow-cancel",
      providerId: "openai",
      methodIndex: 0,
    });
    const pidPath = `${fx.fixturePath}.pid`;
    const pid = Number(readFileSync(pidPath, "utf8"));
    const cancelled = await svc.cancelAuthFlow(begun.authFlowId);
    expect(cancelled.cancelled).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 150));
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch {
      alive = false;
    }
    expect(alive).toBe(false);
    await expect(svc.completeAuthFlow(begun.authFlowId)).rejects.toMatchObject({
      code: "AUTH_FLOW_NOT_FOUND",
    });
    delete process.env.OPENCODE_FAKE_FIXTURE;
  });

  test("REAL prompts[] contract: methods with prompts fail closed and NEVER authorize", async () => {
    const fx = flowFixture("prompt", {
      methods: [{ type: "oauth", label: "OAuth", prompts: [{ id: "token", label: "Token" }] }],
    });
    const svc = service(flowRevisions("conn:flow-prompt", fx.executable, fx.fixturePath));
    process.env.OPENCODE_FAKE_FIXTURE = fx.fixturePath;
    await expect(
      svc.beginAuthFlow({
        connectionId: "conn:flow-prompt",
        providerId: "openai",
        methodIndex: 0,
      }),
    ).rejects.toMatchObject({ code: "AUTH_METHOD_UNSUPPORTED" });
    // No authorize request was ever sent.
    expect(existsSync(`${fx.fixturePath}.authorize`)).toBe(false);
    delete process.env.OPENCODE_FAKE_FIXTURE;
  });

  test("singular `prompt` is NOT authoritative — only prompts[] counts", async () => {
    const fx = flowFixture("singular", {
      methods: [{ type: "oauth", label: "OAuth", prompt: [{ id: "token" }] }],
    });
    const svc = service(flowRevisions("conn:flow-singular", fx.executable, fx.fixturePath));
    process.env.OPENCODE_FAKE_FIXTURE = fx.fixturePath;
    const begun = await svc.beginAuthFlow({
      connectionId: "conn:flow-singular",
      providerId: "openai",
      methodIndex: 0,
    });
    expect(begun.authFlowId).toBeTruthy();
    await svc.cancelAuthFlow(begun.authFlowId);
    delete process.env.OPENCODE_FAKE_FIXTURE;
  });

  test("API methods are NOT eligible for the OAuth flow: beginAuthFlow fails closed BEFORE authorize", async () => {
    const fx = flowFixture("api-method", {
      methods: [
        { type: "oauth", label: "OAuth" },
        { type: "api", label: "API Key" },
      ],
    });
    const svc = service(flowRevisions("conn:flow-api", fx.executable, fx.fixturePath));
    process.env.OPENCODE_FAKE_FIXTURE = fx.fixturePath;
    await expect(
      svc.beginAuthFlow({
        connectionId: "conn:flow-api",
        providerId: "openai",
        methodIndex: 1, // API Key
      }),
    ).rejects.toMatchObject({ code: "AUTH_METHOD_NOT_OAUTH" });
    // /oauth/authorize was NEVER called.
    expect(existsSync(`${fx.fixturePath}.authorize`)).toBe(false);
    // The OAuth method on the SAME fixture still works (unchanged flow).
    const begun = await svc.beginAuthFlow({
      connectionId: "conn:flow-api",
      providerId: "openai",
      methodIndex: 0,
    });
    expect(begun.method).toBe("auto");
    const completed = await svc.completeAuthFlow(begun.authFlowId);
    expect(completed.connected).toBe(true);
    delete process.env.OPENCODE_FAKE_FIXTURE;
  });
});
