# UiPath Jev Router

When a UiPath job faults, this pipeline uses **TypeSafe Jev as a router** to decide two things: whether the fault needs a fix at all, and if so, which Claude model should handle it. Claude Code then investigates with the UiPath CLI and the UiPath skills, and proposes the fix as a pull request.

```
Orchestrator ──job.faulted webhook (HMAC)──▶ Cloudflare Worker (worker/)
                                              verify signature · dedupe (KV) · map process → repo
                                              └─▶ repository_dispatch "uipath-job-faulted"
GitHub Actions: project repo → reusable workflow (.github/workflows/uipath-autofix.yml)
  1 triage  : uip login → gather evidence → Jev (4 judgments) → policy → skip | investigate | fix, sonnet | opus
              → is this fault already tracked by an open PR or issue?
  2 claude  : (skipped when already tracked) install Claude Code + uip + UiPath skills
              → diagnose (uipath-troubleshoot) → fix mode: apply (uipath-rpa conventions)
  3 publish : re-check the patch (guard + XML/JSON) → PR with the patch, or an issue with the
              diagnosis; a fault that is already tracked gets a comment on its thread
```

| Jev verdict | What happens |
|---|---|
| No code fix needed (`needs_code_fix < 0.30`, not recurring) | **skip**: the routing table goes to the Actions run summary only, and no Claude tokens are spent |
| Uncertain, or noise that keeps recurring | **investigate**: Claude diagnoses and opens an issue |
| Code fix needed (`≥ 0.70`, category not noise) | **fix**: Claude diagnoses and applies the fix, and the workflow opens a PR |
| Fix is complex, poorly localized, or Jev's complexity answer is diffuse | the work runs on **Opus**; otherwise it runs on **Sonnet** |

## How Jev routes

`triage/` builds a bounded JSON state from the Orchestrator evidence:
- the job record and error logs
- the tail of the robot log
- the fault history over the last 24h
- which workflows the error references, and whether they exist in this repo

It asks Jev four questions in **one request** (`triage/src/questions.ts`):

| Id | Primitive | Judgment |
|---|---|---|
| `fault_category` | Choice | automation_logic · ui_selector_drift · input_data · transient · infrastructure · external_system |
| `needs_code_fix` | Noul | Does resolving this fault and preventing recurrence require changing the source? |
| `fix_complexity` | Score 0–3 | one value → one workflow → several workflows → redesign or unclear |
| `location_pinpointed` | Noul | Do the error logs identify the failing workflow file and activity? |

`triage/src/policy.ts` is a pure function that turns those probabilities into the action and the model. All thresholds live in `triage/policy.config.json`. The Jev model is pinned to `jev-1.14.0`, and one triage costs a fraction of a cent. If Jev is unreachable (no connection, a timeout, a rate limit or a server error), triage falls back to **investigate + Sonnet**. A rejected key or a malformed request fails the run instead, so a misconfiguration cannot quietly bypass Jev.

## Layout

| Path | What |
|---|---|
| `worker/` | Cloudflare Worker that verifies the signature, dedupes, maps process → repo, and dispatches |
| `triage/` | Jev router: evidence → state → questions → policy → decision, plus an eval harness and fixtures |
| `scripts/` | CI steps: install tools, `uip` login, gather evidence, run Claude, guard the patch, publish; tests in `scripts/test/` |
| `prompts/`, `schemas/` | Claude Code prompts and the structured-output schemas for diagnose and fix |
| `.github/workflows/uipath-autofix.yml` | The reusable workflow that each project repo calls |
| `templates/project-caller.yml` | The ~15-line workflow to drop into each UiPath project repo |
| `docs/SETUP.md` | One-time setup: UiPath, Cloudflare, GitHub |

## Develop

```bash
npm install
npm test                         # worker + triage unit tests, then the script tests (need bash and git; python3 or python for the XML checks)
npm run typecheck
TYPESAFE_API_KEY=... npm run eval -w triage -- --save eval/answers.json   # route the labeled fixtures through real Jev and record the answers
npm run eval -w triage -- --replay eval/answers.json                      # re-run the policy on the recorded answers, no API calls
npm run build -w triage && node triage/dist/src/cli.js --evidence <raw dir> --project <repo> --dry-run
```

## Data handling

A fault sends Orchestrator data to three places. Decide whether that is acceptable for the processes you map before you turn the pipeline on.

| Where | What | How long |
|---|---|---|
| TypeSafe (Jev) | A bounded state: the job's error text, up to 10 error log messages, the last 40 log lines, timings and machine name | Per TypeSafe's terms |
| Anthropic (Claude) | Whatever the diagnosis reads: the captures below and the project source | Per Anthropic's terms |
| GitHub | The `triage` artifact with the raw captures, the `investigation` and `autofix` artifacts, and the excerpts Claude quotes in the issue or PR | Artifacts 14 days; issues and PRs until deleted |

- The raw captures are the job record (**including its input and output arguments**), up to 270 log rows, the job's state history, and 24 hours of job history for the process. Robot logs and arguments often hold business data.
- Keep project repos private unless that data may be public: artifacts and issues are readable by everyone who can read the repo.
- If arguments are sensitive, drop them from the capture by adding an `--output-filter` to the `jobs get` call in `scripts/gather-evidence.sh`.

## Security model

- **Webhook payloads are untrusted.**
  - They only reach CI scripts through `env:`, never through `${{ }}` in `run:`.
  - The job key and process key are validated before use.
  - Prompts are rendered in Node, never through the shell.
- **UiPath access is read-only.** The External Application has read-only scopes, so the model can run `uip` freely during diagnosis without being able to change Orchestrator. Those scopes are what bound the `uip` token: the model's file rules discourage reading the token file, but they are not an OS sandbox.
- **Claude runs in a job with no write token** and a credential-less checkout.
  - Its tools are an explicit allowlist (`--permission-mode dontAsk`). The only shell commands are `uip or …`, two other read-only `uip` command families, and `tee`/`mkdir` under `.local/investigations/`. The fix phase has no shell at all.
  - File edits are confined to the checkout, and the paths `publish` refuses are already denied at the edit.
  - Settings committed in the project repo are not loaded (`--setting-sources user`), and `ANTHROPIC_API_KEY` is stripped from the environment of the commands Claude runs (`CLAUDE_CODE_SUBPROCESS_ENV_SCRUB`).
  - The saved `uip` login is deleted before the fix phase.
- **The tool versions are frozen.** An npm pin alone does not hold for `uip`, which updates itself daily and loads tool packages from the nearest `node_modules/@uipath`. `scripts/install-tools.sh` freezes the version, installs the tools up front and makes `uip` load them from the global install only, so nothing is installed or loaded from the checkout while the model runs.
- **Only `publish` can write, and it trusts nothing the Claude job produced.**
  - It takes only the known files from that job's artifact, and keeps the triage decision only when its hash matches the one the triage job reported (`scripts/accept-artifacts.sh`).
  - It stages the patch itself and judges what git actually staged, never the patch text (`scripts/stage-patch.sh`, `scripts/check-staged.mjs`). A patch can be written so that the paths git applies differ from the ones its headers show.
  - Allowed: added, modified or deleted regular files of the listed types, within the size and count limits.
  - Refused: `.github/`, agent and editor configuration (`.claude/`, `CLAUDE.md`, `AGENTS.md`, `.mcp.json`, `.vscode/`, `NuGet.Config`), mode changes, symlinks, binaries, XML that is not well-formed or carries a DTD, invalid JSON, and added lines that look like a credential.
- **The patch holds only what the fix phase edited.** The worktree is reset between diagnosis and fix, so files that `uip` or the investigation left behind cannot reach a PR.
- **Everything published is scrubbed.** That covers PR and issue bodies, comments, titles, commit subjects and the run summary. Model-written text cannot render images, raw HTML or @-mentions, and anything that looks like a credential is redacted.
- **The human gate is PR review.** UiPath Studio validation does not run in CI.
