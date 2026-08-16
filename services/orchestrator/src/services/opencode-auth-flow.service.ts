/**
 * P2 final closure: bounded OpenCode AUTH FLOW — ONE live management
 * session retained across begin -> operator completes -> complete.
 *
 * OpenCode stores the pending OAuth result in INSTANCE-LOCAL in-memory
 * state: the callback MUST target the same live `opencode serve` instance
 * that performed authorize. The flow owns the session lifecycle:
 *
 *   begin (resolve revision -> start server -> fetch methods -> validate
 *         methodIndex -> POST authorize {method} -> RETAIN session)
 *     -> bounded { authFlowId, url, method: auto|code, instructions }
 *   operator completes provider-owned flow
 *   complete (SAME session -> POST callback {method, code?} -> GET
 *         /provider -> prove connected -> close server -> remove flow)
 *
 * Bounds: cryptographically random opaque authFlowId, short TTL, max
 * active flows, one flow per (connection revision, provider), cancel
 * endpoint, deterministic cleanup, process cleanup on timeout. On process
 * restart in-memory flows fail closed (the OpenCode pending state is
 * gone) — the operator must start authentication again. The server stays
 * 127.0.0.1 with a random password; passwords/tokens/codes are never
 * returned, logged, or persisted.
 */
import { randomBytes } from "node:crypto";
import {
  OpenCodeManagementSession,
  type OpenCodeManagementProfile,
} from "./opencode-management.service";
import { OpenCodeServerError } from "../executors/opencode-server";

export type OpenCodeAuthFlowV1 = {
  authFlowId: string;
  connectionId: string;
  connectionRevision: number;
  providerId: string;
  methodIndex: number;
  authorizationMethod: "auto" | "code";
  instructions: string | null;
  expiresAt: number;
};

export class OpenCodeAuthFlowError extends Error {
  constructor(
    readonly code:
      | "AUTH_FLOW_NOT_FOUND"
      | "AUTH_FLOW_EXPIRED"
      | "AUTH_FLOW_LIMIT"
      | "AUTH_FLOW_CONFLICT"
      | "AUTH_METHOD_INVALID"
      | "AUTH_METHOD_UNSUPPORTED",
    message: string,
  ) {
    super(message);
    this.name = "OpenCodeAuthFlowError";
  }
}

type LiveFlow = OpenCodeAuthFlowV1 & {
  session: OpenCodeManagementSession;
};

export class OpenCodeAuthFlowService {
  static readonly FLOW_TTL_MS = 5 * 60_000;
  static readonly MAX_ACTIVE_FLOWS = 8;

  private readonly flows = new Map<string, LiveFlow>();

  constructor(
    private readonly ttlMs: number = OpenCodeAuthFlowService.FLOW_TTL_MS,
    private readonly maxFlows: number = OpenCodeAuthFlowService.MAX_ACTIVE_FLOWS,
  ) {}

  /** Close + drop expired flows (bounded sweep; also called opportunistically
   *  on every operation). */
  private sweepExpired(): void {
    const now = Date.now();
    for (const [authFlowId, flow] of this.flows) {
      if (flow.expiresAt <= now) {
        this.flows.delete(authFlowId);
        void flow.session.close();
      }
    }
  }

  /**
   * Register a flow bound to the EXACT (connection revision, provider,
   * methodIndex) with the LIVE session that performed authorize. Fails
   * closed when the method index is out of range or the method requires
   * prompt inputs Tenvyr will not drive.
   */
  begin(input: {
    connectionId: string;
    connectionRevision: number;
    providerId: string;
    methodIndex: number;
    methods: Array<{
      methodIndex: number;
      type: "oauth" | "api";
      label: string;
      requiresPrompt: boolean;
    }>;
    session: OpenCodeManagementSession;
    authorization: {
      url: string;
      method: "auto" | "code";
      instructions: string | null;
    };
  }): OpenCodeAuthFlowV1 {
    this.sweepExpired();
    const method = input.methods.find(
      (candidate) => candidate.methodIndex === input.methodIndex,
    );
    if (!method) {
      void input.session.close();
      throw new OpenCodeAuthFlowError(
        "AUTH_METHOD_INVALID",
        `method index ${input.methodIndex} is not in the auth-method snapshot`,
      );
    }
    if (method.requiresPrompt) {
      void input.session.close();
      throw new OpenCodeAuthFlowError(
        "AUTH_METHOD_UNSUPPORTED",
        `auth method "${method.label}" requires prompt inputs Tenvyr does not drive — use the official login command instead`,
      );
    }
    if (this.flows.size >= this.maxFlows) {
      void input.session.close();
      throw new OpenCodeAuthFlowError(
        "AUTH_FLOW_LIMIT",
        `too many active auth flows (max ${this.maxFlows})`,
      );
    }
    // One flow per (connection, provider): a concurrent flow for the same
    // target would split the pending state across instances.
    for (const existing of this.flows.values()) {
      if (
        existing.connectionId === input.connectionId &&
        existing.providerId === input.providerId
      ) {
        void input.session.close();
        throw new OpenCodeAuthFlowError(
          "AUTH_FLOW_CONFLICT",
          `an auth flow for ${input.providerId} on ${input.connectionId} is already active`,
        );
      }
    }
    const authFlowId = randomBytes(16).toString("hex");
    const flow: LiveFlow = {
      authFlowId,
      connectionId: input.connectionId,
      connectionRevision: input.connectionRevision,
      providerId: input.providerId,
      methodIndex: input.methodIndex,
      authorizationMethod: input.authorization.method,
      instructions: input.authorization.instructions,
      expiresAt: Date.now() + this.ttlMs,
      session: input.session,
    };
    this.flows.set(authFlowId, flow);
    return {
      authFlowId,
      connectionId: flow.connectionId,
      connectionRevision: flow.connectionRevision,
      providerId: flow.providerId,
      methodIndex: flow.methodIndex,
      authorizationMethod: flow.authorizationMethod,
      instructions: flow.instructions,
      expiresAt: flow.expiresAt,
    };
  }

  /** Complete the flow through the SAME live session; on any failure the
   *  flow is closed (fail closed — the pending state cannot be resumed). */
  async complete(
    authFlowId: string,
    code?: string,
  ): Promise<{ connected: boolean; providerId: string; connectionId: string }> {
    this.sweepExpired();
    const flow = this.flows.get(authFlowId);
    if (!flow) {
      throw new OpenCodeAuthFlowError(
        "AUTH_FLOW_NOT_FOUND",
        "auth flow is missing or expired — start authentication again",
      );
    }
    this.flows.delete(authFlowId);
    try {
      const completed = await flow.session.completeOauth(
        flow.providerId,
        flow.methodIndex,
        code,
      );
      if (!completed) {
        return {
          connected: false,
          providerId: flow.providerId,
          connectionId: flow.connectionId,
        };
      }
      const list = await flow.session.providers();
      return {
        connected: list.connected.includes(flow.providerId),
        providerId: flow.providerId,
        connectionId: flow.connectionId,
      };
    } catch (error) {
      if (error instanceof OpenCodeServerError) {
        return {
          connected: false,
          providerId: flow.providerId,
          connectionId: flow.connectionId,
        };
      }
      throw error;
    } finally {
      await flow.session.close();
    }
  }

  /** Cancel: close the management session and drop the flow. */
  async cancel(authFlowId: string): Promise<boolean> {
    this.sweepExpired();
    const flow = this.flows.get(authFlowId);
    if (!flow) return false;
    this.flows.delete(authFlowId);
    await flow.session.close();
    return true;
  }

  /** Deterministic process cleanup (also called on shutdown). */
  async closeAll(): Promise<void> {
    const flows = Array.from(this.flows.values());
    this.flows.clear();
    await Promise.all(flows.map((flow) => flow.session.close()));
  }

  activeCount(): number {
    this.sweepExpired();
    return this.flows.size;
  }
}

export function openCodeManagementProfileOf(
  command: string,
  cwd?: string,
  env?: Record<string, string>,
): OpenCodeManagementProfile {
  return { command, cwd, env };
}
