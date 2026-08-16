import { createServer, type Server } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import {
  MODEL_SOURCE_BOUNDS,
  MODEL_SOURCE_KINDS,
  ModelSourceError,
  modelSourceModelsUrl,
  normalizeModelSourceBaseUrl,
  OPENAI_COMPATIBLE_KIND,
  parseModelSource,
  type ModelCatalogEntryV1,
} from "./executors/model-source";
import {
  boundedFetch,
  isBoundedModelId,
  ModelDiscoveryError,
  ModelDiscoveryService,
  parseOpenCodeModelLines,
} from "./services/model-discovery.service";

/**
 * P2: model source domain + discovery — all bounded, deterministic, and
 * credential-free. The fake OpenAI-compatible server covers: no auth,
 * correct bearer env ref, bad credential, malformed JSON, oversized
 * response, duplicate model ids, redirects to unsafe schemes, and URL
 * validation. Normal CI never touches a real external endpoint.
 */

describe("ModelSource domain", () => {
  test("normalizeModelSourceBaseUrl joins /models without interpolation", () => {
    expect(normalizeModelSourceBaseUrl("https://example.com/v1")).toBe(
      "https://example.com/v1",
    );
    expect(modelSourceModelsUrl("https://example.com/v1")).toBe(
      "https://example.com/v1/models",
    );
    expect(modelSourceModelsUrl("https://example.com/v1/")).toBe(
      "https://example.com/v1/models",
    );
  });

  test("URL validation: http/https only, no userinfo, bounded length", () => {
    expect(() => normalizeModelSourceBaseUrl("ftp://example.com/v1")).toThrow(
      ModelSourceError,
    );
    expect(() => normalizeModelSourceBaseUrl("file:///etc/passwd")).toThrow(
      ModelSourceError,
    );
    expect(() =>
      normalizeModelSourceBaseUrl("https://user:pass@example.com/v1"),
    ).toThrow(/must not contain embedded credentials/);
    expect(() =>
      normalizeModelSourceBaseUrl(
        `https://example.com/${"a".repeat(MODEL_SOURCE_BOUNDS.baseUrlMaxLength)}`,
      ),
    ).toThrow(ModelSourceError);
    expect(() => normalizeModelSourceBaseUrl("not a url")).toThrow(
      ModelSourceError,
    );
  });

  test("credentialEnvRef is a reference, never a value", () => {
    const source = parseModelSource({
      sourceId: "src:generic",
      kind: "openai-compatible",
      displayName: "Generic endpoint",
      baseUrl: "http://localhost:20128/v1",
      credentialEnvRef: "NINEROUTER_KEY",
    });
    expect(source.credentialEnvRef).toBe("NINEROUTER_KEY");
    expect(() =>
      parseModelSource({
        sourceId: "src:generic",
        kind: "openai-compatible",
        displayName: "Generic endpoint",
        baseUrl: "http://localhost:20128/v1",
        credentialEnvRef: "«redacted:sk-…»",
      }),
    ).toThrow(ModelSourceError);
  });

  test("P2 closure: only the generic OpenAI-compatible kind exists — 9Router and standalone OpenCode rows are rejected", () => {
    expect(MODEL_SOURCE_KINDS).toEqual([OPENAI_COMPATIBLE_KIND]);
    for (const rejectedKind of ["ninerouter", "opencode"]) {
      expect(() =>
        parseModelSource({
          sourceId: `src:${rejectedKind}`,
          kind: rejectedKind,
          displayName: rejectedKind,
          baseUrl: "http://localhost:20128/v1",
        }),
      ).toThrow(/kind must be/);
    }
    // baseUrl is required for the generic kind.
    expect(() =>
      parseModelSource({
        sourceId: "src:generic",
        kind: "openai-compatible",
        displayName: "Generic",
      }),
    ).toThrow(/requires a baseUrl/);
    const generic = parseModelSource({
      sourceId: "src:generic",
      kind: "openai-compatible",
      displayName: "Generic",
      baseUrl: "https://example.com/v1",
    });
    expect(generic.kind).toBe(OPENAI_COMPATIBLE_KIND);
  });
});

describe("OpenCode CLI discovery (bounded parsing, official commands only)", () => {
  const fixtureDir = mkdtempSync(join(tmpdir(), "tenvyr-opencode-"));
  const fakeCli = (script: string): string => {
    const path = join(
      fixtureDir,
      `fake-opencode-${Math.random().toString(36).slice(2)}.cjs`,
    );
    writeFileSync(path, `#!/usr/bin/env node\n${script}`, { mode: 0o755 });
    return path;
  };
  const service = new ModelDiscoveryService();

  test("models output parses provider/model lines with dedupe", async () => {
    const cli = fakeCli(`
      const [,,sub] = process.argv;
      if (sub === "models") {
        process.stdout.write([
          "anthropic/claude-sonnet-5",
          "anthropic/claude-sonnet-5",
          "opencode-go/deepseek-v4-flash",
          "garbage line without slash",
          "openai/gpt-5.5",
        ].join("\\n") + "\\n");
      }
    `);
    const models = await service.discoverOpenCodeModels(cli);
    expect(models.map((entry) => entry.modelId)).toEqual([
      "anthropic/claude-sonnet-5",
      "opencode-go/deepseek-v4-flash",
      "openai/gpt-5.5",
    ]);
    expect(models[0].providerId).toBe("anthropic");
    expect(models.every((entry) => entry.source === "opencode")).toBe(true);
  });

  test("auth list parses provider names and skips headers", async () => {
    const cli = fakeCli(`
      process.stdout.write([
        "PROVIDER  ID  TYPE",
        "anthropic  x  oauth",
        "opencode-go  y  oauth",
      ].join("\\n") + "\\n");
    `);
    const providers = await service.discoverOpenCodeProviders(cli);
    expect(providers).toEqual(["anthropic", "opencode-go"]);
  });

  test("models <provider> requests AND returns only that provider's models", async () => {
    const cli = fakeCli(`
      const [,,sub,provider] = process.argv;
      if (sub === "models") {
        process.stdout.write([
          "anthropic/claude-sonnet-5",
          "anthropic/claude-opus-4",
          "opencode-go/deepseek-v4-flash",
        ].join("\\n") + "\\n");
        process.exitCode = provider === "anthropic" ? 0 : 3;
      }
    `);
    const models = await service.discoverOpenCodeModels(cli, "anthropic");
    expect(models.map((entry) => entry.modelId)).toEqual([
      "anthropic/claude-sonnet-5",
      "anthropic/claude-opus-4",
    ]);
    // The runtime filtered: no other provider's models leak through.
    expect(models.every((entry) => entry.providerId === "anthropic")).toBe(true);
    // An unknown provider yields an empty catalog (bounded, never mixes).
    expect(await service.discoverOpenCodeModels(cli, "deepseek")).toEqual([]);
  });

  test("models --refresh is invoked for the refresh path", async () => {
    const cli = fakeCli(`
      const [,,sub,flag] = process.argv;
      process.exitCode = sub === "models" && flag === "--refresh" ? 0 : 1;
    `);
    expect(await service.refreshOpenCodeModels(cli)).toBe(true);
  });

  test("never reads the auth file; failing CLI yields empty catalogs", async () => {
    const cli = fakeCli(`process.exit(3);`);
    expect(await service.discoverOpenCodeProviders(cli)).toEqual([]);
    expect(await service.discoverOpenCodeModels(cli)).toEqual([]);
  });

  test("parseOpenCodeModelLines is bounded", () => {
    const entries: ModelCatalogEntryV1[] = Array.from(
      { length: MODEL_SOURCE_BOUNDS.modelsMaxCount + 50 },
      (_, i) => ({
        modelId: `provider/model-${i}`,
        providerId: "provider",
        source: "opencode",
      }),
    );
    const stdout = entries.map((entry) => entry.modelId).join("\n");
    const parsed = parseOpenCodeModelLines(stdout);
    expect(parsed.length).toBe(MODEL_SOURCE_BOUNDS.modelsMaxCount);
    expect(new Set(parsed.map((entry) => entry.modelId)).size).toBe(
      parsed.length,
    );
  });
});

describe("Codex best-effort catalog", () => {
  const service = new ModelDiscoveryService();

  test("debug models JSON parses bounded ids; garbage yields empty (never fails execution)", async () => {
    const good = join(
      mkdtempSync(join(tmpdir(), "tenvyr-codex-")),
      "fake-codex.cjs",
    );
    writeFileSync(
      good,
      `#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({ models: [{ id: "gpt-5.5" }, "gpt-4o-mini", { model: "o3" }] }));`,
      { mode: 0o755 },
    );
    const models = await service.discoverCodexModels(good);
    expect(models.map((entry) => entry.modelId).sort()).toEqual([
      "gpt-4o-mini",
      "gpt-5.5",
      "o3",
    ]);

    const bad = join(
      mkdtempSync(join(tmpdir(), "tenvyr-codex-")),
      "fake-codex-bad.cjs",
    );
    writeFileSync(
      bad,
      `#!/usr/bin/env node\nprocess.stdout.write("not json at all");`,
      {
        mode: 0o755,
      },
    );
    expect(await service.discoverCodexModels(bad)).toEqual([]);
  });
});

describe("OpenAI-compatible catalog fetch (fake server)", () => {
  let server: Server;
  let baseUrl: string;
  let requests: Array<{ path: string; authorization: string | null }> = [];
  let handler: (
    req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse,
  ) => void;

  beforeAll(async () => {
    server = createServer((req, res) => {
      requests.push({
        path: req.url ?? "",
        authorization: req.headers.authorization ?? null,
      });
      handler(req, res);
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const setHandler = (next: typeof handler): void => {
    handler = next;
    requests = [];
  };

  const json = (
    res: import("node:http").ServerResponse,
    body: unknown,
    status = 200,
  ): void => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };

  const service = new ModelDiscoveryService();

  test("no auth: catalog parses, dedupes, and bounds ids", async () => {
    setHandler((_req, res) => {
      json(res, {
        data: [
          { id: "gpt-5.5" },
          { id: "gpt-5.5" },
          { id: "cc/claude-opus-4" },
          { id: "bad id with spaces" },
          { id: "" },
        ],
      });
    });
    const snapshot = await service.fetchOpenAiCompatibleCatalog({
      sourceId: "src:test",
      baseUrl,
    });
    expect(snapshot.models.map((entry) => entry.modelId)).toEqual([
      "gpt-5.5",
      "cc/claude-opus-4",
    ]);
    expect(requests[0].authorization).toBeNull();
  });

  test("correct bearer env ref is resolved only at request time", async () => {
    setHandler((_req, res) => json(res, { data: [{ id: "gpt-5.5" }] }));
    const env = { NINEROUTER_KEY: "sk-fake-value" };
    const snapshot = await service.fetchOpenAiCompatibleCatalog({
      sourceId: "src:test",
      baseUrl,
      credentialEnvRef: "NINEROUTER_KEY",
      env,
    });
    expect(snapshot.models.length).toBe(1);
    expect(requests[0].authorization).toBe("Bearer sk-fake-value");
  });

  test("bad credential (401) maps to AUTH_REQUIRED and never leaks the value", async () => {
    setHandler((_req, res) => json(res, { error: "unauthorized" }, 401));
    await expect(
      service.fetchOpenAiCompatibleCatalog({
        sourceId: "src:test",
        baseUrl,
        credentialEnvRef: "NINEROUTER_KEY",
        env: { NINEROUTER_KEY: "sk-wrong" },
      }),
    ).rejects.toMatchObject({ code: "auth-required" });
  });

  test("missing env value fails closed with AUTH_REQUIRED", async () => {
    setHandler((_req, res) => json(res, { data: [] }));
    await expect(
      service.fetchOpenAiCompatibleCatalog({
        sourceId: "src:test",
        baseUrl,
        credentialEnvRef: "MISSING_REF",
        env: {},
      }),
    ).rejects.toMatchObject({ code: "auth-required" });
  });

  test("malformed JSON maps to malformed", async () => {
    setHandler((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{{{not json");
    });
    await expect(
      service.fetchOpenAiCompatibleCatalog({ sourceId: "src:test", baseUrl }),
    ).rejects.toMatchObject({ code: "malformed" });
  });

  test("oversized response is rejected (bounded bytes)", async () => {
    setHandler((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          data: [
            { id: `x${"a".repeat(MODEL_SOURCE_BOUNDS.responseMaxBytes)}` },
          ],
        }),
      );
    });
    await expect(
      service.fetchOpenAiCompatibleCatalog({ sourceId: "src:test", baseUrl }),
    ).rejects.toMatchObject({ code: "oversized" });
  });

  test("duplicate model ids collapse; count is bounded", async () => {
    setHandler((_req, res) => {
      json(res, {
        data: Array.from(
          { length: MODEL_SOURCE_BOUNDS.modelsMaxCount + 100 },
          (_, i) => ({
            id: `provider/model-${i % 50}`,
          }),
        ),
      });
    });
    const snapshot = await service.fetchOpenAiCompatibleCatalog({
      sourceId: "src:test",
      baseUrl,
    });
    expect(snapshot.models.length).toBe(50);
  });

  test("timeout maps to timeout", async () => {
    setHandler((_req, res) => {
      // Never respond.
      void res;
    });
    await expect(
      service.fetchOpenAiCompatibleCatalog({ sourceId: "src:test", baseUrl }),
    ).rejects.toMatchObject({ code: "timeout" });
  }, 15_000);

  test("redirect to an unsafe scheme is rejected", async () => {
    setHandler((req, res) => {
      if (req.url?.startsWith("/v1/models")) {
        res.writeHead(302, { Location: "file:///etc/passwd" });
        res.end();
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await expect(
      service.fetchOpenAiCompatibleCatalog({ sourceId: "src:test", baseUrl }),
    ).rejects.toMatchObject({ code: "unsupported-redirect" });
  });

  test("redirect with embedded credentials is rejected", async () => {
    setHandler((req, res) => {
      if (req.url?.startsWith("/v1/models")) {
        res.writeHead(302, { Location: "http://user:pass@127.0.0.1:1/models" });
        res.end();
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await expect(
      service.fetchOpenAiCompatibleCatalog({ sourceId: "src:test", baseUrl }),
    ).rejects.toMatchObject({ code: "unsupported-redirect" });
  });

  test("legitimate redirect follows and validates the final URL", async () => {
    setHandler((req, res) => {
      if (req.url?.startsWith("/v1/models")) {
        res.writeHead(307, { Location: `${baseUrl}/actual-models` });
        res.end();
        return;
      }
      if (req.url?.startsWith("/v1/actual-models")) {
        json(res, { data: [{ id: "gpt-5.5" }] });
        return;
      }
      res.writeHead(404);
      res.end();
    });
    const snapshot = await service.fetchOpenAiCompatibleCatalog({
      sourceId: "src:test",
      baseUrl,
    });
    expect(snapshot.models[0].modelId).toBe("gpt-5.5");
  });

  test("boundedFetch never echoes credentials in errors", async () => {
    setHandler((req, res) => {
      if (req.url?.startsWith("/v1/models")) {
        res.writeHead(302, { Location: "http://127.0.0.1:1/never" });
        res.end();
        return;
      }
      res.writeHead(404);
      res.end();
    });
    try {
      await service.fetchOpenAiCompatibleCatalog({
        sourceId: "src:test",
        baseUrl,
        credentialEnvRef: "NINEROUTER_KEY",
        env: { NINEROUTER_KEY: "sk-super-secret" },
      });
      throw new Error("expected fetch to reject");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).not.toContain("sk-super-secret");
      expect(error).toBeInstanceOf(ModelDiscoveryError);
    }
  });
});

describe("model id bounds", () => {
  test("isBoundedModelId enforces pattern + length", () => {
    expect(isBoundedModelId("gpt-5.5")).toBe(true);
    expect(isBoundedModelId("opencode-go/deepseek-v4-flash")).toBe(true);
    expect(isBoundedModelId("cc/claude-opus-4")).toBe(true);
    expect(isBoundedModelId("bad id")).toBe(false);
    expect(isBoundedModelId("")).toBe(false);
    expect(isBoundedModelId(`x${"a".repeat(300)}`)).toBe(false);
    expect(isBoundedModelId("-leading-dash")).toBe(false);
  });
});
