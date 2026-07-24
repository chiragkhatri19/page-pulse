export interface RateLimitDecision {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** Unix seconds at which the bucket is full again. */
  resetAt: number;
  retryAfterSeconds: number;
}

interface Bucket {
  tokens: number;
  lastRefill: number;
}

/**
 * Token bucket rather than a fixed window. A fixed window lets a client spend
 * its whole quota at 11:59:59 and again at 12:00:00, producing a 2x burst at
 * the boundary. A token bucket refills continuously and smooths that out while
 * still permitting a legitimate burst up to the bucket capacity.
 */
export class TokenBucketRateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly capacity: number;
  private readonly windowMs: number;
  private readonly refillPerMs: number;
  private readonly now: () => number;

  constructor(opts: { max: number; windowSeconds: number; now?: () => number }) {
    this.capacity = opts.max;
    this.windowMs = opts.windowSeconds * 1000;
    this.refillPerMs = opts.max / this.windowMs;
    this.now = opts.now ?? Date.now;
  }

  consume(key: string, cost = 1): RateLimitDecision {
    const now = this.now();
    const bucket = this.buckets.get(key) ?? { tokens: this.capacity, lastRefill: now };

    const elapsed = now - bucket.lastRefill;
    if (elapsed > 0) {
      bucket.tokens = Math.min(this.capacity, bucket.tokens + elapsed * this.refillPerMs);
      bucket.lastRefill = now;
    }

    const allowed = bucket.tokens >= cost;
    if (allowed) bucket.tokens -= cost;
    this.buckets.set(key, bucket);

    const deficit = allowed ? 0 : cost - bucket.tokens;
    const retryAfterMs = deficit > 0 ? deficit / this.refillPerMs : 0;
    const msUntilFull = ((this.capacity - bucket.tokens) / this.refillPerMs) || 0;

    return {
      allowed,
      limit: this.capacity,
      remaining: Math.max(0, Math.floor(bucket.tokens)),
      resetAt: Math.ceil((now + msUntilFull) / 1000),
      retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)),
    };
  }

  /** Drops buckets that have refilled completely; called on an interval. */
  sweep(): number {
    const now = this.now();
    let removed = 0;
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.lastRefill > this.windowMs * 2) {
        this.buckets.delete(key);
        removed++;
      }
    }
    return removed;
  }

  get size(): number {
    return this.buckets.size;
  }

  reset(): void {
    this.buckets.clear();
  }
}

/**
 * Identity for limiting. An API key is a real identity; an IP is a weak proxy
 * for one, so it is only the fallback. `x-forwarded-for` is trusted only
 * because deployment terminates at a proxy we control.
 */
export function clientKeyFrom(headers: Record<string, unknown>, socketIp: string | undefined): string {
  const apiKey = headers['x-api-key'];
  if (typeof apiKey === 'string' && apiKey.trim().length > 0) return `key:${apiKey.trim()}`;

  const fwd = headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length > 0) {
    const first = fwd.split(',')[0]?.trim();
    if (first) return `ip:${first}`;
  }
  return `ip:${socketIp ?? 'unknown'}`;
}
