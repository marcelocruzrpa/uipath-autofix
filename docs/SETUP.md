# One-time setup

The files name the toolkit `marcelocruzrpa/uipath-autofix`. In a fork, replace it in:
- `templates/project-caller.yml` (the `uses:` line and `toolkit_repository`)
- the `toolkit_repository` default in `.github/workflows/uipath-autofix.yml`
- `PROCESS_REPO_MAP` and `ORCHESTRATOR_BASE_URL` in `worker/wrangler.jsonc`

## 1. Toolkit repo

1. Push this directory to `<owner>/uipath-autofix`. Then tag a release, plus the moving `v1` tag that callers use:
   ```bash
   git tag -a v1.0.0 -m "v1.0.0" && git tag v1 && git push origin v1.0.0 v1
   ```
   For a later release, tag `v1.x.y` the same way, then move `v1` to it: `git tag -f v1 && git push -f origin v1`. Callers pick it up on their next run.
2. Project repos must be able to use its reusable workflow:
   - **Public repo:** nothing to do.
   - **Private repo:** go to Settings → Actions → General → Access, and allow repositories owned by the same user or organization. Then add a `TOOLKIT_TOKEN` secret (a fine-grained PAT with Contents: read on the toolkit repo) to each project repo, because the workflow checks the toolkit out to run its scripts.

## 2. UiPath External Application (read-only)

1. Go to Automation Cloud → Admin → External Applications → **Add** → *Confidential application*.
2. Under *Application scopes → Orchestrator API Access*, add `OR.Jobs.Read`, `OR.Folders.Read`, `OR.Execution.Read`, `OR.Monitoring.Read`, `OR.Robots.Read` and `OR.Machines.Read`.
3. Copy the **App ID** and **App Secret**.
4. In Orchestrator, give the external application access to the folders that run the monitored processes:
   - **Role:** the built-in *Automation User* role cannot view logs. Create a folder role (for example "Autofix Reader") with **View** on Jobs, Logs, Processes, Folder Packages and Monitoring.
   - **Assignment:** add the external application to each folder with that role, in the Orchestrator UI (folder → *Assign account/group*). `uip or users import --type DirectoryExternalApplication` returned HTTP 500 when this was set up.
   - An external application only sees jobs through a folder: `jobs list --all-folders` fails with "A folder is required for this action". The evidence step reads the folder from the job, so no extra setting is needed.
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
curl https://uipath-autofix.<you>.workers.dev/health   # {"ok":true}
```

- **`GITHUB_DISPATCH_TOKEN`** is a fine-grained PAT with **Repository access** limited to the UiPath project repos, and **Permissions → Contents: Read and write**, which `repository_dispatch` requires. Nothing else.
- **`PROCESS_REPO_MAP`** maps the Orchestrator process (`Release.ProcessKey`) to `owner/repo`. Faults from unmapped processes are acknowledged and ignored.
- **`ORCHESTRATOR_BASE_URL`** (optional) enables job deep links in PRs and issues, for example `https://cloud.uipath.com/<org>/<tenant>/orchestrator_`.

## 4. Orchestrator webhook

Run this yourself. It takes the secret, so don't paste the secret into chat:

```bash
uip or webhooks create "Jev Autofix" \
  --url "https://uipath-autofix.<you>.workers.dev/uipath/webhook" \
  --events "job.faulted" \
  --secret "$(cat .local/webhook-secret)" --output json
```

On Automation Cloud (verified on the staging cloud, 2026-11-23), Orchestrator signs deliveries in base64, and the Worker reads `Job.Key`, `Job.Info` and `Job.Release.ProcessKey`. `Job.Info` arrives as one line whose head and tail differ from what `uip or jobs get` returns, so the fault signature hashes only the exception line and the workflow frames.

**Optional: confirm the payload shape** on another Orchestrator version or an Automation Suite install:
1. Set `"LOG_PAYLOAD_SHAPE": "true"` in `wrangler.jsonc`, redeploy, and run `npx wrangler tail`.
2. Send a test delivery with `uip or webhooks ping <webhook-key>`, then make a test job fault.
3. Read the logged shape. It lists the payload's keys with value types and no values, and it should include `Job.Key`, `Job.Info` and `Job.Release.ProcessKey`. It also says how the `x-uipath-signature` header is encoded. The Worker accepts hex or base64, with or without `sha256=`, and a rejected delivery logs the encoding it saw.
4. Set `LOG_PAYLOAD_SHAPE` back to `"false"`.

## 5. Each UiPath project repo

1. Copy `templates/project-caller.yml` to `.github/workflows/uipath-autofix.yml`.
2. **Secrets:** `ANTHROPIC_API_KEY`, `TYPESAFE_API_KEY`, `UIPATH_CLIENT_ID`, `UIPATH_CLIENT_SECRET`, plus `TOOLKIT_TOKEN` if the toolkit is private. Organization-level secrets work too.
3. **Variables:** `UIPATH_TENANT`, plus `UIPATH_AUTHORITY` if you are not on `cloud.uipath.com`. There is no organization variable: for an external application the organization is fixed by its App ID.
4. **Settings → Actions → General:** enable *Allow GitHub Actions to create and approve pull requests*. If it is off, a validated fix is still pushed to its branch and reported in an issue that links to it, so you can open the pull request by hand.

## 6. Tune and test

1. **Jev thresholds:** run `TYPESAFE_API_KEY=... npm run eval -w triage -- --save eval/answers.json`.
   - Every labeled fixture in `triage/fixtures/` should route as expected. Add `--detail` to see the rule behind each decision.
   - Commit `triage/eval/answers.json`. It holds Jev's answers with a hash of the request each one answered, and `npm test` replays it: a policy change that reroutes a fixture then fails the build without any API call.
   - To re-tune `triage/policy.config.json` or the policy code, use `--replay eval/answers.json`. The recorded answers still apply, because the request did not change.
   - A change to the questions, the state or the Jev model changes the request. The replay then reports the recording as stale: measure the change with a new live run and commit the new answers.
   - **Add fixtures from your own real faults.** Take the `triage` artifact of a run, scrub its identifiers, and record only the new fixture with `--update eval/answers.json`. That mode keeps every answer whose request is unchanged and asks Jev live only for new or stale fixtures, so the other fixtures keep their recorded answers.
   - Fixture 10 is a real fault, scrubbed. Fixtures 01 to 09 are hand-written: their log rows match what `uip or jobs logs` returns, but their error text does not come from real jobs.
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
- **Dedupe:** identical faults (same process and normalized error) dispatch at most once per `DEDUPE_TTL_SECONDS`, which defaults to 1h. After that, an occurrence that is already tracked only adds a comment, with Jev's routing line and no new Claude run.
  - Tracked means an open PR, an open issue, or a fix PR merged in the last 7 days. The fault keeps recurring until the fixed package is deployed, and a new diagnosis of already-fixed source would be paid for nothing.
  - One exception: when the open thread is an issue that only holds a diagnosis and Jev now says `fix`, the fix is attempted once. The issue then gets the `uipath-autofix:fix-attempted` label and is not retried.
  - To get a fresh diagnosis, close the thread first, or run the workflow by hand with `force_action` set.
