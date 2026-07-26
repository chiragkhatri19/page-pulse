# Packet manifest

This folder is the Drive-ready review packet. The source of truth for code remains the public GitHub repository.

## Files

| File | Purpose |
| --- | --- |
| `START_HERE.md` | Human-friendly entry point for the reviewer. |
| `SUBMISSION_LINKS.md` | Required links and quick reviewer path. |
| `SUBMISSION.md` | Task A and Task B evidence, assumptions, AI usage and checklist. |
| `README.md` | API contract, configuration, design notes, testing and repo layout. |
| `ARCHITECTURE.md` | Scale design for 10,000 audits/day, 500 concurrent bursts and SLA handling. |
| `ARCHITECTURE_DIAGRAM.svg` | Visible architecture diagram for Drive/GitHub preview. |
| `ARCHITECTURE_DIAGRAM.mmd` | Standalone Mermaid architecture diagram source. |
| `EVALUATOR_GUIDE.md` | Short technical guide for fast assessment. |
| `PROOF.md` | Live checks, CI proof, cache proof, SSRF proof and coverage numbers. |
| `LOAD_TEST.md` | Burst-test command and local evidence. |
| `CUSTOM_DOMAIN.md` | Plan for `scan.chiragships.site`. |
| `openapi.yaml` | Machine-readable API contract. |
| `render.yaml` | Deployment configuration. |
| `.env.example` | Documented environment knobs. |
| `package.json` | Scripts and dependencies. |

## Not included

- `node_modules`
- `.env`
- `.git`
- `dist`
- `coverage`

Those are intentionally omitted from the Drive packet. The public GitHub repo is the code deliverable.
