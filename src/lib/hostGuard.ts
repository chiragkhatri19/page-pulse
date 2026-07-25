export class HostConcurrencyError extends Error {
  constructor(readonly host: string) {
    super(`Too many concurrent audits for ${host}`);
    this.name = 'HostConcurrencyError';
  }
}

export class HostCircuitOpenError extends Error {
  constructor(
    readonly host: string,
    readonly retryAfterSeconds: number,
  ) {
    super(`Target host ${host} is temporarily unavailable after repeated failures`);
    this.name = 'HostCircuitOpenError';
  }
}

export interface HostGuardOptions {
  maxConcurrentPerHost: number;
  failureThreshold: number;
  cooldownMs: number;
  now?: () => number;
}

interface HostState {
  inFlight: number;
  consecutiveFailures: number;
  circuitOpenedUntil: number;
}

export interface HostGuardStats {
  trackedHosts: number;
  openCircuits: number;
}

/**
 * Prevents one unhealthy target hostname from consuming every global audit
 * permit. Task B moves this to Redis for cross-replica coordination; the
 * single-node build still gets the same bulkhead behavior locally.
 */
export class HostGuard {
  private readonly states = new Map<string, HostState>();
  private readonly now: () => number;

  constructor(private readonly opts: HostGuardOptions) {
    this.now = opts.now ?? Date.now;
  }

  get stats(): HostGuardStats {
    const now = this.now();
    let openCircuits = 0;
    for (const state of this.states.values()) {
      if (state.circuitOpenedUntil > now) openCircuits++;
    }
    return { trackedHosts: this.states.size, openCircuits };
  }

  stateFor(host: string): Readonly<HostState> | undefined {
    return this.states.get(this.key(host));
  }

  async run<T>(host: string, fn: () => Promise<T>, countsAsFailure: (err: unknown) => boolean): Promise<T> {
    const key = this.key(host);
    const state = this.getOrCreate(key);
    const now = this.now();

    if (state.circuitOpenedUntil > now) {
      const retryAfterSeconds = Math.max(1, Math.ceil((state.circuitOpenedUntil - now) / 1000));
      throw new HostCircuitOpenError(key, retryAfterSeconds);
    }
    if (state.inFlight >= this.opts.maxConcurrentPerHost) {
      throw new HostConcurrencyError(key);
    }

    state.inFlight++;
    try {
      const result = await fn();
      state.consecutiveFailures = 0;
      state.circuitOpenedUntil = 0;
      return result;
    } catch (err) {
      if (countsAsFailure(err)) {
        state.consecutiveFailures++;
        if (state.consecutiveFailures >= this.opts.failureThreshold) {
          state.circuitOpenedUntil = this.now() + this.opts.cooldownMs;
        }
      }
      throw err;
    } finally {
      state.inFlight--;
      this.prune(key, state);
    }
  }

  private getOrCreate(key: string): HostState {
    const existing = this.states.get(key);
    if (existing) return existing;
    const created: HostState = { inFlight: 0, consecutiveFailures: 0, circuitOpenedUntil: 0 };
    this.states.set(key, created);
    return created;
  }

  private prune(key: string, state: HostState): void {
    if (state.inFlight === 0 && state.consecutiveFailures === 0 && state.circuitOpenedUntil <= this.now()) {
      this.states.delete(key);
    }
  }

  private key(host: string): string {
    return host.toLowerCase();
  }
}

export function derivePerHostLimit(globalLimit: number, requested: number): number {
  if (requested > 0) return requested;
  return Math.max(2, Math.ceil(globalLimit * 0.15));
}
