# Submission notes

Role: Software Development (SDE). Task A and Task B.

- Live service: `https://page-pulse-9riw.onrender.com`
- Repository: `https://github.com/chiragkhatri19/page-pulse`
- Architecture document (Task B): [ARCHITECTURE.md](./ARCHITECTURE.md)
- API contract: [README.md](./README.md)
- Walkthrough: `https://<your-loom-url>`

---

## Assumptions I made

The brief says "the same URL-audit service" but I did not receive a prior spec, so I defined it. Each call below is a judgment I would defend rather than a gap I ignored.

**1. What an audit actually measures.** I defined it as 24 weighted checks across four pillars: SEO, accessibility, performance and security. Everything is derived from static HTML plus response headers. No headless browser. That means no Core Web Vitals and no SPA rendering, which is a real limitation I chose knowingly: rendering costs about 300 MB and 2 to 5 seconds per audit versus 15 ms, which would break the response-time SLA in Task B outright. Task B specifies where rendering fits later, as a separate async tier.

**2. "Production-grade" means resilient to hostile input, not just handled errors.** An audit service takes an arbitrary URL from an untrusted client and fetches it from inside our network. That is an SSRF machine by construction. I treated the SSRF guard as a core requirement rather than a nice-to-have, and it is the single largest block of tests in the suite.

**3. A target returning 500 is a successful audit that scores badly.** It is not a 5xx from us. This distinction runs through the whole error taxonomy, because it is what makes an alert on our error rate meaningful instead of noise from other people's broken websites.

**4. Caching is per-URL including the query string,** since the query changes the page, but normalised on host casing and trailing slash, since those do not. Key is namespaced `audit:v1:` so a future change to the report shape cannot serve an old shape to a new client.

**5. Rate limiting is per API key when one is present, per IP otherwise.** IP is a weak identity, so it is the fallback rather than the default. `x-forwarded-for` is trusted only because deployment terminates at a proxy I control.

**6. Task B's SLA cannot be promised on uncached fetches.** Response time for a cache miss is set by a third-party web server that owes us nothing. Rather than write an SLA I could not hold, I designed a two-mode API where a miss that exceeds the deadline converts to `202 Accepted` with a job ID. This is the central decision in Task B and the one I would most want to be asked about.

**7. Single-node build, multi-node design.** Task A ships in-process cache, rate limit and single-flight because it runs as one instance. Task B moves all three to Redis, and explains why that is not optional past one box: with N replicas, per-replica rate limits silently mean N times the advertised limit. The cache interface in Task A is already written so the Redis implementation is a swap, not a rewrite.

**Gap I identified and then closed:** the SSRF guard originally validated the resolved address but didn't pin it for the connection, leaving a narrow DNS rebinding window (validate a public IP, then let the HTTP client re-resolve DNS at connect time and land on `169.254.169.254`). I flagged this in Task B's failure analysis as the first thing I'd ship, then shipped it: `fetcher.ts` now dials the exact address `assertPublicTarget` validated via a custom undici `connect` function, and every redirect hop is re-validated and re-pinned before it's followed. `test/fetcher.test.ts` has a case that fails against the pre-fix code (a hostname that can never resolve via DNS, reached only because the connection is pinned to a known-good address) and a case proving a redirect to a re-validated-as-private address is rejected the same way a direct request would be.

---

## Where I used AI

> Rewrite this in your own words before submitting. It has to be true for you, and the interview will be built on it.

I used Claude heavily and would not pretend otherwise. The pattern was: I made the architectural calls and used the model to execute them fast, then pushed back on what came out.

What I directed rather than accepted: the two-mode SLA design in Task B is mine, and it came from noticing that 10,000 audits a day is 0.12 requests per second, so the interesting problem is burst shape and third-party latency rather than throughput. I asked for a first pass that treated it as a scaling problem and rejected it. I also insisted the SSRF guard be a first-class component with real tests after the first version treated it as a one-line URL check, and I chose static parsing over a headless browser once I worked out what rendering does to the latency budget.

What I changed after: [this is factual raw material — verify it's true for you and rewrite in your own voice before submitting, per the note above] The SSRF guard originally validated a target's resolved IP and then discarded it — the actual socket connection let undici resolve DNS again from scratch, which is the rebinding hole DNS-pinning attacks exploit. I had the model draft a first pass and rejected it because it hard-coded the pinned IP into the shared connection pool, which would leak one request's validated address to a different request against the same hostname. I made it build a throwaway single-use connection per hop instead, and required every redirect hop to be re-validated through the same SSRF check as the original URL, not just the first request. I also used the model to pressure-test the failure analysis by asking it to argue against my mitigations, and dropped two failure modes that were generic infrastructure risks rather than specific to auditing strangers' URLs.

---

## Loom script (2 to 3 minutes)

Do not read this out. It is a running order so you do not ramble. Screen-share the live site, then the repo.

**0:00 to 0:20 — What it is, and the one number that shaped it**
"This is Page Pulse. You give it a URL, it fetches the page and scores it across SEO, accessibility, performance and security. The thing that shaped every decision is that 10,000 audits a day is 0.12 requests per second. Load is not the problem. The problem is bursts, and the fact that the latency I'm promising is mostly somebody else's web server."

**0:20 to 0:55 — Live demo.** Audit a real URL on the live site. Point at the score and the ordered fix list. Run it again and point at `x-cache: HIT` in devtools. Then paste `http://169.254.169.254/` and show the 422.
"That last one is cloud metadata. An audit service fetches attacker-supplied URLs from inside my network, so that's the first thing I hardened."

**0:55 to 1:30 — The part I'd defend.** Open `semaphore.ts` and `cache.ts`.
"Two things I'd call out. The concurrency queue is bounded in both depth and wait time, because unbounded queueing just turns a fast failure into a slow one while memory climbs. And single-flight sits in front of the fetch, so 500 concurrent requests for one cold URL produce exactly one outbound fetch. There's a test that fires 12 at once and asserts the origin was hit once."

**1:30 to 2:00 — Tests and CI.** Run `npm test` on camera. 137 tests, roughly 3 seconds.
"Time-dependent tests inject a fake clock rather than sleeping. The caching test asserts the origin was not re-hit, not just that a header said HIT. CI runs this on Node 20 and 22, then builds the container and smoke-tests a real audit against it."

**2:00 to 2:40 — Task B, the one decision.** Show the diagram.
"You can't promise a response time for work a third party performs. So the API has two modes: if a cache miss blows the 5-second deadline, it converts to a 202 with a job ID and the work moves to a queue. I never miss the SLA because a customer's site is slow, and I never lie about how long it took."

**2:40 to 3:00 — Close on a gap I closed, and the one that's next.**
"The SSRF guard used to validate the resolved IP but not pin it for the connection — a narrow DNS rebinding window. I fixed that: `fetcher.ts` dials the exact validated address now, and every redirect hop gets re-validated before it's followed. [Name whatever's honestly next on your list once this one's off it — don't reuse a fixed gap as your closing line.]"

---

## Pre-submit checklist

- [x] Files reorganised into `src/lib` + `test`, `node_modules/`, `dist/`, `coverage/`, `.env*` confirmed gitignored
- [x] `npm run typecheck` and `npm test` pass locally (137/137)
- [ ] `git init`, commit, push to a **public** GitHub repo, confirm the CI badge is green
- [x] Deployed to Render (free plan) at `page-pulse-9riw.onrender.com`; find-and-replace done in `README.md` and `public/index.html`; verified live: `/healthz` 200, a real audit, `x-cache: HIT` on repeat, and `422 URL_NOT_ALLOWED` for `169.254.169.254`
- [ ] Load the live site and confirm the footer credit renders and the link to digitalheroesco.com works
- [ ] Record the Loom, set it to "anyone with the link"
- [ ] Rewrite the AI paragraph so it is true for you
- [ ] Google Drive folder named `SDE_Chirag Khatri`, set to "anyone with the link can view", containing: a one-page links document (live URL, repo URL, Loom URL), plus PDF copies of README and ARCHITECTURE as a fallback in case a reviewer does not open GitHub
- [ ] Test the Drive link in an incognito window. A private link counts as no submission
- [ ] Follow @realshreyanshsingh **before** sending the DM
- [ ] Send the single Drive link by Instagram DM
