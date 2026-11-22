#!/usr/bin/env bash
# Stage a patch in the index and judge what was actually staged.
#   usage: stage-patch.sh <patch>      cwd = the repository, with a clean index
#   env:   PATCH_MAX_BYTES (default 1000000), PATCH_MAX_FILES, PYTHON (see check-staged.mjs)
#   exit 0 = the patch is staged and acceptable
#   exit 1 = rejected (reasons on stdout), and the index is back to HEAD
#
# `--cached` applies to the index only, so nothing from the patch is written into the
# worktree of the job that can push. The verdict comes from check-staged.mjs, which reads
# the index: the patch text itself is never parsed here, because git decides what a patch
# touches and a second parser can be made to disagree with it.
set -uo pipefail
PATCH="${1:?usage: stage-patch.sh <patch>}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MAX_BYTES="${PATCH_MAX_BYTES:-1000000}"

[[ -s "$PATCH" ]] || { echo "rejected: patch is empty"; exit 1; }
size=$(wc -c < "$PATCH")
if (( size > MAX_BYTES )); then
  echo "rejected: patch is $size bytes (limit $MAX_BYTES)"; exit 1
fi

if ! git apply --cached -- "$PATCH" 2>&1; then
  echo "rejected: the patch does not apply to the checked-out commit"
  git reset -q
  exit 1
fi

if ! node "$HERE/check-staged.mjs"; then
  git reset -q
  exit 1
fi
