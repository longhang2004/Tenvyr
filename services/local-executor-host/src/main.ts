import * as path from "node:path";
import { Pool } from "pg";
import { createTenvyrWorker, defineAgent } from "@tenvyr/worker";
import {
  parseHostConfig,
  resolveExecutionCwd,
  executionWorkspaceFromInvocation,
  ExecutionWorkspacePathError,
  type HostAgentConfig,
  type HostConfig,
} from "./config";
export type { HostAgentConfig, HostConfig } from "./config";
import { superviseProcess, type ProcessOutcome } from "./supervisor";
import { MODEL_ID_MAX_LENGTH, MODEL_ID_PATTERN } from "./supervisor";
import { clearRunState, terminateOrphan, writeRunState } from "./state";
import { adaptNativeRuntimeOutput } from "./adapters/native-output-adapter";

let pool: Pool | null = null;
function getDbPool(): Pool {
  if (!pool) {
    const connectionString =
      process.env.DATABASE_URL ||
      process.env.TEST_DATABASE_URL ||
      `postgres://${process.env.POSTGRES_USER || "postgres"}:${process.env.POSTGRES_PASSWORD || "postgres"}@${process.env.POSTGRES_HOST || "127.0.0.1"}:${process.env.POSTGRES_PORT || process.env.TENVYR_POSTGRES_PORT || 5432}/${process.env.POSTGRES_DB || "tenvyr"}`;
    pool = new Pool({ connectionString });
  }
  return pool;
}

export async function resolveConnectionRevisionFromDb(
  connectionId: string,
  revisionNumber: number,
): Promise<{ profile: any; configHash: string } | null> {
  const p = getDbPool();
  const res = await p.query(
    'SELECT "profile", "configHash" FROM "connection_revisions" WHERE "connectionId" = $1 AND "revisionNumber" = $2',
    [connectionId, revisionNumber],
  );
  if (res.rows.length === 0) return null;
  return {
    profile: res.rows[0].profile,
    configHash: res.rows[0].configHash,
  };
}

export async function resolveAuthorizedWorkspaceFromDb(
  sourceWorkspaceId: string,
): Promise<string | null> {
  try {
    const p = getDbPool();
    const res = await p.query(
      'SELECT "path" FROM "workspaces" WHERE "id" = $1 LIMIT 1',
      [sourceWorkspaceId],
    );
    if (res.rows.length === 0) return null;
    return res.rows[0].path;
  } catch {
    return null;
  }
}

export function main(): Promise<void> {
  const config = parseHostConfig();
  return startHostWorkers(config).then(() => {
    console.log("Local executor host started", {
      agents: config.agents.map((profile) => profile.agent),
      dynamicBridge: config.dynamicBridge ?? false,
    });
  });
}

/**
 * Starts one worker per configured agent on its own loopback port,
 * or a unified dynamic bridge worker if no static agents are declared.
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

  if (config.agents.length === 0) {
    const bearerToken =
      process.env[config.bearerTokenEnv ?? "EXECUTOR_HOST_BEARER_TOKEN"] ??
      process.env.HTTP_AGENT_BEARER_TOKEN;
    if (!bearerToken) {
      throw new Error(
        "Missing required bearer token environment variable for Local Executor Host dynamic bridge",
      );
    }
    const port = config.port ?? 3002;

    const worker = createTenvyrWorker({
      agent: defineAgent({
        name: "*",
        execute: async (context) => {
          const invocation = context.invocation;
          let profile: HostAgentConfig;

          if (invocation.connection) {
            const { connectionId, revisionNumber, configHash } =
              invocation.connection;
            let rev: { profile: any; configHash: string } | null = null;
            try {
              rev = await resolveConnectionRevisionFromDb(
                connectionId,
                revisionNumber,
              );
            } catch (err: any) {
              return context.fail({
                code: "EXECUTOR_HOST_DATABASE_ERROR",
                message: `Failed to query connection revision: ${err.message}`,
                retryable: true,
              });
            }
            if (!rev) {
              return context.fail({
                code: "EXECUTOR_HOST_CONNECTION_NOT_FOUND",
                message: `Connection "${connectionId}" revision ${revisionNumber} not found`,
                retryable: false,
              });
            }
            if (rev.configHash !== configHash) {
              return context.fail({
                code: "EXECUTOR_HOST_CONNECTION_MISMATCH",
                message: `Invocation selects revision hash "${configHash}" but revision ${revisionNumber} has hash "${rev.configHash}"`,
                retryable: false,
              });
            }
            const cli = rev.profile?.cli;
            if (!cli || !cli.command) {
              return context.fail({
                code: "EXECUTOR_HOST_CLI_NOT_CONFIGURED",
                message: `Connection "${connectionId}" does not declare a CLI profile`,
                retryable: false,
              });
            }
            profile = {
              agent: invocation.target?.agent || connectionId,
              command: cli.command,
              args: cli.args || [],
              modelArgvPrefix: Array.isArray(cli.modelArgvPrefix)
                ? cli.modelArgvPrefix
                : typeof cli.modelArgvPrefix === "string"
                  ? [cli.modelArgvPrefix]
                  : undefined,
              runtimeKind: rev.profile?.runtimeKind,
              cwd: cli.cwd
                ? path.resolve(config.allowedRoot, cli.cwd)
                : config.allowedRoot,
              env: cli.envAllowlist || {},
              secrets: cli.secrets || {},
              wallTimeMs: 300_000,
              maxStdoutBytes: 16 * 1024 * 1024,
              maxStderrBytes: 16 * 1024 * 1024,
              port,
              bearerTokenEnv:
                config.bearerTokenEnv ?? "EXECUTOR_HOST_BEARER_TOKEN",
              connectionId,
              configHash,
              structuredResult:
                rev.profile?.declaredCapabilities?.structuredResult
                  ?.supported ?? true,
              requireExecutionWorkspace: true,
            };
          } else {
            return context.fail({
              code: "EXECUTOR_HOST_CONNECTION_REQUIRED",
              message: `Dynamic local executor bridge requires an immutable connection reference`,
              retryable: false,
            });
          }

          const bindingError = validateInvocationBinding(profile, invocation);
          if (bindingError) {
            return context.fail({
              code: "EXECUTOR_HOST_CONNECTION_MISMATCH",
              message: bindingError,
              retryable: false,
            });
          }
          let spawnCwd: string;
          try {
            const member = executionWorkspaceFromInvocation(invocation);
            let authorizedRoots: string[] = [];
            if (member?.mode === "shared" && member.sourceWorkspaceId) {
              const wsPath = await resolveAuthorizedWorkspaceFromDb(
                member.sourceWorkspaceId,
              );
              if (wsPath) authorizedRoots.push(wsPath);
            }
            spawnCwd = resolveExecutionCwd(
              profile,
              invocation,
              config.allowedRoot,
              authorizedRoots,
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
        timeoutMs: 310_000,
        concurrency: 4,
        maxQueuedRuns: 16,
      },
      events: {
        enabled: true,
        heartbeatIntervalMs: 15_000,
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
      port,
    });
    started.push({
      agent: "*",
      address,
      stop: async () => {
        await worker.stop();
        if (pool) {
          await pool.end().catch(() => undefined);
          pool = null;
        }
      },
    });
    console.log("Local executor host bridge listening", {
      host: address.host,
      port: address.port,
    });
    return started;
  }

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
            const member = executionWorkspaceFromInvocation(invocation);
            let authorizedRoots: string[] = [];
            if (member?.mode === "shared" && member.sourceWorkspaceId) {
              const wsPath = await resolveAuthorizedWorkspaceFromDb(
                member.sourceWorkspaceId,
              );
              if (wsPath) authorizedRoots.push(wsPath);
            }
            spawnCwd = resolveExecutionCwd(
              profile,
              invocation,
              config.allowedRoot,
              authorizedRoots,
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
  const adapted = adaptNativeRuntimeOutput(outcome, profile);
  if (adapted.success === true) {
    return context.success({ output: adapted.output });
  }
  return context.fail({
    code: adapted.code,
    message: adapted.message,
    retryable: adapted.retryable,
  });
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
