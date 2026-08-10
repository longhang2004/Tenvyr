import type { AgentInvocationV1, AgentResultV1, AgentEventV1 } from "@tenvyr/contracts";

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

export interface AgentAdapter {
  readonly kind: string;

  start(handlers: AgentAdapterHandlers): Promise<void>;

  stop(): Promise<void>;

  invoke(invocation: AgentInvocationV1): Promise<AgentDispatchReceipt>;
}
