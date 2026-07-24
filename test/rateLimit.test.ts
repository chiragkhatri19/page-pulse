import { describe, expect, it } from 'vitest';
import { TokenBucketRateLimiter, clientKeyFrom } from '../src/lib/rateLimit.js';
import { QueueFullError, QueueTimeoutError, createSemaphore } from '../src/lib/semaphore.js';

const clock = (start = 1_000_000) => {
  let now = start;
  return { now: () => now, advance: (ms: number) => (now += ms) };
};

describe('TokenBucketRateLimiter', () => {
  it('allows exactly the configured burst then denies', () => {
    const limiter = new TokenBucketRateLimiter({ max: 3, windowSeconds: 60, now: clock().now });
    expect(limiter.consume('a').allowed).toBe(true);
    expect(limiter.consume('a').allowed).toBe(true);
    expect(limiter.consume('a').allowed).toBe(true);
    expect(limiter.consume('a').allowed).toBe(false);
  });

  it('reports remaining tokens for the client headers', () => {
    const limiter = new TokenBucketRateLimiter({ max: 5, windowSeconds: 60, now: clock().now });
    limiter.consume('a');
    const decision = limiter.consume('a');
    expect(decision.limit).toBe(5);
    expect(decision.remaining).toBe(3);
  });

  it('refills continuously rather than in a cliff at the window edge', () => {
    const c = clock();
    const limiter = new TokenBucketRateLimiter({ max: 60, windowSeconds: 60, now: c.now });
    for (let i = 0; i < 60; i++) limiter.consume('a');
    expect(limiter.consume('a').allowed).toBe(false);

    c.advance(1_000); // one second refills exactly one token
    expect(limiter.consume('a').allowed).toBe(true);
    expect(limiter.consume('a').allowed).toBe(false);
  });

  it('never refills past capacity', () => {
    const c = clock();
    const limiter = new TokenBucketRateLimiter({ max: 4, windowSeconds: 10, now: c.now });
    limiter.consume('a');
    c.advance(10_000_000);
    for (let i = 0; i < 4; i++) expect(limiter.consume('a').allowed).toBe(true);
    expect(limiter.consume('a').allowed).toBe(false);
  });

  it('gives a retry-after that is long enough to actually succeed', () => {
    const c = clock();
    const limiter = new TokenBucketRateLimiter({ max: 2, windowSeconds: 60, now: c.now });
    limiter.consume('a');
    limiter.consume('a');
    const denied = limiter.consume('a');
    expect(denied.allowed).toBe(false);
    c.advance(denied.retryAfterSeconds * 1000);
    expect(limiter.consume('a').allowed).toBe(true);
  });

  it('isolates clients from each other', () => {
    const limiter = new TokenBucketRateLimiter({ max: 1, windowSeconds: 60, now: clock().now });
    expect(limiter.consume('a').allowed).toBe(true);
    expect(limiter.consume('a').allowed).toBe(false);
    expect(limiter.consume('b').allowed).toBe(true);
  });

  it('sweeps buckets that have long since refilled, bounding memory', () => {
    const c = clock();
    const limiter = new TokenBucketRateLimiter({ max: 5, windowSeconds: 60, now: c.now });
    limiter.consume('a');
    limiter.consume('b');
    expect(limiter.size).toBe(2);
    c.advance(200_000);
    expect(limiter.sweep()).toBe(2);
    expect(limiter.size).toBe(0);
  });
});

describe('clientKeyFrom', () => {
  it('prefers an API key, which is a real identity', () => {
    expect(clientKeyFrom({ 'x-api-key': 'abc', 'x-forwarded-for': '1.2.3.4' }, '10.0.0.1')).toBe(
      'key:abc',
    );
  });

  it('falls back to the first forwarded IP', () => {
    expect(clientKeyFrom({ 'x-forwarded-for': '1.2.3.4, 10.0.0.9' }, '10.0.0.1')).toBe('ip:1.2.3.4');
  });

  it('falls back to the socket address when no headers are present', () => {
    expect(clientKeyFrom({}, '9.9.9.9')).toBe('ip:9.9.9.9');
  });

  it('ignores a blank API key rather than bucketing everyone together', () => {
    expect(clientKeyFrom({ 'x-api-key': '   ' }, '9.9.9.9')).toBe('ip:9.9.9.9');
  });
});

describe('Semaphore', () => {
  it('never runs more than the permitted number at once', async () => {
    const sem = createSemaphore({ permits: 3, maxQueueDepth: 100, queueTimeoutMs: 1000 });
    let active = 0;
    let peak = 0;

    await Promise.all(
      Array.from({ length: 20 }, () =>
        sem.run(async () => {
          active++;
          peak = Math.max(peak, active);
          await new Promise((r) => setTimeout(r, 5));
          active--;
        }),
      ),
    );

    expect(peak).toBe(3);
    expect(sem.inFlight).toBe(0);
  });

  it('rejects fast once the queue is full instead of growing without bound', async () => {
    const sem = createSemaphore({ permits: 1, maxQueueDepth: 1, queueTimeoutMs: 5000 });
    const held = sem.run(() => new Promise((r) => setTimeout(r, 50)));
    const queued = sem.run(async () => 'queued');

    await expect(sem.run(async () => 'rejected')).rejects.toBeInstanceOf(QueueFullError);
    await Promise.all([held, queued]);
  });

  it('times out a request that waits too long for a slot', async () => {
    const sem = createSemaphore({ permits: 1, maxQueueDepth: 10, queueTimeoutMs: 20 });
    const held = sem.run(() => new Promise((r) => setTimeout(r, 200)));
    await expect(sem.run(async () => 'never')).rejects.toBeInstanceOf(QueueTimeoutError);
    await held;
  });

  it('releases the permit even when the task throws', async () => {
    const sem = createSemaphore({ permits: 1, maxQueueDepth: 10, queueTimeoutMs: 100 });
    await expect(sem.run(async () => { throw new Error('task failed'); })).rejects.toThrow();
    expect(sem.inFlight).toBe(0);
    await expect(sem.run(async () => 'ok')).resolves.toBe('ok');
  });

  it('exposes queue depth for readiness probes', async () => {
    const sem = createSemaphore({ permits: 1, maxQueueDepth: 10, queueTimeoutMs: 500 });
    const held = sem.run(() => new Promise((r) => setTimeout(r, 40)));
    const queued = sem.run(async () => 'q');
    expect(sem.queueDepth).toBe(1);
    await Promise.all([held, queued]);
    expect(sem.queueDepth).toBe(0);
  });
});
