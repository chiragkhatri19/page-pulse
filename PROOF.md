# Verification proof

Last updated: 2026-07-25.

## CI

- Latest checked run: https://github.com/chiragkhatri19/page-pulse/actions/runs/30168260702
- Commit: `c2aadacde19b99cb17406a93a6e918e6b4520af2`
- Status: `success`
- Workflow: `CI`

The workflow runs typecheck, coverage tests on Node 20 and 22, build, Docker image build, and a container smoke test.

## Live checks

Live service: https://page-pulse-9riw.onrender.com

### Health

Command:

```bash
curl -i https://page-pulse-9riw.onrender.com/healthz
```

Observed result:

```text
HTTP 200
{"status":"ok","uptimeSeconds":620.009470769}
```

### First audit

Command:

```bash
curl -i -X POST https://page-pulse-9riw.onrender.com/v1/audit \
  -H 'content-type: application/json' \
  -d '{"url":"https://example.com"}'
```

Observed result:

```json
{
  "requestId": "b47290d3-2eb1-4133-bfe0-0517b43b3638",
  "cache": { "hit": false, "ageSeconds": 0, "ttlSeconds": 300, "deduped": false },
  "durationMs": 721
}
```

### Repeat audit served from cache

Command:

```bash
curl -i -X POST https://page-pulse-9riw.onrender.com/v1/audit \
  -H 'content-type: application/json' \
  -d '{"url":"https://example.com"}'
```

Observed result:

```json
{
  "requestId": "c4864508-3967-43e6-8d6b-935789d6f068",
  "cache": { "hit": true, "ageSeconds": 5, "ttlSeconds": 300, "deduped": false },
  "durationMs": 6
}
```

### SSRF guard

Command:

```bash
curl -i -X POST https://page-pulse-9riw.onrender.com/v1/audit \
  -H 'content-type: application/json' \
  -d '{"url":"http://169.254.169.254/latest/meta-data/"}'
```

Observed result:

```json
{
  "error": {
    "code": "URL_NOT_ALLOWED",
    "message": "Target resolves to a private or reserved address",
    "requestId": "3ccecb63-49fb-4482-97ee-120b1d57aa09"
  }
}
```

HTTP status: `422`.

## Local checks

Most recent local verification:

```bash
npm run build
npm test
```

Result:

- Build passed.
- 145 tests passed across 7 files.

Coverage evidence is recorded in [LOAD_TEST.md](./LOAD_TEST.md):

- 95.44% statements
- 87.73% branches
- 93.68% functions

---

Built for [Digital Heroes Training Task](https://digitalheroesco.com).
