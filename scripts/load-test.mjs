#!/usr/bin/env node

const baseUrl = process.env.PAGE_PULSE_BASE_URL ?? 'http://localhost:3000';
const targetUrl = process.env.PAGE_PULSE_TARGET_URL ?? 'https://example.com';
const total = Number(process.env.PAGE_PULSE_LOAD_TOTAL ?? '100');
const concurrency = Number(process.env.PAGE_PULSE_LOAD_CONCURRENCY ?? '25');
const fresh = process.env.PAGE_PULSE_LOAD_FRESH === 'true';

if (!Number.isInteger(total) || total < 1) {
  throw new Error('PAGE_PULSE_LOAD_TOTAL must be a positive integer');
}
if (!Number.isInteger(concurrency) || concurrency < 1) {
  throw new Error('PAGE_PULSE_LOAD_CONCURRENCY must be a positive integer');
}

const endpoint = new URL('/v1/audit', baseUrl);
let next = 0;
const results = [];

async function one(i) {
  const started = performance.now();
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-request-id': `load-${Date.now()}-${i}`,
      },
      body: JSON.stringify({ url: targetUrl, fresh }),
    });
    const body = await res.json().catch(() => ({}));
    results.push({
      status: res.status,
      cache: res.headers.get('x-cache') ?? 'n/a',
      durationMs: Math.round(performance.now() - started),
      code: body?.error?.code ?? null,
    });
  } catch (err) {
    results.push({
      status: 0,
      cache: 'n/a',
      durationMs: Math.round(performance.now() - started),
      code: err instanceof Error ? err.message : 'network_error',
    });
  }
}

async function worker() {
  for (;;) {
    const i = next++;
    if (i >= total) return;
    await one(i);
  }
}

const started = performance.now();
await Promise.all(Array.from({ length: Math.min(concurrency, total) }, worker));

const sortedDurations = results.map((r) => r.durationMs).sort((a, b) => a - b);
const percentile = (p) => sortedDurations[Math.min(sortedDurations.length - 1, Math.ceil((p / 100) * sortedDurations.length) - 1)] ?? 0;
const countBy = (field) =>
  results.reduce((acc, result) => {
    const key = String(result[field]);
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});

const summary = {
  baseUrl,
  targetUrl,
  total,
  concurrency,
  fresh,
  wallClockMs: Math.round(performance.now() - started),
  statusCounts: countBy('status'),
  cacheCounts: countBy('cache'),
  errorCounts: Object.fromEntries(Object.entries(countBy('code')).filter(([key]) => key !== 'null')),
  latencyMs: {
    min: sortedDurations[0] ?? 0,
    p50: percentile(50),
    p95: percentile(95),
    p99: percentile(99),
    max: sortedDurations.at(-1) ?? 0,
  },
};

console.log(JSON.stringify(summary, null, 2));
