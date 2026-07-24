import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { fetchPage, FetchSsrfError, type FetchOptions } from '../src/lib/fetcher.js';
import type { NormalisedTarget } from '../src/lib/ssrf.js';
import { startFixtureServer, type Fixture } from './fixtures/server.js';

const baseOpts = (overrides: Partial<FetchOptions> = {}): FetchOptions => ({
  headersTimeoutMs: 2000,
  totalTimeoutMs: 3000,
  maxBytes: 1_000_000,
  maxRedirects: 3,
  userAgent: 'PagePulse-Test/1.0',
  pinnedAddresses: [],
  revalidateTarget: async () => {
    throw new Error('revalidateTarget should not be called in this test');
  },
  ...overrides,
});

describe('fetchPage — DNS pinning', () => {
  let fixture: Fixture | undefined;

  afterEach(async () => {
    await fixture?.close();
    fixture = undefined;
  });

  it('dials the pre-validated address, not a freshly re-resolved one', async () => {
    fixture = await startFixtureServer();
    const port = new URL(fixture.origin).port;
    // `.invalid` is reserved by RFC 2606 to never resolve. If the fix didn't
    // pin the connection, undici would try to resolve this itself and fail
    // with ENOTFOUND before ever reaching the fixture server.
    const url = new URL(`http://page-pulse-pinning-test.invalid:${port}/good`);

    const result = await fetchPage(url, baseOpts({ pinnedAddresses: ['127.0.0.1'] }));

    expect(result.status).toBe(200);
    expect(result.html).toContain('Only one heading of rank one');
  });

  it('fails without a pin when the hostname does not resolve', async () => {
    fixture = await startFixtureServer();
    const port = new URL(fixture.origin).port;
    const url = new URL(`http://page-pulse-pinning-test.invalid:${port}/good`);

    await expect(fetchPage(url, baseOpts({ pinnedAddresses: [] }))).rejects.toThrow();
  });

  it('does not pin when pinnedAddresses is empty (ALLOW_PRIVATE_TARGETS mode)', async () => {
    fixture = await startFixtureServer();
    const url = new URL(`${fixture.origin}/good`);

    const result = await fetchPage(url, baseOpts({ pinnedAddresses: [] }));

    expect(result.status).toBe(200);
  });

  it('rejects a redirect hop that fails SSRF re-validation', async () => {
    fixture = await startFixtureServer();
    const url = new URL(`${fixture.origin}/redirect`);

    const revalidateTarget = async (u: URL): Promise<NormalisedTarget> => {
      throw new FetchSsrfError(`Target resolves to a private or reserved address: ${u}`);
    };

    await expect(
      fetchPage(url, baseOpts({ pinnedAddresses: ['127.0.0.1'], revalidateTarget })),
    ).rejects.toThrow(FetchSsrfError);
  });

  it('follows a redirect hop that passes SSRF re-validation and pins the new address', async () => {
    fixture = await startFixtureServer();
    const url = new URL(`${fixture.origin}/redirect`);

    const revalidateTarget = async (u: URL): Promise<NormalisedTarget> => ({
      url: u,
      addresses: ['127.0.0.1'],
    });

    const result = await fetchPage(url, baseOpts({ pinnedAddresses: ['127.0.0.1'], revalidateTarget }));

    expect(result.status).toBe(200);
    expect(result.finalUrl).toContain('/good');
  });

  it('stops following after maxRedirects hops and returns the last 3xx response', async () => {
    let hits = 0;
    const server = http.createServer((req, res) => {
      hits++;
      const n = Number(new URL(req.url ?? '/', 'http://localhost').searchParams.get('n') ?? '0');
      res.writeHead(302, { location: `/loop?n=${n + 1}` });
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;

    try {
      const url = new URL(`http://127.0.0.1:${port}/loop?n=0`);
      const revalidateTarget = async (u: URL): Promise<NormalisedTarget> => ({ url: u, addresses: ['127.0.0.1'] });

      const result = await fetchPage(
        url,
        baseOpts({ pinnedAddresses: ['127.0.0.1'], revalidateTarget, maxRedirects: 2 }),
      );

      expect(result.status).toBe(302);
      expect(hits).toBe(3); // initial request + 2 followed redirects, 3rd hop returned unfollowed
    } finally {
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    }
  });
});
