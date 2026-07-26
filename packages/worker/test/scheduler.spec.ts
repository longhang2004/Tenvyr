import { RunScheduler } from "../src/invocation/run-scheduler";

type Deferred = {
  promise: Promise<void>;
  resolve(): void;
};

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("bounded FIFO scheduler", () => {
  it("enforces concurrency and starts queued work FIFO", async () => {
    const scheduler = new RunScheduler({ concurrency: 2, maxQueuedRuns: 2 });
    const gates = [deferred(), deferred(), deferred(), deferred()];
    const started: number[] = [];

    for (let index = 0; index < 4; index += 1) {
      expect(
        scheduler.enqueue({
          run: async () => {
            started.push(index);
            await gates[index].promise;
          },
          cancel: jest.fn(),
        }),
      ).toBe(true);
    }
    await new Promise((resolve) => setImmediate(resolve));
    expect(started).toEqual([0, 1]);

    gates[0].resolve();
    await new Promise((resolve) => setImmediate(resolve));
    expect(started).toEqual([0, 1, 2]);

    gates[1].resolve();
    await new Promise((resolve) => setImmediate(resolve));
    expect(started).toEqual([0, 1, 2, 3]);
    gates[2].resolve();
    gates[3].resolve();
    await scheduler.onIdle();
  });

  it("rejects when active slots and queue are full", async () => {
    const scheduler = new RunScheduler({ concurrency: 1, maxQueuedRuns: 1 });
    const gate = deferred();
    expect(
      scheduler.enqueue({ run: () => gate.promise, cancel: jest.fn() }),
    ).toBe(true);
    expect(
      scheduler.enqueue({ run: async () => undefined, cancel: jest.fn() }),
    ).toBe(true);
    expect(
      scheduler.enqueue({ run: async () => undefined, cancel: jest.fn() }),
    ).toBe(false);
    gate.resolve();
    await scheduler.onIdle();
  });

  it("continues after a handler error and releases completed slots", async () => {
    const scheduler = new RunScheduler({ concurrency: 1, maxQueuedRuns: 1 });
    const second = jest.fn();
    scheduler.enqueue({
      run: async () => {
        throw new Error("handler failed");
      },
      cancel: jest.fn(),
    });
    scheduler.enqueue({ run: async () => second(), cancel: jest.fn() });

    await scheduler.onIdle();

    expect(second).toHaveBeenCalledTimes(1);
  });

  it("stops accepting and cancels queued but not active work", async () => {
    const scheduler = new RunScheduler({ concurrency: 1, maxQueuedRuns: 2 });
    const gate = deferred();
    const activeCancel = jest.fn();
    const queuedCancel = jest.fn();
    scheduler.enqueue({ run: () => gate.promise, cancel: activeCancel });
    scheduler.enqueue({ run: async () => undefined, cancel: queuedCancel });
    await new Promise((resolve) => setImmediate(resolve));

    await scheduler.stopAccepting();

    expect(
      scheduler.enqueue({ run: async () => undefined, cancel: jest.fn() }),
    ).toBe(false);
    expect(activeCancel).not.toHaveBeenCalled();
    expect(queuedCancel).toHaveBeenCalledTimes(1);
    gate.resolve();
    await scheduler.onIdle();
  });
});
