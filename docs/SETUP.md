# One-time setup

Replace `your-github-owner` in these files before pushing:
- `templates/project-caller.yml`
- the `toolkit_repository` default in `.github/workflows/uipath-autofix.yml`
- `PROCESS_REPO_MAP` in `worker/wrangler.jsonc`

## 1. Toolkit repo

1. Push this directory to `<owner>/uipath-jev-router` and tag `v1`: `git tag v1 && git push --tags`.
2. Project repos must be able to use its reusable workflow:
   - **Public repo:** nothing to do.
   - **Private repo:** go to Settings → Actions → General → Access, and allow repositories owned by the same user or organization. Then add a `TOOLKIT_TOKEN` secret (a fine-grained PAT with Contents: read on the toolkit repo) to each project repo, because the workflow checks the toolkit out to run its scripts.

## 2. UiPath External Application (read-only)

1. Go to Automation Cloud → Admin → External Applications → **Add** → *Confidential application*.
2. Under *Application scopes → Orchestrator API Access*, add `OR.Jobs.Read`, `OR.Folders.Read`, `OR.Execution.Read`, `OR.Monitoring.Read`, `OR.Robots.Read` and `OR.Machines.Read`.
3. Copy the **App ID** and **App Secret**.
4. In Orchestrator, give the external application access to the folders that run the monitored processes, with a role that can view jobs and logs.
5. Check it locally from an empty folder:
   ```bash
   UIPATH_CLIENT_ID=... UIPATH_CLIENT_SECRET=... UIPATH_TENANT=DefaultTenant UIPATH_AUTHORITY=https://cloud.uipath.com \
     bash scripts/uip-login.sh
   ```
   - Use your own host for `UIPATH_AUTHORITY`, for example `https://staging.uipath.com`, or an Automation Suite URL.
   - This replaces your saved `uip` login on that machine. Run `uip login` again afterwards.

## 3. Cloudflare Worker

```bash
cd worker
npx wrangler login
npx wrangler kv namespace create DEDUPE          # paste the id into wrangler.jsonc
mkdir -p ../.local                               # gitignored, so it does not exist in a fresh clone
openssl rand -hex 32 > ../.local/webhook-secret  # keep this file private
npx wrangler secret put UIPATH_WEBHOOK_SECRET    # paste the same value
npx wrangler secret put GITHUB_DISPATCH_TOKEN    # fine-grained PAT, see below
npx wrangler deploy
curl https://uipath-jev-router.<you>.workers.dev/health   # {"ok":true}
```

- **`GITHUB_DISPATCH_TOKEN`** is a fine-grained PAT with **Repository access** limited to the UiPath project repos, and **Permissions → Contents: Read and write**, which `repository_dispatch` requires. Nothing else.
- **`PROCESS_REPO_MAP`** maps the Orchestrator process (`Release.ProcessKey`) to `owner/repo`. Faults from unmapped processes are acknowledged and ignored.
- **`ORCHESTRATOR_BASE_URL`** (optional) enables job deep links in PRs and issues, for example `https://cloud.uipath.com/<org>/<tenant>/orchestrator_`.

## 4. Orchestrator webhook

Run this yourself. It takes the secret, so don't paste the secret into chat:

```bash
uip or webhooks create "Jev Autofix" \
  --url "https://uipath-jev-router.<you>.workers.dev/uipath/webhook" \
  --events "job.faulted" \
  --secret "$(cat .local/webhook-secret)" --output json
```

**Confirm the payload shape once:**
1. Set `"LOG_RAW_PAYLOAD": "true"` in `wrangler.jsonc`, redeploy, and run `npx wrangler tail`.
2. Make a test job fault.
3. Check that the logged body has `Job.Key`, `Job.Info` and `Job.Release.ProcessKey`, and check which encoding the `x-uipath-signature` header uses. The Worker accepts hex or base64, with or without `sha256=`.
4. Set `LOG_RAW_PAYLOAD` back to `"false"`.

## 5. Each UiPath project repo

1. Copy `templates/project-caller.yml` to `.github/workflows/uipath-autofix.yml`.
2. **Secrets:** `ANTHROPIC_API_KEY`, `TYPESAFE_API_KEY`, `UIPATH_CLIENT_ID`, `UIPATH_CLIENT_SECRET`, plus `TOOLKIT_TOKEN` if the toolkit is private. Organization-level secrets work too.
3. **Variables:** `UIPATH_TENANT`, plus `UIPATH_AUTHORITY` if you are not on `cloud.uipath.com`, and optionally `UIPATH_ORG`.
4. **Settings → Actions → General:** enable *Allow GitHub Actions to create and approve pull requests*.

## 6. Tune and test

1. **Jev thresholds:** run `TYPESAFE_API_KEY=... npm run eval -w triage`.
   - Every labeled fixture in `triage/fixtures/` should route as expected.
   - Adjust `triage/policy.config.json` if needed.
   - Use `--save eval/answers.json` once and `--replay eval/answers.json` to re-tune without API calls.
   - Add fixtures from your own real faults over time.
2. **Replay a real fault without the webhook:** in the project repo, go to Actions → *UiPath autofix* → **Run workflow** and enter a faulted job key and process name. Use `force_action` / `force_model` to demo a specific path.
3. **End to end:** make a job fault in Orchestrator, then watch the Worker log (`wrangler tail`), then the Actions run, then the PR or issue.
4. **First Claude runs:**
   - Check the `permission denied` notices in the *Diagnose* step log, and that the log shows the `uipath-troubleshoot` skill being loaded. Claude runs with `--setting-sources user`, so it reads the runner's user settings (where the skills plugin is enabled) and ignores any `.claude/settings` committed in the project repo.
   - The allowlist in `scripts/run-claude.sh` is deliberately narrow: `uip or …`, `uip traces spans get …`, `uip docsai ask …`, and `tee` and `mkdir` under `.local/investigations/`. Widen it only for a specific read-only command the investigation actually needs. Do not add wildcards for `find`, `grep`, `jq` or `uip` as a whole: `find -exec` runs anything, and `uip` also installs packages and runs local code.
   - The script sets `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1`. It keeps the API key out of the commands Claude runs, and Claude Code then runs those commands in its own sandbox.
     - If Bash commands fail to start on your runner, that sandbox could not be set up. A likely cause on Ubuntu 24.04 runners is the default restriction on unprivileged user namespaces; a step running `sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0` before the Claude steps lifts it.
     - Setting the variable to `0` is the last resort: it hands the API key to every command the model runs.
   - The `autofix` artifact keeps the full Claude result JSON, and the `investigation` artifact keeps the troubleshoot notes.

## Costs and limits

- **Jev:** about 2–4k input tokens per fault at $0.042 per million tokens, which is a fraction of a cent.
- **Claude:** per-model turn and dollar caps are in `policy.config.json`. Sonnet defaults to 40 turns and $3, Opus to 60 turns and $10. The caps apply to each phase, and a fix run has two (diagnose, then fix), so the ceiling for one fault is $6 on Sonnet and $20 on Opus. The PR or issue shows the actual cost.
- **Orchestrator:** 7 API calls per fault, against a tenant budget of 100 per minute. The pipeline never uses `jobs logs --export`, which has a quota of 100 per day.
- **Dedupe:** identical faults (same process and normalized error) dispatch at most once per `DEDUPE_TTL_SECONDS`, which defaults to 1h. After that, a new occurrence that already has an open PR or issue only adds a comment to it, with Jev's routing line and no new Claude run. To get a fresh diagnosis, close the thread first, or run the workflow by hand with `force_action` set.
