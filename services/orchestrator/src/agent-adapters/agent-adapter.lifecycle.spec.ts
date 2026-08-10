import { AgentAdapterLifecycle } from './agent-adapter.lifecycle';

describe('AgentAdapterLifecycle', () => {
  let adapter: any;
  let resultService: any;
  let eventService: any;
  let lifecycle: AgentAdapterLifecycle;

  beforeEach(() => {
    adapter = {
      start: jest.fn().mockResolvedValue(undefined),
      stop: jest.fn().mockResolvedValue(undefined),
    };
    resultService = {
      handle: jest.fn().mockResolvedValue(undefined),
    };
    eventService = {
      handle: jest.fn().mockResolvedValue(undefined),
    };
    lifecycle = new AgentAdapterLifecycle(adapter, resultService, eventService as any);
  });

  it('registers the application result and event handlers at startup', async () => {
    await lifecycle.onModuleInit();

    const handlers = adapter.start.mock.calls[0][0];
    expect(handlers).toEqual(
      expect.objectContaining({
        result: expect.any(Function),
        event: expect.any(Function),
      }),
    );
    const resultMessage = { result: {}, transport: {} };
    await handlers.result(resultMessage);
    expect(resultService.handle).toHaveBeenCalledWith(resultMessage);
    const eventMessage = { event: {}, transport: {} };
    await handlers.event(eventMessage);
    expect(eventService.handle).toHaveBeenCalledWith(eventMessage);
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
