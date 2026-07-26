type ScheduledRun = {
  run(): Promise<void>;
  cancel(): void | Promise<void>;
};

export class RunScheduler {
  private accepting = true;
  private active = 0;
  private readonly queue: ScheduledRun[] = [];
  private readonly idleWaiters = new Set<() => void>();
  private drainScheduled = false;

  constructor(
    private readonly options: { concurrency: number; maxQueuedRuns: number },
  ) {}

  enqueue(run: ScheduledRun): boolean {
    if (!this.accepting || !this.hasCapacity()) return false;
    this.queue.push(run);
    this.scheduleDrain();
    return true;
  }

  hasCapacity(): boolean {
    return (
      this.active + this.queue.length <
      this.options.concurrency + this.options.maxQueuedRuns
    );
  }

  async stopAccepting(): Promise<void> {
    this.accepting = false;
    const queued = this.queue.splice(0);
    await Promise.allSettled(queued.map((run) => run.cancel()));
    this.resolveIdle();
  }

  onIdle(): Promise<void> {
    if (this.active === 0 && this.queue.length === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.add(resolve));
  }

  private scheduleDrain(): void {
    if (this.drainScheduled) return;
    this.drainScheduled = true;
    setImmediate(() => {
      this.drainScheduled = false;
      this.drain();
    });
  }

  private drain(): void {
    while (
      this.accepting &&
      this.active < this.options.concurrency &&
      this.queue.length > 0
    ) {
      const run = this.queue.shift() as ScheduledRun;
      this.active += 1;
      void Promise.resolve()
        .then(() => run.run())
        .catch(() => undefined)
        .finally(() => {
          this.active -= 1;
          this.drain();
          this.resolveIdle();
        });
    }
    this.resolveIdle();
  }

  private resolveIdle(): void {
    if (this.active !== 0 || this.queue.length !== 0) return;
    for (const resolve of this.idleWaiters) resolve();
    this.idleWaiters.clear();
  }
}
