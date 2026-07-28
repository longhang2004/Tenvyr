export type RunState =
  | "accepted"
  | "queued"
  | "running"
  | "callback_pending"
  | "delivered"
  | "callback_failed";

export type RunRecord = {
  invocationId: string;
  requestFingerprint: string;
  runId: string;
  acceptedAt: string;
  state: RunState;
  createdAtMs: number;
  updatedAtMs: number;
};

export class InMemoryIdempotencyStore {
  private readonly records = new Map<string, RunRecord>();

  constructor(
    private readonly options: { ttlMs: number; maxEntries: number },
  ) {}

  create(input: {
    invocationId: string;
    requestFingerprint: string;
    runId: string;
    acceptedAt: string;
    nowMs: number;
  }): RunRecord {
    const existing = this.records.get(input.invocationId);
    if (
      existing &&
      isExpiredTerminal(existing, input.nowMs, this.options.ttlMs)
    )
      this.records.delete(input.invocationId);
    else if (existing) throw new Error("Idempotency record already exists");
    if (this.records.size >= this.options.maxEntries) this.cleanup(input.nowMs);
    if (this.records.size >= this.options.maxEntries)
      throw new Error("Idempotency store capacity exhausted");
    const record: RunRecord = {
      invocationId: input.invocationId,
      requestFingerprint: input.requestFingerprint,
      runId: input.runId,
      acceptedAt: input.acceptedAt,
      state: "accepted",
      createdAtMs: input.nowMs,
      updatedAtMs: input.nowMs,
    };
    this.records.set(record.invocationId, record);
    return record;
  }

  lookup(
    invocationId: string,
    fingerprint: string,
    nowMs: number,
  ): { kind: "miss" } | { kind: "duplicate" | "conflict"; record: RunRecord } {
    const record = this.records.get(invocationId);
    if (!record) return { kind: "miss" };
    if (isExpiredTerminal(record, nowMs, this.options.ttlMs)) {
      this.records.delete(invocationId);
      return { kind: "miss" };
    }
    return {
      kind:
        record.requestFingerprint === fingerprint ? "duplicate" : "conflict",
      record,
    };
  }

  get(invocationId: string): RunRecord | undefined {
    return this.records.get(invocationId);
  }

  updateState(record: RunRecord, state: RunState, nowMs: number): void {
    record.state = state;
    record.updatedAtMs = nowMs;
  }

  cleanup(nowMs: number): void {
    for (const [invocationId, record] of this.records) {
      if (isExpiredTerminal(record, nowMs, this.options.ttlMs)) {
        this.records.delete(invocationId);
      }
    }
  }
}

function isExpiredTerminal(
  record: RunRecord,
  nowMs: number,
  ttlMs: number,
): boolean {
  return (
    (record.state === "delivered" || record.state === "callback_failed") &&
    record.updatedAtMs + ttlMs <= nowMs
  );
}
