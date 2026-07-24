import { Agent, buildConnector, request } from 'undici';
import type { NormalisedTarget } from './ssrf.js';

export interface FetchResult {
  finalUrl: string;
  status: number;
  headers: Record<string, string>;
  html: string;
  bytes: number;
  truncated: boolean;
  timings: {
    /** Milliseconds until response headers arrived. */
    ttfbMs: number;
    /** Milliseconds until the body finished (or was cut off). */
    totalMs: number;
  };
}

export class FetchTimeoutError extends Error {
  constructor(message = 'Target did not respond within the timeout') {
    super(message);
    this.name = 'FetchTimeoutError';
  }
}

export class FetchTooLargeError extends Error {
  constructor(limit: number) {
    super(`Response body exceeded the ${limit} byte limit`);
    this.name = 'FetchTooLargeError';
  }
}

export class FetchNetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FetchNetworkError';
  }
}

/** A redirect hop landed on a target that failed SSRF validation. */
export class FetchSsrfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FetchSsrfError';
  }
}

export interface FetchOptions {
  headersTimeoutMs: number;
  totalTimeoutMs: number;
  maxBytes: number;
  maxRedirects: number;
  userAgent: string;
  signal?: AbortSignal;
  /**
   * Addresses already validated by the SSRF guard for the initial URL. Empty
   * means no pin is available (ALLOW_PRIVATE_TARGETS mode) and the platform
   * connector resolves DNS itself.
   */
  pinnedAddresses: string[];
  /** Re-runs SSRF validation for a redirect target, using the caller's config. */
  revalidateTarget: (url: URL) => Promise<NormalisedTarget>;
}

/**
 * DNS is resolved and validated exactly once by the SSRF guard. Everything
 * downstream must connect to that validated address rather than letting the
 * HTTP client re-resolve DNS itself — a second lookup between validation and
 * connect is a classic DNS-rebinding window (validate a public IP, then
 * connect to whatever the second lookup returns, e.g. cloud metadata). This
 * wraps undici's connector so it dials `address` while leaving `host`
 * untouched, which means TLS SNI and the HTTP Host header are still derived
 * from the original hostname exactly as undici would do by default.
 */
function pinnedConnect(address: string, timeoutMs: number): buildConnector.connector {
  const connector = buildConnector({ timeout: timeoutMs });
  return (options, callback) => connector({ ...options, hostname: address }, callback);
}

/**
 * One throwaway agent per hop rather than a shared pool. Pinning is
 * inherently connection-specific — "the address I validated for this
 * request" can legitimately differ hop to hop or request to request even for
 * the same hostname — and a shared pool keyed only by origin would either
 * leak a stale pinned address to a different validated target or need an
 * address-aware pool key. Traffic here is already bounded by
 * MAX_CONCURRENT_AUDITS plus single-flight and caching, so the extra
 * complexity of a pinned connection pool isn't worth it at this scale; a
 * pooled/keyed pinning agent is a reasonable follow-up if profiling ever
 * shows connection setup dominating latency.
 */
function buildHopDispatcher(address: string | undefined, opts: FetchOptions): Agent {
  return new Agent({
    headersTimeout: opts.headersTimeoutMs,
    bodyTimeout: opts.totalTimeoutMs,
    connections: 1,
    connect: address ? pinnedConnect(address, opts.headersTimeoutMs) : { timeout: opts.headersTimeoutMs },
  });
}

export async function closeFetcher(): Promise<void> {
  // No-op: agents are now created per hop and closed immediately after use,
  // so there is no persistent singleton to tear down. Kept exported so
  // existing callers (e.g. test teardown) don't need to change.
}

const isTimeoutish = (err: unknown): boolean => {
  const code = (err as { code?: string })?.code ?? '';
  const name = (err as { name?: string })?.name ?? '';
  return (
    name === 'AbortError' ||
    name === 'TimeoutError' ||
    code === 'UND_ERR_HEADERS_TIMEOUT' ||
    code === 'UND_ERR_BODY_TIMEOUT' ||
    code === 'UND_ERR_CONNECT_TIMEOUT' ||
    code === 'ETIMEDOUT'
  );
};

const REDIRECT_STATUS_CODES = new Set([300, 301, 302, 303, 307, 308]);

/**
 * Draining a body we don't want (a redirect, an over-limit response) can
 * surface an async 'error' event on the stream once destroyed. We're
 * discarding the body deliberately, so that error is expected noise, not a
 * real failure — swallow it rather than letting it become an unhandled
 * rejection.
 */
function safeDestroy(body: { on: (event: 'error', cb: (err: unknown) => void) => void; destroy: () => void }): void {
  body.on('error', () => {});
  body.destroy();
}

export async function fetchPage(url: URL, opts: FetchOptions): Promise<FetchResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.totalTimeoutMs);
  timer.unref?.();

  const onExternalAbort = () => controller.abort();
  opts.signal?.addEventListener('abort', onExternalAbort, { once: true });

  const started = process.hrtime.bigint();
  const elapsedMs = () => Number(process.hrtime.bigint() - started) / 1e6;

  try {
    const history: URL[] = [];
    let currentUrl = url;
    let currentAddresses = opts.pinnedAddresses;
    let hop = 0;

    for (;;) {
      history.push(currentUrl);
      const dispatcher = buildHopDispatcher(currentAddresses[0], opts);
      let res;
      try {
        res = await request(currentUrl, {
          method: 'GET',
          signal: controller.signal,
          dispatcher,
          headers: {
            'user-agent': opts.userAgent,
            accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5',
            'accept-encoding': 'gzip, deflate, br',
            'accept-language': 'en-US,en;q=0.9',
          },
        });
      } finally {
        void dispatcher.close();
      }

      const location = res.headers.location;
      const locationHeader = Array.isArray(location) ? location[0] : location;

      if (
        REDIRECT_STATUS_CODES.has(res.statusCode) &&
        locationHeader &&
        hop < opts.maxRedirects
      ) {
        safeDestroy(res.body);
        const nextUrl = new URL(locationHeader, currentUrl);
        nextUrl.hash = '';
        if (history.some((seen) => seen.toString() === nextUrl.toString())) {
          throw new FetchNetworkError('Redirect loop detected');
        }
        const validated = await opts.revalidateTarget(nextUrl);
        currentUrl = validated.url;
        currentAddresses = validated.addresses;
        hop += 1;
        continue;
      }

      const ttfbMs = elapsedMs();

      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(res.headers)) {
        headers[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : String(v ?? '');
      }

      // Refuse to buffer a 200 MB video just because someone pointed us at one.
      const declared = Number(headers['content-length'] ?? '0');
      if (Number.isFinite(declared) && declared > opts.maxBytes) {
        safeDestroy(res.body);
        throw new FetchTooLargeError(opts.maxBytes);
      }

      let bytes = 0;
      let truncated = false;
      const chunks: Buffer[] = [];
      for await (const chunk of res.body) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        if (bytes + buf.length > opts.maxBytes) {
          chunks.push(buf.subarray(0, opts.maxBytes - bytes));
          bytes = opts.maxBytes;
          truncated = true;
          safeDestroy(res.body);
          break;
        }
        chunks.push(buf);
        bytes += buf.length;
      }

      return {
        finalUrl: currentUrl.toString(),
        status: res.statusCode,
        headers,
        html: Buffer.concat(chunks).toString('utf8'),
        bytes,
        truncated,
        timings: { ttfbMs: Math.round(ttfbMs), totalMs: Math.round(elapsedMs()) },
      };
    }
  } catch (err) {
    if (err instanceof FetchSsrfError) throw err;
    if (err instanceof FetchTooLargeError) throw err;
    if (isTimeoutish(err)) throw new FetchTimeoutError();
    const code = (err as { code?: string })?.code;
    const message = (err as Error)?.message ?? 'Unknown network failure';
    throw new FetchNetworkError(code ? `${code}: ${message}` : message);
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onExternalAbort);
  }
}
