import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseHostConfig, type HostConfig } from "../src/config";

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
});
