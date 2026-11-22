#!/usr/bin/env bash
# Find the open PR and/or issue that already tracks a fault signature.
#   env:    GH_TOKEN, SIGNATURE, and GH_REPO or a git remote in cwd
#   stdout: "pr=<number or empty>" and "issue=<number or empty>"
#   GITHUB_OUTPUT: existing=pr:<n> | issue:<n> | (empty)
#
# Used twice: by triage, to skip Claude when the fault is already tracked, and by publish,
# to decide between a new thread and a comment.
set -euo pipefail
: "${SIGNATURE:?SIGNATURE is required}"

# The signature is printed in every body, so a plain body search finds the tracking thread.
pr="$(gh pr list --state open --label uipath-autofix --search "$SIGNATURE in:body" --json number --jq '.[0].number // empty')"
issue="$(gh issue list --state open --label uipath-autofix --search "$SIGNATURE in:body" --json number --jq '.[0].number // empty')"

echo "pr=$pr"
echo "issue=$issue"

existing=""
if [[ -n "$pr" ]]; then existing="pr:$pr"; elif [[ -n "$issue" ]]; then existing="issue:$issue"; fi
if [[ -n "${GITHUB_OUTPUT:-}" ]]; then echo "existing=$existing" >> "$GITHUB_OUTPUT"; fi
