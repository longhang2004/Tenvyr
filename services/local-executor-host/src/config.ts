import * as fs from "node:fs";
import * as os from "node:os";
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
  /**
   * M8-S6: the immutable Runtime Connection revision this agent is bound to
   * serve. Declared together with `configHash` (the revision's frozen
   * config hash). Every invocation MUST carry a matching connection
   * reference; anything else fails closed BEFORE spawn. Absent binding =
   * connection-free legacy agent (an invocation that DOES carry a
   * connection reference is refused).
   */
  connectionId?: string;
  configHash?: string;
  runtimeKind?: string;
  /**
   * M8-S6: when true and the child exits 0, stdout is parsed as one JSON
   * document and becomes the structured result output. A parse failure is a
   * deterministic EXECUTOR_HOST_INVALID_STRUCTURED_RESULT failure.
   */
  structuredResult?: boolean;
  /**
   * P2: fixed argv elements inserted before the invocation's requested
   * model id (e.g. ["--model"]), composing
   * `[...args, ...modelArgvPrefix, modelId]`. The prefix is FIXED operator
   * configuration — the model id is the only variable part, appended as a
   * separate argv element (never concatenated, never shell-interpreted).
   * Absent = the agent never composes a model argument (an invocation that
   * carries a requestedModelId is REFUSED — fail closed).
   */
  modelArgvPrefix?: string[];
  /**
   * PP1: when true, EVERY invocation for this agent MUST carry the reserved
   * Tenvyr execution-workspace member (`metadata.tenvyr.executionWorkspace`)
   * and its path must resolve inside the allowlisted root; an invocation
   * without it is REFUSED before spawn (fail closed). When false (default),
   * a present member is still validated and used as the spawn cwd, and an
   * absent member falls back to the static `cwd` (backward compatible).
   */
  requireExecutionWorkspace?: boolean;
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
  port?: number;
  bearerTokenEnv?: string;
  dynamicBridge?: boolean;
};

export function parseHostConfig(
  environment: NodeJS.ProcessEnv = process.env,
): HostConfig {
  const configuredRoot =
    environment.EXECUTOR_HOST_ALLOWED_ROOT ||
    environment.TENVYR_WORKSPACE_ROOT ||
    os.tmpdir();
  const allowedRoot = realDirectory(
    configuredRoot,
    "EXECUTOR_HOST_ALLOWED_ROOT",
  );
  const rawStateDir =
    environment.EXECUTOR_HOST_STATE_DIR ||
    path.join(os.tmpdir(), "tenvyr-host-state");
  const stateDir = path.resolve(rawStateDir);
  try {
    fs.mkdirSync(stateDir, { recursive: true });
  } catch {
    // Ignore if already exists
  }

  const allowedOriginsEnv =
    environment.EXECUTOR_HOST_CALLBACK_ALLOWED_ORIGINS ||
    "http://127.0.0.1:3001,http://localhost:3001,http://127.0.0.1:3000,http://localhost:3000";
  const callbackKeys = environment.EXECUTOR_HOST_CALLBACK_KEYS
    ? parseCallbackKeys(environment.EXECUTOR_HOST_CALLBACK_KEYS)
    : environment.HTTP_AGENT_CALLBACK_SECRET || environment.LOOPBACK_CALLBACK_SECRET
      ? {
          "host-callback-v1":
            environment.HTTP_AGENT_CALLBACK_SECRET ??
            environment.LOOPBACK_CALLBACK_SECRET ??
            "",
          "host-loopback-v1":
            environment.LOOPBACK_CALLBACK_SECRET ??
            environment.HTTP_AGENT_CALLBACK_SECRET ??
            "",
        }
      : {};
  const callbackAllowInsecure =
    environment.EXECUTOR_HOST_CALLBACK_ALLOW_INSECURE === "true";

  const port = Number(environment.EXECUTOR_HOST_PORT || 3002);
  const bearerTokenEnv =
    environment.EXECUTOR_HOST_BEARER_TOKEN_ENV || "EXECUTOR_HOST_BEARER_TOKEN";
  if (!environment[bearerTokenEnv] && environment.HTTP_AGENT_BEARER_TOKEN) {
    environment[bearerTokenEnv] = environment.HTTP_AGENT_BEARER_TOKEN;
  }

  const raw = environment.EXECUTOR_HOST_AGENTS;
  if (!raw || !raw.trim()) {
    if (!environment[bearerTokenEnv]) {
      throw configurationError(
        `Bearer token environment value is missing (${bearerTokenEnv} or HTTP_AGENT_BEARER_TOKEN)`,
      );
    }
    if (Object.keys(callbackKeys).length === 0) {
      throw configurationError(
        "Callback authentication keys are required (EXECUTOR_HOST_CALLBACK_KEYS or HTTP_AGENT_CALLBACK_SECRET)",
      );
    }
    return {
      agents: [],
      allowedRoot,
      stateDir,
      callbackAllowedOrigins: allowedOriginsEnv
        .split(",")
        .map((origin) => origin.trim())
        .filter(Boolean),
      callbackKeys,
      callbackAllowInsecure,
      port,
      bearerTokenEnv,
      dynamicBridge: true,
    };
  }

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
    stateDir,
    callbackAllowedOrigins: allowedOriginsEnv
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
    callbackKeys,
    callbackAllowInsecure,
    port,
    bearerTokenEnv,
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
  // M8-S6: the connection binding is declared as a pair — never one side.
  const connectionId =
    value.connectionId === undefined
      ? undefined
      : boundedString(
          value.connectionId,
          `Agent "${agent}" connectionId`,
          HOST_CONFIG_BOUNDS.commandMaxLength,
        );
  const configHash =
    value.configHash === undefined
      ? undefined
      : boundedString(
          value.configHash,
          `Agent "${agent}" configHash`,
          HOST_CONFIG_BOUNDS.commandMaxLength,
        );
  if ((connectionId === undefined) !== (configHash === undefined)) {
    throw configurationError(
      `Agent "${agent}" must declare connectionId and configHash together (M8-S6 binding)`,
    );
  }
  let structuredResult: boolean | undefined;
  if (value.structuredResult !== undefined) {
    if (typeof value.structuredResult !== "boolean") {
      throw configurationError(
        `Agent "${agent}" structuredResult must be a boolean`,
      );
    }
    structuredResult = value.structuredResult;
  }
  let requireExecutionWorkspace: boolean | undefined;
  if (value.requireExecutionWorkspace !== undefined) {
    if (typeof value.requireExecutionWorkspace !== "boolean") {
      throw configurationError(
        `Agent "${agent}" requireExecutionWorkspace must be a boolean`,
      );
    }
    requireExecutionWorkspace = value.requireExecutionWorkspace;
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
    ...(connectionId !== undefined ? { connectionId } : {}),
    ...(configHash !== undefined ? { configHash } : {}),
    ...(structuredResult !== undefined ? { structuredResult } : {}),
    ...(value.modelArgvPrefix !== undefined
      ? { modelArgvPrefix: parseArgs(agent, value.modelArgvPrefix) }
      : {}),
    ...(requireExecutionWorkspace !== undefined
      ? { requireExecutionWorkspace }
      : {}),
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

export const EXECUTION_WORKSPACE_MEMBER_BOUNDS = {
  workspaceExecutionIdMax: 255,
  pathMax: 4096,
  sourceWorkspaceIdMax: 255,
  headShaShape: /^[0-9a-f]{40}$/,
} as const;

function assertOnlyKeys(
  value: Record<string, unknown>,
  allowed: string[],
  what: string,
): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw configurationError(`${what} contains an unsupported field "${unknown[0]}"`);
  }
}

/**
 * PP1: strict parse of the RESERVED Tenvyr-owned execution-workspace member
 * (`invocation.metadata.tenvyr.executionWorkspace`). Unknown keys, unknown
 * versions, and unbounded shapes are rejected — an invocation can never
 * smuggle an unvalidated execution path. Absent member → null.
 */
export function parseExecutionWorkspaceMember(
  value: unknown,
): {
  workspaceExecutionId: string;
  path: string;
  mode: string;
  sourceWorkspaceId: string;
  baseHeadSha: string | null;
} | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw configurationError(
      "metadata.tenvyr.executionWorkspace must be an object",
    );
  }
  const source = value as Record<string, unknown>;
  assertOnlyKeys(
    source,
    ["schemaVersion", "workspaceExecutionId", "path", "mode", "sourceWorkspaceId", "baseHeadSha"],
    "executionWorkspace",
  );
  if (source.schemaVersion !== 1) {
    throw configurationError(
      `executionWorkspace schemaVersion "${String(source.schemaVersion)}" is not supported`,
    );
  }
  const workspaceExecutionId = boundedString(
    source.workspaceExecutionId,
    "executionWorkspace.workspaceExecutionId",
    EXECUTION_WORKSPACE_MEMBER_BOUNDS.workspaceExecutionIdMax,
  );
  const memberPath = boundedString(
    source.path,
    "executionWorkspace.path",
    EXECUTION_WORKSPACE_MEMBER_BOUNDS.pathMax,
  );
  const mode = source.mode;
  if (mode !== "shared" && mode !== "git-worktree") {
    throw configurationError(
      `executionWorkspace mode "${String(mode)}" is not supported`,
    );
  }
  const sourceWorkspaceId = boundedString(
    source.sourceWorkspaceId,
    "executionWorkspace.sourceWorkspaceId",
    EXECUTION_WORKSPACE_MEMBER_BOUNDS.sourceWorkspaceIdMax,
  );
  let baseHeadSha: string | null = null;
  if (source.baseHeadSha !== null && source.baseHeadSha !== undefined) {
    baseHeadSha = boundedString(
      source.baseHeadSha,
      "executionWorkspace.baseHeadSha",
      40,
    );
    if (!EXECUTION_WORKSPACE_MEMBER_BOUNDS.headShaShape.test(baseHeadSha)) {
      throw configurationError(
        "executionWorkspace.baseHeadSha must be 40 lowercase hex characters or null",
      );
    }
  }
  return {
    workspaceExecutionId,
    path: memberPath,
    mode,
    sourceWorkspaceId,
    baseHeadSha,
  };
}

/** Extract the reserved member from invocation metadata (absent → null;
 *  malformed → throws so the host fails closed BEFORE spawn). */
export function executionWorkspaceFromInvocation(
  invocation: {
    metadata?: unknown;
  },
): ReturnType<typeof parseExecutionWorkspaceMember> {
  const metadata = invocation.metadata;
  if (metadata === null || metadata === undefined) return null;
  if (typeof metadata !== "object" || Array.isArray(metadata)) {
    throw configurationError("invocation metadata must be an object");
  }
  const tenvyr = (metadata as Record<string, unknown>).tenvyr;
  if (tenvyr === undefined) return null;
  if (typeof tenvyr !== "object" || Array.isArray(tenvyr)) {
    throw configurationError("invocation metadata.tenvyr must be an object");
  }
  return parseExecutionWorkspaceMember(
    (tenvyr as Record<string, unknown>).executionWorkspace,
  );
}

export class ExecutionWorkspacePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExecutionWorkspacePathError";
  }
}

/**
 * PP1 — Pivot Invariant 1: resolve the runtime child's working directory
 * from Tenvyr authority.
 *
 * - When the invocation carries the reserved execution-workspace member,
 *   its path MUST be absolute, MUST exist as a directory, and its REAL path
 *   MUST resolve inside the allowlisted root (no traversal, no symlink
 *   escape). The spawn uses the resolved real path, so a symlink swapped
 *   after validation cannot redirect the spawn.
 * - A member is NEVER required to be "the same as the operator config
 *   cwd": it is the authoritative execution path for the run.
 * - Absent member → the static operator-configured `cwd`, UNLESS the agent
 *   declares `requireExecutionWorkspace` (fail closed — an agent bound to
 *   Tenvyr workspace execution refuses workspace-less invocations).
 */
export function resolveExecutionCwd(
  profile: HostAgentConfig,
  invocation: { metadata?: unknown; invocationId?: unknown },
  allowedRoot: string,
  authorizedRoots: string[] = [],
): string {
  const member = executionWorkspaceFromInvocation(invocation);
  const label = `Invocation ${String(invocation.invocationId ?? "<unknown>")}`;
  if (member === null) {
    if (profile.requireExecutionWorkspace) {
      throw new ExecutionWorkspacePathError(
        `${label} carries no Tenvyr execution workspace but agent "${profile.agent}" requires one — refusing to run (fail closed)`,
      );
    }
    return profile.cwd;
  }
  if (!path.isAbsolute(member.path)) {
    throw new ExecutionWorkspacePathError(
      `${label} execution workspace path "${member.path}" is not absolute — refusing to run (fail closed)`,
    );
  }
  const resolved = path.resolve(member.path);
  const real = realDirectoryOrNull(resolved);
  if (real === null) {
    throw new ExecutionWorkspacePathError(
      `${label} execution workspace path "${resolved}" does not resolve to an existing directory — refusing to run (fail closed)`,
    );
  }
  // parseHostConfig already realpaths the allowed root, but canonicalize it
  // here too so containment can never be fooled by a symlinked root.
  const rootsToCheck = [allowedRoot, ...authorizedRoots];
  const isAuthorized = rootsToCheck.some((candidateRoot) => {
    const canonical = realDirectoryOrNull(candidateRoot) ?? candidateRoot;
    const root = `${canonical}${path.sep}`;
    return real === canonical || real.startsWith(root);
  });

  if (!isAuthorized) {
    const canonicalRoot = realDirectoryOrNull(allowedRoot) ?? allowedRoot;
    throw new ExecutionWorkspacePathError(
      `${label} execution workspace path "${real}" resolves outside the allowlisted root "${canonicalRoot}" — refusing to run (fail closed)`,
    );
  }
  return real;
}

function realDirectoryOrNull(value: string): string | null {
  let real: string;
  try {
    real = fs.realpathSync(path.resolve(value));
  } catch {
    return null;
  }
  try {
    if (!fs.statSync(real).isDirectory()) return null;
  } catch {
    return null;
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
