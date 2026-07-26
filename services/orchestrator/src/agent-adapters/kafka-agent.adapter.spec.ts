import { ContractValidationError, type AgentInvocationV1, type AgentResultV1 } from '@agentweave/contracts';
import { KafkaAgentAdapter } from './kafka-agent.adapter';

const invocation: AgentInvocationV1 = {
  schemaVersion: '1',
  invocationId: 'step-execution-1:1',
  executionId: 'execution-1',
  stepExecutionId: 'step-execution-1',
  stepId: 'review',
  target: { agent: 'code-reviewer' },
  input: { code: 'TOP_SECRET' },
  attempt: 1,
  createdAt: '2026-07-26T00:00:00.000Z',
  deadlineAt: '2026-07-26T00:00:30.000Z',
  trace: {
    traceId: 'execution-1',
    correlationId: 'step-execution-1:1',
  },
};

const succeededResult: AgentResultV1 = {
  schemaVersion: '1',
  invocationId: 'step-execution-1:1',
  executionId: 'execution-1',
  stepExecutionId: 'step-execution-1',
  status: 'succeeded',
  output: { score: 100 },
  completedAt: '2026-07-26T00:00:01.000Z',
};

const kafkaMessage = (value: unknown, overrides: Record<string, unknown> = {}) =>
  ({
    topic: 'agentweave.agent.code-reviewer.result',
    partition: 2,
    message: {
      key: Buffer.from('execution-1'),
      value: Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)),
      timestamp: '1785024001000',
      offset: '42',
      attributes: 0,
      headers: { secret: Buffer.from('must-not-leak') },
    },
    heartbeat: jest.fn(),
    pause: jest.fn(),
    ...overrides,
  }) as any;

describe('KafkaAgentAdapter', () => {
  let kafka: {
    connect: jest.Mock;
    disconnect: jest.Mock;
    publish: jest.Mock;
    subscribe: jest.Mock;
  };
  let executionService: {
    getStepExecution: jest.Mock;
  };
  let resultHandler: jest.Mock;
  let adapter: KafkaAgentAdapter;
  let inbound: (payload: any) => Promise<void>;

  beforeEach(() => {
    kafka = {
      connect: jest.fn().mockResolvedValue(undefined),
      disconnect: jest.fn().mockResolvedValue(undefined),
      publish: jest.fn().mockResolvedValue(undefined),
      subscribe: jest.fn().mockImplementation(async (_topics, handler) => {
        inbound = handler;
      }),
    };
    executionService = {
      getStepExecution: jest.fn(),
    };
    resultHandler = jest.fn().mockResolvedValue(undefined);
    adapter = new KafkaAgentAdapter(kafka as any, executionService as any);
  });

  describe('contract and lifecycle', () => {
    it('exposes a stable adapter kind', () => {
      expect(adapter.kind).toBe('kafka');
    });

    it('starts once and does not register duplicate consumers', async () => {
      await adapter.start(resultHandler);
      await adapter.start(resultHandler);

      expect(kafka.connect).toHaveBeenCalledTimes(1);
      expect(kafka.subscribe).toHaveBeenCalledTimes(1);
      expect(kafka.subscribe.mock.calls[0][0]).toEqual([
        'agentweave.agent.code-reviewer.result',
        'agentweave.agent.observability.result',
      ]);
    });

    it('stops idempotently', async () => {
      await adapter.start(resultHandler);
      await adapter.stop();
      await adapter.stop();

      expect(kafka.disconnect).toHaveBeenCalledTimes(1);
    });

    it('rejects invoke before start with a structured retryable error', async () => {
      await expect(adapter.invoke(invocation)).rejects.toMatchObject({
        code: 'ADAPTER_NOT_STARTED',
        adapter: 'kafka',
        invocationId: invocation.invocationId,
        retryable: true,
      });
    });

    it('maps start failures without leaking broker details', async () => {
      kafka.connect.mockRejectedValue(new Error('password=secret broker.internal:9092'));

      await expect(adapter.start(resultHandler)).rejects.toMatchObject({
        code: 'ADAPTER_START_FAILED',
        adapter: 'kafka',
        retryable: true,
        message: 'Kafka agent adapter failed to start',
      });
    });

    it('cleans up a partial start so startup can be retried', async () => {
      kafka.subscribe.mockRejectedValueOnce(new Error('subscription failed'));

      await expect(adapter.start(resultHandler)).rejects.toMatchObject({
        code: 'ADAPTER_START_FAILED',
      });
      expect(kafka.disconnect).toHaveBeenCalledTimes(1);

      await expect(adapter.start(resultHandler)).resolves.toBeUndefined();
      expect(kafka.connect).toHaveBeenCalledTimes(2);
    });

    it('maps stop failures and permits a later retry', async () => {
      await adapter.start(resultHandler);
      kafka.disconnect.mockRejectedValueOnce(new Error('disconnect failed'));

      await expect(adapter.stop()).rejects.toMatchObject({
        code: 'ADAPTER_STOP_FAILED',
        adapter: 'kafka',
        retryable: true,
      });
      kafka.disconnect.mockResolvedValueOnce(undefined);
      await expect(adapter.stop()).resolves.toBeUndefined();
      expect(kafka.disconnect).toHaveBeenCalledTimes(2);
    });
  });

  describe('outbound', () => {
    beforeEach(async () => {
      await adapter.start(resultHandler);
    });

    it('publishes a valid invocation to the existing topic and key', async () => {
      await adapter.invoke(invocation);

      expect(kafka.publish).toHaveBeenCalledWith({
        topic: 'agentweave.agent.code-reviewer.task',
        key: 'execution-1',
        value: expect.any(String),
      });
    });

    it('round-trips every invocation field through JSON serialization', async () => {
      await adapter.invoke(invocation);

      expect(JSON.parse(kafka.publish.mock.calls[0][0].value)).toEqual(invocation);
    });

    it.each([
      ['invocationId', 'step-execution-1:1'],
      ['stepExecutionId', 'step-execution-1'],
      ['attempt', 1],
    ])('does not change %s', async (field, expected) => {
      await adapter.invoke(invocation);

      expect(JSON.parse(kafka.publish.mock.calls[0][0].value)[field]).toBe(expected);
    });

    it('rejects an invalid invocation before publish', async () => {
      await expect(adapter.invoke({ ...invocation, invocationId: '' })).rejects.toBeInstanceOf(ContractValidationError);
      expect(kafka.publish).not.toHaveBeenCalled();
    });

    it('maps serialization failures', async () => {
      const stringify = jest.spyOn(JSON, 'stringify').mockImplementationOnce(() => {
        throw new TypeError('serialization failed');
      });

      await expect(adapter.invoke(invocation)).rejects.toMatchObject({
        code: 'SERIALIZATION_FAILED',
        adapter: 'kafka',
        invocationId: invocation.invocationId,
        retryable: false,
      });
      stringify.mockRestore();
    });

    it('maps producer failures without swallowing them', async () => {
      kafka.publish.mockRejectedValue(new Error('broker unavailable'));

      await expect(adapter.invoke(invocation)).rejects.toMatchObject({
        code: 'DISPATCH_FAILED',
        adapter: 'kafka',
        invocationId: invocation.invocationId,
        retryable: true,
      });
    });

    it('returns a correlated dispatch receipt', async () => {
      const receipt = await adapter.invoke(invocation);

      expect(receipt).toMatchObject({
        adapter: 'kafka',
        invocationId: invocation.invocationId,
        messageKey: invocation.executionId,
      });
      expect(Date.parse(receipt.dispatchedAt)).not.toBeNaN();
    });

    it('does not log full invocation input', async () => {
      const log = jest.spyOn(console, 'log').mockImplementation();

      await adapter.invoke(invocation);

      expect(JSON.stringify(log.mock.calls)).not.toContain('TOP_SECRET');
      log.mockRestore();
    });
  });

  describe('inbound', () => {
    beforeEach(async () => {
      await adapter.start(resultHandler);
    });

    it('parses a v1 result and delivers it to the handler', async () => {
      await inbound(kafkaMessage(succeededResult));

      expect(resultHandler).toHaveBeenCalledWith(expect.objectContaining({ result: succeededResult }));
    });

    it.each([
      ['success', 'COMPLETED', undefined, 'succeeded'],
      ['failure', 'FAILED', 'runner unavailable', 'failed'],
    ])('normalizes a legacy %s result', async (_case, status, error, expectedStatus) => {
      executionService.getStepExecution.mockResolvedValue({
        id: 'step-execution-1',
        executionId: 'execution-1',
        stepId: 'review',
        attempt: 1,
      });

      await inbound(
        kafkaMessage({
          executionId: 'execution-1',
          stepId: 'review',
          status,
          ...(error ? { error } : { output: { score: 100 } }),
          attempt: 1,
          timestamp: '2026-07-26T00:00:01.000Z',
        }),
      );

      expect(resultHandler.mock.calls[0][0].result).toMatchObject({
        invocationId: 'step-execution-1:1',
        stepExecutionId: 'step-execution-1',
        status: expectedStatus,
      });
    });

    it('preserves v1 correlation', async () => {
      await inbound(kafkaMessage(succeededResult));

      expect(resultHandler.mock.calls[0][0].result).toMatchObject({
        invocationId: succeededResult.invocationId,
        executionId: succeededResult.executionId,
        stepExecutionId: succeededResult.stepExecutionId,
      });
    });

    it('does not crash or call the handler for invalid JSON', async () => {
      await expect(inbound(kafkaMessage('{not-json'))).resolves.toBeUndefined();
      expect(resultHandler).not.toHaveBeenCalled();
    });

    it('does not call the handler for an invalid v1 result', async () => {
      await inbound(kafkaMessage({ ...succeededResult, stepExecutionId: '' }));
      expect(resultHandler).not.toHaveBeenCalled();
    });

    it('does not call the handler when legacy context cannot be resolved', async () => {
      executionService.getStepExecution.mockResolvedValue(null);

      await inbound(
        kafkaMessage({
          executionId: 'execution-1',
          stepId: 'missing',
          status: 'COMPLETED',
          timestamp: '2026-07-26T00:00:01.000Z',
        }),
      );

      expect(resultHandler).not.toHaveBeenCalled();
    });

    it('logs malformed messages without raw payload or secrets', async () => {
      const error = jest.spyOn(console, 'error').mockImplementation();

      await inbound(kafkaMessage('{TOP_SECRET:not-json'));

      const logged = JSON.stringify(error.mock.calls);
      expect(logged).toContain('AgentResultV1');
      expect(logged).not.toContain('TOP_SECRET');
      expect(logged).not.toContain('must-not-leak');
      error.mockRestore();
    });

    it('maps handler failure and does not report successful processing', async () => {
      const error = jest.spyOn(console, 'error').mockImplementation();
      resultHandler.mockRejectedValue(new Error('processor failed'));

      await expect(inbound(kafkaMessage(succeededResult))).resolves.toBeUndefined();

      expect(error.mock.calls.flat()).toContainEqual(expect.objectContaining({ errorCode: 'RESULT_HANDLER_FAILED' }));
      error.mockRestore();
    });

    it('maps scalar metadata without leaking a raw Kafka record', async () => {
      await inbound(kafkaMessage(succeededResult));

      const receivedTransport = resultHandler.mock.calls[0][0].transport;
      expect(receivedTransport).toMatchObject({
        adapter: 'kafka',
        messageKey: 'execution-1',
        topic: 'agentweave.agent.code-reviewer.result',
        partition: 2,
        offset: '42',
      });
      expect(Object.keys(receivedTransport).sort()).toEqual(
        ['adapter', 'messageKey', 'offset', 'partition', 'receivedAt', 'topic'].sort(),
      );
    });
  });
});
