import type { AgentInvocationV1, AgentResultV1, AgentEventV1 } from "@tenvyr/contracts";
import type { ExecutorDescriptorV1 } from "../executors/executor-descriptor";

export type AgentTransportMetadata = {
  adapter: string;
  receivedAt: string;
  messageKey?: string;
  topic?: string;
  partition?: number;
  offset?: string;
  deliveryId?: string;
  dispatchId?: string;
  keyId?: string;
  remoteAddress?: string;
};

export type AgentResultMessage = {
  result: AgentResultV1;
  transport: AgentTransportMetadata;
};

export type AgentEventMessage = {
  event: AgentEventV1;
  transport: AgentTransportMetadata;
};

export type AgentResultHandler = (message: AgentResultMessage) => Promise<void>;
export type AgentEventHandler = (message: AgentEventMessage) => Promise<void>;

/**
 * Transport-neutral application message handlers. Adapters only authenticate,
 * parse canonical protocol, attach safe scalar transport metadata, and call
 * the matching handler; they never contain supervision/watchdog policy.
 */
export type AgentAdapterHandlers = {
  result: AgentResultHandler;
  event: AgentEventHandler;
};

export type AgentDispatchReceipt = {
  adapter: string;
  invocationId: string;
  dispatchedAt: string;
  messageKey?: string;
  dispatchId?: string;
};

/**
 * M3-S2: best-effort cancel request for ONE dispatched invocation. The
 * executor is expected to treat this as idempotent (keyed by invocationId).
 */
export type AgentCancelRequest = {
  invocationId: string;
  executionId: string;
  /** Transport-neutral remote run identity from the dispatch receipt. */
  dispatchId?: string;
  reason: string;
};

/**
 * M3-S2: best-effort cancel outcome. `delivered` records whether the executor
 * acknowledged the request; it never reverses Tenvyr's committed cancellation
 * authority, and a missing/negative acknowledgement is recorded evidence, not
 * a state transition.
 */
export type AgentCancelReceipt = {
  adapter: string;
  invocationId: string;
  delivered: boolean;
  message?: string;
};

export interface AgentAdapter {
  readonly kind: string;

  start(handlers: AgentAdapterHandlers): Promise<void>;

  stop(): Promise<void>;

  /**
   * Dispatches an invocation. `pinned` is the executor descriptor frozen on
   * the attempt: when present, routing facts (executor kind and HTTP profile)
   * come from the pinned descriptor and the live configuration may only
   * resolve secret values for that exact profile. When absent, the legacy
   * live-configuration routing (agent name → transport) applies.
   */
  invoke(
    invocation: AgentInvocationV1,
    pinned?: ExecutorDescriptorV1,
  ): Promise<AgentDispatchReceipt>;

  /**
   * Optional capability: best-effort, idempotent cancellation of a dispatched
   * invocation. Method absence means the executor cannot be cancelled —
   * Tenvyr cancellation still commits, and the unsupported limitation is
   * recorded as durable evidence. Implementations must bound their own
   * runtime: a slow or failing cancel must never block Tenvyr's committed
   * cancellation.
   */
  cancel?(request: AgentCancelRequest): Promise<AgentCancelReceipt>;
}
