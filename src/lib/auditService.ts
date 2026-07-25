import type { Config } from '../config.js';
import {
  AppError,
  ErrorCode,
  urlNotAllowed,
  capacityExceeded,
  targetTemporarilyUnavailable,
} from '../errors.js';
import { analyze, type PageFacts, type CheckResult } from './analyze.js';
import { cacheKeyFor, SingleFlight, type CacheStore } from './cache.js';
import {
  fetchPage,
  FetchNetworkError,
  FetchSsrfError,
  FetchTimeoutError,
  FetchTooLargeError,
  type FetchResult,
} from './fetcher.js';
import { HostCircuitOpenError, HostConcurrencyError, type HostGuard } from './hostGuard.js';
import { score, type ScoreResult } from './score.js';
import { QueueFullError, QueueTimeoutError, type Semaphore } from './semaphore.js';
import { assertPublicTarget, normaliseUrl, type NormalisedTarget } from './ssrf.js';

export interface AuditReport {
  url: string;
  finalUrl: string;
  redirected: boolean;
  fetchedAt: string;
  http: {
    status: number;
    contentType: string | null;
    bytes: number;
    truncated: boolean;
    ttfbMs: number;
    totalMs: number;
  };
  score: ScoreResult;
  facts: PageFacts;
  checks: CheckResult[];
}

export interface AuditOutcome {
  report: AuditReport;
  cache: { hit: boolean; ageSeconds: number; ttlSeconds: number; deduped: boolean };
  durationMs: number;
}

export interface AuditRequest {
  url: string;
  /** Bypass the cache for this call and refresh the entry. */
  fresh?: boolean;
  /** Per-request override of the cache window, bounded by config. */
  ttlSeconds?: number;
  signal?: AbortSignal;
}

export class AuditService {
  constructor(
    private readonly deps: {
      config: Config;
      cache: CacheStore<AuditReport>;
      semaphore: Semaphore;
      singleFlight: SingleFlight<AuditReport>;
      hostGuard?: HostGuard;
      /** Injectable so tests can drive timing and failures deterministically. */
      fetchImpl?: typeof fetchPage;
      now?: () => number;
    },
  ) {}

  private get cfg(): Config {
    return this.deps.config;
  }

  async audit(req: AuditRequest): Promise<AuditOutcome> {
    const startedAt = process.hrtime.bigint();
    const url = this.validateTarget(req.url);
    const target = await this.guardSsrf(url);

    const ttlSeconds = this.resolveTtl(req.ttlSeconds);
    const key = cacheKeyFor(target.url);

    if (!req.fresh && ttlSeconds > 0) {
      const hit = await this.deps.cache.get(key);
      if (hit) {
        return {
          report: hit.value,
          cache: { hit: true, ageSeconds: hit.ageSeconds, ttlSeconds, deduped: false },
          durationMs: this.elapsed(startedAt),
        };
      }
    }

    const { value: report, deduped } = await this.deps.singleFlight.run(key, async () => {
      const produced = await this.runAudit(target, req.signal);
      if (ttlSeconds > 0) await this.deps.cache.set(key, produced, ttlSeconds);
      return produced;
    });

    return {
      report,
      cache: { hit: false, ageSeconds: 0, ttlSeconds, deduped },
      durationMs: this.elapsed(startedAt),
    };
  }

  private elapsed(startedAt: bigint): number {
    return Math.round(Number(process.hrtime.bigint() - startedAt) / 1e6);
  }

  private validateTarget(raw: string): URL {
    try {
      return normaliseUrl(raw);
    } catch (err) {
      throw new AppError({
        statusCode: 400,
        code: ErrorCode.VALIDATION_FAILED,
        message: (err as Error).message,
        details: { field: 'url' },
      });
    }
  }

  private async guardSsrf(url: URL): Promise<NormalisedTarget> {
    try {
      return await assertPublicTarget(url, { allowPrivate: this.cfg.ALLOW_PRIVATE_TARGETS });
    } catch (err) {
      throw urlNotAllowed((err as Error).message);
    }
  }

  /**
   * Re-validates a redirect hop with the same rules as the initial URL. A
   * redirect to a private address must be rejected exactly like a direct
   * request to one — otherwise the SSRF guard is a check on the URL a client
   * typed, not on where the audit actually goes.
   */
  private async revalidateHop(url: URL): Promise<NormalisedTarget> {
    try {
      return await assertPublicTarget(url, { allowPrivate: this.cfg.ALLOW_PRIVATE_TARGETS });
    } catch (err) {
      throw new FetchSsrfError((err as Error).message);
    }
  }

  /** Per-request TTL is honoured but clamped, so a client cannot pin a stale entry forever. */
  private resolveTtl(requested: number | undefined): number {
    const ceiling = this.cfg.CACHE_TTL_SECONDS;
    if (ceiling === 0) return 0;
    if (requested === undefined) return ceiling;
    return Math.max(0, Math.min(requested, ceiling * 4));
  }

  private async runAudit(target: NormalisedTarget, signal: AbortSignal | undefined): Promise<AuditReport> {
    const fetchImpl = this.deps.fetchImpl ?? fetchPage;
    const url = target.url;

    let fetched: FetchResult;
    try {
      const fetchWithGlobalLimit = () =>
        this.deps.semaphore.run(() =>
          fetchImpl(url, {
            headersTimeoutMs: this.cfg.FETCH_HEADERS_TIMEOUT_MS,
            totalTimeoutMs: this.cfg.AUDIT_TIMEOUT_MS,
            maxBytes: this.cfg.MAX_RESPONSE_BYTES,
            maxRedirects: this.cfg.MAX_REDIRECTS,
            userAgent: this.cfg.USER_AGENT,
            pinnedAddresses: target.addresses,
            revalidateTarget: (u) => this.revalidateHop(u),
            ...(signal ? { signal } : {}),
          }),
        );
      fetched = this.deps.hostGuard
        ? await this.deps.hostGuard.run(url.hostname, fetchWithGlobalLimit, (err) =>
            this.countsAgainstHost(err),
          )
        : await fetchWithGlobalLimit();
    } catch (err) {
      throw this.mapFetchError(err);
    }

    const contentType = fetched.headers['content-type'] ?? null;
    if (contentType && !/(text\/html|application\/xhtml)/i.test(contentType)) {
      throw new AppError({
        statusCode: 415,
        code: ErrorCode.UNSUPPORTED_CONTENT_TYPE,
        message: `Target returned "${contentType}". Page Pulse audits HTML documents.`,
      });
    }

    const { facts, checks } = analyze(fetched);

    return {
      url: url.toString(),
      finalUrl: fetched.finalUrl,
      redirected: fetched.finalUrl !== url.toString(),
      fetchedAt: new Date(this.deps.now?.() ?? Date.now()).toISOString(),
      http: {
        status: fetched.status,
        contentType,
        bytes: fetched.bytes,
        truncated: fetched.truncated,
        ttfbMs: fetched.timings.ttfbMs,
        totalMs: fetched.timings.totalMs,
      },
      score: score(checks),
      facts,
      checks,
    };
  }

  private mapFetchError(err: unknown): AppError {
    if (err instanceof AppError) return err;
    if (err instanceof HostConcurrencyError) return capacityExceeded();
    if (err instanceof HostCircuitOpenError) {
      return targetTemporarilyUnavailable(err.message, err.retryAfterSeconds);
    }
    if (err instanceof QueueFullError || err instanceof QueueTimeoutError) return capacityExceeded();
    if (err instanceof FetchSsrfError) return urlNotAllowed(err.message);
    if (err instanceof FetchTimeoutError) {
      return new AppError({
        statusCode: 504,
        code: ErrorCode.TARGET_TIMEOUT,
        message: `Target did not respond within ${this.cfg.AUDIT_TIMEOUT_MS} ms.`,
      });
    }
    if (err instanceof FetchTooLargeError) {
      return new AppError({
        statusCode: 413,
        code: ErrorCode.TARGET_TOO_LARGE,
        message: err.message,
      });
    }
    if (err instanceof FetchNetworkError) {
      return new AppError({
        statusCode: 502,
        code: ErrorCode.TARGET_UNREACHABLE,
        message: `Could not reach the target. ${err.message}`,
      });
    }
    return new AppError({
      statusCode: 502,
      code: ErrorCode.TARGET_UNREACHABLE,
      message: 'Could not reach the target.',
    });
  }

  private countsAgainstHost(err: unknown): boolean {
    return err instanceof FetchTimeoutError || err instanceof FetchNetworkError;
  }
}
