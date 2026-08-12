import { AgentAdapterError } from "./agent-adapter.errors";
import {
  buildExecutorDescriptor,
  readExecutorDescriptor,
  type ExecutorDescriptorV1,
} from "../executors/executor-descriptor";

export type DelegationMode = "opaque" | "observed";

/** Operator-declared delegation capability (M6-S5 negotiation): the
 *  modes the runtime is known to support. Absent = unrestricted. */
export function parseDelegationModes(value: unknown, agent: string): DelegationMode[] {
  if (value === undefined || value === null) {
    // No declaration: unrestricted (pre-M6 behavior). The operator
    // restricts by declaring the runtime's actual modes.
    return ["opaque", "observed"];
  }
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > 2 ||
    !value.every((mode) => mode === "opaque" || mode === "observed") ||
    new Set(value).size !== value.length
  ) {
    throw invalidConfiguration(
      `Agent "${agent}" delegationModes must be a unique subset of opaque, observed`,
    );
  }
  return value as DelegationMode[];
}

export type KafkaAgentTransportConfiguration = {
  kind: "kafka";
  /** M6-S5: runtime-advertised delegation modes (negotiation allowlist). */
  delegationModes: DelegationMode[];
};

export type HttpAgentTransportConfiguration = {
  kind: "http";
  submitUrl: string;
  outboundAuthentication: { type: "none" } | { type: "bearer"; token: string };
  callbackAuthentication: {
    keyId: string;
    secret: string;
  };
  requestTimeoutMs: number;
  maxResponseBytes: number;
  /** M6-S5: operator-declared delegation modes (negotiation allowlist). */
  delegationModes: DelegationMode[];
};

export type AgentTransportConfiguration =
  | KafkaAgentTransportConfiguration
  | HttpAgentTransportConfiguration;

export type ParsedAgentTransportConfiguration = {
  agents: Map<string, AgentTransportConfiguration>;
  callbackBaseUrl?: string;
  callbackMaxSkewSeconds: number;
  replayTtlMs: number;
  replayMaxEntries: number;
};

const DEFAULT_CALLBACK_MAX_SKEW_SECONDS = 300;
const DEFAULT_REPLAY_MAX_ENTRIES = 10_000;

export function parseAgentTransportConfiguration(
  environment: NodeJS.ProcessEnv = process.env,
): ParsedAgentTransportConfiguration {
  const raw = environment.AGENT_TRANSPORT_CONFIG?.trim();
  if (!raw) {
    return {
      agents: new Map(),
      callbackMaxSkewSeconds: DEFAULT_CALLBACK_MAX_SKEW_SECONDS,
      replayTtlMs: DEFAULT_CALLBACK_MAX_SKEW_SECONDS * 1000,
      replayMaxEntries: DEFAULT_REPLAY_MAX_ENTRIES,
    };
  }

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (cause) {
    throw invalidConfiguration(
      "AGENT_TRANSPORT_CONFIG must be valid JSON",
      cause,
    );
  }
  if (!isRecord(value))
    throw invalidConfiguration("AGENT_TRANSPORT_CONFIG must be an object");

  const allowInsecure = environment.HTTP_AGENT_ALLOW_INSECURE === "true";
  const agents = new Map<string, AgentTransportConfiguration>();
  for (const [agent, entry] of Object.entries(value)) {
    if (!agent || !isRecord(entry))
      throw invalidConfiguration("Every agent configuration must be an object");
    if (entry.kind === "kafka") {
      assertOnlyKeys(entry, ["kind", "delegationModes"], agent);
      agents.set(agent, {
        kind: "kafka",
        delegationModes: parseDelegationModes(entry.delegationModes, agent),
      });
      continue;
    }
    if (entry.kind !== "http")
      throw invalidConfiguration(
        `Agent "${agent}" has an unsupported transport kind`,
      );

    assertOnlyKeys(
      entry,
      [
        "kind",
        "submitUrl",
        "outboundAuthentication",
        "callbackAuthentication",
        "requestTimeoutMs",
        "maxResponseBytes",
        "delegationModes",
      ],
      agent,
    );
    const submitUrl = validatedUrl(
      entry.submitUrl,
      `Agent "${agent}" submit URL`,
      allowInsecure,
    );
    const outboundAuthentication = parseOutboundAuthentication(
      entry.outboundAuthentication,
      environment,
      agent,
    );
    const callbackAuthentication = parseCallbackAuthentication(
      entry.callbackAuthentication,
      environment,
      agent,
    );
    const requestTimeoutMs = positiveInteger(
      entry.requestTimeoutMs,
      `Agent "${agent}" request timeout`,
    );
    const maxResponseBytes = positiveInteger(
      entry.maxResponseBytes,
      `Agent "${agent}" response-size limit`,
    );

    agents.set(agent, {
      kind: "http",
      submitUrl,
      outboundAuthentication,
      callbackAuthentication,
      requestTimeoutMs,
      maxResponseBytes,
      delegationModes: parseDelegationModes(entry.delegationModes, agent),
    });
  }

  const hasHttpAgent = Array.from(agents.values()).some(
    (configuration) => configuration.kind === "http",
  );
  const callbackBaseUrl = hasHttpAgent
    ? validatedUrl(
        environment.HTTP_AGENT_CALLBACK_BASE_URL,
        "HTTP_AGENT_CALLBACK_BASE_URL",
        allowInsecure,
      )
    : undefined;
  const callbackMaxSkewSeconds = optionalPositiveInteger(
    environment.HTTP_AGENT_CALLBACK_MAX_SKEW_SECONDS,
    DEFAULT_CALLBACK_MAX_SKEW_SECONDS,
    "HTTP_AGENT_CALLBACK_MAX_SKEW_SECONDS",
  );
  const replayTtlMs = optionalPositiveInteger(
    environment.HTTP_AGENT_REPLAY_TTL_MS,
    callbackMaxSkewSeconds * 1000,
    "HTTP_AGENT_REPLAY_TTL_MS",
  );
  if (replayTtlMs < callbackMaxSkewSeconds * 1000) {
    throw invalidConfiguration(
      "HTTP_AGENT_REPLAY_TTL_MS must cover the callback clock-skew window",
    );
  }

  return {
    agents,
    callbackBaseUrl,
    callbackMaxSkewSeconds,
    replayTtlMs,
    replayMaxEntries: optionalPositiveInteger(
      environment.HTTP_AGENT_REPLAY_MAX_ENTRIES,
      DEFAULT_REPLAY_MAX_ENTRIES,
      "HTTP_AGENT_REPLAY_MAX_ENTRIES",
    ),
  };
}

export class AgentTransportConfigService {
  private readonly configuration: ParsedAgentTransportConfiguration;

  constructor(configuration = parseAgentTransportConfiguration()) {
    this.configuration = configuration;
  }

  forAgent(agent: string): AgentTransportConfiguration {
    return (
      this.configuration.agents.get(agent) ?? {
        kind: "kafka",
        delegationModes: ["opaque", "observed"],
      }
    );
  }

  /**
   * M3: resolves and freezes the bounded executor descriptor for an agent at
   * attempt-claim time, mirroring `forAgent` routing semantics. The frozen
   * descriptor becomes the attempt's executorSnapshot; dispatch later consumes
   * exactly this pinned selection.
   */
  resolveExecutorDescriptor(agent: string): ExecutorDescriptorV1 {
    return buildExecutorDescriptor(agent, this.forAgent(agent));
  }

  /**
   * M3: reads the executor descriptor frozen on an attempt. Versioned
   * descriptors are pinned; legacy `{ agent }` snapshots (M0–M2) are routed
   * from live configuration exactly as before M3. Invalid snapshots raise a
   * deterministic non-retryable configuration failure.
   */
  frozenDescriptor(snapshot: unknown): ExecutorDescriptorV1 {
    return readExecutorDescriptor(snapshot, (agent) => this.forAgent(agent));
  }

  httpForAgent(agent: string): HttpAgentTransportConfiguration | undefined {
    const configuration = this.configuration.agents.get(agent);
    return configuration?.kind === "http" ? configuration : undefined;
  }

  callbackUrlFor(agent: string): string {
    if (!this.configuration.callbackBaseUrl) {
      throw invalidConfiguration(
        "HTTP_AGENT_CALLBACK_BASE_URL is required for HTTP agents",
      );
    }
    const url = new URL(this.configuration.callbackBaseUrl);
    url.pathname = `${url.pathname.replace(/\/$/, "")}/internal/agent-callbacks/http/${encodeURIComponent(agent)}`;
    return url.toString();
  }

  callbackSettings(): Pick<
    ParsedAgentTransportConfiguration,
    "callbackMaxSkewSeconds" | "replayTtlMs" | "replayMaxEntries"
  > {
    return {
      callbackMaxSkewSeconds: this.configuration.callbackMaxSkewSeconds,
      replayTtlMs: this.configuration.replayTtlMs,
      replayMaxEntries: this.configuration.replayMaxEntries,
    };
  }
}

function parseOutboundAuthentication(
  value: unknown,
  environment: NodeJS.ProcessEnv,
  agent: string,
): HttpAgentTransportConfiguration["outboundAuthentication"] {
  if (!isRecord(value))
    throw invalidConfiguration(
      `Agent "${agent}" outbound authentication is required`,
    );
  if (value.type === "none") {
    assertOnlyKeys(value, ["type"], agent);
    return { type: "none" };
  }
  if (value.type !== "bearer") {
    throw invalidConfiguration(
      `Agent "${agent}" has unsupported outbound authentication`,
    );
  }
  assertOnlyKeys(value, ["type", "tokenEnv"], agent);
  const tokenEnv = nonEmptyString(
    value.tokenEnv,
    `Agent "${agent}" bearer token environment name`,
  );
  const token = environment[tokenEnv];
  if (!token)
    throw invalidConfiguration(
      `Agent "${agent}" bearer token environment value is missing`,
    );
  return { type: "bearer", token };
}

function parseCallbackAuthentication(
  value: unknown,
  environment: NodeJS.ProcessEnv,
  agent: string,
): HttpAgentTransportConfiguration["callbackAuthentication"] {
  if (!isRecord(value))
    throw invalidConfiguration(
      `Agent "${agent}" callback authentication is required`,
    );
  assertOnlyKeys(value, ["keyId", "secretEnv"], agent);
  const keyId = nonEmptyString(value.keyId, `Agent "${agent}" callback key ID`);
  // The keyId is persisted as the durable transport scope (sourceScope
  // varchar(255)) on both the event and result paths. Reject an oversized
  // configuration at startup instead of failing every callback later.
  if (keyId.length > 255) {
    throw invalidConfiguration(
      `Agent "${agent}" callback key ID exceeds the 255-character durable bound`,
    );
  }
  const secretEnv = nonEmptyString(
    value.secretEnv,
    `Agent "${agent}" callback secret environment name`,
  );
  const secret = environment[secretEnv];
  if (!secret)
    throw invalidConfiguration(
      `Agent "${agent}" callback secret environment value is missing`,
    );
  return { keyId, secret };
}

function validatedUrl(
  value: unknown,
  field: string,
  allowInsecure: boolean,
): string {
  const raw = nonEmptyString(value, field);
  let url: URL;
  try {
    url = new URL(raw);
  } catch (cause) {
    throw invalidConfiguration(`${field} is invalid`, cause);
  }
  if (url.username || url.password)
    throw invalidConfiguration(`${field} must not contain credentials`);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw invalidConfiguration(`${field} must use http or https`);
  }
  if (url.protocol === "http:" && !allowInsecure) {
    throw invalidConfiguration(
      `${field} requires HTTPS unless HTTP_AGENT_ALLOW_INSECURE=true`,
    );
  }
  return url.toString();
}

function optionalPositiveInteger(
  value: unknown,
  fallback: number,
  field: string,
): number {
  if (value === undefined) return fallback;
  const parsed =
    typeof value === "string" && value.trim() ? Number(value) : value;
  return positiveInteger(parsed, field);
}

function positiveInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw invalidConfiguration(`${field} must be a positive integer`);
  }
  return value;
}

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim())
    throw invalidConfiguration(`${field} must be a non-empty string`);
  return value;
}

function assertOnlyKeys(
  value: Record<string, unknown>,
  allowed: string[],
  agent: string,
): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    throw invalidConfiguration(
      `Agent "${agent}" configuration contains an unsupported field`,
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function invalidConfiguration(
  message: string,
  cause?: unknown,
): AgentAdapterError {
  return new AgentAdapterError(
    "HTTP_CONFIGURATION_INVALID",
    "router",
    message,
    {
      retryable: false,
      cause,
    },
  );
}
