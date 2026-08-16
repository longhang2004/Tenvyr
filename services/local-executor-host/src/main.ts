import { createTenvyrWorker, defineAgent } from "@tenvyr/worker";
import {
  parseHostConfig,
  resolveExecutionCwd,
  ExecutionWorkspacePathError,
  type HostAgentConfig,
  type HostConfig,
} from "./config";
export type { HostAgentConfig, HostConfig } from "./config";
import { superviseProcess, type ProcessOutcome } from "./supervisor";
import { MODEL_ID_MAX_LENGTH, MODEL_ID_PATTERN } from "./supervisor";
import { clearRunState, terminateOrphan, writeRunState } from "./state";

/**
 * M3-S3: trusted-code-only local process executor host.
 *
 * One TenvyrWorker instance per configured agent (each on its own port),
 * so the canonical HTTP Worker protocol, bearer auth, callback signing,
 * idempotency, and scheduling come from the reviewed worker SDK. The agent's
 * `execute` resolves the FIXED operator-configured command for the
 * invocation's agent target, supervises it with bounded IO and process-group
 * deadline/cancel, and materializes the canonical result.
 *
 * The host is trusted-code-only: it runs exactly the configured command in
 * an explicit allowlisted environment, with no sandbox. It never accepts
 * executable paths, commands, arguments, or environment from the pipeline.
 *
 * M8-S6: a connection-bound agent (connectionId + configHash declared)
 * validates every invocation's frozen connection reference against its own
 * fixed configuration and FAILS CLOSED before spawn on any mismatch — the
 * immutable connection revision is authoritative for what the host runs.
 *
 * PP1 (Pivot Invariant 1): the WORKING DIRECTORY of every runtime child is
 * Tenvyr authority too. When the invocation carries the reserved
 * `metadata.tenvyr.executionWorkspace` member, `resolveExecutionCwd`
 * validates the path (absolute, existing directory, realpath inside
 * EXECUTOR_HOST_ALLOWED_ROOT — no traversal, no symlink escape) and the
 * child spawns there; agents declaring `requireExecutionWorkspace` refuse
 * workspace-less invocations. Planner/worker task input can never choose or
 * override cwd.
 */

export function main(): Promise<void> {
  const config = parseHostConfig();
  return startHostWorkers(config).then(() => {
    console.log("Local executor host started", {
      agents: config.agents.map((profile) => profile.agent),
    });
  });
}

/**
 * Starts one worker per configured agent on its own loopback port.
 * Exported so integration tests exercise the REAL host wiring (config ->
 * worker -> supervisor -> canonical result) in-process.
 */
export async function startHostWorkers(config: HostConfig): Promise<
  Array<{
    agent: string;
    address: { host: string; port: number };
    stop: () => Promise<void>;
  }>
> {
  const workers = [];
  const started: Array<{
    agent: string;
    address: { host: string; port: number };
    stop: () => Promise<void>;
  }> = [];

  for (const profile of config.agents) {
    // Restart/orphan policy: never adopt, never re-spawn — terminate any
    // process group a previous host run left behind.
    const orphan = await terminateOrphan(config.stateDir, profile.agent);
    if (orphan) {
      console.warn("Terminated orphaned process from a previous host run", {
        agent: profile.agent,
        invocationId: orphan,
      });
    }

    const bearerToken = process.env[profile.bearerTokenEnv] ?? "";
    const worker = createTenvyrWorker({
      agent: defineAgent({
        name: profile.agent,
        execute: async (context) => {
          const invocation = context.invocation;
          const bindingError = validateInvocationBinding(profile, invocation);
          if (bindingError) {
            return context.fail({
              code: "EXECUTOR_HOST_CONNECTION_MISMATCH",
              message: bindingError,
              retryable: false,
            });
          }
          // PP1 — Pivot Invariant 1: the Tenvyr execution workspace
          // determines the child cwd; validation fails closed BEFORE spawn.
          let spawnCwd: string;
          try {
            spawnCwd = resolveExecutionCwd(
              profile,
              invocation,
              config.allowedRoot,
            );
          } catch (error) {
            if (error instanceof ExecutionWorkspacePathError) {
              return context.fail({
                code: "EXECUTOR_HOST_WORKSPACE_PATH_INVALID",
                message: error.message,
                retryable: false,
              });
            }
            throw error;
          }
          const startedAt = new Date().toISOString();
          try {
            const outcome = await superviseProcess({
              profile,
              env: resolvedEnvironment(profile),
              input: invocation,
              requestedModelId:
                typeof invocation.requestedModelId === "string"
                  ? invocation.requestedModelId
                  : undefined,
              signal: context.signal,
              invocationDeadlineAt: invocation.deadlineAt,
              cwdOverride: spawnCwd,
              onSpawn: (pid) => {
                // Restart/orphan policy state: the CHILD pid is the process
                // group a future host restart must terminate.
                try {
                  writeRunState(config.stateDir, profile.agent, {
                    invocationId: invocation.invocationId,
                    pid,
                    startedAt,
                    killAt: new Date(
                      Date.now() + profile.wallTimeMs,
                    ).toISOString(),
                  });
                } catch (error) {
                  console.error(
                    "Run state write failed; orphan protection degraded",
                    {
                      agent: profile.agent,
                      invocationId: invocation.invocationId,
                      reason:
                        error instanceof Error ? error.message : String(error),
                    },
                  );
                }
              },
            });
            return materializeResult(context, outcome, profile);
          } finally {
            clearRunState(config.stateDir, profile.agent);
          }
        },
      }),
      authentication: { bearerToken },
      callbackAuthentication: { keys: config.callbackKeys },
      callbackPolicy: {
        allowedOrigins: config.callbackAllowedOrigins,
        allowInsecureHttp: config.callbackAllowInsecure,
      },
      execution: {
        // The SDK run timeout must stay BEHIND the host's own wall clock so
        // the supervisor's process-group escalation is authoritative.
        timeoutMs: profile.wallTimeMs + 10_000,
        concurrency: 1,
        maxQueuedRuns: 4,
      },
      events: {
        enabled: true,
        heartbeatIntervalMs: Math.min(
          60_000,
          Math.max(1_000, Math.floor(profile.wallTimeMs / 3)),
        ),
      },
      logger: {
        debug: () => undefined,
        info: (message, contextData) =>
          console.log(message, safeLog(contextData)),
        warn: (message, contextData) =>
          console.warn(message, safeLog(contextData)),
        error: (message, contextData) =>
          console.error(message, safeLog(contextData)),
      },
    });

    const address = await worker.start({
      host: "127.0.0.1",
      port: profile.port,
    });
    workers.push({ worker, profile, address });
    started.push({
      agent: profile.agent,
      address,
      stop: () => worker.stop(),
    });
    console.log("Local executor host agent listening", {
      agent: profile.agent,
      host: address.host,
      port: address.port,
      command: profile.command,
    });
  }

  return started;
}

/**
 * M8-S6: fail-closed binding check — the host's fixed operator configuration
 * must equal the invocation's frozen connection reference. Returns a
 * deterministic error message when the invocation must NOT run; null when it
 * may. Never consults pipeline input for anything executable.
 *
 * P2: the same fail-closed discipline applies to the requested model — an
 * invocation carrying a requestedModelId requires the agent to declare a
 * fixed modelArgvPrefix, and the model id must be a bounded data value.
 */
export function validateInvocationBinding(
  profile: HostAgentConfig,
  invocation: {
    connection?: {
      connectionId: string;
      revisionNumber: number;
      configHash: string;
    };
    requestedModelId?: unknown;
    invocationId: string;
  },
): string | null {
  const carried = invocation.connection;
  if (profile.connectionId !== undefined && profile.configHash !== undefined) {
    if (!carried) {
      return `Invocation ${invocation.invocationId} carries no connection reference but agent "${profile.agent}" is bound to connection "${profile.connectionId}" — refusing to run (fail closed)`;
    }
    if (carried.connectionId !== profile.connectionId) {
      return `Invocation ${invocation.invocationId} selects connection "${carried.connectionId}" but agent "${profile.agent}" is bound to "${profile.connectionId}" — refusing to run (fail closed)`;
    }
    if (carried.configHash !== profile.configHash) {
      return `Invocation ${invocation.invocationId} selects connection revision hash "${carried.configHash}" but agent "${profile.agent}" is configured for hash "${profile.configHash}" — refusing to run (fail closed)`;
    }
  } else if (carried) {
    return `Invocation ${invocation.invocationId} carries connection "${carried.connectionId}" but agent "${profile.agent}" declares no connection binding — refusing to run (fail closed)`;
  }
  // P2: model argument support is fixed operator configuration. A requested
  // model can never be composed without a declared argv prefix, and a model
  // id is never trusted as anything but bounded data.
  if (invocation.requestedModelId !== undefined) {
    if (
      profile.modelArgvPrefix === undefined ||
      profile.modelArgvPrefix.length === 0
    ) {
      return `Invocation ${invocation.invocationId} requests model "${String(invocation.requestedModelId)}" but agent "${profile.agent}" declares no modelArgvPrefix — refusing to run (fail closed)`;
    }
    const modelId = invocation.requestedModelId;
    if (
      typeof modelId !== "string" ||
      modelId.length === 0 ||
      modelId.length > MODEL_ID_MAX_LENGTH ||
      !MODEL_ID_PATTERN.test(modelId)
    ) {
      return `Invocation ${invocation.invocationId} requests an invalid model id — refusing to run (fail closed)`;
    }
  }
  return null;
}

function resolvedEnvironment(profile: HostAgentConfig): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [childName, hostEnvName] of Object.entries(profile.env)) {
    environment[childName] = process.env[hostEnvName] ?? "";
  }
  for (const [childName, secretEnvName] of Object.entries(profile.secrets)) {
    environment[childName] = process.env[secretEnvName] ?? "";
  }
  return environment;
}

function materializeResult(
  context: import("@tenvyr/worker").AgentExecutionContext,
  outcome: ProcessOutcome,
  profile: HostAgentConfig,
): unknown {
  switch (outcome.kind) {
    case "succeeded": {
      if (profile.structuredResult) {
        // M8-S6: the child's stdout IS the structured result — one JSON
        // document. A parse failure is a deterministic failure: garbage
        // output must never be stored as a successful result.
        let parsed: unknown;
        try {
          parsed = JSON.parse(outcome.stdout);
        } catch (error) {
          return context.fail({
            code: "EXECUTOR_HOST_INVALID_STRUCTURED_RESULT",
            message: `Structured result from "${profile.agent}" is not valid JSON: ${
              error instanceof Error ? error.message : String(error)
            }`,
            retryable: false,
          });
        }
        return context.success({ output: parsed });
      }
      return context.success({
        output: {
          exitCode: outcome.exitCode,
          stdout: outcome.stdout,
          // stderr is omitted from the success payload; it stays in host
          // logs only if the operator's command writes there.
        },
      });
    }
    case "failed":
      return context.fail({
        code: "EXECUTOR_HOST_PROCESS_FAILED",
        message:
          boundedTail(outcome.stderr, 1024) ||
          `Process exited with code ${outcome.exitCode}`,
        retryable: false,
      });
    case "spawn_failed":
      return context.fail({
        code: "EXECUTOR_HOST_SPAWN_FAILED",
        message: outcome.message,
        retryable: false,
      });
    case "killed":
      return context.fail({
        code:
          outcome.trigger === "shutdown"
            ? "EXECUTOR_HOST_SHUTDOWN"
            : "EXECUTOR_HOST_DEADLINE",
        message: `Process group ${outcome.finalSignal} after ${outcome.trigger}`,
        retryable: true,
      });
    case "output_limit":
      return context.fail({
        code: "EXECUTOR_HOST_OUTPUT_LIMIT",
        message: `${outcome.stream} exceeded the configured byte bound for agent "${profile.agent}"`,
        retryable: false,
      });
  }
}

function boundedTail(value: string, maxLength: number): string {
  return value.length <= maxLength
    ? value
    : `...${value.slice(value.length - maxLength)}`;
}

/**
 * Log hygiene: never log invocation input (context/artifacts), child
 * environment values, or argv. Only safe scalars pass through.
 */
function safeLog(
  contextData: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!contextData) return undefined;
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(contextData)) {
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      safe[key] = value;
    }
  }
  return safe;
}

if (require.main === module) {
  main().catch((error) => {
    console.error("Local executor host failed to start", {
      reason: error instanceof Error ? error.message : String(error),
    });
    process.exitCode = 1;
  });
}
