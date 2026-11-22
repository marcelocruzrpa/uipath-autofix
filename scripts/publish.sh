#!/usr/bin/env bash
# Open a PR (validated patch in fix mode) or an issue (everything else), or comment on the
# open PR/issue that already tracks this fault signature. cwd = project checkout.
#   env: GH_TOKEN, TOOLKIT_DIR, SIGNATURE, JOB_KEY, PROCESS_KEY, ACTION, TIER,
#        HAS_PATCH, VALIDATION, RUN_URL, BASE_BRANCH, ORCHESTRATOR_URL
set -euo pipefail
: "${GH_TOKEN:?}" "${TOOLKIT_DIR:?}" "${JOB_KEY:?}" "${PROCESS_KEY:?}"
SIG="${SIGNATURE:-${JOB_KEY:0:12}}"
export SIGNATURE="$SIG"
AF=.autofix
mkdir -p "$AF"

summary() { [[ -n "${GITHUB_STEP_SUMMARY:-}" ]] && echo "$1" >> "$GITHUB_STEP_SUMMARY"; echo "$1"; }

gh label create uipath-autofix --color 5319e7 --description "Opened by the UiPath Jev router" --force >/dev/null
gh label create uipath-autofix:investigate --color fbca04 --description "Diagnosis only, no PR" --force >/dev/null
labels=(--label uipath-autofix)
if [[ -n "${TIER:-}" ]]; then
  gh label create "model:${TIER}" --color 0e8a16 --description "Claude model chosen by Jev" --force >/dev/null
  labels+=(--label "model:${TIER}")
fi

threads="$(bash "$TOOLKIT_DIR/scripts/find-thread.sh")"
existing_pr="$(sed -n 's/^pr=//p' <<<"$threads")"
existing_issue="$(sed -n 's/^issue=//p' <<<"$threads")"

comment_on() {
  local kind="$1" num="$2"
  node "$TOOLKIT_DIR/scripts/render-body.mjs" comment "$AF" > "$AF/comment.md"
  gh "$kind" comment "$num" --body-file "$AF/comment.md" >/dev/null
  summary "↪️ Same fault is already tracked in $kind #$num, so I added a comment."
}

# The claude job hosts the model, so its verdict (VALIDATION) is not what decides here.
# This is the only job that can write: it stages the patch it downloaded and judges what
# git actually staged (stage-patch.sh), and leaves it in the index when that passes.
revalidate() {
  bash "$TOOLKIT_DIR/scripts/stage-patch.sh" "$AF/fix.patch" > "$AF/validation.txt" 2>&1
}

# One scrubbed, redacted line for titles and the commit subject; empty without a diagnosis.
title_cause() {
  node "$TOOLKIT_DIR/scripts/render-body.mjs" title "$AF"
}

# An open PR already carries a fix for this fault: add to it, whatever this run produced.
if [[ -n "$existing_pr" ]]; then comment_on pr "$existing_pr"; exit 0; fi

if [[ "${ACTION:-}" == "fix" && "${HAS_PATCH:-false}" == "true" && -s "$AF/fix.patch" ]]; then
  if revalidate; then
    [[ "${VALIDATION:-}" == "ok" ]] || echo "note: the claude job reported validation=${VALIDATION:-}, but the patch passed here"
    node "$TOOLKIT_DIR/scripts/render-body.mjs" pr "$AF" > "$AF/body.md"
    [[ -n "$existing_issue" ]] && printf '\nRelated: #%s\n' "$existing_issue" >> "$AF/body.md"

    slug="$(printf '%s' "$PROCESS_KEY" | tr '[:upper:]' '[:lower:]' | tr -cs 'a-z0-9' '-' | sed 's/^-//;s/-$//' | cut -c1-40)"
    branch="autofix/${slug}/${SIG}-${GITHUB_RUN_ID:-local}"
    cause="$(title_cause)"

    git config user.name "github-actions[bot]"
    git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
    git checkout -q -b "$branch"   # carries the staged patch onto the new branch
    # The patch lives in the index only (the worktree still holds the base files), and a
    # plain commit records exactly the index.
    git commit -q -m "fix(${PROCESS_KEY}): ${cause:-autofix for faulted job ${JOB_KEY}}" \
      -m "Faulted job: ${JOB_KEY}" -m "Fault signature: ${SIG}" -m "Routed by TypeSafe Jev → ${TIER:-?}; run ${RUN_URL:-}"
    git push -q origin "$branch"

    url="$(gh pr create --base "${BASE_BRANCH:-main}" --head "$branch" \
      --title "fix(${PROCESS_KEY}): ${cause:-autofix for faulted job}" \
      --body-file "$AF/body.md" "${labels[@]}")"
    summary "🛠️ Opened PR: $url"
    exit 0
  fi
  echo "patch rejected by the publish job:"
  cat "$AF/validation.txt"
fi

# No acceptable patch: investigation issue (or comment on the one that already tracks it).
if [[ -n "$existing_issue" ]]; then comment_on issue "$existing_issue"; exit 0; fi

node "$TOOLKIT_DIR/scripts/render-body.mjs" issue "$AF" > "$AF/body.md"
cause="$(title_cause)"
url="$(gh issue create --title "[autofix] ${PROCESS_KEY}: ${cause:-faulted job ${JOB_KEY}}" \
  --body-file "$AF/body.md" "${labels[@]}" --label uipath-autofix:investigate)"
summary "🔎 Opened issue: $url"
