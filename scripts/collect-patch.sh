#!/usr/bin/env bash
# Capture Claude's edits as a patch and judge the staged change.
# cwd = project checkout. Sets GITHUB_OUTPUT has_patch=true|false, validation=ok|failed|none.
#
# The verdict here is early feedback only: this job hosts the model, so `publish` stages
# the patch and runs the same check itself before it writes anything.
set -uo pipefail
TOOLKIT_DIR="${TOOLKIT_DIR:?}"
MAX_BYTES="${PATCH_MAX_BYTES:-1000000}"
mkdir -p .autofix

emit() { [[ -n "${GITHUB_OUTPUT:-}" ]] && echo "$1" >> "$GITHUB_OUTPUT"; echo "$1"; }

git add -A                      # .local/ and .autofix/ are in .git/info/exclude
# quotePath=false keeps non-ASCII file names literal instead of octal-escaped, and
# --no-renames turns a rename into a delete plus an add so both paths are judged.
git -c core.quotePath=false diff --cached --binary --no-renames > .autofix/fix.patch
git -c core.quotePath=false diff --cached --no-renames --name-only > .autofix/changed-files.txt

if [[ ! -s .autofix/fix.patch ]]; then
  git reset -q
  emit "has_patch=false"; emit "validation=none"; exit 0
fi

status=ok
: > .autofix/validation.txt
size=$(wc -c < .autofix/fix.patch)
if (( size > MAX_BYTES )); then
  echo "rejected: patch is $size bytes (limit $MAX_BYTES)" >> .autofix/validation.txt
  status=failed
fi
# The index holds exactly what the patch carries, so the check reads it before the reset.
node "$TOOLKIT_DIR/scripts/check-staged.mjs" >> .autofix/validation.txt 2>&1 || status=failed
git reset -q
cat .autofix/validation.txt
emit "has_patch=true"; emit "validation=$status"
