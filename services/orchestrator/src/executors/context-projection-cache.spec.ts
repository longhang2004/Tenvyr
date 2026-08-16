import { ContextProjectionCache } from "./context-projection-cache";
import type { TenvyrContextEnvelope } from "../domain/context-snapshot";

const envelope = (value: unknown) =>
  ({
    tenvyr: {
      schemaVersion: 1,
      executionState: { version: 1, values: { key: value as never } },
      artifacts: [],
    },
  } as unknown) as TenvyrContextEnvelope;

const metrics = (projectedBytes: number) => ({
  projectedBytes,
  projectedCharacters: projectedBytes,
  selectedContextItemCount: 1,
  selectedArtifactCount: 0,
  executionStateBytes: projectedBytes * 2,
});

describe("P3 Context Projection Reuse cache", () => {
  it("MISS -> materialize + store; identical hash -> HIT -> same bytes", () => {
    const cache = new ContextProjectionCache();
    const hash = "a".repeat(64);
    expect(cache.get(hash)).toBeUndefined();
    expect(cache.stats().misses).toBe(1);

    cache.set(hash, envelope({ text: "hello" }), metrics(100));
    expect(cache.get(hash)?.metrics.projectedBytes).toBe(100);
    expect(cache.stats().hits).toBe(1);
    expect(cache.stats().entries).toBe(1);
    // The cached envelope is immutable: mutating a returned clone must not
    // corrupt the entry.
    const returned = cache.get(hash)!;
    (returned.envelope as any).tenvyr.executionState.values.key = "MUTATED";
    const again = cache.get(hash)!;
    expect((again.envelope as any).tenvyr.executionState.values.key).toEqual({
      text: "hello",
    });
  });

  it("different hashes never collide", () => {
    const cache = new ContextProjectionCache();
    cache.set("a".repeat(64), envelope(1), metrics(10));
    expect(cache.get("b".repeat(64))).toBeUndefined();
  });

  it("derives the spent total bytes and evicts old entries at the bounds", () => {
    const cache = new ContextProjectionCache();
    for (let index = 0; index < 100; index++) {
      cache.set(index.toString().padStart(64, "0"), envelope(index), metrics(100));
    }
    expect(cache.stats().entries).toBeLessThanOrEqual(64);
    expect(cache.bytes()).toBeLessThanOrEqual(4 * 1024 * 1024);
    // Oldest entries were evicted first (LRU-ish); the newest survives.
    expect(cache.get("0".repeat(64))).toBeUndefined();
    expect(cache.get("99".padStart(64, "0"))).toBeDefined();
  });

  it("refuses to cache a bundle larger than the whole budget", () => {
    const cache = new ContextProjectionCache();
    cache.set("a".repeat(64), envelope(1), metrics(5 * 1024 * 1024));
    expect(cache.stats().entries).toBe(0);
  });

  it("reset clears every entry and the counters", () => {
    const cache = new ContextProjectionCache();
    cache.set("a".repeat(64), envelope(1), metrics(10));
    cache.get("a".repeat(64));
    cache.reset();
    expect(cache.stats()).toEqual({ hits: 0, misses: 0, entries: 0, bytes: 0 });
    expect(cache.get("a".repeat(64))).toBeUndefined();
  });
});