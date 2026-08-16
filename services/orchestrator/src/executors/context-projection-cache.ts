import type { TenvyrContextEnvelope } from "../domain/context-snapshot";
import type { ContextMetricsV1, EnvelopeMetricsV1 } from "../domain/context-bundle";

export const CONTEXT_PROJECTION_CACHE_BOUNDS = {
  /** Maximum distinct immutable bundles kept in memory. */
  maxEntries: 64,
  /** Maximum total canonical envelope bytes kept in memory. */
  maxTotalBytes: 4 * 1024 * 1024,
} as const;

export type ContextProjectionCacheEntry = {
  envelope: TenvyrContextEnvelope;
  /** ENVELOPE-DERIVED metrics only. The full-state metric
   *  `executionStateBytes` is NOT a function of the cached envelope and is
   *  deliberately excluded — it is recomputed against the CURRENT full
   *  execution state on every claim (a cache HIT across executions with
   *  different unselected state must never inherit another execution's
   *  full-state size). */
  metrics: EnvelopeMetricsV1;
  bytes: number;
};

export type ContextProjectionCacheStats = {
  hits: number;
  misses: number;
  entries: number;
  bytes: number;
};

/**
 * P3 — Context Projection Reuse (the ONE deterministic optimization).
 *
 * Content-addressed in-memory store of already-materialized immutable
 * context envelopes, keyed by the ContextBundle hash. The hash is computed
 * from canonical deterministic projection inputs, so identical inputs reuse
 * the already-materialized bounded projection instead of rebuilding the
 * 65,536-byte envelope + validation pass.
 *
 * - Deterministic and fail-closed by construction: entries are keyed by the
 *   content fingerprint; any load-bearing input change yields a different
 *   key (a miss), so no stale envelope can ever be served under the wrong
 *   hash. Wall-clock TTL plays no correctness role.
 * - Immutable on BOTH sides: `set` stores isolated deep clones of the
 *   caller's envelope and a defensive copy of the metrics, and `get` hands
 *   back isolated clones — a caller mutating its source after `set`, or a
 *   caller mutating a returned value, can never corrupt the stored entry.
 * - Never authority: this cache holds ONLY the immutable envelope + bounded
 *   envelope-derived metrics. Approvals, revocation, budget, deadline,
 *   policy, plan authority, health, and auth readiness NEVER enter it;
 *   every authority gate executes on every claim regardless of hit/miss.
 * - Process-local and disposable: correctness never depends on the cache —
 *   PostgreSQL attempts and the Capsule are the durable record; a restart
 *   simply starts an empty cache. LRU-ish eviction keeps memory bounded.
 */
export class ContextProjectionCache {
  private readonly entries = new Map<string, ContextProjectionCacheEntry>();
  private hits = 0;
  private misses = 0;

  get(hash: string): ContextProjectionCacheEntry | undefined {
    const entry = this.entries.get(hash);
    if (!entry) {
      this.misses++;
      return undefined;
    }
    this.hits++;
    // LRU touch: re-insert to move the entry to the newest position.
    this.entries.delete(hash);
    this.entries.set(hash, entry);
    // The stored envelope is immutable: callers receive an isolated deep
    // clone so downstream persistence can never mutate the cached entry.
    return {
      envelope: structuredClone(entry.envelope),
      metrics: { ...entry.metrics },
      bytes: entry.bytes,
    };
  }

  set(
    hash: string,
    envelope: TenvyrContextEnvelope,
    metrics: ContextMetricsV1,
  ): void {
    if (this.entries.has(hash)) return;
    const bytes = metrics.projectedBytes;
    // Fail closed on absurd growth: never cache something larger than the
    // whole cache budget.
    if (bytes > CONTEXT_PROJECTION_CACHE_BOUNDS.maxTotalBytes) return;
    // WRITE-side isolation: the caller keeps owning its mutable inputs.
    // Store a deep clone of the envelope and a defensive copy of the
    // envelope-derived metrics only (executionStateBytes is never cached).
    this.entries.set(hash, {
      envelope: structuredClone(envelope),
      metrics: {
        projectedBytes: metrics.projectedBytes,
        projectedCharacters: metrics.projectedCharacters,
        selectedContextItemCount: metrics.selectedContextItemCount,
        selectedArtifactCount: metrics.selectedArtifactCount,
      },
      bytes,
    });
    this.evict();
  }

  /** Total canonical envelope bytes currently held. */
  bytes(): number {
    let total = 0;
    for (const entry of this.entries.values()) total += entry.bytes;
    return total;
  }

  stats(): ContextProjectionCacheStats {
    return {
      hits: this.hits,
      misses: this.misses,
      entries: this.entries.size,
      bytes: this.bytes(),
    };
  }

  reset(): void {
    this.entries.clear();
    this.hits = 0;
    this.misses = 0;
  }

  private evict(): void {
    // Evict oldest entries first (Map insertion order) until both bounds
    // hold; a fresh oversized entry was already rejected above.
    while (
      this.entries.size > CONTEXT_PROJECTION_CACHE_BOUNDS.maxEntries ||
      this.bytes() > CONTEXT_PROJECTION_CACHE_BOUNDS.maxTotalBytes
    ) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
  }
}