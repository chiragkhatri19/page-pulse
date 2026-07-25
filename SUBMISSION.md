# Page Pulse submission

Role: Software Development (SDE). Task A and Task B.

## Links

- Live service: `https://page-pulse-9riw.onrender.com`
- Repository: `https://github.com/chiragkhatri19/page-pulse`
- API contract: [README.md](./README.md)
- Architecture document: [ARCHITECTURE.md](./ARCHITECTURE.md)
- OpenAPI contract: [openapi.yaml](./openapi.yaml)
- Load-test evidence: [LOAD_TEST.md](./LOAD_TEST.md)
- Walkthrough: paste Loom link here after recording

## What I built

Page Pulse is a production-grade URL audit service. A client submits a public URL, the service validates it, guards against SSRF, fetches the page under strict timeouts, parses the HTML and response headers, and returns a scored JSON report across SEO, accessibility, performance and security.

The live build also includes a small browser UI so the reviewer can try the API without writing curl commands. The footer includes the required visible credit line linked to `digitalheroesco.com`.

## Task A evidence

| Requirement | Where it is covered |
| --- | --- |
| Input validation | `src/server.ts`, `src/lib/ssrf.ts` |
| Request timeouts | `src/lib/fetcher.ts`, environment config in `.env.example` |
| Concurrency limits | Global cap in `src/lib/semaphore.ts`; per-host cap and circuit breaker in `src/lib/hostGuard.ts` |
| Structured errors | `src/errors.ts`, Fastify error handler in `src/server.ts` |
| Caching window | `src/lib/cache.ts`, `CACHE_TTL_SECONDS` config |
| Repeat audit without refetch | `test/audit.route.test.ts` asserts the fixture origin is not hit again |
| Rate limiting per client | `src/lib/rateLimit.ts`, route hook in `src/server.ts` |
| Structured logging and request IDs | Fastify logger and request ID hooks in `src/server.ts` |
| Meaningful tests | 145 tests across SSRF, fetcher, cache, host guard, rate limit, scoring and routes |
| CI on push | `.github/workflows/ci.yml` runs typecheck, coverage tests, build and Docker smoke |
| Live deployment | Render service at `https://page-pulse-9riw.onrender.com` |
| README API contract | `README.md` |
| OpenAPI contract | `openapi.yaml` |
| Load-test evidence | `LOAD_TEST.md`, `scripts/load-test.mjs` |

## Task B evidence

`ARCHITECTURE.md` covers:

- Components, data flow, queueing strategy and state ownership, with a Mermaid diagram.
- Technology decision record with rejected alternatives for each major choice.
- Three likely failure modes at scale, ranked by probability and blast radius.
- Monitoring, alerting, canary deploys and rollback strategy.

The main architectural decision is that the SLA has to be tiered. A cache hit can have a tight latency promise because it is our work. A cache miss depends on a third-party origin, so the scale design enforces a deadline and converts slow misses to async jobs rather than pretending we can control another server's response time.

## Assumptions I made

**1. Audit scope.** I treated the audit as static HTML plus response headers, not a headless-browser Lighthouse clone. That means Page Pulse can grade SEO, accessibility markup, basic performance signals and security headers quickly, but it does not claim Core Web Vitals or SPA-rendered DOM coverage. The scale document explains where a slower `render: true` tier would fit later.

**2. Production-grade means hostile-input safe.** A URL audit service is naturally an SSRF risk because it fetches attacker-controlled URLs from inside our infrastructure. I treated private-address blocking, DNS validation, redirect revalidation and DNS pinning as core correctness work, not optional security polish.

**3. Target failures are not service failures.** If the audited site returns 500, Page Pulse still returns a successful audit response and marks that target status in the report. A 5xx from Page Pulse means our service failed. That distinction keeps monitoring and client behavior sane.

**4. Cache keys include query strings.** Query strings can change the page, so they are part of the cache key. Host casing and missing trailing slash are normalized because they should not create distinct entries.

**5. Single-node implementation, multi-node design.** Task A uses in-process cache, rate limiting and single-flight because the deployed build is one service instance. Task B moves those shared concerns to Redis because multiple replicas would otherwise multiply rate limits and split the cache.

## Where I used AI

I used AI heavily as an implementation accelerator and as a reviewer, but I made the architectural calls myself and pushed back on several first drafts. The clearest example is Task B: I rejected a generic "scale the API horizontally" answer after doing the math that 10,000 audits per day is only about 0.12 requests per second on average. The real problem is burst shape and third-party latency, which is why the architecture centers on caching, single-flight, bounded concurrency and async conversion for slow origins.

I also used AI to pressure-test the SSRF design. The first version validated the resolved IP but let the HTTP client resolve DNS again at connect time, leaving a DNS rebinding window. I changed the implementation so the fetcher dials the exact validated address and revalidates every redirect hop before following it. I added tests that prove the pinned connection works and that redirects to unsafe targets are rejected.

## Verification

Last local verification:

```bash
npm run typecheck
npm test
```

Result: typecheck passed; 145 tests passed.

Additional checks already performed:

- Live `/healthz` returned 200.
- Live landing page returned 200.
- Footer contains `Built for Digital Heroes Training Task` and links to `https://digitalheroesco.com`.
- GitHub repo is public.
- `.env` is ignored and not tracked.
- OpenAPI contract and load-test runner are included.

## Loom running order

Use this as a guide, not a script to read word for word.

**0:00 to 0:20 - What it is**

Show the live site. Explain that Page Pulse audits a public URL and returns a scored JSON report across SEO, accessibility, performance and security.

**0:20 to 0:55 - Live demo**

Audit `https://example.com`, point to the score and recommendations, then run it again and show the cache hit. Paste `http://169.254.169.254/` and show the 422 SSRF rejection.

**0:55 to 1:30 - Engineering choices**

Open `src/lib/semaphore.ts`, `src/lib/hostGuard.ts`, `src/lib/cache.ts` and `src/lib/fetcher.ts`. Call out bounded concurrency, per-host bulkheading, single-flight cache dedupe and DNS-pinned fetching.

**1:30 to 2:00 - Tests and CI**

Run `npm test` or show the latest passing output. Mention that the suite asserts behavior, not just status codes: cache tests check origin hit counts, and fetcher tests cover DNS pinning and redirect revalidation.

**2:00 to 2:40 - Scale architecture**

Open `ARCHITECTURE.md`. Explain the key SLA decision: cache hits are fast and fully under our control; slow cache misses convert to async jobs because third-party website latency is not under our control.

**2:40 to 3:00 - What I would improve next**

Name one honest next step: move the in-process cache, rate limits, single-flight locks and host guard to Redis so the same protections work across multiple replicas.

## Final pre-submit checklist

- [x] Public GitHub repo exists.
- [x] Live deployment works.
- [x] README has API contract.
- [x] Architecture document covers Task B.
- [x] OpenAPI contract exists.
- [x] Load-test evidence exists.
- [x] Required footer credit exists on the live page.
- [x] Local typecheck passes.
- [x] Local tests pass.
- [ ] Record Loom and paste final link above.
- [ ] Create Google Drive folder named `SDE_Chirag Khatri`.
- [ ] Add a one-page links document to the Drive folder.
- [ ] Add PDF copies of README and ARCHITECTURE as fallback artifacts.
- [ ] Set Drive sharing to "anyone with the link can view".
- [ ] Test the Drive link in an incognito window.
- [ ] Follow `@realshreyanshsingh`.
- [ ] Send the single Drive link by Instagram DM.
