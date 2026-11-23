#!/usr/bin/env bash
# Open a PR (validated patch in fix mode) or an issue (everything else), or comment on the
# thread that already tracks this fault signature. cwd = project checkout.
#   env: GH_TOKEN, TOOLKIT_DIR, SIGNATURE, JOB_KEY, PROCESS_KEY, ACTION, TIER,
#        HAS_PATCH, VALIDATION, RUN_URL, BASE_BRANCH, ORCHESTRATOR_URL
set -euo pipefail
: "${GH_TOKEN:?}" "${TOOLKIT_DIR:?}" "${JOB_KEY:?}" "${PROCESS_KEY:?}"
SIG="${SIGNATURE:-${JOB_KEY:0:12}}"
export SIGNATURE="$SIG"
AF=.autofix
mkdir -p "$AF"
FIX_ATTEMPTED_LABEL="uipath-autofix:fix-attempted"

summary() { [[ -n "${GITHUB_STEP_SUMMARY:-}" ]] && echo "$1" >> "$GITHUB_STEP_SUMMARY"; echo "$1"; }
render() { node "$TOOLKIT_DIR/scripts/render-body.mjs" "$@"; }

gh label create uipath-autofix --color 5319e7 --description "Opened by UiPath Autofix" --force >/dev/null
gh label create uipath-autofix:investigate --color fbca04 --description "Diagnosis only, no PR" --force >/dev/null
gh label create "$FIX_ATTEMPTED_LABEL" --color d4c5f9 --description "A fix was already attempted for this issue" --force >/dev/null
labels=(--label uipath-autofix)
if [[ -n "${TIER:-}" ]]; then
  gh label create "model:${TIER}" --color 0e8a16 --description "Claude model chosen by Jev" --force >/dev/null
  labels+=(--label "model:${TIER}")
fi

threads="$(bash "$TOOLKIT_DIR/scripts/find-thread.sh")"
existing_pr="$(sed -n 's/^pr=//p' <<<"$threads")"
existing_issue="$(sed -n 's/^issue=//p' <<<"$threads")"
merged_pr="$(sed -n 's/^merged_pr=//p' <<<"$threads")"

# The claude job is skipped for a fault that is already tracked; its result file tells.
claude_ran=false
if [[ -f "$AF/diagnose-run.json" ]]; then claude_ran=true; fi
# Appended to the issue or comment when a validated fix could not become a pull request.
extra_note=""

# comment_on <pr|issue> <number> [render kind] [summary line]
comment_on() {
  local kind="$1" num="$2" as="${3:-comment}"
  render "$as" "$AF" > "$AF/comment.md"
  if [[ -n "$extra_note" ]]; then printf '\n%s\n' "$extra_note" >> "$AF/comment.md"; fi
  gh "$kind" comment "$num" --body-file "$AF/comment.md" >/dev/null
  summary "${4:-↪️ Same fault is already tracked in $kind #$num, so I added a comment.}"
}

# One fix attempt per issue: triage reads this label and does not start another.
mark_fix_attempted() {
  local issue="$1"
  if [[ -n "$issue" && "${ACTION:-}" == "fix" && "$claude_ran" == true ]]; then
    gh issue edit "$issue" --add-label "$FIX_ATTEMPTED_LABEL" >/dev/null || true
  fi
}

# The claude job hosts the model, so its verdict (VALIDATION) is not what decides here.
# This is the only job that can write: it stages the patch it downloaded and judges what
# git actually staged (stage-patch.sh), and leaves it in the index when that passes.
revalidate() {
  bash "$TOOLKIT_DIR/scripts/stage-patch.sh" "$AF/fix.patch" > "$AF/validation.txt" 2>&1
}

# One scrubbed, redacted line for titles and the commit subject; empty without a diagnosis.
title_cause() { render title "$AF"; }

# An open PR already carries a fix for this fault: add to it, whatever this run produced.
if [[ -n "$existing_pr" ]]; then comment_on pr "$existing_pr"; exit 0; fi

if [[ "${ACTION:-}" == "fix" && "${HAS_PATCH:-false}" == "true" && -s "$AF/fix.patch" ]]; then
  if revalidate; then
    [[ "${VALIDATION:-}" == "ok" ]] || echo "note: the claude job reported validation=${VALIDATION:-}, but the patch passed here"
    render pr "$AF" > "$AF/body.md"
    if [[ -n "$existing_issue" ]]; then printf '\nRelated: #%s\n' "$existing_issue" >> "$AF/body.md"; fi

    slug="$(printf '%s' "$PROCESS_KEY" | tr '[:upper:]' '[:lower:]' | tr -cs 'a-z0-9' '-' | sed 's/^-//;s/-$//' | cut -c1-40)"
    # The run attempt keeps a re-run of this job from colliding with the branch it pushed.
    branch="autofix/${slug}/${SIG}-${GITHUB_RUN_ID:-local}-${GITHUB_RUN_ATTEMPT:-1}"
    cause="$(title_cause)"

    git config user.name "github-actions[bot]"
    git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
    git checkout -q -b "$branch"   # carries the staged patch onto the new branch
    # The patch lives in the index only (the worktree still holds the base files), and a
    # plain commit records exactly the index.
    git commit -q -m "fix(${PROCESS_KEY}): ${cause:-autofix for faulted job ${JOB_KEY}}" \
      -m "Faulted job: ${JOB_KEY}" -m "Fault signature: ${SIG}" -m "Routed by TypeSafe Jev → ${TIER:-?}; run ${RUN_URL:-}"
    git push -q origin "$branch"

    if url="$(gh pr create --base "${BASE_BRANCH:-main}" --head "$branch" \
      --title "fix(${PROCESS_KEY}): ${cause:-autofix for faulted job}" \
      --body-file "$AF/body.md" "${labels[@]}")"; then
      summary "🛠️ Opened PR: $url"
      mark_fix_attempted "$existing_issue"
      exit 0
    fi
    # The branch is pushed but the pull request was refused. The usual cause is a
    # repository setting, so the fix is handed over in an issue instead of being lost.
    compare="${GITHUB_SERVER_URL:-https://github.com}/${GITHUB_REPOSITORY:-}/compare/${BASE_BRANCH:-main}...${branch}?expand=1"
    extra_note="$(printf '### A fix is ready, but the pull request could not be opened\nThe patch passed validation and is on branch `%s`: %s\n\nThe usual cause is that *Settings → Actions → General → Allow GitHub Actions to create and approve pull requests* is off. Enable it, then open the pull request from that link.' "$branch" "$compare")"
    echo "::warning::gh pr create failed; the fix is on branch $branch and is reported in an issue"
  else
    echo "patch rejected by the publish job:"
    cat "$AF/validation.txt"
  fi
fi

# A fix for this fault was merged recently and nothing is open: the fault recurs until the
# fixed package is deployed. Triage skipped Claude for that reason, so only say so.
if [[ -z "$existing_issue" && -n "$merged_pr" && "$claude_ran" != true ]]; then
  comment_on pr "$merged_pr" comment-merged "↪️ A fix for this fault was merged in pr #$merged_pr, so I added a comment there instead of starting a new diagnosis."
  exit 0
fi

# No pull request: comment on the issue that already tracks the fault, or open one.
if [[ -n "$existing_issue" ]]; then
  comment_on issue "$existing_issue"
  mark_fix_attempted "$existing_issue"
  exit 0
fi

render issue "$AF" > "$AF/body.md"
if [[ -n "$extra_note" ]]; then printf '\n%s\n' "$extra_note" >> "$AF/body.md"; fi
cause="$(title_cause)"
issue_labels=("${labels[@]}" --label uipath-autofix:investigate)
if [[ "${ACTION:-}" == "fix" && "$claude_ran" == true ]]; then issue_labels+=(--label "$FIX_ATTEMPTED_LABEL"); fi
url="$(gh issue create --title "[autofix] ${PROCESS_KEY}: ${cause:-faulted job ${JOB_KEY}}" \
  --body-file "$AF/body.md" "${issue_labels[@]}")"
summary "🔎 Opened issue: $url"
