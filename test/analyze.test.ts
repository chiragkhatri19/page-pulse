import { describe, expect, it } from 'vitest';
import { extractFacts, runChecks, type CheckResult } from '../src/lib/analyze.js';
import { gradeFor, score } from '../src/lib/score.js';
import type { FetchResult } from '../src/lib/fetcher.js';
import { BAD_PAGE, GOOD_PAGE } from './fixtures/server.js';

const fetchResult = (over: Partial<FetchResult> = {}): FetchResult => ({
  finalUrl: 'https://example.com/',
  status: 200,
  headers: { 'content-type': 'text/html' },
  html: GOOD_PAGE,
  bytes: 4_000,
  truncated: false,
  timings: { ttfbMs: 120, totalMs: 200 },
  ...over,
});

describe('extractFacts', () => {
  it('reads the core SEO elements from a well-formed page', () => {
    const facts = extractFacts(GOOD_PAGE, 'https://example.com/');
    expect(facts.title).toBe('A perfectly reasonable page title');
    expect(facts.metaDescriptionLength).toBeGreaterThan(50);
    expect(facts.canonical).toBe('http://127.0.0.1/good');
    expect(facts.lang).toBe('en');
    expect(facts.h1Count).toBe(1);
    expect(facts.hasOpenGraph).toBe(true);
    expect(facts.hasStructuredData).toBe(true);
    expect(facts.hasFavicon).toBe(true);
    expect(facts.hasViewportMeta).toBe(true);
  });

  it('treats an explicit empty alt as decorative, not missing', () => {
    const facts = extractFacts(GOOD_PAGE, 'https://example.com/');
    expect(facts.imageCount).toBe(2);
    expect(facts.imagesMissingAlt).toBe(0);
  });

  it('counts genuinely missing alt attributes', () => {
    const facts = extractFacts(BAD_PAGE, 'https://example.com/');
    expect(facts.imagesMissingAlt).toBe(2);
  });

  it('does not count deferred scripts as render blocking', () => {
    expect(extractFacts(GOOD_PAGE, 'https://example.com/').blockingScriptCount).toBe(0);
    expect(extractFacts(BAD_PAGE, 'https://example.com/').blockingScriptCount).toBe(1);
  });

  it('detects a skipped heading rank', () => {
    expect(extractFacts(GOOD_PAGE, 'https://example.com/').headingOrderValid).toBe(true);
    expect(extractFacts(BAD_PAGE, 'https://example.com/').headingOrderValid).toBe(false);
  });

  it('flags unlabelled form controls', () => {
    expect(extractFacts(GOOD_PAGE, 'https://example.com/').formsMissingLabels).toBe(0);
    expect(extractFacts(BAD_PAGE, 'https://example.com/').formsMissingLabels).toBe(1);
  });

  it('distinguishes internal from external links using the final origin', () => {
    const facts = extractFacts(GOOD_PAGE, 'https://example.com/');
    expect(facts.linkCount).toBe(2);
    expect(facts.internalLinkCount).toBe(1);
  });

  it('survives malformed markup without throwing', () => {
    expect(() => extractFacts('<html><body><p>unclosed', 'https://example.com/')).not.toThrow();
    expect(() => extractFacts('', 'not-a-url')).not.toThrow();
  });
});

describe('runChecks', () => {
  const idsOf = (checks: CheckResult[]) => new Set(checks.map((c) => c.id));

  it('produces a check for every pillar', () => {
    const checks = runChecks(extractFacts(GOOD_PAGE, 'https://example.com/'), fetchResult());
    expect(idsOf(checks).size).toBe(checks.length);
    for (const pillar of ['seo', 'accessibility', 'performance', 'security']) {
      expect(checks.some((c) => c.pillar === pillar)).toBe(true);
    }
  });

  it('fails the HTTPS check for a plain HTTP final URL', () => {
    const checks = runChecks(
      extractFacts(GOOD_PAGE, 'http://example.com/'),
      fetchResult({ finalUrl: 'http://example.com/' }),
    );
    expect(checks.find((c) => c.id === 'sec.https')?.passed).toBe(false);
  });

  it('passes clickjacking protection via CSP frame-ancestors alone', () => {
    const checks = runChecks(
      extractFacts(GOOD_PAGE, 'https://example.com/'),
      fetchResult({ headers: { 'content-security-policy': "frame-ancestors 'none'" } }),
    );
    expect(checks.find((c) => c.id === 'sec.frameOptions')?.passed).toBe(true);
  });

  it('fails the TTFB check above the threshold', () => {
    const checks = runChecks(
      extractFacts(GOOD_PAGE, 'https://example.com/'),
      fetchResult({ timings: { ttfbMs: 1500, totalMs: 1800 } }),
    );
    expect(checks.find((c) => c.id === 'perf.ttfb')?.passed).toBe(false);
  });

  it('flags version-disclosing server headers', () => {
    const checks = runChecks(
      extractFacts(BAD_PAGE, 'https://example.com/'),
      fetchResult({ headers: { server: 'nginx/1.25.3', 'x-powered-by': 'Express' } }),
    );
    expect(checks.find((c) => c.id === 'sec.serverDisclosure')?.passed).toBe(false);
  });

  it('fails the status check on a 5xx response', () => {
    const checks = runChecks(extractFacts(GOOD_PAGE, 'https://example.com/'), fetchResult({ status: 503 }));
    expect(checks.find((c) => c.id === 'seo.status')?.passed).toBe(false);
  });
});

describe('score', () => {
  const mk = (over: Partial<CheckResult>): CheckResult => ({
    id: 'x',
    pillar: 'seo',
    label: 'l',
    passed: true,
    weight: 1,
    detail: '',
    ...over,
  });

  it('is a weighted ratio, not a simple pass count', () => {
    const result = score([
      mk({ id: 'a', weight: 9, passed: true }),
      mk({ id: 'b', weight: 1, passed: false }),
    ]);
    expect(result.overall).toBe(90);
  });

  it('scores each pillar independently', () => {
    const result = score([
      mk({ id: 'a', pillar: 'seo', weight: 10, passed: true }),
      mk({ id: 'b', pillar: 'security', weight: 10, passed: false }),
    ]);
    expect(result.pillars.seo.score).toBe(100);
    expect(result.pillars.security.score).toBe(0);
    expect(result.pillars.security.failedChecks).toBe(1);
  });

  it('gives a pillar with no applicable checks a neutral 100 rather than a zero', () => {
    expect(score([mk({ pillar: 'seo' })]).pillars.performance.score).toBe(100);
  });

  it('orders recommendations by weight so the biggest win is first', () => {
    const result = score([
      mk({ id: 'small', weight: 2, passed: false }),
      mk({ id: 'big', weight: 9, passed: false }),
      mk({ id: 'mid', weight: 5, passed: false }),
    ]);
    expect(result.recommendations.map((r) => r.checkId)).toEqual(['big', 'mid', 'small']);
    expect(result.recommendations.map((r) => r.impact)).toEqual(['high', 'medium', 'low']);
  });

  it('returns no recommendations for a page that passes everything', () => {
    expect(score([mk({ passed: true })]).recommendations).toHaveLength(0);
  });

  it('is deterministic for identical input', () => {
    const checks = runChecks(extractFacts(GOOD_PAGE, 'https://example.com/'), fetchResult());
    expect(JSON.stringify(score(checks))).toBe(JSON.stringify(score(checks)));
  });

  it.each([
    [100, 'A'],
    [90, 'A'],
    [89, 'B'],
    [80, 'B'],
    [79, 'C'],
    [70, 'C'],
    [69, 'D'],
    [60, 'D'],
    [59, 'F'],
    [0, 'F'],
  ])('grades %i as %s', (value, expected) => {
    expect(gradeFor(value)).toBe(expected);
  });

  it('scores a good page above a bad one', () => {
    const good = score(runChecks(extractFacts(GOOD_PAGE, 'https://example.com/'), fetchResult()));
    const bad = score(
      runChecks(
        extractFacts(BAD_PAGE, 'http://example.com/'),
        fetchResult({ finalUrl: 'http://example.com/', html: BAD_PAGE, headers: {} }),
      ),
    );
    expect(good.overall).toBeGreaterThan(bad.overall);
  });
});
