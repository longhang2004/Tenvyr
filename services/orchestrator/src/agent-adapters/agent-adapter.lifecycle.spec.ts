import { AgentAdapterLifecycle } from './agent-adapter.lifecycle';

describe('AgentAdapterLifecycle', () => {
  let adapter: any;
  let resultService: any;
  let lifecycle: AgentAdapterLifecycle;

  beforeEach(() => {
    adapter = {
      start: jest.fn().mockResolvedValue(undefined),
      stop: jest.fn().mockResolvedValue(undefined),
    };
    resultService = {
      handle: jest.fn().mockResolvedValue(undefined),
    };
    lifecycle = new AgentAdapterLifecycle(adapter, resultService);
  });

  it('registers the application result handler at startup', async () => {
    await lifecycle.onModuleInit();

    expect(adapter.start).toHaveBeenCalledWith(expect.any(Function));
    const handler = adapter.start.mock.calls[0][0];
    const message = { result: {}, transport: {} };
    await handler(message);
    expect(resultService.handle).toHaveBeenCalledWith(message);
  });

  it('does not hide startup failures', async () => {
    adapter.start.mockRejectedValue(new Error('startup failed'));

    await expect(lifecycle.onModuleInit()).rejects.toThrow('startup failed');
  });

  it('stops the adapter during application shutdown', async () => {
    await lifecycle.onModuleDestroy();

    expect(adapter.stop).toHaveBeenCalledTimes(1);
  });
});
