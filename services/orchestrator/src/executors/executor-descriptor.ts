import { AgentAdapterError } from "../agent-adapters/agent-adapter.errors";
import type { AgentTransportConfiguration } from "../agent-adapters/agent-transport-config.service";
import { sha256Json } from "../domain/canonical-json";
import {
  parseConnectionReference,
  type ConnectionReferenceV1,
} from "./runtime-connection";

/**
 * M3: bounded, versioned, secret-free executor descriptor frozen on one step
 * attempt.
 *
 * The descriptor explains routing and capability evidence for one attempt:
 * executor kind/id, transport kind, the trusted configuration profile hash,
 * and conservative capability flags. It NEVER contains credential values —
 * the live trusted configuration resolves secrets for the exact pinned
 * profile at dispatch time. Descriptors are JSON-clean and explicitly
 * bounded; because they are secret-free by construction, any render of a
 * parsed descriptor is a safe (redacted) view.
 *
 * `configHash` is evidence of the non-secret profile the attempt was pinned
 * to (audit/explanation), not a runtime guard: routing facts are frozen
 * directly in `kind`/`httpProfile`, so a rotated live configuration cannot
 * silently reroute a pending dispatch.
 */
export const EXECUTOR_DESCRIPTOR_SCHEMA_VERSION = "1" as const;

export type ExecutorCapabilitiesV1 = {
  /** Tenvyr can request cancellation of an in-flight invocation. */
  cancel: boolean;
};

export type HttpExecutorProfileV1 = {
  submitUrl: string;
  requestTimeoutMs: number;
  maxResponseBytes: number;
};

/**
 * M8-S6: frozen secret-free LOCAL execution profile for CLI runtime
 * connections (codex/claude/opencode/generic-cli), captured at attempt
 * claim from the connection revision's fixed cli profile. Command, argv,
 * cwd, and environment are REFERENCES/operator configuration — never
 * secret values and never pipeline input. Dispatch/provenance consume
 * exactly this frozen data; a revised connection can never change what
 * an already-dispatched attempt was pinned to.
 */
export type LocalExecutorProfileV1 = {
  /** Absolute fixed executable path. */
  command: string;
  /** Fixed argv; no shell, no interpolation, no evaluation. */
  args: string[];
  /** Optional absolute working directory. */
  cwd?: string;
  /** Environment allowlist: child var name -> host env var name. */
  envAllowlist?: Record<string, string>;
  /** Secret references: child var name -> host env var name. */
  secrets?: Record<string, string>;
};

export type ExecutorDescriptorV1 = {
  schemaVersion: typeof EXECUTOR_DESCRIPTOR_SCHEMA_VERSION;
  /** Stable logical executor reference the pipeline selected. */
  executorId: string;
  /** Logical agent target; preserved for supervision and event correlation. */
  agent: string;
  /** Executor kind — one transport class per executor today. */
  kind: "kafka" | "http";
  /** SHA-256 (hex) of the canonical non-secret trusted configuration profile. */
  configHash: string;
  /** Conservative capability declarations; false unless proven. */
  capabilities: ExecutorCapabilitiesV1;
  /** M8-S2: frozen connection revision identity when the agent's routing
   *  selected a Runtime Connection at claim time; secret-free by
   *  construction. Absent for pre-M8 routing. */
  connection?: ConnectionReferenceV1;
  /** M8-S6: frozen CLI execution data when the selected connection is a
   *  CLI runtime (codex/claude/opencode/generic-cli); secret-free by
   *  construction (references only). Absent for worker/agent-only routing. */
  localProfile?: LocalExecutorProfileV1;
  /** Frozen HTTP routing profile; present iff kind === "http". */
  httpProfile?: HttpExecutorProfileV1;
};

const BOUNDS = {
  agentMaxLength: 255,
  executorIdMaxLength: 255,
  submitUrlMaxLength: 2048,
  configHashLength: 64,
} as const;

/** Bounds mirror the connection CLI profile bounds (runtime-connection.ts). */
export const LOCAL_PROFILE_BOUNDS = {
  commandMaxLength: 4096,
  argsMaxCount: 64,
  argMaxLength: 1024,
  envMaxEntries: 64,
} as const;

const HTTP_PROFILE_KEYS = ["submitUrl", "requestTimeoutMs", "maxResponseBytes"];
const LOCAL_PROFILE_KEYS = ["command", "args", "cwd", "envAllowlist", "secrets"];
const ENV_NAME_PATTERN = /^[A-Za-z0-9_]+$/;
const DESCRIPTOR_KEYS = [
  "schemaVersion",
  "executorId",
  "agent",
  "kind",
  "configHash",
  "capabilities",
  "connection",
  "localProfile",
  "httpProfile",
];

/**
 * Builds the frozen descriptor for an agent from the live trusted
 * configuration, mirroring the pre-M3 routing decision exactly (exact agent
 * name → HTTP, everything else → Kafka).
 */
export function buildExecutorDescriptor(
  agent: string,
  configuration: AgentTransportConfiguration,
): ExecutorDescriptorV1 {
  assertAgent(agent);
  if (configuration.kind === "http") {
    const httpProfile: HttpExecutorProfileV1 = {
      submitUrl: configuration.submitUrl,
      requestTimeoutMs: configuration.requestTimeoutMs,
      maxResponseBytes: configuration.maxResponseBytes,
    };
    return {
      schemaVersion: "1",
      executorId: `agent:${agent}`,
      agent,
      kind: "http",
      configHash: sha256Json({ kind: "http", httpProfile }),
      capabilities: { cancel: false },
      httpProfile,
    };
  }
  return {
    schemaVersion: "1",
    executorId: `agent:${agent}`,
    agent,
    kind: "kafka",
    configHash: sha256Json({ kind: "kafka" }),
    capabilities: { cancel: false },
  };
}

/**
 * Strict parse of a persisted descriptor (a trust boundary: the value comes
 * from durable jsonb evidence). Unknown keys, unknown schema versions, and
 * out-of-bounds fields are rejected — a snapshot claiming a capability or
 * shape this version does not define is never silently coerced.
 */
export function parseExecutorDescriptor(value: unknown): ExecutorDescriptorV1 {
  const snapshot = record(value, "ExecutorDescriptorV1");
  if (snapshot.schemaVersion !== "1") {
    throw descriptorInvalid(
      `Executor descriptor schemaVersion "${String(snapshot.schemaVersion)}" is not supported`,
    );
  }
  assertOnlyKeys(snapshot, DESCRIPTOR_KEYS, "Executor descriptor");

  const agent = boundedString(
    snapshot.agent,
    "agent",
    BOUNDS.agentMaxLength,
  );
  const executorId = boundedString(
    snapshot.executorId,
    "executorId",
    BOUNDS.executorIdMaxLength,
  );
  if (snapshot.kind !== "kafka" && snapshot.kind !== "http") {
    throw descriptorInvalid(`Executor descriptor kind "${String(snapshot.kind)}" is not supported`);
  }
  const kind = snapshot.kind;
  const configHash = boundedString(
    snapshot.configHash,
    "configHash",
    BOUNDS.configHashLength,
  );
  if (!/^[0-9a-f]{64}$/.test(configHash)) {
    throw descriptorInvalid("Executor descriptor configHash must be 64 lowercase hex characters");
  }
  const capabilities = record(snapshot.capabilities, "executor capabilities");
  assertOnlyKeys(capabilities, ["cancel"], "Executor capabilities");
  if (typeof capabilities.cancel !== "boolean") {
    throw descriptorInvalid("Executor capability cancel must be a boolean");
  }

  const descriptor: ExecutorDescriptorV1 = {
    schemaVersion: "1",
    executorId,
    agent,
    kind,
    configHash,
    capabilities: { cancel: capabilities.cancel },
  };
  if (snapshot.connection !== undefined) {
    descriptor.connection = parseConnectionReference(snapshot.connection);
  }
  if (snapshot.localProfile !== undefined) {
    descriptor.localProfile = parseLocalProfile(snapshot.localProfile);
  }
  if (kind === "http") {
    descriptor.httpProfile = parseHttpProfile(snapshot.httpProfile);
  } else if (snapshot.httpProfile !== undefined) {
    throw descriptorInvalid("Kafka executor descriptors must not carry an HTTP profile");
  }
  return descriptor;
}

/**
 * M8-S6: attaches the frozen secret-free local execution profile of a
 * claimed connection revision (CLI runtime kinds only). The frozen data
 * mirrors the revision's fixed cli profile exactly — command/argv/cwd and
 * environment REFERENCES, never values. Attempts without a cli profile
 * (worker transports) stay unchanged.
 */
export function attachLocalExecutorProfile(
  descriptor: ExecutorDescriptorV1,
  revision: import("./runtime-connection").ConnectionRevisionV1,
): ExecutorDescriptorV1 {
  const cli = revision.profile.cli;
  if (!cli) return descriptor;
  const localProfile: LocalExecutorProfileV1 = {
    command: cli.command,
    args: cli.args,
  };
  if (cli.cwd !== undefined) localProfile.cwd = cli.cwd;
  if (cli.envAllowlist && Object.keys(cli.envAllowlist).length > 0) {
    localProfile.envAllowlist = cli.envAllowlist;
  }
  if (cli.secrets && Object.keys(cli.secrets).length > 0) {
    localProfile.secrets = cli.secrets;
  }
  return { ...descriptor, localProfile };
}

/**
 * Strict parse of the frozen local execution profile (trust boundary:
 * the value comes from durable jsonb evidence). Only reference-shaped
 * fields are accepted — a snapshot can never smuggle a secret value in.
 */
export function parseLocalProfile(value: unknown): LocalExecutorProfileV1 {
  const profile = record(value, "Local executor profile");
  assertOnlyKeys(profile, LOCAL_PROFILE_KEYS, "Local executor profile");
  const command = boundedString(
    profile.command,
    "command",
    LOCAL_PROFILE_BOUNDS.commandMaxLength,
  );
  const args = parseLocalArgs(profile.args);
  const local: LocalExecutorProfileV1 = { command, args };
  if (profile.cwd !== undefined) {
    local.cwd = boundedString(profile.cwd, "cwd", LOCAL_PROFILE_BOUNDS.commandMaxLength);
  }
  if (profile.envAllowlist !== undefined) {
    local.envAllowlist = parseEnvReferenceMap(profile.envAllowlist, "envAllowlist");
  }
  if (profile.secrets !== undefined) {
    local.secrets = parseEnvReferenceMap(profile.secrets, "secrets");
  }
  return local;
}

function parseLocalArgs(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > LOCAL_PROFILE_BOUNDS.argsMaxCount) {
    throw descriptorInvalid(
      `Local executor profile args must be an array of at most ${LOCAL_PROFILE_BOUNDS.argsMaxCount} strings`,
    );
  }
  return value.map((arg, index) =>
    boundedString(arg, `args[${index}]`, LOCAL_PROFILE_BOUNDS.argMaxLength),
  );
}

function parseEnvReferenceMap(
  value: unknown,
  what: string,
): Record<string, string> {
  const map = record(value, `Local executor profile ${what}`);
  const entries = Object.entries(map);
  if (entries.length > LOCAL_PROFILE_BOUNDS.envMaxEntries) {
    throw descriptorInvalid(
      `Local executor profile ${what} exceeds ${LOCAL_PROFILE_BOUNDS.envMaxEntries} entries`,
    );
  }
  const result: Record<string, string> = {};
  for (const [child, envName] of entries) {
    if (!child || child.length > 255 || !ENV_NAME_PATTERN.test(child)) {
      throw descriptorInvalid(
        `Local executor profile ${what} contains an invalid child variable name: "${child}"`,
      );
    }
    if (
      typeof envName !== "string" ||
      !envName.trim() ||
      envName.length > 255 ||
      !ENV_NAME_PATTERN.test(envName)
    ) {
      throw descriptorInvalid(
        `Local executor profile ${what} value for "${child}" must match ${ENV_NAME_PATTERN}`,
      );
    }
    result[child] = envName;
  }
  return result;
}

/**
 * Compatibility reader for the attempt's frozen `executorSnapshot`.
 *
 * - `schemaVersion: "1"`: the value is a frozen M3 descriptor; parsed strictly
 *   and used as pinned (live configuration can never change its routing).
 * - legacy `{ agent }` (M0–M2 rows): routed from live trusted configuration at
 *   dispatch time, exactly the pre-M3 semantics. The descriptor produced here
 *   is ephemeral — the legacy row itself is never rewritten.
 * - an unknown schema version or any other shape is a deterministic
 *   non-retryable configuration failure, never an automatic fallback.
 */
export function readExecutorDescriptor(
  snapshot: unknown,
  liveConfig: (agent: string) => AgentTransportConfiguration,
): ExecutorDescriptorV1 {
  if (snapshot === null || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    throw snapshotInvalid("Executor snapshot must be an object");
  }
  const value = snapshot as Record<string, unknown>;
  if (value.schemaVersion === "1") return parseExecutorDescriptor(value);
  if (value.schemaVersion !== undefined) {
    throw snapshotInvalid(
      `Executor snapshot schemaVersion "${String(value.schemaVersion)}" is not supported`,
    );
  }
  if (typeof value.agent === "string" && value.agent.length > 0) {
    if (value.agent.length > BOUNDS.agentMaxLength) {
      throw snapshotInvalid(
        `Legacy executor snapshot agent exceeds the ${BOUNDS.agentMaxLength}-character bound`,
      );
    }
    return buildExecutorDescriptor(value.agent, liveConfig(value.agent));
  }
  throw snapshotInvalid(
    "Executor snapshot is neither a versioned descriptor nor a legacy { agent } record",
  );
}

function parseHttpProfile(value: unknown): HttpExecutorProfileV1 {
  const profile = record(value, "HTTP executor profile");
  assertOnlyKeys(profile, HTTP_PROFILE_KEYS, "HTTP executor profile");
  const submitUrl = boundedString(
    profile.submitUrl,
    "submitUrl",
    BOUNDS.submitUrlMaxLength,
  );
  let url: URL;
  try {
    url = new URL(submitUrl);
  } catch {
    throw descriptorInvalid("Executor HTTP profile submitUrl is not a valid URL");
  }
  if (url.username || url.password) {
    throw descriptorInvalid("Executor HTTP profile submitUrl must not contain credentials");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw descriptorInvalid("Executor HTTP profile submitUrl must use http or https");
  }
  const requestTimeoutMs = positiveInteger(profile.requestTimeoutMs, "requestTimeoutMs");
  const maxResponseBytes = positiveInteger(profile.maxResponseBytes, "maxResponseBytes");
  return { submitUrl, requestTimeoutMs, maxResponseBytes };
}

function assertAgent(agent: string): void {
  if (typeof agent !== "string" || !agent.trim() || agent.length > BOUNDS.agentMaxLength) {
    throw descriptorInvalid(
      `Executor agent must be a non-empty string of at most ${BOUNDS.agentMaxLength} characters`,
    );
  }
}

function boundedString(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength) {
    throw descriptorInvalid(
      `Executor descriptor ${field} must be a non-empty string of at most ${maxLength} characters`,
    );
  }
  return value;
}

function positiveInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw descriptorInvalid(`Executor descriptor ${field} must be a positive integer`);
  }
  return value;
}

function record(value: unknown, what: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw descriptorInvalid(`${what} must be an object`);
  }
  return value as Record<string, unknown>;
}

function assertOnlyKeys(
  value: Record<string, unknown>,
  allowed: string[],
  what: string,
): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw descriptorInvalid(`${what} contains an unsupported field "${unknown[0]}"`);
  }
}

function descriptorInvalid(message: string): AgentAdapterError {
  return new AgentAdapterError("EXECUTOR_DESCRIPTOR_INVALID", "executor", message, {
    retryable: false,
  });
}

function snapshotInvalid(message: string): AgentAdapterError {
  return new AgentAdapterError("EXECUTOR_SNAPSHOT_INVALID", "executor", message, {
    retryable: false,
  });
}
