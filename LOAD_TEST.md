# Load-test evidence

This repo includes a dependency-free burst test that uses Node's built-in `fetch`. It is intentionally small enough to run locally or against the free Render deployment without becoming abusive.

## Command

```bash
npm run load:test
```

Defaults:

- Base URL: `http://localhost:3000`
- Target URL: `https://example.com`
- Total requests: `100`
- Client-side concurrency: `25`
- Cache bypass: `false`

Override with environment variables:

```bash
PAGE_PULSE_BASE_URL=https://page-pulse-9riw.onrender.com \
PAGE_PULSE_TARGET_URL=https://example.com \
PAGE_PULSE_LOAD_TOTAL=50 \
PAGE_PULSE_LOAD_CONCURRENCY=10 \
npm run load:test
```

Use `PAGE_PULSE_LOAD_FRESH=true` only for small tests. It bypasses cache and deliberately increases load on the target origin.

## What this proves

- The API remains responsive under a burst of concurrent clients.
- Repeat requests for the same URL collapse through cache and single-flight instead of repeatedly fetching the origin.
- Rate limiting, global concurrency and per-host bulkheading return structured errors if the configured limits are exceeded.

## Latest local verification

```bash
npm run typecheck
npm test
npm run build
npm run test:coverage
```

Result:

- TypeScript typecheck passed.
- Build passed.
- 145 tests passed across 7 files.
- Coverage thresholds passed: 95.44% statements, 87.75% branches, 93.68% functions.

## Latest local burst run

Command run against a local production build on port 3100:

```bash
PAGE_PULSE_BASE_URL=http://127.0.0.1:3100 PAGE_PULSE_LOAD_TOTAL=20 PAGE_PULSE_LOAD_CONCURRENCY=5 npm run load:test
```

Result:

```json
{
  "total": 20,
  "concurrency": 5,
  "statusCounts": { "200": 20 },
  "cacheCounts": { "MISS": 5, "HIT": 15 },
  "errorCounts": {},
  "latencyMs": {
    "min": 9,
    "p50": 23,
    "p95": 215,
    "p99": 272,
    "max": 272
  }
}
```

For the Loom, a lightweight live run against Render is enough:

```bash
PAGE_PULSE_BASE_URL=https://page-pulse-9riw.onrender.com PAGE_PULSE_LOAD_TOTAL=20 PAGE_PULSE_LOAD_CONCURRENCY=5 npm run load:test
```
