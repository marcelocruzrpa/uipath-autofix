#!/usr/bin/env bash
# Install the pinned UiPath CLI and (optionally) Claude Code + the UiPath skills plugin.
#   WITH_CLAUDE=true|false   (default true)
#   UIPATH_CLI_VERSION, CLAUDE_CODE_VERSION  (pins; bump deliberately)
set -euo pipefail

UIPATH_CLI_VERSION="${UIPATH_CLI_VERSION:-1.206.0}"
CLAUDE_CODE_VERSION="${CLAUDE_CODE_VERSION:-2.1.330}"
WITH_CLAUDE="${WITH_CLAUDE:-true}"

echo "::group::Install @uipath/cli@${UIPATH_CLI_VERSION}"
npm install -g --no-fund --no-audit "@uipath/cli@${UIPATH_CLI_VERSION}"
uip --version
echo "::endgroup::"

if [[ "$WITH_CLAUDE" != "true" ]]; then exit 0; fi

echo "::group::Install Claude Code ${CLAUDE_CODE_VERSION}"
export DISABLE_AUTOUPDATER=1
npm install -g --no-fund --no-audit "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}"
claude --version
echo "::endgroup::"

# The UiPath skills ship as a Claude Code plugin (uipath@uipath-marketplace); `uip skills
# install --agent claude` registers the marketplace and runs `claude plugin install` at
# user scope, so nothing is written into the project checkout.
echo "::group::Install UiPath skills for Claude Code"
uip skills install --agent claude --output json
if ! claude plugin list 2>&1 | grep -q "uipath@uipath-marketplace"; then
  echo "::error::UiPath skills plugin (uipath@uipath-marketplace) is not installed"
  claude plugin list || true
  exit 1
fi
echo "::endgroup::"
