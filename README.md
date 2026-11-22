# UiPath Autofix

When a UiPath Orchestrator job faults, this pipeline collects the evidence, decides whether the fault needs a code change, and has Claude Code diagnose it and, when the cause is clear, fix it. The result lands in that project's GitHub repo as a pull request, an issue, or just a note in the Actions run summary.

```
Orchestrator ── job.faulted webhook ──▶ Cloudflare Worker ── repository_dispatch ──▶ project repo
                                                                                        │
   GitHub Actions (reusable workflow)                                                   ▼
   1 triage   gather evidence with uip → Jev: skip | investigate | fix, Sonnet | Opus
   2 claude   diagnose (uipath-troubleshoot) → apply the fix (uipath-rpa)
   3 publish  check the patch → PR, issue, or a comment on the existing thread
```

## How it works

1. **Worker** (`worker/`): receives the Orchestrator `job.faulted` webhook, verifies its signature, drops duplicate faults, maps the process to its GitHub repo and triggers that repo's workflow.
2. **Triage** (`triage/`): logs in to UiPath with a read-only app and gathers the job, its logs and recent history. TypeSafe Jev then acts as the **triage** step (does this fault need intervention?) and the **model router** (Sonnet for small fixes, Opus for complex ones). A fault that already has an open PR or issue only gets a comment.
3. **Claude Code**: runs in a job with no write access. It investigates with the `uip` CLI and the UiPath skills, and in fix mode edits the project source.
4. **Publish**: the only job that can write. It checks the patch, then opens a PR or an issue, or comments on the existing one.

Each UiPath project repo calls the reusable workflow (`.github/workflows/uipath-autofix.yml`) with a short caller (`templates/project-caller.yml`). The caller can also be run by hand for any job key, with the action and model overridden.

## Outcomes

| Triage decision | What you get |
|---|---|
| **skip**: no code fix needed | The routing table in the Actions run summary. Claude does not run. |
| **investigate**: uncertain, or recurring noise | An issue with Claude's diagnosis |
| **fix**: a code change is needed | A pull request with the fix and the diagnosis |

The thresholds and models are in `triage/policy.config.json`, and the questions Jev answers are in `triage/src/questions.ts`. If Jev can't be reached, triage falls back to investigate with Sonnet.

## Layout

| Path | What |
|---|---|
| `worker/` | Cloudflare Worker: webhook → GitHub dispatch |
| `triage/` | Evidence → Jev → decision, plus an eval harness and labeled fixtures |
| `scripts/` | CI steps: install tools, log in, gather evidence, run Claude, check and publish the patch |
| `prompts/`, `schemas/` | Claude Code prompts and output schemas for diagnose and fix |
| `.github/workflows/uipath-autofix.yml` | The reusable workflow |
| `templates/project-caller.yml` | The workflow to copy into each UiPath project repo |
| `docs/` | `SETUP.md` (one-time setup) and `SECURITY.md` (security model and data handling) |

## Setup

See [docs/SETUP.md](docs/SETUP.md). It covers the toolkit repo, the UiPath External Application, the Cloudflare Worker, the Orchestrator webhook and each project repo.

## Develop

```bash
npm install
npm test            # unit and script tests (need bash and git; python3 or python for the XML checks)
npm run typecheck
TYPESAFE_API_KEY=... npm run eval -w triage -- --save eval/answers.json   # run the fixtures through Jev and record the answers
npm run eval -w triage -- --replay eval/answers.json                      # re-run the policy on recorded answers, no API calls
npm run build -w triage && node triage/dist/src/cli.js --evidence <raw dir> --project <repo> --dry-run
```

## Security and data

- Webhook data is treated as untrusted input.
- UiPath access is read-only.
- Claude runs with no write token and an explicit tool allowlist.
- Only the publish job can write, and it checks what git actually staged before opening a PR.
- Everything published is scrubbed of credentials, and PR review is the human gate.
- Fault data goes to TypeSafe, Anthropic and GitHub (artifacts are kept 14 days), so keep project repos private.

Details: [docs/SECURITY.md](docs/SECURITY.md).
