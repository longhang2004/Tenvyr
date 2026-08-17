import { AgentAdapterError } from "../agent-adapters/agent-adapter.errors";
import { sha256Json } from "../domain/canonical-json";

/**
 * M8-S1: durable, immutable, secret-free Runtime Connection domain.
 *
 * A Runtime Connection is operator-owned configuration selecting an executor
 * and a runtime profile plus credential references and declared/detected
 * capabilities. A Connection Revision is the immutable, secret-free
 * configuration identity: a new edit creates a new revision, and attempts
 * never point at mutable latest state.
 *
 * Boundary: this module is pure domain + validation. It defines no provider
 * routing, no fallback, no auth import, and no raw secret storage — credential
 * fields are references (`env` names resolved at the trusted executor
 * boundary), and every render of a revision/status is a safe redacted view.
 * Provider/account ownership stays inside the runtime.
 *
 * Slice scope (M8 GOAL slice 1): immutable connection/revision/capability/
 * status domain plus pure validation. Persistence, claim resolution, CLI
 * composition, and runtime profiles arrive in later slices.
 */

export const RUNTIME_CONNECTION_SCHEMA_VERSION = "1" as const;

export const RUNTIME_KINDS = [
  "codex",
  "claude",
  "opencode",
  "generic-cli",
  "http-worker",
  "kafka-worker",
] as const;
export type RuntimeKind = (typeof RUNTIME_KINDS)[number];

export const CAPABILITY_SOURCES = ["configured", "detected", "verified"] as const;
export type CapabilitySource = (typeof CAPABILITY_SOURCES)[number];

/**
 * Conservative capability vocabulary (SPEC). Missing/unknown means
 * unsupported; detection never widens authority beyond configuration.
 */
export const RUNTIME_CAPABILITY_KEYS = [
  "invocation",
  "structuredResult",
  "progressEvents",
  "heartbeat",
  "cancellation",
  "artifacts",
  "observedDelegation",
  "supervisedDelegation",
  "plannerOutput",
  "verifierDecision",
  "toolActionInterception",
  "localProcessTermination",
] as const;
export type RuntimeCapabilityKey = (typeof RUNTIME_CAPABILITY_KEYS)[number];

export type RuntimeCapability = {
  supported: boolean;
  source: CapabilitySource;
  /** Runtime/tool version the claim refers to; omitted when unknown. */
  version?: string;
};

export type ConnectionCapabilities = Partial<
  Record<RuntimeCapabilityKey, RuntimeCapability>
>;

/** Secret-free credential reference; resolved only at the trusted executor
 *  boundary (mirrors the local host's `secrets` env-reference model). */
export type CredentialReference = { kind: "env"; name: string };

/**
 * M8-S3: fixed CLI execution/probe profile for CLI-based runtime kinds
 * (generic-cli today; codex/claude/opencode in slice 4). The command is an
 * absolute path and argv is fixed operator configuration — never pipeline
 * input, never shell-interpreted. `secrets` are env references resolved only
 * at spawn time; values never enter the profile, revision, or receipts.
 */
export type CliProbeConfigV1 = {
  /** Fixed probe argv (e.g. ["--version"]); never shell-interpreted. */
  args: string[];
  /** Probe wall-clock bound before group SIGTERM/SIGKILL escalation. */
  wallTimeMs?: number;
  /** Per-stream byte bound for probe stdout/stderr capture. */
  maxOutputBytes?: number;
  /** Operator-declared exit codes that mean "auth required". Explicit
   *  mapping only — the probe never infers auth from output. */
  authExitCodes?: number[];
  /** Documented "exit 0 when authenticated" semantics: any non-zero exit
   *  is auth-required. Explicit mapping only, never output inference. */
  authAnyNonZero?: boolean;
  /** True when the probe's first stdout line IS the runtime version.
   *  False (default) means stdout is never parsed — auth-status probes
   *  must not leak output into the tested version. */
  expectsVersion?: boolean;
};

export type CliProfileV1 = {
  /** Absolute path to the fixed executable. */
  command: string;
  /** Fixed run argv; no shell, no interpolation, no evaluation. */
  args: string[];
  /** Fixed argv prefix inserted before a requested model id (e.g. ["--model"]). */
  modelArgvPrefix?: string[];
  /** Optional working directory (absolute). */
  cwd?: string;
  /** Probe environment allowlist: child var name -> host env var name. */
  envAllowlist?: Record<string, string>;
  /** Probe secret references: child var name -> host env var name.
   *  Resolved at spawn time; values never persisted or echoed. */
  secrets?: Record<string, string>;
  probe: CliProbeConfigV1;
  /** Optional second probe for documented auth-status commands. Runs after
   *  the primary probe; its failure (per its own exit mapping) overrides
   *  the outcome as auth-required. Never parses auth output. */
  authProbe?: CliProbeConfigV1;
};

export type ConnectionProfileV1 = {
  name: string;
  runtimeKind: RuntimeKind;
  executorId: string;
  /** Operator-pinned runtime version expectation; omitted when unknown. */
  version?: string;
  /** Secret-free references; empty when the runtime owns its own auth. */
  credentialRefs: CredentialReference[];
  /** Operator-declared conservative capability claims. */
  declaredCapabilities: ConnectionCapabilities;
  /** M8-S3: fixed CLI profile; required for generic-cli, forbidden for
   *  worker transports, allowed for CLI-based runtime kinds. */
  cli?: CliProfileV1;
};

export type ConnectionRevisionV1 = {
  schemaVersion: typeof RUNTIME_CONNECTION_SCHEMA_VERSION;
  connectionId: string;
  revisionNumber: number;
  createdAt: string;
  profile: ConnectionProfileV1;
  /** SHA-256 (hex) of the canonical secret-free profile. */
  configHash: string;
  /** Conservative capabilities resolved at freeze time; never re-resolved. */
  capabilities: ConnectionCapabilities;
};

export const CONNECTION_STATUS_STATES = [
  "DRAFT",
  "AVAILABLE",
  "AUTH_REQUIRED",
  "UNAVAILABLE",
  "DEGRADED",
  "REVOKED",
] as const;
export type ConnectionStatusState = (typeof CONNECTION_STATUS_STATES)[number];

export const STATUS_REASON_CODES = [
  "none",
  "missing-executable",
  "unsupported-version",
  "auth-required",
  "timeout",
  "malformed-output",
  "capability-mismatch",
  "command-failed",
  "revoked",
] as const;
export type StatusReasonCode = (typeof STATUS_REASON_CODES)[number];

/**
 * Bounded status projection from explicit probes. It is not dispatch
 * authority by itself and structurally cannot carry secrets, command output,
 * tokens, prompts, or provider responses.
 */
export type ConnectionStatus = {
  state: ConnectionStatusState;
  reasonCode: StatusReasonCode;
  testedAt?: string;
  testedVersion?: string;
};

export type StatusTestEvent = {
  type: "test";
  outcome: "ok" | "authRequired" | "failed" | "degraded";
  reasonCode: StatusReasonCode;
  testedAt: string;
  testedVersion?: string;
};

export type StatusRevokeEvent = { type: "revoke" };

export type ConnectionStatusEvent = StatusTestEvent | StatusRevokeEvent;

export const CONNECTION_BOUNDS = {
  nameMaxLength: 255,
  idMaxLength: 255,
  executorIdMaxLength: 255,
  versionMaxLength: 128,
  credentialRefMaxCount: 16,
  envNameMaxLength: 255,
  createdAtMaxLength: 40,
} as const;

/** CLI profile bounds (mirror the local executor host's config bounds). */
export const CLI_BOUNDS = {
  commandMaxLength: 4096,
  argsMaxCount: 64,
  argMaxLength: 1024,
  envMaxEntries: 64,
  probeWallTimeMsDefault: 10_000,
  probeWallTimeMsMax: 60_000,
  probeOutputBytesDefault: 64 * 1024,
  probeOutputBytesMax: 1024 * 1024,
  probeAuthExitCodeMaxCount: 8,
} as const;

const CLI_KEYS = ["command", "args", "modelArgvPrefix", "cwd", "envAllowlist", "secrets", "probe", "authProbe"];
const CLI_PROBE_KEYS = [
  "args",
  "wallTimeMs",
  "maxOutputBytes",
  "authExitCodes",
  "authAnyNonZero",
  "expectsVersion",
];
const CLI_RUNTIME_KINDS = ["generic-cli", "codex", "claude", "opencode"];

/** Version identifiers only: semver-ish tokens, no whitespace or shell
 *  metacharacters. Version strings are metadata that may reach logs/status. */
const VERSION_PATTERN = /^[A-Za-z0-9._+\-]+$/;

const PROFILE_KEYS = [
  "name",
  "runtimeKind",
  "executorId",
  "version",
  "credentialRefs",
  "declaredCapabilities",
  "cli",
];

const REVISION_KEYS = [
  "schemaVersion",
  "connectionId",
  "revisionNumber",
  "createdAt",
  "profile",
  "configHash",
  "capabilities",
];

const STATUS_KEYS = ["state", "reasonCode", "testedAt", "testedVersion"];

export const CONNECTION_ID_PATTERN = /^[A-Za-z0-9_.:-]+$/;
const ENV_NAME_PATTERN = /^[A-Za-z0-9_]+$/;

/**
 * Secret-free frozen identity of ONE connection revision, embedded in the
 * attempt's executor snapshot (M8-S2). It pins connection ID, revision
 * number, runtime kind/version, the canonical config hash, and the
 * conservative capabilities resolved at claim time — never secret values.
 * Dispatch/redelivery and Capsule provenance consume exactly this reference.
 */
export type ConnectionReferenceV1 = {
  schemaVersion: typeof RUNTIME_CONNECTION_SCHEMA_VERSION;
  connectionId: string;
  revisionNumber: number;
  runtimeKind: RuntimeKind;
  version?: string;
  configHash: string;
  capabilities: ConnectionCapabilities;
};

const REFERENCE_KEYS = [
  "schemaVersion",
  "connectionId",
  "revisionNumber",
  "runtimeKind",
  "version",
  "configHash",
  "capabilities",
];

/** Freezes the secret-free connection reference for one revision. */
export function buildConnectionReference(
  revision: ConnectionRevisionV1,
): ConnectionReferenceV1 {
  const reference: ConnectionReferenceV1 = {
    schemaVersion: RUNTIME_CONNECTION_SCHEMA_VERSION,
    connectionId: revision.connectionId,
    revisionNumber: revision.revisionNumber,
    runtimeKind: revision.profile.runtimeKind,
    configHash: revision.configHash,
    capabilities: revision.capabilities,
  };
  if (revision.profile.version !== undefined) {
    reference.version = revision.profile.version;
  }
  return deepFreeze(reference);
}

/**
 * Strict parse of a persisted connection reference (trust boundary). A
 * reference may never claim a revision number/identity it does not carry
 * verbatim; unknown fields and out-of-bounds values are rejected.
 */
export function parseConnectionReference(value: unknown): ConnectionReferenceV1 {
  const snapshot = record(value, "ConnectionReferenceV1", connectionInvalid);
  if (snapshot.schemaVersion !== RUNTIME_CONNECTION_SCHEMA_VERSION) {
    throw connectionInvalid(
      `Connection reference schemaVersion "${String(snapshot.schemaVersion)}" is not supported`,
    );
  }
  assertOnlyKeys(snapshot, REFERENCE_KEYS, "Connection reference", connectionInvalid);
  const reference: ConnectionReferenceV1 = {
    schemaVersion: RUNTIME_CONNECTION_SCHEMA_VERSION,
    connectionId: validateConnectionId(snapshot.connectionId),
    revisionNumber: revisionNumberOrInvalid(snapshot.revisionNumber, connectionInvalid),
    runtimeKind: snapshot.runtimeKind as RuntimeKind,
    configHash: boundedString(snapshot.configHash, "configHash", 64),
    capabilities: parseCapabilities(snapshot.capabilities, "capabilities"),
  };
  if (!RUNTIME_KINDS.includes(reference.runtimeKind)) {
    throw connectionInvalid(
      `Connection reference runtimeKind "${String(snapshot.runtimeKind)}" is not supported`,
    );
  }
  if (!/^[0-9a-f]{64}$/.test(reference.configHash)) {
    throw connectionInvalid("Connection reference configHash must be 64 lowercase hex characters");
  }
  if (snapshot.version !== undefined) {
    reference.version = versionString(snapshot.version, "version", connectionInvalid);
  }
  return deepFreeze(reference);
}

const SOURCE_ORDER: Record<CapabilitySource, number> = {
  configured: 0,
  detected: 1,
  verified: 2,
};

/**
 * Conservative capability resolution: detection may only downgrade or
 * confirm, never widen. A capability is supported only when the operator
 * declared it supported AND detection (when present) also reports it.
 * Missing keys stay missing (unsupported by omission).
 */
export function resolveCapabilities(
  declared: ConnectionCapabilities,
  detected?: ConnectionCapabilities,
): ConnectionCapabilities {
  const resolved: ConnectionCapabilities = {};
  for (const key of RUNTIME_CAPABILITY_KEYS) {
    const claim = declared[key];
    if (!claim || !claim.supported) continue;
    const probe = detected?.[key];
    if (probe && !probe.supported) {
      resolved[key] = {
        supported: false,
        source: "detected",
        ...(probe.version ? { version: probe.version } : {}),
      };
      continue;
    }
    const source: CapabilitySource =
      probe && SOURCE_ORDER[probe.source] > SOURCE_ORDER[claim.source]
        ? probe.source
        : claim.source;
    resolved[key] = {
      supported: true,
      source,
      ...(probe?.version ?? claim.version ? { version: probe?.version ?? claim.version } : {}),
    };
  }
  return resolved;
}

/**
 * Freezes one immutable connection revision. `createdAt` is caller-supplied
 * for deterministic tests. The result is deeply frozen: a revision can never
 * be mutated after freeze; persistence (slice 2) enforces the same property
 * durably.
 */
export function freezeConnectionRevision(input: {
  connectionId: string;
  revisionNumber: number;
  createdAt: string;
  profile: ConnectionProfileV1;
}): ConnectionRevisionV1 {
  const connectionId = validateConnectionId(input.connectionId);
  const revisionNumber = validateRevisionNumber(input.revisionNumber);
  const createdAt = validateCreatedAt(input.createdAt);
  const profile = parseConnectionProfile(input.profile);
  const configHash = connectionConfigHash(profile);
  const revision: ConnectionRevisionV1 = {
    schemaVersion: RUNTIME_CONNECTION_SCHEMA_VERSION,
    connectionId,
    revisionNumber,
    createdAt,
    profile,
    configHash,
    capabilities: resolveCapabilities(profile.declaredCapabilities),
  };
  return deepFreeze(revision);
}

/** Canonical secret-free profile hash (stable, idempotent). */
export function connectionConfigHash(profile: ConnectionProfileV1): string {
  return sha256Json(profile);
}

/**
 * Strict parse of a connection profile (trust boundary: values may come from
 * operator configuration or durable jsonb evidence). Unknown keys, unknown
 * runtime kinds, out-of-bounds fields, and any non-reference credential
 * shape are rejected — a snapshot can never smuggle a secret value into the
 * profile.
 */
export function parseConnectionProfile(value: unknown): ConnectionProfileV1 {
  const snapshot = record(value, "ConnectionProfileV1", connectionInvalid);
  assertOnlyKeys(snapshot, PROFILE_KEYS, "Connection profile", connectionInvalid);

  const name = boundedString(snapshot.name, "name", CONNECTION_BOUNDS.nameMaxLength);
  if (!RUNTIME_KINDS.includes(snapshot.runtimeKind as RuntimeKind)) {
    throw connectionInvalid(
      `Connection profile runtimeKind "${String(snapshot.runtimeKind)}" is not supported`,
    );
  }
  const runtimeKind = snapshot.runtimeKind as RuntimeKind;
  const executorId = boundedString(
    snapshot.executorId,
    "executorId",
    CONNECTION_BOUNDS.executorIdMaxLength,
  );
  const version = optionalBoundedString(snapshot.version, "version");
  const credentialRefs = parseCredentialRefs(snapshot.credentialRefs);
  const declaredCapabilities = parseCapabilities(
    snapshot.declaredCapabilities,
    "declaredCapabilities",
  );

  const profile: ConnectionProfileV1 = {
    name,
    runtimeKind,
    executorId,
    credentialRefs,
    declaredCapabilities,
  };
  if (version !== undefined) profile.version = version;
  if (snapshot.cli !== undefined) {
    // parseCliProfile rejects cli for non-CLI runtime kinds.
    profile.cli = parseCliProfile(snapshot.cli, runtimeKind);
  } else if (runtimeKind === "generic-cli") {
    throw connectionInvalid(
      "Connection profile runtimeKind generic-cli requires a fixed cli profile",
    );
  }
  return profile;
}

/**
 * Strict parse of the fixed CLI profile (trust boundary). The command must
 * be an absolute path (never pipeline-supplied), argv is a bounded fixed
 * array, and env/secret entries are references, never values.
 */
function parseCliProfile(value: unknown, runtimeKind: RuntimeKind): CliProfileV1 {
  const snapshot = record(value, "CliProfileV1", connectionInvalid);
  assertOnlyKeys(snapshot, CLI_KEYS, "CLI profile", connectionInvalid);
  const command = boundedString(
    snapshot.command,
    "cli command",
    CLI_BOUNDS.commandMaxLength,
  );
  if (!pathIsAbsolute(command)) {
    throw connectionInvalid("cli command must be an absolute path (never pipeline-supplied)");
  }
  if (command.includes("\u0000")) {
    throw connectionInvalid("cli command must not contain NUL bytes");
  }
  const args = parseFixedArgs(snapshot.args, "cli args");
  if (!CLI_RUNTIME_KINDS.includes(runtimeKind)) {
    throw connectionInvalid(
      `cli profile is not supported for runtimeKind ${runtimeKind}`,
    );
  }
  const cli: CliProfileV1 = { command, args, probe: parseCliProbe(snapshot.probe) };
  if (snapshot.modelArgvPrefix !== undefined) {
    cli.modelArgvPrefix = parseFixedArgs(snapshot.modelArgvPrefix, "cli modelArgvPrefix");
  }
  if (snapshot.cwd !== undefined) {
    const cwd = boundedString(snapshot.cwd, "cli cwd", CLI_BOUNDS.commandMaxLength);
    if (!pathIsAbsolute(cwd)) {
      throw connectionInvalid("cli cwd must be an absolute path");
    }
    cli.cwd = cwd;
  }
  if (snapshot.envAllowlist !== undefined) {
    cli.envAllowlist = parseEnvReferenceMap(snapshot.envAllowlist, "cli envAllowlist");
  }
  if (snapshot.secrets !== undefined) {
    cli.secrets = parseEnvReferenceMap(snapshot.secrets, "cli secrets");
  }
  if (snapshot.authProbe !== undefined) {
    cli.authProbe = parseCliProbe(snapshot.authProbe);
  }
  return cli;
}

function parseCliProbe(value: unknown): CliProbeConfigV1 {
  const snapshot = record(value, "CliProbeConfigV1", connectionInvalid);
  assertOnlyKeys(snapshot, CLI_PROBE_KEYS, "CLI probe", connectionInvalid);
  const probe: CliProbeConfigV1 = {
    args: parseFixedArgs(snapshot.args, "cli probe args"),
  };
  if (snapshot.wallTimeMs !== undefined) {
    probe.wallTimeMs = boundedInteger(
      snapshot.wallTimeMs,
      "cli probe wallTimeMs",
      CLI_BOUNDS.probeWallTimeMsMax,
      connectionInvalid,
    );
  }
  if (snapshot.maxOutputBytes !== undefined) {
    probe.maxOutputBytes = boundedInteger(
      snapshot.maxOutputBytes,
      "cli probe maxOutputBytes",
      CLI_BOUNDS.probeOutputBytesMax,
      connectionInvalid,
    );
  }
  if (snapshot.authExitCodes !== undefined) {
    if (
      !Array.isArray(snapshot.authExitCodes) ||
      snapshot.authExitCodes.length === 0 ||
      snapshot.authExitCodes.length > CLI_BOUNDS.probeAuthExitCodeMaxCount
    ) {
      throw connectionInvalid(
        `cli probe authExitCodes must be an array of 1-${CLI_BOUNDS.probeAuthExitCodeMaxCount} integers`,
      );
    }
    const codes = snapshot.authExitCodes.map((code, index) =>
      boundedInteger(code, `cli probe authExitCodes[${index}]`, 255, connectionInvalid),
    );
    if (new Set(codes).size !== codes.length) {
      throw connectionInvalid("cli probe authExitCodes must be unique");
    }
    probe.authExitCodes = codes;
  }
  if (snapshot.authAnyNonZero !== undefined) {
    if (typeof snapshot.authAnyNonZero !== "boolean") {
      throw connectionInvalid("cli probe authAnyNonZero must be a boolean");
    }
    probe.authAnyNonZero = snapshot.authAnyNonZero;
  }
  if (snapshot.expectsVersion !== undefined) {
    if (typeof snapshot.expectsVersion !== "boolean") {
      throw connectionInvalid("cli probe expectsVersion must be a boolean");
    }
    probe.expectsVersion = snapshot.expectsVersion;
  }
  return probe;
}

function parseFixedArgs(value: unknown, what: string): string[] {
  if (!Array.isArray(value) || value.length > CLI_BOUNDS.argsMaxCount) {
    throw connectionInvalid(
      `${what} must be an array of at most ${CLI_BOUNDS.argsMaxCount} strings`,
    );
  }
  return value.map((arg, index) =>
    boundedString(arg, `${what}[${index}]`, CLI_BOUNDS.argMaxLength),
  );
}

function parseEnvReferenceMap(value: unknown, what: string): Record<string, string> {
  const snapshot = record(value, what, connectionInvalid);
  const entries = Object.entries(snapshot);
  if (entries.length > CLI_BOUNDS.envMaxEntries) {
    throw connectionInvalid(`${what} exceeds ${CLI_BOUNDS.envMaxEntries} entries`);
  }
  const result: Record<string, string> = {};
  for (const [child, envName] of entries) {
    if (!child || child.length > CONNECTION_BOUNDS.envNameMaxLength || !ENV_NAME_PATTERN.test(child)) {
      throw connectionInvalid(`${what} contains an invalid child variable name: "${child}"`);
    }
    result[child] = boundedString(
      envName,
      `${what} value for "${child}"`,
      CONNECTION_BOUNDS.envNameMaxLength,
    );
    if (!ENV_NAME_PATTERN.test(result[child])) {
      throw connectionInvalid(`${what} value for "${child}" must match ${ENV_NAME_PATTERN}`);
    }
  }
  return result;
}

function boundedInteger(
  value: unknown,
  field: string,
  max: number,
  invalid: (message: string) => AgentAdapterError,
): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0 || value > max) {
    throw invalid(`${field} must be an integer between 1 and ${max}`);
  }
  return value;
}

function pathIsAbsolute(value: string): boolean {
  return value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value);
}

/**
 * Strict parse of a persisted revision. Beyond field validation it enforces
 * the capability-spoofing guard: a revision may never claim a capability the
 * frozen profile did not declare (detection can only downgrade). The
 * `configHash` must match the embedded profile, proving the revision is a
 * coherent freeze rather than an assembled row.
 */
export function parseConnectionRevision(value: unknown): ConnectionRevisionV1 {
  const snapshot = record(value, "ConnectionRevisionV1", revisionInvalid);
  if (snapshot.schemaVersion !== RUNTIME_CONNECTION_SCHEMA_VERSION) {
    throw revisionInvalid(
      `Connection revision schemaVersion "${String(snapshot.schemaVersion)}" is not supported`,
    );
  }
  assertOnlyKeys(snapshot, REVISION_KEYS, "Connection revision", revisionInvalid);

  const connectionId = validateConnectionId(snapshot.connectionId);
  const revisionNumber = validateRevisionNumber(snapshot.revisionNumber);
  const createdAt = validateCreatedAt(snapshot.createdAt);
  const profile = parseConnectionProfile(snapshot.profile);
  const configHash = boundedString(snapshot.configHash, "configHash", 64);
  if (!/^[0-9a-f]{64}$/.test(configHash)) {
    throw revisionInvalid("Connection revision configHash must be 64 lowercase hex characters");
  }
  if (configHash !== connectionConfigHash(profile)) {
    throw revisionInvalid("Connection revision configHash does not match its frozen profile");
  }
  const capabilities = parseCapabilities(snapshot.capabilities, "capabilities");
  for (const key of RUNTIME_CAPABILITY_KEYS) {
    const claim = capabilities[key];
    if (claim?.supported && !profile.declaredCapabilities[key]?.supported) {
      throw revisionInvalid(
        `Connection revision capability "${key}" claims support the frozen profile never declared`,
      );
    }
  }

  const revision: ConnectionRevisionV1 = {
    schemaVersion: RUNTIME_CONNECTION_SCHEMA_VERSION,
    connectionId,
    revisionNumber,
    createdAt,
    profile,
    configHash,
    capabilities,
  };
  return deepFreeze(revision);
}

/**
 * Bounded status projection. REVOKED is terminal; a test result can move any
 * other state, and revocation is idempotent. The projection carries only
 * bounded reason codes and timestamps — never output or secrets.
 */
export function applyStatusTransition(
  status: ConnectionStatus,
  event: ConnectionStatusEvent,
): ConnectionStatus {
  if (status.state === "REVOKED") return deepFreeze({ ...status });
  if (event.type === "revoke") {
    return deepFreeze({ state: "REVOKED", reasonCode: "revoked" });
  }
  const state: ConnectionStatusState =
    event.outcome === "ok"
      ? "AVAILABLE"
      : event.outcome === "authRequired"
        ? "AUTH_REQUIRED"
        : event.outcome === "degraded"
          ? "DEGRADED"
          : "UNAVAILABLE";
  const next: ConnectionStatus = {
    state,
    reasonCode: event.reasonCode,
    testedAt: event.testedAt,
  };
  if (event.testedVersion !== undefined) next.testedVersion = event.testedVersion;
  return deepFreeze(next);
}

/** Strict parse of a persisted status projection (trust boundary). */
export function parseConnectionStatus(value: unknown): ConnectionStatus {
  const snapshot = record(value, "ConnectionStatus", statusInvalid);
  assertOnlyKeys(snapshot, STATUS_KEYS, "Connection status", statusInvalid);
  if (!CONNECTION_STATUS_STATES.includes(snapshot.state as ConnectionStatusState)) {
    throw statusInvalid(
      `Connection status state "${String(snapshot.state)}" is not supported`,
    );
  }
  if (!STATUS_REASON_CODES.includes(snapshot.reasonCode as StatusReasonCode)) {
    throw statusInvalid(
      `Connection status reasonCode "${String(snapshot.reasonCode)}" is not supported`,
    );
  }
  const status: ConnectionStatus = {
    state: snapshot.state as ConnectionStatusState,
    reasonCode: snapshot.reasonCode as StatusReasonCode,
  };
  if (snapshot.testedAt !== undefined) {
    status.testedAt = validateCreatedAt(snapshot.testedAt);
  }
  if (snapshot.testedVersion !== undefined) {
    status.testedVersion = versionString(
      snapshot.testedVersion,
      "testedVersion",
      statusInvalid,
    );
  }
  return deepFreeze(status);
}

function parseCredentialRefs(value: unknown): CredentialReference[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > CONNECTION_BOUNDS.credentialRefMaxCount) {
    throw connectionInvalid(
      `Connection profile credentialRefs must be an array of at most ${CONNECTION_BOUNDS.credentialRefMaxCount} references`,
    );
  }
  return value.map((entry, index) => {
    const ref = record(entry, `credentialRefs[${index}]`, connectionInvalid);
    if (ref.kind !== "env") {
      // Structural secret-value rejection: only env references are a valid
      // credential shape; anything else is refused rather than interpreted.
      throw connectionInvalid(
        `Connection profile credentialRefs[${index}] kind "${String(ref.kind)}" is not supported`,
      );
    }
    if (Object.keys(ref).length !== 2) {
      throw connectionInvalid(
        `Connection profile credentialRefs[${index}] must contain exactly kind and name`,
      );
    }
    const name = boundedString(
      ref.name,
      `credentialRefs[${index}] name`,
      CONNECTION_BOUNDS.envNameMaxLength,
    );
    if (!ENV_NAME_PATTERN.test(name)) {
      throw connectionInvalid(
        `Connection profile credentialRefs[${index}] name must match ${ENV_NAME_PATTERN}`,
      );
    }
    return { kind: "env", name };
  });
}

function parseCapabilities(
  value: unknown,
  what: string,
): ConnectionCapabilities {
  if (value === undefined) return {};
  const snapshot = record(value, what, connectionInvalid);
  const capabilities: ConnectionCapabilities = {};
  for (const [key, entry] of Object.entries(snapshot)) {
    if (!RUNTIME_CAPABILITY_KEYS.includes(key as RuntimeCapabilityKey)) {
      throw connectionInvalid(
        `${what} contains an unsupported capability "${key}"`,
      );
    }
    const capability = record(entry, `${what}.${key}`, connectionInvalid);
    if (Object.keys(capability).length > 3) {
      throw connectionInvalid(
        `${what}.${key} must contain at most supported, source, and version`,
      );
    }
    if (typeof capability.supported !== "boolean") {
      throw connectionInvalid(`${what}.${key} supported must be a boolean`);
    }
    if (!CAPABILITY_SOURCES.includes(capability.source as CapabilitySource)) {
      throw connectionInvalid(
        `${what}.${key} source "${String(capability.source)}" is not supported`,
      );
    }
    const parsed: RuntimeCapability = {
      supported: capability.supported,
      source: capability.source as CapabilitySource,
    };
    if (capability.version !== undefined) {
      parsed.version = versionString(
        capability.version,
        `${what}.${key} version`,
        connectionInvalid,
      );
    }
    capabilities[key as RuntimeCapabilityKey] = parsed;
  }
  return capabilities;
}

function validateConnectionId(value: unknown): string {
  const connectionId = boundedString(
    value,
    "connectionId",
    CONNECTION_BOUNDS.idMaxLength,
  );
  if (!CONNECTION_ID_PATTERN.test(connectionId)) {
    throw connectionInvalid(
      `Connection revision connectionId must match ${CONNECTION_ID_PATTERN}`,
    );
  }
  return connectionId;
}

function validateRevisionNumber(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw revisionInvalid("Connection revision revisionNumber must be a positive integer");
  }
  return value;
}

function revisionNumberOrInvalid(
  value: unknown,
  invalid: (message: string) => AgentAdapterError,
): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw invalid("revisionNumber must be a positive integer");
  }
  return value;
}

function validateCreatedAt(value: unknown): string {
  const createdAt = boundedString(
    value,
    "createdAt",
    CONNECTION_BOUNDS.createdAtMaxLength,
  );
  if (Number.isNaN(Date.parse(createdAt))) {
    throw revisionInvalid("Connection revision createdAt must be a valid ISO-8601 timestamp");
  }
  return createdAt;
}

function boundedString(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength) {
    throw connectionInvalid(
      `${field} must be a non-empty string of at most ${maxLength} characters`,
    );
  }
  return value;
}

function optionalBoundedString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  return versionString(value, field, connectionInvalid);
}

function versionString(
  value: unknown,
  field: string,
  invalid: (message: string) => AgentAdapterError,
): string {
  const parsed = boundedString(value, field, CONNECTION_BOUNDS.versionMaxLength);
  if (!VERSION_PATTERN.test(parsed)) {
    throw invalid(`${field} must match ${VERSION_PATTERN}`);
  }
  return parsed;
}

function record(
  value: unknown,
  what: string,
  invalid: (message: string) => AgentAdapterError,
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw invalid(`${what} must be an object`);
  }
  return value as Record<string, unknown>;
}

function assertOnlyKeys(
  value: Record<string, unknown>,
  allowed: string[],
  what: string,
  invalid: (message: string) => AgentAdapterError,
): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw invalid(`${what} contains an unsupported field "${unknown[0]}"`);
  }
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const nested of Object.values(value as Record<string, unknown>)) {
      deepFreeze(nested);
    }
    Object.freeze(value);
  }
  return value;
}

function connectionInvalid(message: string): AgentAdapterError {
  return new AgentAdapterError("RUNTIME_CONNECTION_INVALID", "runtime-connection", message, {
    retryable: false,
  });
}

function revisionInvalid(message: string): AgentAdapterError {
  return new AgentAdapterError(
    "RUNTIME_CONNECTION_REVISION_INVALID",
    "runtime-connection",
    message,
    { retryable: false },
  );
}

function statusInvalid(message: string): AgentAdapterError {
  return new AgentAdapterError(
    "RUNTIME_CONNECTION_STATUS_INVALID",
    "runtime-connection",
    message,
    { retryable: false },
  );
}
