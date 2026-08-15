import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseHostConfig, type HostConfig } from "../src/config";
import { validateInvocationBinding } from "../src/main";

const node = process.execPath;
const configuredRoot = "/tmp/tenvyr-host-root";

const baseEnv = (
  overrides: Record<string, string> = {},
): NodeJS.ProcessEnv => ({
  EXECUTOR_HOST_ALLOWED_ROOT: configuredRoot,
  EXECUTOR_HOST_STATE_DIR: "/tmp/tenvyr-host-state",
  EXECUTOR_HOST_CALLBACK_ALLOWED_ORIGINS: "https://orchestrator.example",
  EXECUTOR_HOST_CALLBACK_KEYS: JSON.stringify({ "host-v1": "callback-secret" }),
  EXECUTOR_HOST_AGENTS: JSON.stringify({
    echo: {
      command: node,
      args: ["-e", "console.log('ok')"],
      cwd: "/tmp/tenvyr-host-root",
      wallTimeMs: 30_000,
      maxStdoutBytes: 65_536,
      maxStderrBytes: 65_536,
      port: 4101,
      bearerTokenEnv: "HOST_TOKEN_1",
    },
  }),
  HOST_TOKEN_1: "host-token",
  ...overrides,
});

describe("parseHostConfig", () => {
  beforeAll(() => fs.mkdirSync(configuredRoot, { recursive: true }));

  it("parses a valid agent configuration", () => {
    const config = parseHostConfig(baseEnv());

    expect(config.agents).toHaveLength(1);
    expect(config.agents[0]).toMatchObject({
      agent: "echo",
      command: node,
      args: ["-e", "console.log('ok')"],
      cwd: fs.realpathSync(configuredRoot),
      wallTimeMs: 30_000,
      port: 4101,
    });
    expect(config.callbackKeys).toEqual({ "host-v1": "callback-secret" });
  });

  it("rejects non-absolute or missing commands (never pipeline-supplied paths)", () => {
    const env = baseEnv({
      EXECUTOR_HOST_AGENTS: JSON.stringify({
        echo: {
          command: "relative-command",
          cwd: "/tmp/tenvyr-host-root",
          wallTimeMs: 1000,
          maxStdoutBytes: 1024,
          maxStderrBytes: 1024,
          port: 4101,
          bearerTokenEnv: "HOST_TOKEN_1",
        },
      }),
    });
    expect(() => parseHostConfig(env)).toThrow(/must be an absolute path/);
  });

  it("rejects a cwd that escapes the allowlisted root (traversal)", () => {
    const env = baseEnv({
      EXECUTOR_HOST_AGENTS: JSON.stringify({
        echo: {
          command: node,
          cwd: "../../etc",
          wallTimeMs: 1000,
          maxStdoutBytes: 1024,
          maxStderrBytes: 1024,
          port: 4101,
          bearerTokenEnv: "HOST_TOKEN_1",
        },
      }),
    });
    expect(() => parseHostConfig(env)).toThrow(/outside the allowlisted root/);
  });

  it("rejects a cwd symlink that escapes the allowlisted root", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tenvyr-host-root-"));
    const outside = fs.mkdtempSync(
      path.join(os.tmpdir(), "tenvyr-host-outside-"),
    );
    fs.symlinkSync(outside, path.join(root, "escape"), "dir");
    const env = baseEnv({
      EXECUTOR_HOST_ALLOWED_ROOT: root,
      EXECUTOR_HOST_AGENTS: JSON.stringify({
        echo: {
          command: node,
          cwd: path.join(root, "escape"),
          wallTimeMs: 1000,
          maxStdoutBytes: 1024,
          maxStderrBytes: 1024,
          port: 4101,
          bearerTokenEnv: "HOST_TOKEN_1",
        },
      }),
    });
    expect(() => parseHostConfig(env)).toThrow(/outside the allowlisted root/);
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it("rejects hostile child variable names in the env allowlist", () => {
    const env = baseEnv({
      EXECUTOR_HOST_AGENTS: JSON.stringify({
        echo: {
          command: node,
          cwd: "/tmp/tenvyr-host-root",
          env: { "BAD;NAME": "SOME_ENV" },
          wallTimeMs: 1000,
          maxStdoutBytes: 1024,
          maxStderrBytes: 1024,
          port: 4101,
          bearerTokenEnv: "HOST_TOKEN_1",
        },
      }),
    });
    expect(() => parseHostConfig(env)).toThrow(/invalid child variable name/);
  });

  it("rejects oversized arg arrays and missing secret/bearer environments", () => {
    const bigArgs = baseEnv({
      EXECUTOR_HOST_AGENTS: JSON.stringify({
        echo: {
          command: node,
          args: Array.from({ length: 65 }, (_, i) => `a${i}`),
          cwd: "/tmp/tenvyr-host-root",
          wallTimeMs: 1000,
          maxStdoutBytes: 1024,
          maxStderrBytes: 1024,
          port: 4101,
          bearerTokenEnv: "HOST_TOKEN_1",
        },
      }),
    });
    expect(() => parseHostConfig(bigArgs)).toThrow(/at most 64/);

    const missingSecret = baseEnv({
      EXECUTOR_HOST_AGENTS: JSON.stringify({
        echo: {
          command: node,
          cwd: "/tmp/tenvyr-host-root",
          secrets: { TOKEN: "MISSING_SECRET_ENV" },
          wallTimeMs: 1000,
          maxStdoutBytes: 1024,
          maxStderrBytes: 1024,
          port: 4101,
          bearerTokenEnv: "HOST_TOKEN_1",
        },
      }),
    });
    expect(() => parseHostConfig(missingSecret)).toThrow(
      /secret reference environment value is missing/,
    );

    const missingBearer = baseEnv({ HOST_TOKEN_1: "" });
    expect(() => parseHostConfig(missingBearer)).toThrow(
      /bearer token environment/,
    );
  });

  it("rejects duplicate ports and empty agent maps", () => {
    const twoAgents = baseEnv({
      EXECUTOR_HOST_AGENTS: JSON.stringify({
        a: {
          command: node,
          cwd: "/tmp/tenvyr-host-root",
          wallTimeMs: 1000,
          maxStdoutBytes: 1024,
          maxStderrBytes: 1024,
          port: 4101,
          bearerTokenEnv: "HOST_TOKEN_1",
        },
        b: {
          command: node,
          cwd: "/tmp/tenvyr-host-root",
          wallTimeMs: 1000,
          maxStdoutBytes: 1024,
          maxStderrBytes: 1024,
          port: 4101,
          bearerTokenEnv: "HOST_TOKEN_1",
        },
      }),
    });
    expect(() => parseHostConfig(twoAgents)).toThrow(/distinct port/);
    expect(() =>
      parseHostConfig(baseEnv({ EXECUTOR_HOST_AGENTS: "{}" })),
    ).toThrow(/at least one agent/);
  });

  it("rejects agent names that could escape the state directory", () => {
    const env = baseEnv({
      EXECUTOR_HOST_AGENTS: JSON.stringify({
        "../escape": {
          command: node,
          cwd: "/tmp/tenvyr-host-root",
          wallTimeMs: 1000,
          maxStdoutBytes: 1024,
          maxStderrBytes: 1024,
          port: 4101,
          bearerTokenEnv: "HOST_TOKEN_1",
        },
      }),
    });
    expect(() => parseHostConfig(env)).toThrow(/outside \[A-Za-z0-9_.-\]/);
  });

  it("rejects callback keys that are not an object and non-http(s) origins are operator choice", () => {
    const badKeys = baseEnv({ EXECUTOR_HOST_CALLBACK_KEYS: "not-json" });
    expect(() => parseHostConfig(badKeys)).toThrow(/must be valid JSON/);
  });

  it("is stable across repeated parses of the same trusted configuration", () => {
    const first = parseHostConfig(baseEnv());
    const second = parseHostConfig(baseEnv());
    expect(first.agents).toEqual(second.agents);
    expect(first.callbackKeys).toEqual(second.callbackKeys);
  });

  it("M8-S6: parses the connection binding pair (connectionId + configHash) and structuredResult", () => {
    const config = parseHostConfig(
      baseEnv({
        EXECUTOR_HOST_AGENTS: JSON.stringify({
          bound: {
            command: node,
            args: ["-e", "console.log('ok')"],
            cwd: "/tmp/tenvyr-host-root",
            wallTimeMs: 30_000,
            maxStdoutBytes: 65_536,
            maxStderrBytes: 65_536,
            port: 4102,
            bearerTokenEnv: "HOST_TOKEN_1",
            connectionId: "conn:codex-local",
            configHash: "abc123",
            structuredResult: true,
          },
        }),
      }),
    );
    expect(config.agents[0]).toMatchObject({
      connectionId: "conn:codex-local",
      configHash: "abc123",
      structuredResult: true,
    });
  });

  it("M8-S6: rejects a binding declared on only one side (fail-closed configuration)", () => {
    expect(() =>
      parseHostConfig(
        baseEnv({
          EXECUTOR_HOST_AGENTS: JSON.stringify({
            half: {
              command: node,
              args: ["-e", "console.log('ok')"],
              cwd: "/tmp/tenvyr-host-root",
              wallTimeMs: 30_000,
              maxStdoutBytes: 65_536,
              maxStderrBytes: 65_536,
              port: 4103,
              bearerTokenEnv: "HOST_TOKEN_1",
              connectionId: "conn:codex-local",
            },
          }),
        }),
      ),
    ).toThrow(/connectionId and configHash together/);
    expect(() =>
      parseHostConfig(
        baseEnv({
          EXECUTOR_HOST_AGENTS: JSON.stringify({
            half: {
              command: node,
              args: ["-e", "console.log('ok')"],
              cwd: "/tmp/tenvyr-host-root",
              wallTimeMs: 30_000,
              maxStdoutBytes: 65_536,
              maxStderrBytes: 65_536,
              port: 4104,
              bearerTokenEnv: "HOST_TOKEN_1",
              configHash: "abc123",
            },
          }),
        }),
      ),
    ).toThrow(/connectionId and configHash together/);
  });

  it("M8-S6: rejects a non-boolean structuredResult", () => {
    expect(() =>
      parseHostConfig(
        baseEnv({
          EXECUTOR_HOST_AGENTS: JSON.stringify({
            bad: {
              command: node,
              args: ["-e", "console.log('ok')"],
              cwd: "/tmp/tenvyr-host-root",
              wallTimeMs: 30_000,
              maxStdoutBytes: 65_536,
              maxStderrBytes: 65_536,
              port: 4105,
              bearerTokenEnv: "HOST_TOKEN_1",
              structuredResult: "yes",
            },
          }),
        }),
      ),
    ).toThrow(/structuredResult must be a boolean/);
  });
});

describe("validateInvocationBinding", () => {
  const bound: HostConfig["agents"][number] = {
    agent: "bound-agent",
    command: "/bin/true",
    args: [],
    cwd: "/tmp/tenvyr-host-root",
    env: {},
    secrets: {},
    wallTimeMs: 30_000,
    maxStdoutBytes: 65_536,
    maxStderrBytes: 65_536,
    port: 4106,
    bearerTokenEnv: "HOST_TOKEN_1",
    connectionId: "conn:codex-local",
    configHash: "abc123",
    structuredResult: true,
  };
  const legacy: HostConfig["agents"][number] = {
    agent: "legacy-agent",
    command: "/bin/true",
    args: [],
    cwd: "/tmp/tenvyr-host-root",
    env: {},
    secrets: {},
    wallTimeMs: 30_000,
    maxStdoutBytes: 65_536,
    maxStderrBytes: 65_536,
    port: 4107,
    bearerTokenEnv: "HOST_TOKEN_1",
  };
  const reference = {
    connectionId: "conn:codex-local",
    revisionNumber: 1,
    configHash: "abc123",
  };

  it("accepts an invocation carrying the exact bound reference", () => {
    expect(
      validateInvocationBinding(bound, {
        invocationId: "i-1",
        connection: reference,
      }),
    ).toBeNull();
  });

  it("fails closed when the invocation carries NO reference for a bound agent", () => {
    expect(validateInvocationBinding(bound, { invocationId: "i-2" })).toMatch(
      /no connection reference/,
    );
  });

  it("fails closed on connectionId mismatch and on configHash mismatch (revision not authoritative)", () => {
    expect(
      validateInvocationBinding(bound, {
        invocationId: "i-3",
        connection: { ...reference, connectionId: "conn:other" },
      }),
    ).toMatch(/bound to "conn:codex-local"/);
    expect(
      validateInvocationBinding(bound, {
        invocationId: "i-4",
        connection: { ...reference, configHash: "stale-hash" },
      }),
    ).toMatch(/configured for hash "abc123"/);
  });

  it("fails closed when an unbound agent receives a connection-bearing invocation", () => {
    expect(
      validateInvocationBinding(legacy, {
        invocationId: "i-5",
        connection: reference,
      }),
    ).toMatch(/declares no connection binding/);
  });

  it("accepts connection-free invocations for unbound agents (legacy path)", () => {
    expect(
      validateInvocationBinding(legacy, { invocationId: "i-6" }),
    ).toBeNull();
  });

  // P2: requested model binding — fixed modelArgvPrefix is operator
  // configuration; a model request without it (or an invalid model id)
  // fails closed BEFORE spawn.

  it("accepts a bounded requested model when the agent declares modelArgvPrefix", () => {
    const withModel = { ...bound, modelArgvPrefix: ["--model"] };
    expect(
      validateInvocationBinding(withModel, {
        invocationId: "i-7",
        connection: reference,
        requestedModelId: "gpt-5.5",
      }),
    ).toBeNull();
    expect(
      validateInvocationBinding(withModel, {
        invocationId: "i-8",
        connection: reference,
        requestedModelId: "opencode-go/deepseek-v4-flash",
      }),
    ).toBeNull();
  });

  it("fails closed when a model is requested but the agent declares no modelArgvPrefix", () => {
    expect(
      validateInvocationBinding(bound, {
        invocationId: "i-9",
        connection: reference,
        requestedModelId: "gpt-5.5",
      }),
    ).toMatch(/declares no modelArgvPrefix/);
  });

  it("fails closed on invalid model ids (hostile data never reaches argv)", () => {
    const withModel = { ...bound, modelArgvPrefix: ["--model"] };
    for (const bad of [
      "gpt 5.5",
      "",
      `x${"a".repeat(300)}`,
      "-leading",
      "a;rm -rf /",
    ]) {
      expect(
        validateInvocationBinding(withModel, {
          invocationId: "i-10",
          connection: reference,
          requestedModelId: bad,
        }),
      ).toMatch(/invalid model id/);
    }
  });
});
