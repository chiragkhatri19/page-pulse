# Page Pulse SDE Submission

Name: Chirag Khatri  
Role: Software Development (SDE)

## Review links

- Live service: https://page-pulse-9riw.onrender.com
- GitHub repository: https://github.com/chiragkhatri19/page-pulse
- Recommended first read: [SUBMISSION.md](./SUBMISSION.md)

## The short version

Page Pulse is a URL audit API built around the parts that usually get skipped in demo projects: hostile input, slow origins, cache stampedes, rate limits, useful errors and proof that the thing actually runs.

The scoring UI is there so the service is easy to try. The engineering work is in the request path: validate the URL, resolve and pin the target address, reject private networks, limit each client, collapse duplicate audits, cap outbound concurrency, fetch under deadlines, and return a structured report with a request ID.

## Fast review path

1. Open the live service and scan `https://example.com`.
2. Scan it again. The second response should come back as a cache hit.
3. Scan `http://169.254.169.254/latest/meta-data/`. It should return `422 URL_NOT_ALLOWED`.
4. Open [PROOF.md](./PROOF.md) for live verification, test coverage and burst-test evidence.
5. Open [ARCHITECTURE.pdf](./ARCHITECTURE.pdf) for the architecture diagram in a Drive-visible document.
6. Open [ARCHITECTURE.md](./ARCHITECTURE.md) for the full 10,000 audits/day and 500-concurrent-request design.
7. Open [README.md](./README.md) for the API contract.

## What I would ask about in an interview

- Why the fetcher dials the DNS-validated IP instead of letting the HTTP client resolve again.
- Why a target site's `500` is a successful audit, while a Page Pulse `500` is an outage.
- Why the scale design converts slow cache misses to async jobs instead of pretending third-party latency is under our control.
- Why the cache and rate limiter are in process for the submitted build, but move to Redis in the scale design.
- How the test suite proves behavior rather than only testing helper functions.

## AI usage

AI tools were used as an implementation accelerator and reviewer. The final choices are mine, and [SUBMISSION.md](./SUBMISSION.md) calls out the places where AI helped pressure-test the design, especially the DNS rebinding gap in the first SSRF approach.

## Required footer

The live service includes the required footer credit:

`Built for Digital Heroes Training Task`

It links to `https://digitalheroesco.com`.
