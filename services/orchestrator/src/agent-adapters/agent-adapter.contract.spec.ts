import * as fs from 'fs';
import * as path from 'path';
import { AgentAdapterError } from './agent-adapter.errors';

describe('AgentAdapter public contract', () => {
  it('keeps raw Kafka types out of transport-neutral public types', () => {
    const source = fs.readFileSync(path.resolve(__dirname, 'agent-adapter.types.ts'), 'utf8');
    expect(source).not.toMatch(/kafkajs|EachMessagePayload|Buffer|Consumer|Producer/);
  });

  it('retains a cause for diagnostics without exposing it in the message', () => {
    const cause = new Error('password=secret');
    const error = new AgentAdapterError('DISPATCH_FAILED', 'kafka', 'Kafka dispatch failed', {
      invocationId: 'invocation-1',
      retryable: true,
      cause,
    });

    expect(error).toMatchObject({
      code: 'DISPATCH_FAILED',
      adapter: 'kafka',
      invocationId: 'invocation-1',
      retryable: true,
      cause,
      message: 'Kafka dispatch failed',
    });
    expect(error.message).not.toContain('secret');
  });
});
