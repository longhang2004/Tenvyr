import { createTenvyrWorker, defineAgent } from "@tenvyr/worker";
import { parseHostConfig, type HostAgentConfig } from "./config";
import { superviseProcess, type ProcessOutcome } from "./supervisor";
import {
  clearRunState,
  terminateOrphan,
  writeRunState,
} from "./state";

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
 */

export async function main(): Promise<void> {
  const config = parseHostConfig();
  const workers = [];

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
          const startedAt = new Date().toISOString();
          try {
            const outcome = await superviseProcess({
              profile,
              env: resolvedEnvironment(profile),
              input: invocation,
              signal: context.signal,
              invocationDeadlineAt: invocation.deadlineAt,
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
                  console.error("Run state write failed; orphan protection degraded", {
                    agent: profile.agent,
                    invocationId: invocation.invocationId,
                    reason: error instanceof Error ? error.message : String(error),
                  });
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
        heartbeatIntervalMs: Math.min(60_000, Math.max(1_000, Math.floor(profile.wallTimeMs / 3))),
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

    const address = await worker.start({ host: "127.0.0.1", port: profile.port });
    workers.push({ worker, profile, address });
    console.log("Local executor host agent listening", {
      agent: profile.agent,
      host: address.host,
      port: address.port,
      command: profile.command,
    });
  }

  console.log("Local executor host started", {
    agents: workers.map(({ profile }) => profile.agent),
  });
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
    case "succeeded":
      return context.success({
        output: {
          exitCode: outcome.exitCode,
          stdout: outcome.stdout,
          // stderr is omitted from the success payload; it stays in host
          // logs only if the operator's command writes there.
        },
      });
    case "failed":
      return context.fail({
        code: "EXECUTOR_HOST_PROCESS_FAILED",
        message: boundedTail(outcome.stderr, 1024) || `Process exited with code ${outcome.exitCode}`,
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
