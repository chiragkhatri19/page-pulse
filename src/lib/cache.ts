/**
 * Cache contract. The in-process implementation below is what ships today; a
 * Redis-backed implementation satisfying the same interface is what replaces it
 * once the service runs on more than one node (see ARCHITECTURE.md).
 */
export interface CacheStore<V> {
  get(key: string): Promise<CacheHit<V> | undefined>;
  set(key: string, value: V, ttlSeconds: number): Promise<void>;
  delete(key: string): Promise<void>;
  clear(): Promise<void>;
  size(): number;
  stats(): CacheStats;
}

export interface CacheHit<V> {
  value: V;
  /** Whole seconds until this entry expires. */
  ageSeconds: number;
  expiresAt: number;
}

export interface CacheStats {
  hits: number;
  misses: number;
  evictions: number;
  expired: number;
}

interface Entry<V> {
  value: V;
  expiresAt: number;
  storedAt: number;
}

/**
 * Map preserves insertion order, so the first key is the least recently used
 * provided we re-insert on every read. That gives O(1) LRU without a dep.
 */
export class MemoryCache<V> implements CacheStore<V> {
  private readonly map = new Map<string, Entry<V>>();
  private readonly maxEntries: number;
  private readonly now: () => number;
  private counters: CacheStats = { hits: 0, misses: 0, evictions: 0, expired: 0 };

  constructor(opts: { maxEntries: number; now?: () => number }) {
    this.maxEntries = opts.maxEntries;
    this.now = opts.now ?? Date.now;
  }

  async get(key: string): Promise<CacheHit<V> | undefined> {
    const entry = this.map.get(key);
    if (!entry) {
      this.counters.misses++;
      return undefined;
    }
    const now = this.now();
    if (entry.expiresAt <= now) {
      this.map.delete(key);
      this.counters.expired++;
      this.counters.misses++;
      return undefined;
    }
    // Refresh recency.
    this.map.delete(key);
    this.map.set(key, entry);
    this.counters.hits++;
    return {
      value: entry.value,
      ageSeconds: Math.floor((now - entry.storedAt) / 1000),
      expiresAt: entry.expiresAt,
    };
  }

  async set(key: string, value: V, ttlSeconds: number): Promise<void> {
    if (ttlSeconds <= 0) return; // caching disabled
    const now = this.now();
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, { value, storedAt: now, expiresAt: now + ttlSeconds * 1000 });

    while (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next();
      if (oldest.done) break;
      this.map.delete(oldest.value);
      this.counters.evictions++;
    }
  }

  async delete(key: string): Promise<void> {
    this.map.delete(key);
  }

  async clear(): Promise<void> {
    this.map.clear();
  }

  size(): number {
    return this.map.size;
  }

  stats(): CacheStats {
    return { ...this.counters };
  }
}

/**
 * Cache key. Deliberately normalises the URL so `https://a.com` and
 * `https://a.com/` and `HTTPS://A.com/` share one entry, but preserves the
 * query string because it changes the page.
 */
export function cacheKeyFor(url: URL): string {
  const host = url.host.toLowerCase();
  const path = url.pathname === '' ? '/' : url.pathname;
  return `audit:v1:${url.protocol}//${host}${path}${url.search}`;
}

/**
 * Collapses concurrent identical requests into a single upstream fetch. Without
 * this, a cold cache plus a 500-request burst on one URL means 500 outbound
 * fetches to a target we are supposed to be gentle with.
 */
export class SingleFlight<V> {
  private readonly inflight = new Map<string, Promise<V>>();

  async run(key: string, fn: () => Promise<V>): Promise<{ value: V; deduped: boolean }> {
    const existing = this.inflight.get(key);
    if (existing) return { value: await existing, deduped: true };

    const promise = fn().finally(() => this.inflight.delete(key));
    this.inflight.set(key, promise);
    return { value: await promise, deduped: false };
  }

  get pending(): number {
    return this.inflight.size;
  }
}
