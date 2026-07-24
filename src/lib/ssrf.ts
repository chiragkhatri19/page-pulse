import { lookup } from 'node:dns/promises';
import net from 'node:net';

/**
 * An audit service takes an arbitrary URL from an untrusted client and fetches
 * it from inside our network. That is textbook SSRF. We therefore (1) restrict
 * the scheme, (2) resolve DNS ourselves, and (3) reject any answer that lands
 * in a private, loopback, link-local or reserved range before a socket opens.
 */

export interface NormalisedTarget {
  url: URL;
  /** Resolved addresses, already verified as public. */
  addresses: string[];
}

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

export function normaliseUrl(raw: string): URL {
  const trimmed = raw.trim();
  // Bare hostnames are a common client mistake; default them to https.
  const candidate = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed) ? trimmed : `https://${trimmed}`;

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new Error('Value is not a parseable URL');
  }

  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    throw new Error(`Unsupported protocol "${url.protocol}". Only http and https are audited.`);
  }
  if (!url.hostname) throw new Error('URL is missing a hostname');
  if (url.username || url.password) throw new Error('URLs with embedded credentials are rejected');

  url.hash = '';
  return url;
}

/** IPv4 ranges that must never be reachable from a user-supplied URL. */
export function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p))) return true;
  const [a = 0, b = 0] = parts;
  if (a === 0) return true; // "this" network
  if (a === 10) return true; // RFC1918
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local, incl. cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
  if (a === 192 && b === 168) return true; // RFC1918
  if (a === 192 && b === 0) return true; // IETF protocol assignments
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a >= 224) return true; // multicast, reserved, broadcast
  return false;
}

export function isPrivateIPv6(ip: string): boolean {
  const addr = ip.toLowerCase().split('%')[0] ?? '';
  if (addr === '::' || addr === '::1') return true;
  if (addr.startsWith('fe80')) return true; // link-local
  if (addr.startsWith('fc') || addr.startsWith('fd')) return true; // unique-local
  if (addr.startsWith('ff')) return true; // multicast
  // IPv4-mapped (::ffff:10.0.0.1) inherits the v4 verdict.
  const mapped = addr.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped?.[1]) return isPrivateIPv4(mapped[1]);
  return false;
}

export function isPrivateAddress(ip: string): boolean {
  const version = net.isIP(ip);
  if (version === 4) return isPrivateIPv4(ip);
  if (version === 6) return isPrivateIPv6(ip);
  return true; // unparseable means untrusted
}

export interface ResolveOptions {
  allowPrivate: boolean;
  /** Injectable for tests. */
  resolver?: (hostname: string) => Promise<{ address: string }[]>;
}

const defaultResolver = async (hostname: string) => {
  const result = await lookup(hostname, { all: true, verbatim: true });
  return result.map((r) => ({ address: r.address }));
};

export async function assertPublicTarget(url: URL, opts: ResolveOptions): Promise<NormalisedTarget> {
  if (opts.allowPrivate) return { url, addresses: [] };

  const host = url.hostname.replace(/^\[|\]$/g, '');

  // Literal IP in the URL: check it directly, no DNS needed.
  if (net.isIP(host)) {
    if (isPrivateAddress(host)) {
      throw new Error('Target resolves to a private or reserved address');
    }
    return { url, addresses: [host] };
  }

  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal')) {
    throw new Error('Target resolves to a private or reserved address');
  }

  const resolve = opts.resolver ?? defaultResolver;
  let addresses: { address: string }[];
  try {
    addresses = await resolve(host);
  } catch {
    throw new Error(`DNS lookup failed for "${host}"`);
  }
  if (addresses.length === 0) throw new Error(`DNS lookup returned no records for "${host}"`);

  for (const { address } of addresses) {
    if (isPrivateAddress(address)) {
      throw new Error('Target resolves to a private or reserved address');
    }
  }

  return { url, addresses: addresses.map((a) => a.address) };
}
