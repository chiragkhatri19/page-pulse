# SDE submission links - Chirag Khatri

Role: Software Development (SDE)

## Required links

- Live service: https://page-pulse-9riw.onrender.com
- GitHub repository: https://github.com/chiragkhatri19/page-pulse
- Evaluator guide: EVALUATOR_GUIDE.md
- Live proof: PROOF.md

## Supporting documents

- API contract: README.md
- OpenAPI contract: openapi.yaml
- Scale architecture: ARCHITECTURE.md
- Standalone Mermaid diagram: ARCHITECTURE_DIAGRAM.mmd
- Load-test evidence: LOAD_TEST.md
- Submission notes: SUBMISSION.md
- Custom domain plan: CUSTOM_DOMAIN.md

## Quick reviewer path

1. Open the live service and run an audit for `https://example.com`.
2. Run the same audit again to see the cache hit behavior.
3. Try `http://169.254.169.254/` to see the SSRF guard reject cloud metadata access.
4. Open `ARCHITECTURE.md` for the 10,000 audits/day and 500-concurrent-request design.
5. Open `LOAD_TEST.md` for burst-test commands and latest verification numbers.
6. Open `PROOF.md` for live CI, health, cache and SSRF evidence.
7. Check GitHub Actions for CI, or run `npm run typecheck` and `npm test` locally.
