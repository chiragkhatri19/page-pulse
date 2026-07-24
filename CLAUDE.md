# Page Pulse — Claude Code context

## What this is
A URL audit service. POST a URL, get back a scored JSON report across SEO, accessibility,
performance and security. Single Fastify service, TypeScript strict mode, no headless browser.

## Commands you'll use
```bash
npm test           # 137 tests, ~3 seconds
npm run typecheck  # tsc --noEmit, zero errors expected
npm run dev        # tsx watch, port 3000
ALLOW_PRIVATE_TARGETS=true npm run dev  # needed to audit localhost fixtures in manual testing
```

## Architecture in one paragraph
`src/server.ts` wires the Fastify app. All real logic lives in `src/lib/`. Inbound: validate →
SSRF guard → rate limit → cache read → single-flight → semaphore → fetch. Outbound: undici
with layered timeouts (headers timeout, AbortSignal for total). Analysis is pure HTML parsing
with cheerio + response headers. Scoring is a pure weighted function, zero I/O, which is why
it's cheap to test. State is all in-process right now (MemoryCache, TokenBucketRateLimiter,
Semaphore) — the interfaces are already written for Redis swap when this goes multi-node.

## Key constraints — don't break these
- `ALLOW_PRIVATE_TARGETS` must default false. The SSRF guard is not optional.
- Scoring must be deterministic: same checks in, same numbers out. No timestamps, no randomness.
- Cache key is `audit:v1:{protocol}//{host}{path}{search}`, host lowercased. Changing the
  report shape = bump to v2, don't modify the existing key.
- Error responses always have `{ error: { code, message, requestId } }`. Never deviate from
  this shape — clients branch on `error.code`.
- Tests must stay green. `npm test` before any commit.

## Files that matter most
| File | Role |
| --- | --- |
| `src/lib/ssrf.ts` | SSRF guard — most security-critical file |
| `src/lib/auditService.ts` | Orchestration — cache, single-flight, semaphore, fetch |
| `src/lib/analyze.ts` | 24 checks, fact extraction — most product logic |
| `src/lib/score.ts` | Pure scoring, recommendations ordering |
| `src/server.ts` | Rate limit hook, error handler, routes |
| `test/audit.route.test.ts` | End-to-end tests against a live fixture server |

## Where I'd work next
1. ~~**DNS pinning**~~ — done. `fetcher.ts` now connects to the address `ssrf.ts` already
   validated instead of letting undici re-resolve DNS, via a custom `connect` function, and
   re-validates every redirect hop before following it. See `test/fetcher.test.ts`.
2. **More checks** — `analyze.ts` is the easiest place to add product value. Each check is
   one entry in the `runChecks` return array. Add a test case to `analyze.test.ts` for it.
3. **Response body schema validation** — the response shape is implicit. A Zod schema on the
   output would catch drift between the implementation and the README contract.
4. **Pinned-connection pooling** — the DNS-pinning fix above uses one throwaway connection per
   hop rather than a shared pool, since pinning is inherently per-request state. If profiling
   ever shows connection setup dominating latency, an address-aware pool keyed by
   `(hostname, pinned address)` would let repeat audits of the same host reuse sockets again.
4. **Redis swap** — `MemoryCache` implements `CacheStore<V>`. A `RedisCache<V>` implementing
   the same interface + `SET NX PX` for single-flight is all that's needed for multi-node.

## Testing conventions
- Time-dependent tests inject a `now: () => number` clock rather than sleeping.
- The caching integration test asserts `fixture.hits()` didn't increase, not just `x-cache: HIT`.
- The fixture server at `test/fixtures/server.ts` has `/good`, `/bad`, `/slow`, `/redirect`,
  `/json`, `/boom` — add new paths there when you need a new test scenario.

## What not to do
- Don't add a headless browser. It costs 300 MB + 2–5 s per audit. If we ever add rendering
  it ships as a separate async tier with its own worker pool.
- Don't change the response status for a target that returns 5xx. A target returning 500 is a
  successful audit with a bad score. Only our own failures are 5xx from us.
- Don't add a console.log. Everything goes through Fastify's `req.log` (Pino). Named events,
  not free text.
