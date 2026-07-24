export class QueueFullError extends Error {
  constructor() {
    super('Concurrency queue is full');
    this.name = 'QueueFullError';
  }
}

export class QueueTimeoutError extends Error {
  constructor() {
    super('Timed out waiting for a concurrency slot');
    this.name = 'QueueTimeoutError';
  }
}

interface Waiter {
  resolve: () => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout | undefined;
}

export interface SemaphoreOptions {
  permits: number;
  maxQueueDepth: number;
  queueTimeoutMs: number;
}

/**
 * Bounds how many outbound audits run at once. Two properties matter more than
 * the counting itself: the queue is bounded, so a burst fails fast instead of
 * building an unbounded backlog and dying on memory; and waiting is bounded, so
 * nobody sits in the queue past the point their client has given up.
 */
export class Semaphore {
  private readonly capacity: number;
  private readonly maxQueueDepth: number;
  private readonly queueTimeoutMs: number;
  private available: number;
  private readonly waiters: Waiter[] = [];

  constructor(opts: SemaphoreOptions) {
    this.capacity = opts.permits;
    this.available = opts.permits;
    this.maxQueueDepth = opts.maxQueueDepth;
    this.queueTimeoutMs = opts.queueTimeoutMs;
  }

  get inFlight(): number {
    return this.capacity - this.available;
  }

  get queueDepth(): number {
    return this.waiters.length;
  }

  private acquire(): Promise<void> {
    if (this.available > 0) {
      this.available--;
      return Promise.resolve();
    }
    if (this.waiters.length >= this.maxQueueDepth) {
      return Promise.reject(new QueueFullError());
    }
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, timer: undefined };
      if (this.queueTimeoutMs > 0) {
        waiter.timer = setTimeout(() => {
          const idx = this.waiters.indexOf(waiter);
          if (idx >= 0) this.waiters.splice(idx, 1);
          reject(new QueueTimeoutError());
        }, this.queueTimeoutMs);
        waiter.timer.unref?.();
      }
      this.waiters.push(waiter);
    });
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next) {
      if (next.timer) clearTimeout(next.timer);
      next.resolve();
      return;
    }
    this.available++;
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}

export const createSemaphore = (opts: SemaphoreOptions): Semaphore => new Semaphore(opts);
