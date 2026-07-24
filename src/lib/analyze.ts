import * as cheerio from 'cheerio';
import type { FetchResult } from './fetcher.js';

export interface CheckResult {
  id: string;
  pillar: Pillar;
  label: string;
  passed: boolean;
  weight: number;
  /** Human-readable explanation of the observed state. */
  detail: string;
}

export type Pillar = 'seo' | 'accessibility' | 'performance' | 'security';

export interface PageFacts {
  title: string | null;
  titleLength: number;
  metaDescription: string | null;
  metaDescriptionLength: number;
  canonical: string | null;
  lang: string | null;
  h1Count: number;
  headingOrderValid: boolean;
  imageCount: number;
  imagesMissingAlt: number;
  linkCount: number;
  internalLinkCount: number;
  scriptCount: number;
  blockingScriptCount: number;
  stylesheetCount: number;
  inlineStyleBytes: number;
  hasViewportMeta: boolean;
  hasOpenGraph: boolean;
  hasStructuredData: boolean;
  hasFavicon: boolean;
  formsMissingLabels: number;
}

export interface AnalysisResult {
  facts: PageFacts;
  checks: CheckResult[];
}

const text = (v: string | undefined | null): string => (v ?? '').trim();

export function extractFacts(html: string, finalUrl: string): PageFacts {
  const $ = cheerio.load(html);
  let origin = '';
  try {
    origin = new URL(finalUrl).origin;
  } catch {
    origin = '';
  }

  const title = text($('head > title').first().text()) || null;
  const metaDescription = text($('meta[name="description"]').attr('content')) || null;
  const canonical = text($('link[rel="canonical"]').attr('href')) || null;
  const lang = text($('html').attr('lang')) || null;

  const images = $('img');
  let imagesMissingAlt = 0;
  images.each((_, el) => {
    const alt = $(el).attr('alt');
    // An explicit empty alt is a valid decorative marker; a missing one is not.
    if (alt === undefined) imagesMissingAlt++;
  });

  const links = $('a[href]');
  let internalLinkCount = 0;
  links.each((_, el) => {
    const href = text($(el).attr('href'));
    if (!href) return;
    if (href.startsWith('/') || href.startsWith('#')) internalLinkCount++;
    else if (origin && href.startsWith(origin)) internalLinkCount++;
  });

  const scripts = $('script[src]');
  let blockingScriptCount = 0;
  scripts.each((_, el) => {
    const $el = $(el);
    if ($el.attr('async') === undefined && $el.attr('defer') === undefined) {
      const type = text($el.attr('type'));
      if (type !== 'module') blockingScriptCount++;
    }
  });

  let inlineStyleBytes = 0;
  $('style').each((_, el) => {
    inlineStyleBytes += Buffer.byteLength($(el).text(), 'utf8');
  });

  const headings = $('h1,h2,h3,h4,h5,h6')
    .toArray()
    .map((el) => Number((el as { tagName?: string }).tagName?.slice(1) ?? 0))
    .filter((n) => n > 0);
  let headingOrderValid = true;
  for (let i = 1; i < headings.length; i++) {
    const prev = headings[i - 1] ?? 0;
    const cur = headings[i] ?? 0;
    if (cur - prev > 1) {
      headingOrderValid = false;
      break;
    }
  }

  let formsMissingLabels = 0;
  $('input,select,textarea').each((_, el) => {
    const $el = $(el);
    const type = text($el.attr('type')).toLowerCase();
    if (type === 'hidden' || type === 'submit' || type === 'button') return;
    const id = text($el.attr('id'));
    const labelled =
      (id && $(`label[for="${id.replace(/"/g, '\\"')}"]`).length > 0) ||
      $el.attr('aria-label') !== undefined ||
      $el.attr('aria-labelledby') !== undefined ||
      $el.parents('label').length > 0;
    if (!labelled) formsMissingLabels++;
  });

  return {
    title,
    titleLength: title?.length ?? 0,
    metaDescription,
    metaDescriptionLength: metaDescription?.length ?? 0,
    canonical,
    lang,
    h1Count: $('h1').length,
    headingOrderValid,
    imageCount: images.length,
    imagesMissingAlt,
    linkCount: links.length,
    internalLinkCount,
    scriptCount: scripts.length,
    blockingScriptCount,
    stylesheetCount: $('link[rel="stylesheet"]').length,
    inlineStyleBytes,
    hasViewportMeta: $('meta[name="viewport"]').length > 0,
    hasOpenGraph: $('meta[property^="og:"]').length > 0,
    hasStructuredData: $('script[type="application/ld+json"]').length > 0,
    hasFavicon: $('link[rel~="icon"]').length > 0,
    formsMissingLabels,
  };
}

export function runChecks(facts: PageFacts, fetched: FetchResult): CheckResult[] {
  const h = fetched.headers;
  const isHttps = fetched.finalUrl.startsWith('https://');
  const check = (
    id: string,
    pillar: Pillar,
    label: string,
    weight: number,
    passed: boolean,
    detail: string,
  ): CheckResult => ({ id, pillar, label, weight, passed, detail });

  return [
    // SEO
    check(
      'seo.title',
      'seo',
      'Page has a title of usable length',
      8,
      facts.titleLength >= 15 && facts.titleLength <= 65,
      facts.title
        ? `Title is ${facts.titleLength} characters; 15 to 65 renders without truncation.`
        : 'No <title> element found.',
    ),
    check(
      'seo.description',
      'seo',
      'Meta description present and sized for SERP',
      6,
      facts.metaDescriptionLength >= 50 && facts.metaDescriptionLength <= 160,
      facts.metaDescription
        ? `Meta description is ${facts.metaDescriptionLength} characters; target 50 to 160.`
        : 'No meta description found.',
    ),
    check(
      'seo.h1',
      'seo',
      'Exactly one H1',
      5,
      facts.h1Count === 1,
      `Found ${facts.h1Count} H1 elements.`,
    ),
    check(
      'seo.canonical',
      'seo',
      'Canonical URL declared',
      4,
      facts.canonical !== null,
      facts.canonical ? `Canonical points to ${facts.canonical}.` : 'No canonical link element.',
    ),
    check(
      'seo.openGraph',
      'seo',
      'Open Graph tags for link previews',
      3,
      facts.hasOpenGraph,
      facts.hasOpenGraph ? 'Open Graph tags present.' : 'No og: meta tags found.',
    ),
    check(
      'seo.structuredData',
      'seo',
      'Structured data (JSON-LD)',
      3,
      facts.hasStructuredData,
      facts.hasStructuredData ? 'JSON-LD block present.' : 'No application/ld+json block.',
    ),
    check(
      'seo.status',
      'seo',
      'Returns a 2xx status',
      6,
      fetched.status >= 200 && fetched.status < 300,
      `Final status was ${fetched.status}.`,
    ),

    // Accessibility
    check(
      'a11y.lang',
      'accessibility',
      'HTML lang attribute set',
      5,
      facts.lang !== null,
      facts.lang ? `lang="${facts.lang}".` : 'No lang attribute on <html>.',
    ),
    check(
      'a11y.imgAlt',
      'accessibility',
      'All images carry an alt attribute',
      8,
      facts.imagesMissingAlt === 0,
      `${facts.imagesMissingAlt} of ${facts.imageCount} images have no alt attribute.`,
    ),
    check(
      'a11y.headingOrder',
      'accessibility',
      'Heading levels do not skip',
      4,
      facts.headingOrderValid,
      facts.headingOrderValid ? 'Heading hierarchy is sequential.' : 'Heading levels skip a rank.',
    ),
    check(
      'a11y.formLabels',
      'accessibility',
      'Form controls are labelled',
      5,
      facts.formsMissingLabels === 0,
      `${facts.formsMissingLabels} form controls have no associated label.`,
    ),
    check(
      'a11y.viewport',
      'accessibility',
      'Responsive viewport meta tag',
      5,
      facts.hasViewportMeta,
      facts.hasViewportMeta ? 'Viewport meta present.' : 'No viewport meta tag.',
    ),

    // Performance
    check(
      'perf.ttfb',
      'performance',
      'Time to first byte under 800 ms',
      8,
      fetched.timings.ttfbMs < 800,
      `TTFB measured at ${fetched.timings.ttfbMs} ms.`,
    ),
    check(
      'perf.documentSize',
      'performance',
      'HTML document under 200 KB',
      5,
      fetched.bytes < 200_000,
      `Document is ${Math.round(fetched.bytes / 1024)} KB.`,
    ),
    check(
      'perf.blockingScripts',
      'performance',
      'No render-blocking scripts',
      6,
      facts.blockingScriptCount === 0,
      `${facts.blockingScriptCount} of ${facts.scriptCount} external scripts lack async or defer.`,
    ),
    check(
      'perf.compression',
      'performance',
      'Response is compressed',
      4,
      ['gzip', 'br', 'deflate', 'zstd'].some((e) => (h['content-encoding'] ?? '').includes(e)),
      h['content-encoding']
        ? `Content-Encoding: ${h['content-encoding']}.`
        : 'No Content-Encoding header on the response.',
    ),
    check(
      'perf.caching',
      'performance',
      'Cache-Control header present',
      3,
      typeof h['cache-control'] === 'string' && h['cache-control'].length > 0,
      h['cache-control'] ? `Cache-Control: ${h['cache-control']}.` : 'No Cache-Control header.',
    ),

    // Security
    check(
      'sec.https',
      'security',
      'Served over HTTPS',
      8,
      isHttps,
      isHttps ? 'Final URL uses HTTPS.' : 'Final URL is plain HTTP.',
    ),
    check(
      'sec.hsts',
      'security',
      'Strict-Transport-Security header',
      5,
      Boolean(h['strict-transport-security']),
      h['strict-transport-security'] ? 'HSTS enabled.' : 'No HSTS header.',
    ),
    check(
      'sec.csp',
      'security',
      'Content-Security-Policy header',
      5,
      Boolean(h['content-security-policy']),
      h['content-security-policy'] ? 'CSP present.' : 'No Content-Security-Policy header.',
    ),
    check(
      'sec.contentTypeOptions',
      'security',
      'X-Content-Type-Options: nosniff',
      3,
      (h['x-content-type-options'] ?? '').toLowerCase() === 'nosniff',
      h['x-content-type-options'] ? 'nosniff set.' : 'No X-Content-Type-Options header.',
    ),
    check(
      'sec.frameOptions',
      'security',
      'Clickjacking protection',
      3,
      Boolean(h['x-frame-options']) || (h['content-security-policy'] ?? '').includes('frame-ancestors'),
      'Checked X-Frame-Options and CSP frame-ancestors.',
    ),
    check(
      'sec.referrerPolicy',
      'security',
      'Referrer-Policy header',
      2,
      Boolean(h['referrer-policy']),
      h['referrer-policy'] ? `Referrer-Policy: ${h['referrer-policy']}.` : 'No Referrer-Policy header.',
    ),
    check(
      'sec.serverDisclosure',
      'security',
      'Server does not disclose version details',
      2,
      !/\d/.test(h['server'] ?? '') && !h['x-powered-by'],
      h['x-powered-by'] || h['server']
        ? `Server headers expose: ${[h['server'], h['x-powered-by']].filter(Boolean).join(', ')}.`
        : 'No version-disclosing server headers.',
    ),
  ];
}

export function analyze(fetched: FetchResult): AnalysisResult {
  const facts = extractFacts(fetched.html, fetched.finalUrl);
  return { facts, checks: runChecks(facts, fetched) };
}
