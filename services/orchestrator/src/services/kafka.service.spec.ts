import { KafkaService } from './kafka.service';

describe('KafkaService infrastructure wrapper', () => {
  let service: KafkaService;
  let producer: {
    connect: jest.Mock;
    disconnect: jest.Mock;
    send: jest.Mock;
  };
  let consumer: {
    connect: jest.Mock;
    disconnect: jest.Mock;
    subscribe: jest.Mock;
    run: jest.Mock;
  };

  beforeEach(() => {
    producer = {
      connect: jest.fn().mockResolvedValue(undefined),
      disconnect: jest.fn().mockResolvedValue(undefined),
      send: jest.fn().mockResolvedValue(undefined),
    };
    consumer = {
      connect: jest.fn().mockResolvedValue(undefined),
      disconnect: jest.fn().mockResolvedValue(undefined),
      subscribe: jest.fn().mockResolvedValue(undefined),
      run: jest.fn().mockResolvedValue(undefined),
    };
    service = new KafkaService();
    (service as any).producer = producer;
    (service as any).consumer = consumer;
  });

  it('connects producer and consumer', async () => {
    await service.connect();

    expect(producer.connect).toHaveBeenCalledTimes(1);
    expect(consumer.connect).toHaveBeenCalledTimes(1);
  });

  it('disconnects producer and consumer', async () => {
    await service.disconnect();

    expect(producer.disconnect).toHaveBeenCalledTimes(1);
    expect(consumer.disconnect).toHaveBeenCalledTimes(1);
  });

  it('publishes the supplied topic, key, and serialized value unchanged', async () => {
    await service.publish({
      topic: 'agentweave.agent.code-reviewer.task',
      key: 'execution-1',
      value: '{"schemaVersion":"1"}',
    });

    expect(producer.send).toHaveBeenCalledWith({
      topic: 'agentweave.agent.code-reviewer.task',
      messages: [
        {
          key: 'execution-1',
          value: '{"schemaVersion":"1"}',
        },
      ],
    });
  });

  it('subscribes to every supplied topic without replaying history', async () => {
    const handler = jest.fn();

    await service.subscribe(['result.one', 'result.two'], handler);

    expect(consumer.subscribe.mock.calls).toEqual([
      [{ topic: 'result.one', fromBeginning: false }],
      [{ topic: 'result.two', fromBeginning: false }],
    ]);
    expect(consumer.run).toHaveBeenCalledWith({
      eachMessage: handler,
    });
  });

  it('does not swallow producer failures', async () => {
    producer.send.mockRejectedValueOnce(new Error('producer unavailable'));

    await expect(
      service.publish({
        topic: 'task',
        key: 'execution-1',
        value: '{}',
      }),
    ).rejects.toThrow('producer unavailable');
  });
});
