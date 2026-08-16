/**
 * P2 closure (round 2): CONNECTION-SCOPED provider/model discovery.
 *
 * Everything here resolves the Runtime Connection FIRST (rejecting
 * missing/revoked connections), then loads its CURRENT revision, then uses
 * THAT revision's fixed secret-free profile (cli.command, cli.cwd,
 * approved env/secret REFERENCES) — never a global PATH lookup, never
 * runtimeKind/executable/cwd/env supplied by the frontend. Two same-kind
 * connections with different executables/configurations are fully
 * independent.
 *
 * - OpenCode provider state: official Server API (`opencode serve` on
 *   127.0.0.1, ephemeral port, random password) — structured JSON, never
 *   TUI output parsing.
 * - OpenCode models: documented `opencode models [provider]` CLI invoked
 *   through the EXACT connection profile.
 * - Test Runtime Target: a SMALL BOUNDED REAL INVOCATION through the
 *   connection's frozen run argv + the runtime template's fixed
 *   modelArgvPrefix — never an orchestrator-side inference call.
 */
import { Inject, Injectable } from "@nestjs/common";
import { spawn } from "node:child_process";
import { DataSource } from "typeorm";
import { ConnectionRevisionV1 } from "../executors/runtime-connection";
import { RUNTIME_PROFILE_TEMPLATES } from "../executors/runtime-profiles";
import {
  ModelCatalogEntryV1,
  ModelCatalogSnapshotV1,
  RuntimeProviderV1,
} from "../executors/model-source";
import {
  parseOpenCodeModelLines,
  toRuntimeProviderV1,
  type OpenCodeProviderAuthMethodV1,
} from "../executors/opencode-server";
import { OpenCodeServerError } from "../executors/opencode-server";
import {
  OpenCodeAuthFlowError,
  OpenCodeAuthFlowService,
} from "./opencode-auth-flow.service";
import {
  OpenCodeManagementSession,
  withOpenCodeSession,
  type OpenCodeManagementProfile,
} from "./opencode-management.service";
import { isBoundedModelId, ModelDiscoveryService } from "./model-discovery.service";
import { runBoundedCliCommand } from "./cli-probe";
import { RuntimeConnectionService } from "./runtime-connection.service";

export const TEST_TARGET_BOUNDS = {
  wallTimeMs: 30_000,
  maxOutputBytes: 64 * 1024,
  prompt: "Respond with exactly: OK",
} as const;

export class ProviderDiscoveryError extends Error {
  constructor(
    readonly code:
      | "CONNECTION_NOT_FOUND"
      | "CONNECTION_REVOKED"
      | "RUNTIME_NOT_SUPPORTED"
      | "MODEL_NOT_SUPPORTED"
      | "OPENCODE_SERVER_FAILED"
      | "INVALID_OAUTH_URL"
      | "INVALID_METHOD_INDEX"
      | "AUTH_METHOD_UNSUPPORTED"
      | "PROVIDER_NOT_AUTHENTICATED"
      | "INVALID_MODEL_ID",
    message: string,
  ) {
    super(message);
    this.name = "ProviderDiscoveryError";
  }
}

export type ProviderDiscoveryV1 = {
  connectionId: string;
  revisionNumber: number;
  runtimeKind: string;
  providers: RuntimeProviderV1[];
};

export type RuntimeModelsRefreshV1 = {
  connectionId: string;
  revisionNumber: number;
  runtimeKind: string;
  catalog: ModelCatalogSnapshotV1;
};

export type ProviderAuthMethodsV1 = {
  connectionId: string;
  revisionNumber: number;
  runtimeKind: string;
  providerId: string;
  methods: OpenCodeProviderAuthMethodV1[];
};

export type TestTargetEvidenceV1 = {
  connectionId: string;
  revisionNumber: number;
  runtimeKind: string;
  requestedModelId: string | null;
  /** "ok" ONLY on a bounded successful real invocation — never READY. */
  status: "ok" | "failed";
  exitCode: number | null;
  durationMs: number;
  outputTruncated: boolean;
};

@Injectable()
export class ProviderDiscoveryService {
  private readonly connections: RuntimeConnectionService;
  private readonly discovery: ModelDiscoveryService;

  constructor(
    @Inject("DATA_SOURCE") private readonly dataSource: DataSource,
    connections?: RuntimeConnectionService,
    discovery?: ModelDiscoveryService,
    authFlows?: OpenCodeAuthFlowService,
  ) {
    this.connections = connections ?? new RuntimeConnectionService(this.dataSource);
    this.discovery = discovery ?? new ModelDiscoveryService();
    this.authFlows = authFlows ?? new OpenCodeAuthFlowService();
  }

  private readonly authFlows: OpenCodeAuthFlowService;

  /** Load the connection, reject revoked/missing, return its CURRENT
   *  revision (the connection service enforces both). */
  private async resolveRevision(connectionId: string): Promise<ConnectionRevisionV1> {
    // claimRevision is the shared authority-checked primitive: it throws
    // CONNECTION_NOT_FOUND for missing connections and CONNECTION_REVOKED
    // for revoked ones — both propagate unchanged.
    return this.connections.claimRevision(connectionId);
  }

  /** Secret-free profile for management/CLI spawns: the revision's fixed
   *  command/cwd + env allowlist/secret REFERENCES resolved at spawn time
   *  (values never persisted, never logged). */
  private sessionProfile(revision: ConnectionRevisionV1): OpenCodeManagementProfile {
    const cli = revision.profile.cli;
    if (!cli) {
      throw new ProviderDiscoveryError(
        "RUNTIME_NOT_SUPPORTED",
        `connection "${revision.connectionId}" has no CLI profile`,
      );
    }
    const env: Record<string, string> = {};
    for (const [child, host] of Object.entries(cli.envAllowlist ?? {})) {
      const value = process.env[host];
      if (value !== undefined) env[child] = value;
    }
    for (const [child, host] of Object.entries(cli.secrets ?? {})) {
      const value = process.env[host];
      if (value !== undefined) env[child] = value;
    }
    return { command: cli.command, cwd: cli.cwd, env };
  }

  private requireOpenCode(revision: ConnectionRevisionV1): void {
    if (revision.profile.runtimeKind !== "opencode") {
      throw new ProviderDiscoveryError(
        "RUNTIME_NOT_SUPPORTED",
        `provider management requires an opencode connection, got "${revision.profile.runtimeKind}"`,
      );
    }
  }

  /** Structured runtime-owned provider state for ONE connection. */
  async discoverRuntimeProviders(connectionId: string): Promise<ProviderDiscoveryV1> {
    const revision = await this.resolveRevision(connectionId);
    const runtimeKind = revision.profile.runtimeKind;
    let providers: RuntimeProviderV1[] = [];
    if (runtimeKind === "opencode") {
      try {
        providers = await withOpenCodeSession(this.sessionProfile(revision), async (session) =>
          toRuntimeProviderV1(await session.providers()),
        );
      } catch (error) {
        throw new ProviderDiscoveryError(
          "OPENCODE_SERVER_FAILED",
          String((error as Error).message),
        );
      }
    }
    // codex/claude/generic: provider multiplicity is NOT exposed by the
    // runtime — the frontend renders the single implied provider from the
    // runtime auth probe instead.
    return { connectionId, revisionNumber: revision.revisionNumber, runtimeKind, providers };
  }

  /** Model enumeration for ONE connection via the documented CLI through
   *  the exact connection profile. OpenCode: `models [provider]`; Codex:
   *  experimental best-effort; Claude/generic: empty (manual entry). */
  async refreshRuntimeModels(
    connectionId: string,
    providerId?: string,
  ): Promise<RuntimeModelsRefreshV1> {
    const revision = await this.resolveRevision(connectionId);
    const runtimeKind = revision.profile.runtimeKind;
    const cli = revision.profile.cli;
    let models: ModelCatalogEntryV1[] = [];
    if (runtimeKind === "opencode" && cli) {
      const outcome = await runBoundedCliCommand({
        command: cli.command,
        args: ["models", ...(providerId ? [providerId] : [])],
        cwd: cli.cwd,
        // The approved allowlist is merged ON TOP of the host environment
        // (a bare allowlist would strip PATH and break the spawn).
        env: { ...process.env, ...this.resolvedEnv(revision) },
      });
      if (outcome.ok) {
        models = parseOpenCodeModelLines(outcome.stdout, providerId);
      }
    } else if (runtimeKind === "codex" && cli) {
      models = await this.discovery.discoverCodexModels(cli.command);
    }
    return {
      connectionId,
      revisionNumber: revision.revisionNumber,
      runtimeKind,
      catalog: {
        sourceId: connectionId,
        discoveredAt: new Date().toISOString(),
        models,
      },
    };
  }

  private resolvedEnv(revision: ConnectionRevisionV1): Record<string, string> {
    const profile = this.sessionProfile(revision);
    return profile.env ?? {};
  }

  /** Auth methods for one provider of one connection (OpenCode Server API). */
  async getRuntimeProviderAuthMethods(
    connectionId: string,
    providerId: string,
  ): Promise<ProviderAuthMethodsV1> {
    const revision = await this.resolveRevision(connectionId);
    const runtimeKind = revision.profile.runtimeKind;
    let methods: OpenCodeProviderAuthMethodV1[] = [];
    if (runtimeKind === "opencode") {
      this.requireOpenCode(revision);
      try {
        methods = await withOpenCodeSession(this.sessionProfile(revision), async (session) => {
          const byProvider = await session.authMethods();
          return byProvider[providerId] ?? [];
        });
      } catch (error) {
        throw new ProviderDiscoveryError(
          "OPENCODE_SERVER_FAILED",
          String((error as Error).message),
        );
      }
    }
    return { connectionId, revisionNumber: revision.revisionNumber, runtimeKind, providerId, methods };
  }

  /** Begin the runtime-owned auth flow for one provider of one connection.
   *  Resolves the EXACT current revision, starts a LIVE management server
   *  (RETAINED — never closed here; the flow owns its lifecycle), fetches
   *  the fresh auth-method snapshot, VALIDATES the methodIndex and prompt
   *  support BEFORE any authorize call, then performs POST authorize.
   *  The same live session completes the flow (OpenCode pending state is
   *  instance-local). */
  async beginAuthFlow(input: {
    connectionId: string;
    providerId: string;
    methodIndex: number;
  }): Promise<{
    authFlowId: string;
    url: string;
    method: "auto" | "code";
    instructions: string | null;
    connectionId: string;
    connectionRevision: number;
    providerId: string;
  }> {
    const revision = await this.resolveRevision(input.connectionId);
    this.requireOpenCode(revision);
    if (
      !Number.isInteger(input.methodIndex) ||
      input.methodIndex < 0 ||
      input.methodIndex > 32
    ) {
      throw new ProviderDiscoveryError(
        "INVALID_METHOD_INDEX",
        "method index must be a bounded non-negative integer",
      );
    }
    const session = await OpenCodeManagementSession.start(
      this.sessionProfile(revision),
    );
    try {
      const methodsByProvider = await session.authMethods();
      const methods = methodsByProvider[input.providerId] ?? [];
      const method = methods.find(
        (candidate) => candidate.methodIndex === input.methodIndex,
      );
      if (!method) {
        await session.close();
        throw new ProviderDiscoveryError(
          "INVALID_METHOD_INDEX",
          `method index ${input.methodIndex} is not in the auth-method snapshot for ${input.providerId}`,
        );
      }
      if (method.requiresPrompt) {
        // Fail closed: never authorize with missing required inputs and
        // never collect credentials. The guided runtime-owned fallback
        // (opencode auth login --provider <id>) is the supported path.
        await session.close();
        throw new ProviderDiscoveryError(
          "AUTH_METHOD_UNSUPPORTED",
          `auth method "${method.label}" requires prompt inputs Tenvyr does not drive — use the official login command instead`,
        );
      }
      const authorization = await session.authorize(
        input.providerId,
        input.methodIndex,
      );
      const flow = this.authFlows.begin({
        connectionId: input.connectionId,
        connectionRevision: revision.revisionNumber,
        providerId: input.providerId,
        methodIndex: input.methodIndex,
        methods,
        session,
        authorization,
      });
      return {
        authFlowId: flow.authFlowId,
        url: authorization.url,
        method: authorization.method,
        instructions: authorization.instructions,
        connectionId: input.connectionId,
        connectionRevision: revision.revisionNumber,
        providerId: input.providerId,
      };
    } catch (error) {
      await session.close();
      if (
        error instanceof OpenCodeAuthFlowError ||
        error instanceof OpenCodeServerError
      ) {
        throw new ProviderDiscoveryError(
          error instanceof OpenCodeAuthFlowError &&
            error.code === "AUTH_METHOD_UNSUPPORTED"
            ? "AUTH_METHOD_UNSUPPORTED"
            : "OPENCODE_SERVER_FAILED",
          String((error as Error).message),
        );
      }
      throw error;
    }
  }

  /** Complete the runtime-owned flow through the SAME live session that
   *  performed authorize; proves connected via a refreshed GET /provider;
   *  then closes the server and removes the flow. */
  async completeAuthFlow(
    authFlowId: string,
    code?: string,
  ): Promise<{ connected: boolean; providerId: string; connectionId: string }> {
    return this.authFlows.complete(authFlowId, code);
  }

  /** Cancel: deterministic cleanup of the live management session. */
  async cancelAuthFlow(authFlowId: string): Promise<{ cancelled: boolean }> {
    return { cancelled: await this.authFlows.cancel(authFlowId) };
  }

  /**
   * Test Runtime Target: a SMALL BOUNDED REAL INVOCATION through the
   * connection's frozen run argv (revision cli.args) + the runtime
   * template's fixed modelArgvPrefix + the requested model id, with a
   * bounded "respond exactly OK" prompt. Never an orchestrator-side
   * inference call; never catalog enumeration passed off as a test.
   */
  async testRuntimeTarget(
    connectionId: string,
    modelId: string,
  ): Promise<TestTargetEvidenceV1> {
    const revision = await this.resolveRevision(connectionId);
    const runtimeKind = revision.profile.runtimeKind;
    const cli = revision.profile.cli;
    if (!cli) {
      throw new ProviderDiscoveryError(
        "RUNTIME_NOT_SUPPORTED",
        `connection "${connectionId}" has no CLI profile`,
      );
    }
    if (!isBoundedModelId(modelId)) {
      throw new ProviderDiscoveryError("INVALID_MODEL_ID", "model id is out of bounds");
    }
    const template = RUNTIME_PROFILE_TEMPLATES[runtimeKind as keyof typeof RUNTIME_PROFILE_TEMPLATES];
    const modelArgvPrefix = template?.modelArgvPrefix ?? [];
    if (modelArgvPrefix.length === 0) {
      // Fail closed: this runtime cannot take a requested model.
      throw new ProviderDiscoveryError(
        "MODEL_NOT_SUPPORTED",
        `runtime "${runtimeKind}" has no model argument contract`,
      );
    }
    const argv: string[] = [...cli.args, ...modelArgvPrefix, modelId];
    const usesStdin = cli.args.includes("-");
    if (!usesStdin) {
      argv.push(TEST_TARGET_BOUNDS.prompt);
    }

    const startedAt = Date.now();
    const outcome = await this.runBoundedInvocation({
      command: cli.command,
      args: argv,
      cwd: cli.cwd,
      env: this.resolvedEnv(revision),
      stdin: usesStdin ? TEST_TARGET_BOUNDS.prompt : undefined,
    });
    return {
      connectionId,
      revisionNumber: revision.revisionNumber,
      runtimeKind,
      requestedModelId: modelId,
      status: outcome.ok ? "ok" : "failed",
      exitCode: outcome.exitCode,
      durationMs: Date.now() - startedAt,
      outputTruncated: outcome.outputTruncated,
    };
  }

  /** Bounded no-shell invocation with optional stdin and strict
   *  escalation/caps (same safety contract as the CLI probe). */
  private runBoundedInvocation(input: {
    command: string;
    args: string[];
    cwd?: string;
    env: Record<string, string>;
    stdin?: string;
    wallTimeMs?: number;
    maxOutputBytes?: number;
  }): Promise<{
    ok: boolean;
    exitCode: number | null;
    outputTruncated: boolean;
  }> {
    const wallTimeMs = input.wallTimeMs ?? TEST_TARGET_BOUNDS.wallTimeMs;
    const maxOutputBytes = input.maxOutputBytes ?? TEST_TARGET_BOUNDS.maxOutputBytes;
    return new Promise((resolve) => {
      const child = spawn(input.command, input.args, {
        cwd: input.cwd,
        env: { ...process.env, ...input.env },
        shell: false,
        detached: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdoutBytes = 0;
      let outputTruncated = false;
      let timedOut = false;
      let settled = false;
      const timers: NodeJS.Timeout[] = [];
      const settle = (outcome: { ok: boolean; exitCode: number | null; outputTruncated: boolean }): void => {
        if (settled) return;
        settled = true;
        for (const timer of timers) clearTimeout(timer);
        resolve(outcome);
      };
      const killGroup = (signal: "SIGTERM" | "SIGKILL"): void => {
        if (child.pid === undefined || child.exitCode !== null) return;
        try {
          process.kill(-child.pid, signal);
        } catch {
          // already gone
        }
      };
      child.stdout?.on("data", (chunk: Buffer) => {
        stdoutBytes += chunk.length;
        if (stdoutBytes > maxOutputBytes) {
          outputTruncated = true;
          child.stdout?.pause();
        }
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stdoutBytes += chunk.length;
        if (stdoutBytes > maxOutputBytes * 2) {
          outputTruncated = true;
          child.stderr?.pause();
        }
      });
      child.once("error", () => settle({ ok: false, exitCode: null, outputTruncated }));
      child.once("exit", (code) =>
        settle({ ok: !timedOut && code === 0, exitCode: code, outputTruncated }),
      );
      if (input.stdin !== undefined) {
        child.stdin.on("error", () => {
          /* EPIPE when the child exits early */
        });
        child.stdin.write(input.stdin, () => child.stdin.end());
      } else {
        child.stdin.end();
      }
      timers.push(
        setTimeout(() => {
          timedOut = true;
          killGroup("SIGTERM");
          timers.push(
            setTimeout(() => {
              killGroup("SIGKILL");
            }, 1000),
          );
        }, wallTimeMs),
      );
    });
  }
}
