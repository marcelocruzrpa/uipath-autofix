#!/usr/bin/env bash
# Take over only what `publish` knows how to judge from the artifact the claude job
# uploaded, and keep the triage decision only if it is the one the triage job wrote.
#   usage: accept-artifacts.sh <incoming dir> <autofix dir>
#   env:   DECISION_SHA256   sha256 of decision.json, as reported by the triage job's output
#
# The claude job hosts the model, so its artifact is untrusted as a whole: it also carries
# its own copy of decision.json, which render-body.mjs prints as trusted Markdown. Job
# outputs do not pass through that job, so the hash tells the two copies apart.
set -euo pipefail
IN="${1:?usage: accept-artifacts.sh <incoming dir> <autofix dir>}"
OUT="${2:?usage: accept-artifacts.sh <incoming dir> <autofix dir>}"
mkdir -p "$OUT"

for f in diagnose.json diagnose-run.json fix.json fix-run.json fix.patch; do
  src="$IN/$f"
  if [[ -f "$src" && ! -L "$src" ]]; then
    cp -- "$src" "$OUT/$f"
    echo "accepted $f"
  fi
done

decision="$OUT/decision.json"
if [[ -e "$decision" || -L "$decision" ]]; then
  actual=""
  if [[ -f "$decision" && ! -L "$decision" ]]; then
    actual="$(sha256sum "$decision" | cut -d' ' -f1)"
  fi
  if [[ -z "${DECISION_SHA256:-}" || "$actual" != "$DECISION_SHA256" ]]; then
    echo "::warning::decision.json does not match the hash reported by the triage job, so it is dropped"
    rm -f -- "$decision"
  else
    echo "decision.json verified"
  fi
fi
