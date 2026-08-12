import * as fs from "node:fs";
import * as path from "node:path";

/**
 * M3-S3: trusted-code-only local process executor host configuration.
 *
 * The pipeline can only select an agent name; the HOST (not the pipeline)
 * resolves that agent to a FIXED preconfigured command. The command, argv,
 * working directory, environment allowlist, and secret references are all
 * operator-controlled deployment configuration — never pipeline input.
 *
 * Trust boundary: this executor is documented as trusted-code-only. There is
 * no sandbox; the host runs exactly the configured command with an explicit
 * environment. Secret VALUES never enter configuration or logs: they are
 * resolved from the host environment at spawn time via `secrets` references.
 */

export const HOST_CONFIG_BOUNDS = {
  argsMaxCount: 64,
  argMaxLength: 1024,
  envMaxEntries: 64,
  envNameMaxLength: 255,
  envValueMaxLength: 4096,
  commandMaxLength: 4096,
  wallTimeMsMax: 24 * 60 * 60 * 1000,
  ioByteMax: 16 * 1024 * 1024,
  portMax: 65535,
} as const;

export type HostAgentConfig = {
  agent: string;
  /** Absolute path to the fixed executable; never shell-interpreted. */
  command: string;
  /** Fixed argv array; no shell, no interpolation, no evaluation. */
  args: string[];
  /** Working directory; must resolve inside the allowlisted root. */
  cwd: string;
  /** Environment allowlist: child var name -> host env var name. */
  env: Record<string, string>;
  /** Secret references: child var name -> host env var name. Resolved at
   *  spawn; values never logged, persisted, or echoed. */
  secrets: Record<string, string>;
  /** Wall-time bound before the process group is escalated to SIGKILL. */
  wallTimeMs: number;
  maxStdoutBytes: number;
  maxStderrBytes: number;
  port: number;
  bearerTokenEnv: string;
};

export type HostConfig = {
  agents: HostAgentConfig[];
  /** Allowlisted working root; every agent cwd must resolve inside it. */
  allowedRoot: string;
  /** Directory for per-agent run state files (orphan policy). */
  stateDir: string;
  callbackAllowedOrigins: string[];
  callbackKeys: Record<string, string>;
  callbackAllowInsecure: boolean;
};

export function parseHostConfig(
  environment: NodeJS.ProcessEnv = process.env,
): HostConfig {
  const configuredRoot = requiredEnv(environment, "EXECUTOR_HOST_ALLOWED_ROOT");
  const allowedRoot = realDirectory(
    configuredRoot,
    "EXECUTOR_HOST_ALLOWED_ROOT",
  );
  const stateDir = requiredEnv(environment, "EXECUTOR_HOST_STATE_DIR");
  const allowedOriginsEnv = requiredEnv(
    environment,
    "EXECUTOR_HOST_CALLBACK_ALLOWED_ORIGINS",
  );
  const keysEnv = requiredEnv(environment, "EXECUTOR_HOST_CALLBACK_KEYS");
  const callbackKeys = parseCallbackKeys(keysEnv);
  const callbackAllowInsecure =
    environment.EXECUTOR_HOST_CALLBACK_ALLOW_INSECURE === "true";

  const raw = requiredEnv(environment, "EXECUTOR_HOST_AGENTS");
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw configurationError("EXECUTOR_HOST_AGENTS must be valid JSON");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw configurationError("EXECUTOR_HOST_AGENTS must be an object");
  }

  const agents: HostAgentConfig[] = [];
  for (const [agent, entry] of Object.entries(
    value as Record<string, unknown>,
  )) {
    if (!agent || agent.length > 255) {
      throw configurationError(
        "Every EXECUTOR_HOST_AGENTS key must be a non-empty agent name of at most 255 characters",
      );
    }
    // Agent names become state file names (`<agent>.json`) and log fields:
    // reject path separators and any character that could escape the state
    // directory or confuse log parsers.
    if (!/^[A-Za-z0-9_.-]+$/.test(agent)) {
      throw configurationError(
        `Agent name "${agent}" contains characters outside [A-Za-z0-9_.-]`,
      );
    }
    agents.push(
      parseAgentConfig(agent, entry, environment, allowedRoot, callbackKeys),
    );
  }
  if (agents.length === 0) {
    throw configurationError(
      "EXECUTOR_HOST_AGENTS must configure at least one agent",
    );
  }
  const ports = agents.map((agent) => agent.port);
  if (new Set(ports).size !== ports.length) {
    throw configurationError(
      "Every EXECUTOR_HOST_AGENTS entry must use a distinct port",
    );
  }
  return {
    agents,
    allowedRoot,
    stateDir: path.resolve(stateDir),
    callbackAllowedOrigins: allowedOriginsEnv
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
    callbackKeys,
    callbackAllowInsecure,
  };
}

function parseAgentConfig(
  agent: string,
  entry: unknown,
  environment: NodeJS.ProcessEnv,
  allowedRoot: string,
  callbackKeys: Record<string, string>,
): HostAgentConfig {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
    throw configurationError(
      `Agent "${agent}" configuration must be an object`,
    );
  }
  const value = entry as Record<string, unknown>;
  const command = boundedString(
    value.command,
    `Agent "${agent}" command`,
    HOST_CONFIG_BOUNDS.commandMaxLength,
  );
  if (!path.isAbsolute(command)) {
    throw configurationError(
      `Agent "${agent}" command must be an absolute path (never pipeline-supplied)`,
    );
  }
  if (!fs.existsSync(command)) {
    throw configurationError(
      `Agent "${agent}" command does not exist: ${command}`,
    );
  }
  const args = parseArgs(agent, value.args);
  const cwd = parseCwd(agent, value.cwd, allowedRoot);
  const env = parseEnvMap(agent, value.env, "env allowlist");
  const secrets = parseEnvMap(agent, value.secrets, "secret references");
  const wallTimeMs = boundedPositiveInteger(
    value.wallTimeMs,
    `Agent "${agent}" wallTimeMs`,
    HOST_CONFIG_BOUNDS.wallTimeMsMax,
  );
  const maxStdoutBytes = boundedPositiveInteger(
    value.maxStdoutBytes,
    `Agent "${agent}" maxStdoutBytes`,
    HOST_CONFIG_BOUNDS.ioByteMax,
  );
  const maxStderrBytes = boundedPositiveInteger(
    value.maxStderrBytes,
    `Agent "${agent}" maxStderrBytes`,
    HOST_CONFIG_BOUNDS.ioByteMax,
  );
  const port = boundedPositiveInteger(
    value.port,
    `Agent "${agent}" port`,
    HOST_CONFIG_BOUNDS.portMax,
  );
  const bearerTokenEnv = boundedString(
    value.bearerTokenEnv,
    `Agent "${agent}" bearerTokenEnv`,
    HOST_CONFIG_BOUNDS.envNameMaxLength,
  );
  if (!environment[bearerTokenEnv]) {
    throw configurationError(
      `Agent "${agent}" bearer token environment value is missing`,
    );
  }
  for (const secretEnvName of Object.values(secrets)) {
    if (!environment[secretEnvName]) {
      throw configurationError(
        `Agent "${agent}" secret reference environment value is missing: ${secretEnvName}`,
      );
    }
  }
  if (Object.keys(callbackKeys).length === 0) {
    throw configurationError(
      "EXECUTOR_HOST_CALLBACK_KEYS must contain at least one key",
    );
  }
  return {
    agent,
    command,
    args,
    cwd,
    env,
    secrets,
    wallTimeMs,
    maxStdoutBytes,
    maxStderrBytes,
    port,
    bearerTokenEnv,
  };
}

function parseArgs(agent: string, value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > HOST_CONFIG_BOUNDS.argsMaxCount) {
    throw configurationError(
      `Agent "${agent}" args must be an array of at most ${HOST_CONFIG_BOUNDS.argsMaxCount} strings`,
    );
  }
  return value.map((arg, index) =>
    boundedString(
      arg,
      `Agent "${agent}" args[${index}]`,
      HOST_CONFIG_BOUNDS.argMaxLength,
    ),
  );
}

function parseCwd(agent: string, value: unknown, allowedRoot: string): string {
  const raw = boundedString(
    value,
    `Agent "${agent}" cwd`,
    HOST_CONFIG_BOUNDS.commandMaxLength,
  );
  const resolved = path.isAbsolute(raw)
    ? path.resolve(raw)
    : path.resolve(allowedRoot, raw);
  const real = realDirectory(resolved, `Agent "${agent}" cwd`);
  const root = `${allowedRoot}${path.sep}`;
  if (real !== allowedRoot && !real.startsWith(root)) {
    throw configurationError(
      `Agent "${agent}" cwd resolves outside the allowlisted root: ${real}`,
    );
  }
  return real;
}

function realDirectory(value: string, field: string): string {
  let real: string;
  try {
    real = fs.realpathSync(path.resolve(value));
  } catch {
    throw configurationError(`${field} must be an existing directory`);
  }
  if (!fs.statSync(real).isDirectory()) {
    throw configurationError(`${field} must be an existing directory`);
  }
  return real;
}

function parseEnvMap(
  agent: string,
  value: unknown,
  what: string,
): Record<string, string> {
  if (value === undefined) return {};
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw configurationError(`Agent "${agent}" ${what} must be an object`);
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > HOST_CONFIG_BOUNDS.envMaxEntries) {
    throw configurationError(
      `Agent "${agent}" ${what} exceeds ${HOST_CONFIG_BOUNDS.envMaxEntries} entries`,
    );
  }
  const result: Record<string, string> = {};
  for (const [name, envName] of entries) {
    if (
      !name ||
      name.length > HOST_CONFIG_BOUNDS.envNameMaxLength ||
      /[^A-Za-z0-9_]/.test(name)
    ) {
      throw configurationError(
        `Agent "${agent}" ${what} contains an invalid child variable name: "${name}"`,
      );
    }
    result[name] = boundedString(
      envName,
      `Agent "${agent}" ${what} value for "${name}"`,
      HOST_CONFIG_BOUNDS.envNameMaxLength,
    );
  }
  return result;
}

function parseCallbackKeys(raw: string): Record<string, string> {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw configurationError("EXECUTOR_HOST_CALLBACK_KEYS must be valid JSON");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw configurationError("EXECUTOR_HOST_CALLBACK_KEYS must be an object");
  }
  const result: Record<string, string> = {};
  for (const [keyId, secret] of Object.entries(
    value as Record<string, unknown>,
  )) {
    if (!keyId || keyId.length > 255) {
      throw configurationError(
        "EXECUTOR_HOST_CALLBACK_KEYS key IDs must be 1-255 characters",
      );
    }
    if (typeof secret !== "string" || !secret) {
      throw configurationError(
        `EXECUTOR_HOST_CALLBACK_KEYS secret for "${keyId}" must be a non-empty string`,
      );
    }
    result[keyId] = secret;
  }
  return result;
}

function boundedString(
  value: unknown,
  field: string,
  maxLength: number,
): string {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength) {
    throw configurationError(
      `${field} must be a non-empty string of at most ${maxLength} characters`,
    );
  }
  return value;
}

function boundedPositiveInteger(
  value: unknown,
  field: string,
  max: number,
): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value <= 0 ||
    value > max
  ) {
    throw configurationError(
      `${field} must be an integer between 1 and ${max}`,
    );
  }
  return value;
}

function requiredEnv(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name];
  if (!value || !value.trim()) {
    throw configurationError(`${name} is required`);
  }
  return value;
}

function configurationError(message: string): Error {
  return new Error(`Local executor host configuration error: ${message}`);
}
