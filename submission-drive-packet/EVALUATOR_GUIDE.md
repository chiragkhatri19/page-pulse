# Evaluator guide

This is the fastest path through the submission if you are reviewing several entries.

## Start here

- Live service: https://page-pulse-9riw.onrender.com
- Repository: https://github.com/chiragkhatri19/page-pulse
- API contract: [README.md](./README.md)
- Scale design: [ARCHITECTURE.md](./ARCHITECTURE.md)
- Verification proof: [PROOF.md](./PROOF.md)

## What to try first

1. Open the live service and scan `https://example.com`.
2. Scan the same URL again. The second response should be served from cache.
3. Scan `http://169.254.169.254/latest/meta-data/`. The service should reject it with `422 URL_NOT_ALLOWED`.
4. Open GitHub Actions and check the latest CI run.
5. Read the Task A versus Task B table in [ARCHITECTURE.md](./ARCHITECTURE.md#5-what-is-shipped-now-versus-what-changes-at-scale).

## Three things I want you to notice

**1. SSRF is treated as core correctness.** The service resolves and validates target addresses before fetching, rejects private and metadata ranges, revalidates redirect hops, and dials the validated address instead of letting the HTTP client resolve DNS again.

**2. Burst control is layered.** Caching, single-flight, global concurrency, per-host concurrency and per-host circuits are separate controls. They solve different failure shapes and are tested independently.

**3. Task B is not generic scaling advice.** The architecture starts by doing the traffic math. The average load is tiny; the real problems are burst shape, third-party latency and outbound reputation. The proposed scale design follows from that.

## Local verification commands

```bash
npm ci
npm run typecheck
npm test
npm run build
npm run test:coverage
```

Optional burst test:

```bash
npm run build
npm start
PAGE_PULSE_BASE_URL=http://127.0.0.1:3000 PAGE_PULSE_LOAD_TOTAL=20 PAGE_PULSE_LOAD_CONCURRENCY=5 npm run load:test
```

## Tradeoffs to ask me about

- Why this build uses static HTML parsing instead of headless Chrome.
- Why Task A keeps cache/rate-limit state in process, while Task B moves it to Redis.
- Why a slow target origin should convert to async at scale instead of making the synchronous API wait.
- Why a target `500` is a successful audit response, but a service `500` is an outage.

---

Built for [Digital Heroes Training Task](https://digitalheroesco.com).
