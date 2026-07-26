# pagepulse.run submission

Role: Software Development (SDE). Task A and Task B.

## Links

- Live service: `https://page-pulse-9riw.onrender.com`
- Repository: `https://github.com/chiragkhatri19/page-pulse`
- API contract: [README.md](./README.md)
- Architecture document: [ARCHITECTURE.md](./ARCHITECTURE.md)
- Drive-visible architecture PDF: [ARCHITECTURE.pdf](./ARCHITECTURE.pdf)
- OpenAPI contract: [openapi.yaml](./openapi.yaml)
- Verification proof: [PROOF.md](./PROOF.md)

## Reviewer thesis

Most URL-audit demos are just `fetch(url)` plus a score. I treated the URL as attacker-controlled infrastructure input. That changes the shape of the project: SSRF protection, DNS pinning, redirect revalidation, request deadlines, bounded concurrency, cache dedupe, rate limits and structured error contracts become core product behavior, not cleanup work.

The live build still has a simple browser UI so the reviewer can try the API quickly. The API is the real deliverable.

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
| Burst-test evidence | `PROOF.md`; load-test runner in the GitHub repo at `scripts/load-test.mjs` |

## Task B evidence

`ARCHITECTURE.md` covers:

- Components, data flow, queueing strategy and state ownership, with a visible diagram in `ARCHITECTURE.pdf`.
- Technology decision record with rejected alternatives for each major choice.
- Three likely failure modes at scale, ranked by probability and blast radius.
- Monitoring, alerting, canary deploys and rollback strategy.

The scale document starts with the number most submissions skip: 10,000 audits/day is only about 0.12 requests per second on average. The hard part is not average throughput. The hard part is a 500-request burst aimed at third-party websites we do not control. That is why the design centers on single-flight caching, host bulkheads, deadline-based async conversion and explicit backpressure.

## Assumptions I made

**1. Audit scope.** I treated the audit as static HTML plus response headers, not a headless-browser Lighthouse clone. That means Page Pulse can grade SEO, accessibility markup, basic performance signals and security headers quickly, but it does not claim Core Web Vitals or SPA-rendered DOM coverage. The scale document explains where a slower `render: true` tier would fit later.

**2. Production-grade means hostile-input safe.** A URL audit service is naturally an SSRF risk because it fetches attacker-controlled URLs from inside our infrastructure. I treated private-address blocking, DNS validation, redirect revalidation and DNS pinning as core correctness work, not optional security polish.

**3. Target failures are not service failures.** If the audited site returns 500, Page Pulse still returns a successful audit response and marks that target status in the report. A 5xx from Page Pulse means our service failed. That distinction keeps monitoring and client behavior sane.

**4. Cache keys include query strings.** Query strings can change the page, so they are part of the cache key. Host casing and missing trailing slash are normalized because they should not create distinct entries.

**5. Single-node implementation, multi-node design.** Task A uses in-process cache, rate limiting and single-flight because the deployed build is one service instance. Task B moves those shared concerns to Redis because multiple replicas would otherwise multiply rate limits and split the cache.

## Where I used AI

I used AI as an implementation accelerator and as a reviewer, not as the decision-maker. One useful moment was rejecting the generic "scale the API horizontally" answer after doing the traffic math. Another was using AI to attack the SSRF design, which exposed a DNS rebinding window in the first approach.

The final implementation dials the exact validated address and revalidates every redirect hop before following it. The tests prove both behaviors.

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
- OpenAPI contract is included, and the load-test runner is in the public GitHub repo.

## Final packet contents

- `README.md`: API contract and implementation notes.
- `ARCHITECTURE.md`: full Task B architecture, technology decisions, failure analysis, observability and rollback.
- `ARCHITECTURE.pdf`: Drive-visible architecture diagram.
- `openapi.yaml`: machine-readable API contract.
- `PROOF.md`: live checks, CI, coverage and burst-test evidence.
