import { createHmac, timingSafeEqual } from 'crypto';
import { AgentAdapterError } from './agent-adapter.errors';

type HttpCallbackSignatureInput = {
  secret: string;
  timestamp?: string;
  deliveryId?: string;
  signature?: string;
  rawBody: Buffer;
  maxSkewSeconds: number;
  nowMs?: number;
};

export function createHttpCallbackSignature(
  secret: string,
  timestamp: string,
  deliveryId: string,
  rawBody: Buffer,
): string {
  const digest = createHmac('sha256', secret)
    .update(timestamp)
    .update('.')
    .update(deliveryId)
    .update('.')
    .update(rawBody)
    .digest('hex');
  return `v1=${digest}`;
}

export function verifyHttpCallbackSignature(input: HttpCallbackSignatureInput): void {
  const { timestamp, deliveryId, signature } = input;
  if (!timestamp || !/^\d+$/.test(timestamp) || !deliveryId || !signature || !/^v1=[a-f0-9]{64}$/.test(signature)) {
    throw unauthorized();
  }

  const nowSeconds = Math.floor((input.nowMs ?? Date.now()) / 1000);
  if (Math.abs(nowSeconds - Number(timestamp)) > input.maxSkewSeconds) throw unauthorized();

  const expected = createHttpCallbackSignature(input.secret, timestamp, deliveryId, input.rawBody);
  if (!constantTimeEqual(Buffer.from(signature), Buffer.from(expected))) throw unauthorized();
}

export function constantTimeEqual(actual: Buffer, expected: Buffer): boolean {
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function unauthorized(): AgentAdapterError {
  return new AgentAdapterError('CALLBACK_UNAUTHORIZED', 'http', 'HTTP callback authentication failed', {
    retryable: false,
  });
}
