import type { EnrichedNode } from "../shared/types.js";

interface CachedSnapshot {
  tree: EnrichedNode;
  version: number;
  fetchedAt: number;
  lastAccessed: number;
}

export const DEFAULT_SNAPSHOT_MAX_AGE_MS = 15 * 60 * 1000;
const MAX_ENTRIES = 30; // LRU eviction threshold

export interface SnapshotProvenance {
  snapshotAt: string;
  cacheAgeMs: number;
}

export interface CachedSnapshotHit extends SnapshotProvenance {
  tree: EnrichedNode;
}

export interface SnapshotCacheOptions {
  now?: () => number;
}

export class SnapshotCache {
  private cache = new Map<string, CachedSnapshot>();
  private currentVersion = 0;
  private readonly now: () => number;

  constructor({ now = Date.now }: SnapshotCacheOptions = {}) {
    this.now = now;
  }

  get version(): number {
    return this.currentVersion;
  }

  set(key: string, tree: EnrichedNode): SnapshotProvenance {
    // LRU eviction — remove oldest-accessed entry if at capacity
    if (this.cache.size >= MAX_ENTRIES && !this.cache.has(key)) {
      let oldestKey: string | null = null;
      let oldestTime = Infinity;
      for (const [candidateKey, entry] of this.cache) {
        if (entry.lastAccessed < oldestTime) {
          oldestTime = entry.lastAccessed;
          oldestKey = candidateKey;
        }
      }
      if (oldestKey) this.cache.delete(oldestKey);
    }

    const fetchedAt = this.now();
    this.cache.set(key, {
      tree,
      version: this.currentVersion,
      fetchedAt,
      lastAccessed: fetchedAt,
    });
    return { snapshotAt: new Date(fetchedAt).toISOString(), cacheAgeMs: 0 };
  }

  /**
   * Reuse a snapshot only when it is at most maxAgeMs old. Entries that are too
   * old for one caller stay available to callers that explicitly accept an
   * older snapshot.
   */
  get(key: string, maxAgeMs = DEFAULT_SNAPSHOT_MAX_AGE_MS): CachedSnapshotHit | null {
    const entry = this.cache.get(key);
    if (!entry) return null;
    const cacheAgeMs = Math.max(0, this.now() - entry.fetchedAt);
    if (this.isStale(entry, cacheAgeMs, maxAgeMs)) {
      if (entry.version < this.currentVersion) this.cache.delete(key);
      return null;
    }
    // Update access time for LRU
    entry.lastAccessed = this.now();
    return {
      tree: entry.tree,
      snapshotAt: new Date(entry.fetchedAt).toISOString(),
      cacheAgeMs,
    };
  }

  /** Invalidate all cached snapshots (call after mutations) */
  invalidateAll(): void {
    this.currentVersion++;
    this.cache.clear();
  }

  /** Invalidate a specific cache entry. */
  invalidate(key: string): void {
    this.cache.delete(key);
  }

  private isStale(entry: CachedSnapshot, cacheAgeMs: number, maxAgeMs: number): boolean {
    // Stale if version has advanced (mutations happened)
    if (entry.version < this.currentVersion) return true;
    // Callers control the acceptable age; zero is a cache bypass.
    if (cacheAgeMs > maxAgeMs || maxAgeMs === 0) return true;
    return false;
  }
}
