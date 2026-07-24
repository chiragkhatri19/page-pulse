import { describe, expect, it } from 'vitest';
import {
  assertPublicTarget,
  isPrivateAddress,
  isPrivateIPv4,
  isPrivateIPv6,
  normaliseUrl,
} from '../src/lib/ssrf.js';

describe('normaliseUrl', () => {
  it('accepts a well-formed https URL unchanged', () => {
    expect(normaliseUrl('https://example.com/path?a=1').toString()).toBe(
      'https://example.com/path?a=1',
    );
  });

  it('defaults a bare hostname to https', () => {
    expect(normaliseUrl('example.com').protocol).toBe('https:');
  });

  it('strips the fragment, which never reaches the server anyway', () => {
    expect(normaliseUrl('https://example.com/a#section').toString()).toBe('https://example.com/a');
  });

  it('trims surrounding whitespace', () => {
    expect(normaliseUrl('  https://example.com  ').host).toBe('example.com');
  });

  it.each(['ftp://example.com', 'file:///etc/passwd', 'javascript:alert(1)', 'gopher://a.com'])(
    'rejects unsupported scheme %s',
    (value) => {
      expect(() => normaliseUrl(value)).toThrow();
    },
  );

  it('rejects embedded credentials, a classic filter bypass', () => {
    expect(() => normaliseUrl('https://user:pass@example.com')).toThrow(/credentials/i);
  });

  it('rejects unparseable input', () => {
    expect(() => normaliseUrl('http://')).toThrow();
  });
});

describe('private address detection', () => {
  it.each([
    '10.0.0.1',
    '127.0.0.1',
    '172.16.5.4',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254', // cloud instance metadata
    '0.0.0.0',
    '100.64.0.1',
    '224.0.0.1',
  ])('flags %s as private or reserved', (ip) => {
    expect(isPrivateIPv4(ip)).toBe(true);
  });

  it.each(['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.32.0.1', '172.15.0.1'])(
    'allows public address %s',
    (ip) => {
      expect(isPrivateIPv4(ip)).toBe(false);
    },
  );

  it.each(['::1', '::', 'fe80::1', 'fd00::1', 'ff02::1', '::ffff:10.0.0.1'])(
    'flags IPv6 %s as private',
    (ip) => {
      expect(isPrivateIPv6(ip)).toBe(true);
    },
  );

  it('allows a public IPv6 address', () => {
    expect(isPrivateIPv6('2606:4700:4700::1111')).toBe(false);
  });

  it('treats unparseable values as untrusted', () => {
    expect(isPrivateAddress('not-an-ip')).toBe(true);
  });
});

describe('assertPublicTarget', () => {
  const resolver = (map: Record<string, string[]>) => async (host: string) => {
    const addrs = map[host];
    if (!addrs) throw new Error('NXDOMAIN');
    return addrs.map((address) => ({ address }));
  };

  it('passes a hostname that resolves publicly', async () => {
    const result = await assertPublicTarget(new URL('https://example.com'), {
      allowPrivate: false,
      resolver: resolver({ 'example.com': ['93.184.216.34'] }),
    });
    expect(result.addresses).toEqual(['93.184.216.34']);
  });

  it('blocks DNS rebinding where a public name resolves to a private address', async () => {
    await expect(
      assertPublicTarget(new URL('https://evil.example'), {
        allowPrivate: false,
        resolver: resolver({ 'evil.example': ['169.254.169.254'] }),
      }),
    ).rejects.toThrow(/private or reserved/);
  });

  it('blocks when any one of several answers is private', async () => {
    await expect(
      assertPublicTarget(new URL('https://mixed.example'), {
        allowPrivate: false,
        resolver: resolver({ 'mixed.example': ['8.8.8.8', '10.1.2.3'] }),
      }),
    ).rejects.toThrow(/private or reserved/);
  });

  it('blocks literal private IPs without a DNS round trip', async () => {
    await expect(
      assertPublicTarget(new URL('http://127.0.0.1:8080/'), { allowPrivate: false }),
    ).rejects.toThrow(/private or reserved/);
  });

  it('blocks localhost and .internal names', async () => {
    await expect(
      assertPublicTarget(new URL('http://localhost:3000'), { allowPrivate: false }),
    ).rejects.toThrow();
    await expect(
      assertPublicTarget(new URL('http://db.internal'), { allowPrivate: false }),
    ).rejects.toThrow();
  });

  it('surfaces DNS failures rather than silently allowing', async () => {
    await expect(
      assertPublicTarget(new URL('https://nope.example'), {
        allowPrivate: false,
        resolver: resolver({}),
      }),
    ).rejects.toThrow(/DNS lookup failed/);
  });

  it('skips the guard entirely when private targets are explicitly allowed', async () => {
    await expect(
      assertPublicTarget(new URL('http://127.0.0.1'), { allowPrivate: true }),
    ).resolves.toBeDefined();
  });
});
