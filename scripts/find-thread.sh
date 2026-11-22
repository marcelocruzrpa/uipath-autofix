#!/usr/bin/env bash
# Find the thread that already tracks a fault signature.
#   env:    GH_TOKEN, SIGNATURE, and GH_REPO or a git remote in cwd
#           MERGED_WITHIN_DAYS (default 7): how long a merged fix PR still counts
#   stdout: "pr=<n>", "issue=<n>", "merged_pr=<n>" (each empty when there is none) and
#           "fix_attempted=true|false" for the issue
#   GITHUB_OUTPUT: existing=pr:<n> | issue:<n> | merged:<n> | (empty), and fix_attempted
#
# Used twice: by triage, to skip Claude when the fault is already tracked, and by publish,
# to decide between a new thread and a comment.
#
# Every body starts with a marker line that holds the signature. The threads are listed by
# label through the issues API and matched on that exact line, so the result does not
# depend on the search index (which lags behind new threads and tokenises the text).
set -euo pipefail
: "${SIGNATURE:?SIGNATURE is required}"
if [[ ! "$SIGNATURE" =~ ^[0-9a-f-]{12}$ ]]; then
  echo "::error::SIGNATURE has an unexpected shape"; exit 1
fi
MARKER="<!-- autofix-signature: ${SIGNATURE} -->"
FIX_ATTEMPTED_LABEL="uipath-autofix:fix-attempted"
DAYS="${MERGED_WITHIN_DAYS:-7}"
[[ "$DAYS" =~ ^[0-9]+$ ]] || DAYS=7

# One line per open thread with this signature, newest first: number, pr|issue, true|false.
open="$(gh api --paginate "repos/{owner}/{repo}/issues?state=open&labels=uipath-autofix&per_page=100" \
  --jq ".[] | select((.body // \"\") | startswith(\"${MARKER}\")) | [.number, (if .pull_request then \"pr\" else \"issue\" end), ([.labels[].name] | index(\"${FIX_ATTEMPTED_LABEL}\") != null)] | @tsv")"

pr=""; issue=""; fix_attempted=false
while IFS=$'\t' read -r number kind attempted; do
  [[ "$number" =~ ^[0-9]+$ ]] || continue
  if [[ "$kind" == "pr" && -z "$pr" ]]; then pr="$number"; fi
  if [[ "$kind" == "issue" && -z "$issue" ]]; then issue="$number"; fix_attempted="$attempted"; fi
done <<< "$open"
[[ "$fix_attempted" == "true" ]] || fix_attempted=false

# A fix PR that was merged recently. The fault keeps recurring until the fixed package is
# deployed, and a new diagnosis of already-fixed source would be paid for nothing.
merged_pr=""
if [[ -z "$pr" ]]; then
  since="$(node -e 'console.log(new Date(Date.now() - Number(process.argv[1]) * 864e5).toISOString())' "$DAYS")"
  merged="$(gh api --paginate "repos/{owner}/{repo}/issues?state=closed&labels=uipath-autofix&since=${since}&per_page=100" \
    --jq ".[] | select(.pull_request.merged_at != null and .pull_request.merged_at >= \"${since}\") | select((.body // \"\") | startswith(\"${MARKER}\")) | .number")"
  merged_pr="$(head -n 1 <<< "$merged")"
  [[ "$merged_pr" =~ ^[0-9]+$ ]] || merged_pr=""
fi

echo "pr=$pr"
echo "issue=$issue"
echo "merged_pr=$merged_pr"
echo "fix_attempted=$fix_attempted"

existing=""
if [[ -n "$pr" ]]; then existing="pr:$pr"
elif [[ -n "$issue" ]]; then existing="issue:$issue"
elif [[ -n "$merged_pr" ]]; then existing="merged:$merged_pr"
fi
if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  { echo "existing=$existing"; echo "fix_attempted=$fix_attempted"; } >> "$GITHUB_OUTPUT"
fi
