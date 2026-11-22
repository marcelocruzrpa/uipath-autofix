#!/usr/bin/env bash
# Run one headless Claude Code phase inside the project checkout (cwd).
#   usage: run-claude.sh diagnose|fix
#   env:   TOOLKIT_DIR, MODEL, MAX_TURNS, BUDGET_USD, JOB_KEY, PROCESS_KEY, MODE,
#          ROUTING_REASON, ANTHROPIC_API_KEY
# Writes .autofix/<phase>-run.json (full CLI result) and .autofix/<phase>.json (structured
# output), and sets GITHUB_OUTPUT fix_ready=true|false after diagnose.
set -uo pipefail

PHASE="${1:?usage: run-claude.sh diagnose|fix}"
: "${TOOLKIT_DIR:?}" "${MODEL:?}" "${MAX_TURNS:?}" "${BUDGET_USD:?}" "${JOB_KEY:?}" "${PROCESS_KEY:?}"
export DISABLE_AUTOUPDATER=1
# Keep credentials (ANTHROPIC_API_KEY and the like) out of the environment of the Bash
# commands the model runs; Claude Code keeps its own key for API calls. Setting the
# variable to 0 hands the key to every one of those commands: see docs/SETUP.md first.
export CLAUDE_CODE_SUBPROCESS_ENV_SCRUB="${CLAUDE_CODE_SUBPROCESS_ENV_SCRUB:-1}"
mkdir -p .autofix

# No phase reads the saved uip login or another process's environment. These rules stop the
# built-in file tools; they are not an OS sandbox. What bounds the uip token is its
# read-only scopes (and the workflow deletes it before the fix phase), the env scrub above
# keeps the API key out of Bash, and everything published is redacted on the way out.
DENIED=("Read(~/.uipath/.auth)" "Read(~/.uipath/profiles/**)" "Read(//proc/**)")
# Edit(...) rules cover every file-editing tool; Write(...) is listed too so the intent
# survives a change in how Claude Code groups them.
deny_writes() { local p; for p in "$@"; do DENIED+=("Edit($p)" "Write($p)"); done; }
# What scripts/check-staged.mjs refuses to publish, so the model hears "no" at the edit
# instead of producing a patch that is rejected later. That check stays the authority.
PROTECTED=("./.git/**" "./.github/**" "./.autofix/**" "./.claude/**" "./.cursor/**" "./.vscode/**" "./.devcontainer/**")
for name in .mcp.json CLAUDE.md AGENTS.md NuGet.Config; do PROTECTED+=("./$name" "./**/$name"); done

case "$PHASE" in
  diagnose)
    # Investigation: read anything, write only under .local/, and run only the uip command
    # families the uipath-troubleshoot skill documents for job faults. uip as a whole also
    # installs packages and runs local code, and a wildcard on find, grep or jq reaches
    # past reading (`find -exec`), so the built-in Grep, Glob and Read tools stand in for
    # them. tee and mkdir are what the skill uses to save raw captures.
    ALLOWED=(Skill Read Glob Grep TaskCreate TaskUpdate TaskList Agent
      "Edit(./.local/**)" "Write(./.local/**)"
      "Bash(uip or *)" "Bash(uip traces spans get *)" "Bash(uip docsai ask *)"
      "Bash(tee .local/investigations/*)" "Bash(tee -a .local/investigations/*)"
      "Bash(mkdir -p .local/investigations*)")
    # --export has a quota of 100 a day and writes a file wherever --destination points.
    DENIED+=("Bash(uip login *)" "Bash(uip logout *)" "Bash(uip or * --export*)" "Bash(git *)")
    deny_writes "${PROTECTED[@]}"
    SCHEMA="$TOOLKIT_DIR/schemas/diagnosis.schema.json"
    ;;
  fix)
    # Apply the approved diagnosis: edit project source only. The rules are scoped to the
    # checkout because a bare Edit would also reach the toolkit scripts that run next.
    ALLOWED=(Skill Read Glob Grep "Edit(./**)" "Write(./**)" TaskCreate TaskUpdate TaskList)
    DENIED+=("Bash")
    deny_writes "${PROTECTED[@]}" "./.local/**"
    SCHEMA="$TOOLKIT_DIR/schemas/fix.schema.json"
    ;;
  *) echo "unknown phase: $PHASE"; exit 2 ;;
esac

PROMPT="$(node "$TOOLKIT_DIR/scripts/render-prompt.mjs" "$TOOLKIT_DIR/prompts/$PHASE.md")"

# --setting-sources user: the skills plugin is enabled in the runner's user settings. The
# project repository's own .claude/settings files are left out, so nothing committed there
# can add to the allowlist above.
echo "::group::claude $PHASE (model=$MODEL, max_turns=$MAX_TURNS, budget=\$$BUDGET_USD)"
claude -p "$PROMPT" \
  --model "$MODEL" \
  --max-turns "$MAX_TURNS" \
  --max-budget-usd "$BUDGET_USD" \
  --permission-mode dontAsk \
  --setting-sources user \
  --append-system-prompt-file "$TOOLKIT_DIR/prompts/ci-context.md" \
  --json-schema "$(cat "$SCHEMA")" \
  --output-format json \
  --allowedTools "${ALLOWED[@]}" \
  --disallowedTools "${DENIED[@]}" \
  > ".autofix/$PHASE-run.json"
rc=$?
echo "::endgroup::"

# Extract structured output + bookkeeping; tolerate a failed/partial run.
node -e '
  const fs = require("fs");
  const [phase, rc, mode] = process.argv.slice(1);
  let run = {};
  try { run = JSON.parse(fs.readFileSync(`.autofix/${phase}-run.json`, "utf8")); } catch {}
  const out = run.structured_output ?? null;
  if (out) fs.writeFileSync(`.autofix/${phase}.json`, JSON.stringify(out, null, 2) + "\n");
  const denials = run.permission_denials ?? [];
  console.log(`claude ${phase}: exit=${rc} subtype=${run.subtype ?? "?"} turns=${run.num_turns ?? "?"} cost=$${(run.total_cost_usd ?? 0).toFixed(3)} structured=${!!out} denials=${denials.length}`);
  for (const d of denials.slice(0, 20)) console.log(`::notice::permission denied: ${d.tool_name} ${JSON.stringify(d.tool_input ?? {}).slice(0, 200)}`);
  if (phase === "diagnose" && process.env.GITHUB_OUTPUT) {
    const ready = mode === "fix" && !!out && out.is_code_fix === true && out.confidence !== "low" && (out.proposed_changes ?? []).length > 0;
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `fix_ready=${ready}\ndiagnosed=${!!out}\n`);
  }
' "$PHASE" "$rc" "${MODE:-investigate}"

# A failed run is reported (publish opens an issue), not fatal to the job.
exit 0
