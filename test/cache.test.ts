import { describe, expect, it, vi } from 'vitest';
import { MemoryCache, SingleFlight, cacheKeyFor } from '../src/lib/cache.js';

const clock = (start = 1_000_000) => {
  let now = start;
  return { now: () => now, advance: (ms: number) => (now += ms) };
};

describe('MemoryCache', () => {
  it('returns a stored value inside the window', async () => {
    const cache = new MemoryCache<string>({ maxEntries: 10 });
    await cache.set('a', 'value', 60);
    const hit = await cache.get('a');
    expect(hit?.value).toBe('value');
  });

  it('reports the age of a hit in whole seconds', async () => {
    const c = clock();
    const cache = new MemoryCache<string>({ maxEntries: 10, now: c.now });
    await cache.set('a', 'value', 60);
    c.advance(4_500);
    expect((await cache.get('a'))?.ageSeconds).toBe(4);
  });

  it('misses once the TTL has elapsed', async () => {
    const c = clock();
    const cache = new MemoryCache<string>({ maxEntries: 10, now: c.now });
    await cache.set('a', 'value', 5);
    c.advance(4_999);
    expect(await cache.get('a')).toBeDefined();
    c.advance(2);
    expect(await cache.get('a')).toBeUndefined();
    expect(cache.stats().expired).toBe(1);
  });

  it('does not store anything when the TTL is zero', async () => {
    const cache = new MemoryCache<string>({ maxEntries: 10 });
    await cache.set('a', 'value', 0);
    expect(cache.size()).toBe(0);
  });

  it('evicts the least recently used entry at capacity', async () => {
    const cache = new MemoryCache<string>({ maxEntries: 2 });
    await cache.set('a', '1', 60);
    await cache.set('b', '2', 60);
    await cache.get('a'); // 'a' is now the most recent, so 'b' should go
    await cache.set('c', '3', 60);

    expect(await cache.get('a')).toBeDefined();
    expect(await cache.get('b')).toBeUndefined();
    expect(await cache.get('c')).toBeDefined();
    expect(cache.stats().evictions).toBe(1);
  });

  it('tracks hit and miss counters', async () => {
    const cache = new MemoryCache<string>({ maxEntries: 5 });
    await cache.set('a', '1', 60);
    await cache.get('a');
    await cache.get('a');
    await cache.get('missing');
    expect(cache.stats()).toMatchObject({ hits: 2, misses: 1 });
  });

  it('supports explicit deletion and clearing', async () => {
    const cache = new MemoryCache<string>({ maxEntries: 5 });
    await cache.set('a', '1', 60);
    await cache.delete('a');
    expect(await cache.get('a')).toBeUndefined();
    await cache.set('b', '2', 60);
    await cache.clear();
    expect(cache.size()).toBe(0);
  });
});

describe('cacheKeyFor', () => {
  it('treats host casing and a missing trailing slash as the same page', () => {
    expect(cacheKeyFor(new URL('https://Example.COM'))).toBe(
      cacheKeyFor(new URL('https://example.com/')),
    );
  });

  it('keeps the query string, because it changes the page', () => {
    expect(cacheKeyFor(new URL('https://a.com/?x=1'))).not.toBe(cacheKeyFor(new URL('https://a.com/')));
  });

  it('separates http from https', () => {
    expect(cacheKeyFor(new URL('http://a.com/'))).not.toBe(cacheKeyFor(new URL('https://a.com/')));
  });

  it('is namespaced and versioned so a schema change cannot serve stale shapes', () => {
    expect(cacheKeyFor(new URL('https://a.com/'))).toMatch(/^audit:v1:/);
  });
});

describe('SingleFlight', () => {
  it('collapses concurrent calls for the same key into one execution', async () => {
    const sf = new SingleFlight<number>();
    const fn = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 20));
      return 42;
    });

    const results = await Promise.all([
      sf.run('k', fn),
      sf.run('k', fn),
      sf.run('k', fn),
      sf.run('k', fn),
    ]);

    expect(fn).toHaveBeenCalledTimes(1);
    expect(results.map((r) => r.value)).toEqual([42, 42, 42, 42]);
    expect(results.filter((r) => r.deduped)).toHaveLength(3);
  });

  it('runs different keys independently', async () => {
    const sf = new SingleFlight<string>();
    const fn = vi.fn(async (v: string) => v);
    await Promise.all([sf.run('a', () => fn('a')), sf.run('b', () => fn('b'))]);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('clears the in-flight entry after a rejection so the next call retries', async () => {
    const sf = new SingleFlight<number>();
    await expect(sf.run('k', async () => { throw new Error('upstream down'); })).rejects.toThrow();
    expect(sf.pending).toBe(0);
    await expect(sf.run('k', async () => 7)).resolves.toMatchObject({ value: 7 });
  });
});
