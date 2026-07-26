# Digital Heroes SDE Submission

Name: Chirag Khatri  
Role: Software Development (SDE)

## Review links

- Live service: https://page-pulse-9riw.onrender.com
- GitHub repository: https://github.com/chiragkhatri19/page-pulse
- Recommended first read: [EVALUATOR_GUIDE.md](./EVALUATOR_GUIDE.md)

## What this is

`pagepulse.run` is a production-minded URL audit service. It accepts a public URL, validates it, blocks unsafe network targets, fetches under strict timeouts, scores the page across SEO, accessibility, performance and security, and returns a structured JSON report.

The important part is not the scoring UI. The important part is the production behavior around it: SSRF defense, DNS-pinned fetching, bounded concurrency, per-host protection, cache dedupe, rate limiting, structured errors, request IDs, tests and CI.

## Fast review path

1. Open the live service.
2. Scan `https://example.com`.
3. Scan it again and check that the second response is cached.
4. Scan `http://169.254.169.254/latest/meta-data/` and confirm it returns `422 URL_NOT_ALLOWED`.
5. Open [PROOF.md](./PROOF.md) for live verification evidence.
6. Open [ARCHITECTURE.pdf](./ARCHITECTURE.pdf) for the architecture diagram in a Drive-visible document.
7. Open [ARCHITECTURE.md](./ARCHITECTURE.md) for the full 10,000 audits/day and 500-concurrent-request design.
8. Open [README.md](./README.md) for the API contract.

## What to notice

- The implementation treats URL auditing as an SSRF risk, not just an HTTP request.
- The cache has single-flight behavior so repeated cold requests do not stampede the origin.
- One slow hostname cannot consume the whole audit pool because global and per-host limits are separate.
- The scale document starts with the traffic math and designs around burst shape plus third-party latency.
- The tests assert behavior, including origin hit counts, redirect revalidation, rate-limit headers, cache hits and structured error contracts.

## AI usage

AI tools were used as an implementation accelerator and reviewer. The architectural decisions, tradeoffs and final implementation choices are documented in [SUBMISSION.md](./SUBMISSION.md), including where early drafts were rejected and tightened.

## Required footer

The live service includes the required footer credit:

`Built for Digital Heroes Training Task`

It links to `https://digitalheroesco.com`.
