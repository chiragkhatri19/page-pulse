# Page Pulse

A URL audit service. Give it a public URL, it fetches the page under strict timeouts, reads the markup and the response headers, and returns a scored JSON report across four pillars: SEO, accessibility, performance and security.

Live: **https://page-pulse-9riw.onrender.com**
CI: ![CI](https://github.com/chiragkhatri19/page-pulse/actions/workflows/ci.yml/badge.svg)

Built for the Digital Heroes training task. Architecture for the 10k audits/day scenario is in [ARCHITECTURE.md](./ARCHITECTURE.md).
OpenAPI contract: [openapi.yaml](./openapi.yaml). Load-test notes: [LOAD_TEST.md](./LOAD_TEST.md).

---

## What it actually does

It is a single stateless HTTP service. One request in, one report out:

1. Validate and normalise the URL (`example.com` becomes `https://example.com`).
2. Resolve DNS ourselves and refuse anything landing on a private, loopback or link-local address. An audit service is an SSRF machine by design; this is the guard.
3. Check the cache. A repeat audit inside the window never touches the origin.
4. Acquire host-level and global concurrency permits. One slow hostname cannot consume the whole audit pool.
5. Fetch with layered timeouts and a byte cap, following at most 5 redirects.
6. Parse and score 24 weighted checks. Scoring is pure and deterministic.

## Quick start

```bash
npm install
cp .env.example .env
npm run dev            # http://localhost:3000
npm test               # 145 tests
npm run test:coverage  # enforces 90% statements / 85% functions / 80% branches
npm run build && npm start
npm run load:test      # optional burst test against localhost
```

Docker:

```bash
docker build -t page-pulse .
docker run -p 3000:3000 -e LOG_LEVEL=info page-pulse
```

---

## API contract

Base URL: `https://page-pulse-9riw.onrender.com`. All responses are `application/json`. Every response, success or failure, carries an `x-request-id` header.

### `POST /v1/audit`

Audit a URL.

**Request body**

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `url` | string | yes | 1 to 2048 characters. A bare hostname is upgraded to `https://`. Only `http` and `https` are accepted. |
| `fresh` | boolean | no | Bypass the cache for this call and refresh the stored entry. Default `false`. |
| `ttlSeconds` | integer | no | Override the cache window for this entry. Clamped to 4x the server ceiling, so a client cannot pin a stale entry indefinitely. |

```bash
curl -X POST https://page-pulse-9riw.onrender.com/v1/audit \
  -H 'content-type: application/json' \
  -d '{"url":"https://example.com"}'
```

**200 response**

```jsonc
{
  "requestId": "9f2c1a3e-...",
  "cache": { "hit": false, "ageSeconds": 0, "ttlSeconds": 300, "deduped": false },
  "durationMs": 258,
  "report": {
    "url": "https://example.com/",
    "finalUrl": "https://example.com/",
    "redirected": false,
    "fetchedAt": "2026-07-24T16:28:23.160Z",
    "http": {
      "status": 200,
      "contentType": "text/html; charset=utf-8",
      "bytes": 126685,
      "truncated": false,
      "ttfbMs": 67,
      "totalMs": 145
    },
    "score": {
      "overall": 78,
      "grade": "C",
      "pillars": {
        "seo":           { "score": 71, "earned": 25, "possible": 35, "grade": "C", "failedChecks": 2 },
        "accessibility": { "score": 85, "earned": 23, "possible": 27, "grade": "B", "failedChecks": 1 },
        "performance":   { "score": 80, "earned": 21, "possible": 26, "grade": "B", "failedChecks": 1 },
        "security":      { "score": 75, "earned": 21, "possible": 28, "grade": "C", "failedChecks": 2 }
      },
      "recommendations": [
        {
          "checkId": "a11y.imgAlt",
          "pillar": "accessibility",
          "title": "All images carry an alt attribute",
          "detail": "4 of 19 images have no alt attribute.",
          "impact": "high"
        }
      ]
    },
    "facts": { "title": "Example Domain", "h1Count": 1, "imagesMissingAlt": 4, "...": "..." },
    "checks": [
      { "id": "seo.title", "pillar": "seo", "label": "Page has a title of usable length",
        "passed": true, "weight": 8, "detail": "Title is 34 characters; 15 to 65 renders without truncation." }
    ]
  }
}
```

`recommendations` is the failed subset of `checks`, sorted heaviest first, so a client can render "fix this first" without doing its own sorting.

**Response headers**

| Header | Meaning |
| --- | --- |
| `x-request-id` | Echoed from the caller's `x-request-id` if supplied, otherwise minted. Appears in every log line for the request. |
| `x-cache` | `HIT` or `MISS`. |
| `x-cache-age` | Age of the served entry, in seconds. |
| `x-ratelimit-limit` / `x-ratelimit-remaining` / `x-ratelimit-reset` | Current bucket state. |
| `retry-after` | Present on 429 and 503. |

### `GET /v1/audit`

Identical, with `url`, `fresh` and `ttlSeconds` as query parameters. Useful for links and browser testing.

```bash
curl 'https://page-pulse-9riw.onrender.com/v1/audit?url=example.com&fresh=true'
```

### `GET /healthz`

Liveness. Never rate limited, so a probe can't be throttled out of existence.

### `GET /readyz`

Readiness. Returns `503` once the work queue is saturated, which is what a load balancer should act on.

### `GET /v1/stats`

Cache counters, in-flight audits, queue depth, tracked rate-limit clients, RSS.

---

## Error contract

Every error has the same shape. Branch on `error.code`, never on the message.

```json
{
  "error": {
    "code": "TARGET_TIMEOUT",
    "message": "Target did not respond within 8000 ms.",
    "requestId": "9f2c1a3e-...",
    "retryAfterSeconds": 2
  }
}
```

| Status | Code | When |
| --- | --- | --- |
| 400 | `VALIDATION_FAILED` | Missing or malformed `url`, unsupported scheme, embedded credentials, bad JSON body. Includes a `details` array of `{field, message}`. |
| 404 | `NOT_FOUND` | Unknown route. |
| 413 | `TARGET_TOO_LARGE` | Target's response exceeds `MAX_RESPONSE_BYTES`. |
| 415 | `UNSUPPORTED_CONTENT_TYPE` | Target returned something that isn't HTML. |
| 422 | `URL_NOT_ALLOWED` | Target resolves to a private, loopback, link-local or reserved address. |
| 429 | `RATE_LIMITED` | Bucket empty. `retryAfterSeconds` is long enough to actually succeed. |
| 502 | `TARGET_UNREACHABLE` | DNS failure, connection refused, TLS failure. |
| 503 | `CAPACITY_EXCEEDED` | Concurrency queue full or the wait exceeded its budget. |
| 504 | `TARGET_TIMEOUT` | Target accepted the connection and then stalled. |
| 500 | `INTERNAL` | A defect. The message asks the caller to quote the request ID. |

Note the distinction that matters most here: a *target* returning 500 is a successful audit that scores badly (200 from us). A 5xx from Page Pulse means Page Pulse failed.

---

## Configuration

Every knob is environment-driven and validated at boot with Zod. A malformed value fails startup loudly rather than silently defaulting. Full list in [.env.example](./.env.example).

| Variable | Default | Purpose |
| --- | --- | --- |
| `AUDIT_TIMEOUT_MS` | `8000` | Hard ceiling on one audit, including body read. |
| `FETCH_HEADERS_TIMEOUT_MS` | `5000` | Time to first byte from the target. |
| `MAX_RESPONSE_BYTES` | `3000000` | Body cap. Prevents a 200 MB file becoming a memory incident. |
| `MAX_REDIRECTS` | `5` | Redirect hops before giving up. |
| `MAX_CONCURRENT_AUDITS` | `25` | Outbound fetches in flight at once. |
| `MAX_QUEUE_DEPTH` | `200` | Requests allowed to wait for a permit. Beyond this, fail fast with 503. |
| `CONCURRENCY_QUEUE_TIMEOUT_MS` | `2000` | Max wait for a permit. |
| `MAX_CONCURRENT_AUDITS_PER_HOST` | `0` | Per-host in-flight cap. `0` derives a conservative value from the global cap. |
| `HOST_CIRCUIT_FAILURE_THRESHOLD` | `5` | Consecutive target health failures before a hostname's circuit opens. |
| `HOST_CIRCUIT_COOLDOWN_MS` | `60000` | Time to shed an unhealthy hostname before allowing another probe. |
| **`CACHE_TTL_SECONDS`** | `300` | **The cache window.** `0` disables caching entirely. |
| `CACHE_MAX_ENTRIES` | `1000` | LRU capacity. |
| `RATE_LIMIT_MAX` | `30` | Token bucket capacity per client. |
| `RATE_LIMIT_WINDOW_SECONDS` | `60` | Refill period. |
| `ALLOW_PRIVATE_TARGETS` | `false` | Disables the SSRF guard. Only ever `true` in tests. |

---

## Design notes

**Caching.** Keyed on `audit:v1:{protocol}//{host}{path}{query}`, with host lowercased and an empty path normalised to `/`. The query string is part of the key because it changes the page. The `v1` namespace means a future report-shape change cannot serve an old shape to a new client; you bump it and the old entries age out.

A cache alone doesn't solve the cold-start burst: 500 concurrent requests for one uncached URL would be 500 outbound fetches. A single-flight layer sits in front of the fetch so concurrent identical requests share one upstream call. `cache.deduped` in the response tells you it happened. There is a test that fires 12 simultaneous requests at a cold URL and asserts the origin was hit exactly once.

**Rate limiting.** Token bucket, not a fixed window. A fixed window lets a client spend its full quota at 11:59:59 and again at 12:00:00, a 2x burst at the boundary. A token bucket refills continuously, so it smooths that out while still allowing a legitimate burst up to capacity. Identity is the API key when present, otherwise the first `x-forwarded-for` hop, otherwise the socket address. Idle buckets are swept on an interval so memory stays bounded by active clients rather than lifetime clients.

**Concurrency.** A semaphore, not a queue library. Both the queue depth and the wait time are bounded, because unbounded queueing under load just converts a fast failure into a slow one while the memory graph climbs. Once the queue is full, `/readyz` reports 503 and the load balancer stops sending traffic. A host-level guard sits in front of the global semaphore, capping in-flight audits per hostname and opening a short circuit after repeated target timeouts or network failures. That prevents one broken origin from starving unrelated audits.

**Timeouts.** Layered, not one number: connect timeout, headers timeout, and an `AbortSignal` capping the whole operation. A target that completes its handshake and then trickles bytes forever is caught by the third one.

**Errors.** A closed set of codes in `src/errors.ts`. Expected conditions (429, 422) log at `warn`; defects log at `error`. This is what keeps an alert on error-rate meaningful instead of drowning in traffic-shaping noise.

**Logging.** Pino, one JSON object per line, with a stable field set (`service`, `env`, `reqId`, `event`, plus event-specific fields). `authorization`, `x-api-key` and `cookie` are redacted at the serialiser, so a secret can't reach the log pipeline by accident. Named events (`audit_completed`, `rate_limited`, `request_failed`) mean you query on `event`, not on substrings of a message.

## Known limitations

These are deliberate boundaries in the submitted build, not accidental omissions.

- **Static HTML only.** Page Pulse does not execute JavaScript or inspect the browser-rendered DOM, so heavily client-rendered SPAs may score as the initial shell rather than the final user-visible page.
- **No Core Web Vitals.** The performance pillar uses response and markup signals such as TTFB, payload size and blocking-script hints. Real LCP, INP and CLS require browser instrumentation and belong in the slower async render tier described in `ARCHITECTURE.md`.
- **Single-node state.** Task A uses in-process cache, rate limiting, single-flight and host-guard state because the live deployment is a single service. The scale design moves those concerns to Redis so they work across replicas.
- **HTML document scope.** Non-HTML targets return `UNSUPPORTED_CONTENT_TYPE`; the service is not a file scanner, media analyzer or malware sandbox.
- **Best-effort external fetches.** Some targets block cloud-hosted egress IPs or bot user agents. Page Pulse reports those outcomes clearly, but it cannot force a third-party origin to serve content.

## Testing

145 tests across 7 files. Coverage is enforced in CI and the build fails below the thresholds.

| File | Covers |
| --- | --- |
| `ssrf.test.ts` | URL normalisation, private-range detection for v4 and v6, DNS rebinding, cloud metadata addresses, credential-embedding bypass. |
| `fetcher.test.ts` | DNS-pinned connections dial the validated address rather than re-resolving DNS; a redirect hop that fails SSRF re-validation is rejected; a redirect hop that passes is followed and re-pinned; redirect-hop limits are enforced. |
| `cache.test.ts` | TTL expiry at the boundary, LRU eviction order, key normalisation, single-flight collapse and its failure path. |
| `hostGuard.test.ts` | Per-host concurrency caps, circuit-open behavior, cooldown recovery, and derived limit calculation. |
| `rateLimit.test.ts` | Bucket exhaustion, continuous refill, retry-after correctness, per-client isolation, sweep. Plus semaphore concurrency ceiling, queue-full and queue-timeout paths, permit release on throw. |
| `analyze.test.ts` | Fact extraction from good and bad fixtures, every non-trivial check, weighted scoring, grade boundaries, recommendation ordering, determinism. |
| `audit.route.test.ts` | End to end against a real local origin: caching (asserting the origin was not re-hit), fresh bypass, burst deduplication, redirects, every error code, rate limit headers and 429, request-ID propagation. |

Tests that assert on time inject a fake clock rather than sleeping, so they're deterministic and the suite finishes in a few seconds.

CI runs on every push: typecheck, tests with coverage on Node 20 and 22, build, then a Docker build plus a smoke job that starts the container and asserts a real audit works, that the second request returns `x-cache: HIT`, and that the SSRF guard returns 422 for `169.254.169.254`.

## Repository layout

```
src/
  config.ts              Zod-validated environment
  errors.ts              Error taxonomy and response shape
  server.ts              Fastify wiring: request IDs, rate limit hook, error handler, routes
  index.ts               Entry point and graceful shutdown
  lib/
    ssrf.ts              URL normalisation and private-range guard
    fetcher.ts           undici fetch, DNS-pinned connections, layered timeouts and byte cap
    analyze.ts           HTML parsing and the 24 checks
    score.ts             Pure weighted scoring
    cache.ts             TTL + LRU store, cache keys, single-flight
    hostGuard.ts         Per-host bulkhead and circuit breaker
    rateLimit.ts         Token bucket and client identity
    semaphore.ts         Bounded concurrency with bounded queueing
    auditService.ts      Orchestration
public/index.html        Landing page and live demo
test/                    145 tests
```

---

Built for [Digital Heroes Training Task](https://digitalheroesco.com).
