#!/usr/bin/env bash
# Guard the patch before it is pushed: Claude's input came partly from untrusted robot
# logs, so reject anything outside the blast radius of an automation fix.
#   usage: check-patch.sh <patch>    exit 0 = acceptable, 1 = rejected (reasons on stdout)
#
# Expects the patch collect-patch.sh writes: `git diff --no-renames` with
# core.quotePath=false, so every header reads `diff --git a/<path> b/<path>` with the same
# literal path on both sides. Anything else is rejected rather than parsed.
set -uo pipefail
PATCH="${1:?usage: check-patch.sh <patch>}"
MAX_FILES="${PATCH_MAX_FILES:-20}"
MAX_BYTES="${PATCH_MAX_BYTES:-1000000}"

[[ -s "$PATCH" ]] || { echo "patch is empty"; exit 1; }

fail=0
reject() { echo "rejected: $*"; fail=1; }

size=$(wc -c < "$PATCH")
(( size > MAX_BYTES )) && reject "patch is $size bytes (limit $MAX_BYTES)"
grep -q '^GIT binary patch' "$PATCH" && reject "binary changes are not allowed"
grep -qE '^new file mode 120000' "$PATCH" && reject "symlinks are not allowed"
grep -qE '^(old|new) mode ' "$PATCH" && reject "file mode changes are not allowed"
grep -qE '^(rename|copy) (from|to) ' "$PATCH" && reject "renames and copies are not allowed"

files=()
while IFS= read -r header; do
  rest="${header#diff --git }"
  if [[ "$rest" == \"* ]]; then
    reject "quoted path is not supported: $rest"; continue
  fi
  # "a/<path> b/<path>": the two halves must be the same path, which also settles where
  # the split is when the path itself contains " b/".
  rest="${rest#a/}"
  n=$(( (${#rest} - 3) / 2 ))
  f=""
  (( n > 0 )) && f="${rest:0:n}"
  if [[ -z "$f" || "$rest" != "$f b/$f" ]]; then
    reject "old and new paths differ: $header"; continue
  fi
  files+=("$f")
done < <(grep -E '^diff --git ' "$PATCH")

(( ${#files[@]} == 0 )) && reject "no file headers found"
(( ${#files[@]} > MAX_FILES )) && reject "${#files[@]} files changed (limit $MAX_FILES)"

for f in "${files[@]}"; do
  case "$f" in
    .github/*|.git/*|.local/*|.autofix/*|*/.git/*) reject "$f: protected path" ;;
    *..*) reject "$f: path traversal" ;;
  esac
  case "${f,,}" in
    *.xaml|*.cs|*.vb|*.json|*.md|*.txt|*.config|*.xml|*.csv) ;;
    *) reject "$f: file type not allowed" ;;
  esac
done

(( fail == 0 )) && echo "patch ok: ${#files[@]} file(s), $size bytes"
exit $fail
