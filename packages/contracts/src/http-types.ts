import type { AgentInvocationV1 } from './types';

export type HttpAgentRunRequestV1 = {
  schemaVersion: '1';
  invocation: AgentInvocationV1;
  resultDelivery: {
    mode: 'callback';
    callbackUrl: string;
    authentication: {
      scheme: 'hmac-sha256';
      keyId: string;
    };
  };
};

export type HttpAgentRunAcceptedV1 = {
  schemaVersion: '1';
  invocationId: string;
  runId: string;
  status: 'accepted';
  acceptedAt: string;
};
