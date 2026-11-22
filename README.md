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

`triage/src/policy.ts` is a pure function that turns those probabilities into the action and the model. All thresholds live in `triage/policy.config.json`. The Jev model is pinned to `jev-1.14.0`, and one triage costs a fraction of a cent. If Jev is unreachable, triage falls back to **investigate + Sonnet**.

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
npm test                         # worker + triage unit tests, then the script tests (need bash; python3 for the XML checks)
npm run typecheck
TYPESAFE_API_KEY=... npm run eval -w triage   # route the labeled fixtures through real Jev
npm run build -w triage && node triage/dist/src/cli.js --evidence <raw dir> --project <repo> --dry-run
```

## Security model

- **Webhook payloads are untrusted.**
  - They only reach CI scripts through `env:`, never through `${{ }}` in `run:`.
  - The job key and process key are validated before use.
  - Prompts are rendered in Node, never through the shell.
- **UiPath access is read-only.** The External Application has read-only scopes, so the model can run `uip` freely during diagnosis without being able to change Orchestrator. Those scopes are what bound the `uip` token: the model's file rules discourage reading the token file, but they are not an OS sandbox.
- **Claude runs in a job with no write token** and a credential-less checkout. Its tools are an explicit allowlist (`--permission-mode dontAsk`), its rules deny writes to `.git/`, `.github/` and `.autofix/`, and `ANTHROPIC_API_KEY` is stripped from the environment of the commands it runs (`CLAUDE_CODE_SUBPROCESS_ENV_SCRUB`).
- **Only `publish` can write, and it trusts nothing the Claude job says about the patch.** It re-runs `scripts/check-patch.sh` itself, which rejects `.github/`, renames, binaries, symlinks, mode changes, unknown file types and oversized diffs, and then re-checks that changed XAML parses and contains no DTD.
- **The patch holds only what the fix phase edited.** The worktree is reset between diagnosis and fix, so files that `uip` or the investigation left behind cannot reach a PR.
- **PR and issue bodies are scrubbed.** Model-written text cannot render images, raw HTML or @-mentions, and anything that looks like a credential is redacted.
- **The human gate is PR review.** UiPath Studio validation does not run in CI.
