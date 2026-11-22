#!/usr/bin/env bash
# Capture Claude's edits as a patch, validate the changed files, and run the patch guard.
# cwd = project checkout. Sets GITHUB_OUTPUT has_patch=true|false, validation=ok|failed|none.
#
# The verdict here is early feedback only: this job hosts the model, so `publish` re-runs
# the guard and the file checks itself before it writes anything.
set -uo pipefail
TOOLKIT_DIR="${TOOLKIT_DIR:?}"
mkdir -p .autofix

git add -A                      # .local/ and .autofix/ are in .git/info/exclude
# quotePath=false keeps non-ASCII file names literal instead of octal-escaped, and
# --no-renames turns a rename into a delete plus an add so the guard sees both paths.
git -c core.quotePath=false diff --cached --binary --no-renames > .autofix/fix.patch
git diff --cached --no-renames --name-only -z > .autofix/changed-files.z
tr '\0' '\n' < .autofix/changed-files.z > .autofix/changed-files.txt
git reset -q

emit() { [[ -n "${GITHUB_OUTPUT:-}" ]] && echo "$1" >> "$GITHUB_OUTPUT"; echo "$1"; }

if [[ ! -s .autofix/fix.patch ]]; then
  emit "has_patch=false"; emit "validation=none"; exit 0
fi

status=ok
: > .autofix/validation.txt
bash "$TOOLKIT_DIR/scripts/validate-files.sh" .autofix/changed-files.z >> .autofix/validation.txt 2>&1 || status=failed
bash "$TOOLKIT_DIR/scripts/check-patch.sh" .autofix/fix.patch >> .autofix/validation.txt 2>&1 || status=failed
cat .autofix/validation.txt
emit "has_patch=true"; emit "validation=$status"
