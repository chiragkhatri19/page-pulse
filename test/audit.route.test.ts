import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { closeFetcher } from '../src/lib/fetcher.js';
import { startFixtureServer, type Fixture } from './fixtures/server.js';

let fixture: Fixture;

const baseEnv = {
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  ALLOW_PRIVATE_TARGETS: 'true',
  RATE_LIMIT_MAX: '1000',
  CACHE_TTL_SECONDS: '300',
};

const makeApp = (overrides: Record<string, string> = {}) =>
  buildServer({ config: loadConfig({ ...baseEnv, ...overrides } as NodeJS.ProcessEnv) });

beforeAll(async () => {
  fixture = await startFixtureServer();
});

afterAll(async () => {
  await fixture.close();
  await closeFetcher();
});

describe('POST /v1/audit', () => {
  it('audits a real page and returns a scored report', async () => {
    const app = makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/audit',
      payload: { url: `${fixture.origin}/good` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.report.http.status).toBe(200);
    expect(body.report.score.overall).toBeGreaterThan(0);
    expect(body.report.score.overall).toBeLessThanOrEqual(100);
    expect(body.report.facts.title).toBe('A perfectly reasonable page title');
    expect(Object.keys(body.report.score.pillars).sort()).toEqual([
      'accessibility',
      'performance',
      'security',
      'seo',
    ]);
    expect(body.requestId).toBeTruthy();
    await app.close();
  });

  it('reports timing and payload size for the fetch', async () => {
    const app = makeApp();
    const body = (
      await app.inject({ method: 'POST', url: '/v1/audit', payload: { url: `${fixture.origin}/good` } })
    ).json();
    expect(body.report.http.ttfbMs).toBeGreaterThanOrEqual(0);
    expect(body.report.http.bytes).toBeGreaterThan(100);
    expect(body.durationMs).toBeGreaterThanOrEqual(0);
    await app.close();
  });

  it('serves a repeat audit from cache without touching the origin', async () => {
    const app = makeApp();
    const url = `${fixture.origin}/good?cache-probe=1`;

    const first = await app.inject({ method: 'POST', url: '/v1/audit', payload: { url } });
    const hitsAfterFirst = fixture.hits();
    const second = await app.inject({ method: 'POST', url: '/v1/audit', payload: { url } });

    expect(first.headers['x-cache']).toBe('MISS');
    expect(second.headers['x-cache']).toBe('HIT');
    expect(second.json().cache.hit).toBe(true);
    expect(fixture.hits()).toBe(hitsAfterFirst);
    // A cached report is byte-identical to the one that produced it.
    expect(second.json().report).toEqual(first.json().report);
    await app.close();
  });

  it('bypasses and refreshes the cache when fresh is set', async () => {
    const app = makeApp();
    const url = `${fixture.origin}/good?fresh-probe=1`;

    await app.inject({ method: 'POST', url: '/v1/audit', payload: { url } });
    const before = fixture.hits();
    const res = await app.inject({ method: 'POST', url: '/v1/audit', payload: { url, fresh: true } });

    expect(res.headers['x-cache']).toBe('MISS');
    expect(fixture.hits()).toBe(before + 1);
    await app.close();
  });

  it('skips caching entirely when the window is configured to zero', async () => {
    const app = makeApp({ CACHE_TTL_SECONDS: '0' });
    const url = `${fixture.origin}/good?nocache=1`;

    await app.inject({ method: 'POST', url: '/v1/audit', payload: { url } });
    const before = fixture.hits();
    const res = await app.inject({ method: 'POST', url: '/v1/audit', payload: { url } });

    expect(res.headers['x-cache']).toBe('MISS');
    expect(fixture.hits()).toBe(before + 1);
    await app.close();
  });

  it('collapses a burst on one cold URL into a single origin fetch', async () => {
    const app = makeApp();
    const url = `${fixture.origin}/good?burst=1`;
    const before = fixture.hits();

    const responses = await Promise.all(
      Array.from({ length: 12 }, () =>
        app.inject({ method: 'POST', url: '/v1/audit', payload: { url } }),
      ),
    );

    expect(responses.every((r) => r.statusCode === 200)).toBe(true);
    expect(fixture.hits()).toBe(before + 1);
    await app.close();
  });

  it('follows a redirect and reports the final URL', async () => {
    const app = makeApp();
    const body = (
      await app.inject({
        method: 'POST',
        url: '/v1/audit',
        payload: { url: `${fixture.origin}/redirect` },
      })
    ).json();
    expect(body.report.redirected).toBe(true);
    expect(body.report.finalUrl).toContain('/good');
    await app.close();
  });

  it('still grades a page that returns 5xx, marking the status check failed', async () => {
    const app = makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/audit',
      payload: { url: `${fixture.origin}/boom` },
    });
    expect(res.statusCode).toBe(200);
    const checks = res.json().report.checks;
    expect(checks.find((c: { id: string }) => c.id === 'seo.status').passed).toBe(false);
    await app.close();
  });
});

describe('GET /v1/audit', () => {
  it('accepts the URL as a query parameter', async () => {
    const app = makeApp();
    const res = await app.inject({
      method: 'GET',
      url: `/v1/audit?url=${encodeURIComponent(`${fixture.origin}/good`)}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().report.score.grade).toMatch(/^[A-F]$/);
    await app.close();
  });

  it('honours fresh=true from the query string', async () => {
    const app = makeApp();
    const target = encodeURIComponent(`${fixture.origin}/good?q-fresh=1`);
    await app.inject({ method: 'GET', url: `/v1/audit?url=${target}` });
    const before = fixture.hits();
    await app.inject({ method: 'GET', url: `/v1/audit?url=${target}&fresh=true` });
    expect(fixture.hits()).toBe(before + 1);
    await app.close();
  });
});

describe('input validation and error contract', () => {
  it('rejects a missing url with a structured 400', async () => {
    const app = makeApp();
    const res = await app.inject({ method: 'POST', url: '/v1/audit', payload: {} });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error.code).toBe('VALIDATION_FAILED');
    expect(body.error.requestId).toBeTruthy();
    expect(body.error.details[0].field).toBe('url');
    await app.close();
  });

  it.each([
    ['ftp://example.com', 'unsupported protocol'],
    ['not a url at all', 'unparseable'],
    ['https://user:pw@example.com', 'embedded credentials'],
  ])('rejects %s', async (url) => {
    const app = makeApp();
    const res = await app.inject({ method: 'POST', url: '/v1/audit', payload: { url } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_FAILED');
    await app.close();
  });

  it('rejects an oversized url string before doing any work', async () => {
    const app = makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/audit',
      payload: { url: `https://example.com/${'a'.repeat(3000)}` },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('rejects a private target with 422 when the SSRF guard is active', async () => {
    const app = makeApp({ ALLOW_PRIVATE_TARGETS: 'false' });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/audit',
      payload: { url: 'http://169.254.169.254/latest/meta-data/' },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('URL_NOT_ALLOWED');
    await app.close();
  });

  it('returns 415 for a non-HTML content type', async () => {
    const app = makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/audit',
      payload: { url: `${fixture.origin}/json` },
    });
    expect(res.statusCode).toBe(415);
    expect(res.json().error.code).toBe('UNSUPPORTED_CONTENT_TYPE');
    await app.close();
  });

  it('returns 504 when the target stalls past the timeout', async () => {
    const app = makeApp({ AUDIT_TIMEOUT_MS: '600', FETCH_HEADERS_TIMEOUT_MS: '600' });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/audit',
      payload: { url: `${fixture.origin}/slow` },
    });
    expect(res.statusCode).toBe(504);
    expect(res.json().error.code).toBe('TARGET_TIMEOUT');
    await app.close();
  });

  it('sheds same-host work once the per-host concurrency cap is reached', async () => {
    const app = makeApp({
      AUDIT_TIMEOUT_MS: '600',
      FETCH_HEADERS_TIMEOUT_MS: '600',
      CACHE_TTL_SECONDS: '0',
      MAX_CONCURRENT_AUDITS: '5',
      MAX_CONCURRENT_AUDITS_PER_HOST: '1',
    });

    const responses = await Promise.all([
      app.inject({ method: 'POST', url: '/v1/audit', payload: { url: `${fixture.origin}/slow?host-cap=1` } }),
      app.inject({ method: 'POST', url: '/v1/audit', payload: { url: `${fixture.origin}/slow?host-cap=2` } }),
    ]);

    expect(responses.map((r) => r.statusCode).sort()).toEqual([503, 504]);
    expect(responses.find((r) => r.statusCode === 503)?.json().error.code).toBe('CAPACITY_EXCEEDED');
    await app.close();
  });

  it('opens a host circuit after repeated target timeouts', async () => {
    const app = makeApp({
      AUDIT_TIMEOUT_MS: '600',
      FETCH_HEADERS_TIMEOUT_MS: '600',
      CACHE_TTL_SECONDS: '0',
      HOST_CIRCUIT_FAILURE_THRESHOLD: '1',
      HOST_CIRCUIT_COOLDOWN_MS: '60000',
    });

    const first = await app.inject({
      method: 'POST',
      url: '/v1/audit',
      payload: { url: `${fixture.origin}/slow?circuit=1` },
    });
    const second = await app.inject({
      method: 'POST',
      url: '/v1/audit',
      payload: { url: `${fixture.origin}/good?circuit=2` },
    });

    expect(first.statusCode).toBe(504);
    expect(second.statusCode).toBe(502);
    expect(second.json().error.code).toBe('TARGET_UNREACHABLE');
    expect(second.headers['retry-after']).toBeDefined();
    await app.close();
  });

  it('returns 502 when the target refuses the connection', async () => {
    const app = makeApp({ AUDIT_TIMEOUT_MS: '2000' });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/audit',
      payload: { url: 'http://127.0.0.1:1/' },
    });
    expect(res.statusCode).toBe(502);
    expect(res.json().error.code).toBe('TARGET_UNREACHABLE');
    await app.close();
  });

  it('returns a structured 404 for an unknown route', async () => {
    const app = makeApp();
    const res = await app.inject({ method: 'GET', url: '/v1/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
    await app.close();
  });

  it('rejects malformed JSON without leaking a stack trace', async () => {
    const app = makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/audit',
      headers: { 'content-type': 'application/json' },
      payload: '{"url": ',
    });
    expect(res.statusCode).toBe(400);
    expect(res.payload).not.toContain('at ');
    await app.close();
  });
});

describe('rate limiting', () => {
  it('returns 429 with retry guidance once the bucket is empty', async () => {
    const app = makeApp({ RATE_LIMIT_MAX: '2', RATE_LIMIT_WINDOW_SECONDS: '60' });
    const url = `${fixture.origin}/good?rl=1`;

    const first = await app.inject({ method: 'POST', url: '/v1/audit', payload: { url } });
    const second = await app.inject({ method: 'POST', url: '/v1/audit', payload: { url } });
    const third = await app.inject({ method: 'POST', url: '/v1/audit', payload: { url } });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(third.statusCode).toBe(429);
    expect(third.json().error.code).toBe('RATE_LIMITED');
    expect(third.json().error.retryAfterSeconds).toBeGreaterThan(0);
    expect(third.headers['retry-after']).toBeDefined();
    await app.close();
  });

  it('advertises the limit on every audit response', async () => {
    const app = makeApp({ RATE_LIMIT_MAX: '5' });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/audit',
      payload: { url: `${fixture.origin}/good` },
    });
    expect(res.headers['x-ratelimit-limit']).toBe('5');
    expect(Number(res.headers['x-ratelimit-remaining'])).toBe(4);
    await app.close();
  });

  it('buckets separately per API key', async () => {
    const app = makeApp({ RATE_LIMIT_MAX: '1' });
    const url = `${fixture.origin}/good?rlkey=1`;

    const a1 = await app.inject({ method: 'POST', url: '/v1/audit', headers: { 'x-api-key': 'tenant-a' }, payload: { url } });
    const a2 = await app.inject({ method: 'POST', url: '/v1/audit', headers: { 'x-api-key': 'tenant-a' }, payload: { url } });
    const b1 = await app.inject({ method: 'POST', url: '/v1/audit', headers: { 'x-api-key': 'tenant-b' }, payload: { url } });

    expect(a1.statusCode).toBe(200);
    expect(a2.statusCode).toBe(429);
    expect(b1.statusCode).toBe(200);
    await app.close();
  });

  it('never rate limits the health probe', async () => {
    const app = makeApp({ RATE_LIMIT_MAX: '1' });
    for (let i = 0; i < 5; i++) {
      expect((await app.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
    }
    await app.close();
  });
});

describe('observability surface', () => {
  it('echoes a caller-supplied request ID so traces stitch together', async () => {
    const app = makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/audit',
      headers: { 'x-request-id': 'trace-abc-123' },
      payload: { url: `${fixture.origin}/good` },
    });
    expect(res.headers['x-request-id']).toBe('trace-abc-123');
    expect(res.json().requestId).toBe('trace-abc-123');
    await app.close();
  });

  it('mints a request ID when the caller does not supply one', async () => {
    const app = makeApp();
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.headers['x-request-id']).toMatch(/[0-9a-f-]{36}/);
    await app.close();
  });

  it('carries the request ID into error responses', async () => {
    const app = makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/audit',
      headers: { 'x-request-id': 'err-trace-1' },
      payload: {},
    });
    expect(res.json().error.requestId).toBe('err-trace-1');
    await app.close();
  });

  it('reports liveness and readiness', async () => {
    const app = makeApp();
    expect((await app.inject({ method: 'GET', url: '/healthz' })).json().status).toBe('ok');
    expect((await app.inject({ method: 'GET', url: '/readyz' })).json().status).toBe('ready');
    await app.close();
  });

  it('exposes cache, concurrency and rate limit counters', async () => {
    const app = makeApp();
    await app.inject({ method: 'POST', url: '/v1/audit', payload: { url: `${fixture.origin}/good?stats=1` } });
    await app.inject({ method: 'POST', url: '/v1/audit', payload: { url: `${fixture.origin}/good?stats=1` } });

    const stats = (await app.inject({ method: 'GET', url: '/v1/stats' })).json();
    expect(stats.cache.hits).toBeGreaterThanOrEqual(1);
    expect(stats.cache.entries).toBeGreaterThanOrEqual(1);
    expect(stats.concurrency.limit).toBeGreaterThan(0);
    expect(stats.rateLimit.trackedClients).toBeGreaterThanOrEqual(1);
    await app.close();
  });

  it('serves the landing page with the required attribution', async () => {
    const app = makeApp();
    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(200);
    expect(res.payload).toContain('Digital Heroes Training Task');
    expect(res.payload).toContain('digitalheroesco.com');
    await app.close();
  });
});
