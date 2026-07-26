import type { AgentInvocationV1, AgentResultV1 } from '@agentweave/contracts';

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

export type AgentResultHandler = (message: AgentResultMessage) => Promise<void>;

export type AgentDispatchReceipt = {
  adapter: string;
  invocationId: string;
  dispatchedAt: string;
  messageKey?: string;
  dispatchId?: string;
};

export interface AgentAdapter {
  readonly kind: string;

  start(handler: AgentResultHandler): Promise<void>;

  stop(): Promise<void>;

  invoke(invocation: AgentInvocationV1): Promise<AgentDispatchReceipt>;
}
