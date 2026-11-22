#!/usr/bin/env bash
# Install the pinned UiPath CLI and (optionally) Claude Code + the UiPath skills plugin.
#   WITH_CLAUDE=true|false   (default true)
#   UIPATH_CLI_VERSION, UIPATH_TOOLS_VERSION, CLAUDE_CODE_VERSION  (pins; bump deliberately)
#
# An npm version pin alone does not hold for uip: the CLI updates itself and its tools on
# the first ordinary command of the day, installs a missing tool on first use, and loads
# tool packages from the nearest node_modules/@uipath above the current directory. So this
# script freezes the version, installs the tools up front, and tells the rest of the job
# (through $GITHUB_ENV) to load tools from the global install only and install nothing.
set -euo pipefail

UIPATH_CLI_VERSION="${UIPATH_CLI_VERSION:-1.206.0}"
UIPATH_TOOLS_VERSION="${UIPATH_TOOLS_VERSION:-$UIPATH_CLI_VERSION}"
CLAUDE_CODE_VERSION="${CLAUDE_CODE_VERSION:-2.1.330}"
WITH_CLAUDE="${WITH_CLAUDE:-true}"

# The Orchestrator tool is what gather-evidence.sh and the diagnosis use. The traces tool
# backs the one other command family the diagnose phase may run.
TOOLS=(orchestrator-tool)
[[ "$WITH_CLAUDE" == "true" ]] && TOOLS+=(traces-tool)

export UIPATH_CLI_DISABLE_VERSION_SYNC=1

echo "::group::Install @uipath/cli@${UIPATH_CLI_VERSION}"
npm install -g --no-fund --no-audit "@uipath/cli@${UIPATH_CLI_VERSION}"
# An exact version freezes the CLI and its tools ("uip config set version" help).
uip config set version "$UIPATH_CLI_VERSION" --output json > /dev/null
for tool in "${TOOLS[@]}"; do
  uip tools install "@uipath/${tool}@${UIPATH_TOOLS_VERSION}" --output json > /dev/null
done
uip tools list --output json --output-filter "[].{Name: Name, Version: Version}"

installed="$(uip --version)"
if [[ "$installed" != "$UIPATH_CLI_VERSION" ]]; then
  echo "::error::uip is ${installed}, expected the pinned ${UIPATH_CLI_VERSION}"
  exit 1
fi
echo "::endgroup::"

# For every later step in this job, including the commands the model runs.
tools_dir="$(npm root -g)/@uipath"
if [[ -n "${GITHUB_ENV:-}" ]]; then
  {
    echo "UIPATH_CLI_DISABLE_VERSION_SYNC=1"
    echo "UIPATH_CLI_DISABLE_AUTOINSTALL=1"
    echo "UIPATH_CLI_TOOLS_DIRS=${tools_dir}"
  } >> "$GITHUB_ENV"
fi

if [[ "$WITH_CLAUDE" != "true" ]]; then exit 0; fi

echo "::group::Install Claude Code ${CLAUDE_CODE_VERSION}"
export DISABLE_AUTOUPDATER=1
npm install -g --no-fund --no-audit "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}"
claude --version
echo "::endgroup::"

# The UiPath skills ship as a Claude Code plugin (uipath@uipath-marketplace); `uip skills
# install --agent claude` registers the marketplace and runs `claude plugin install` at
# user scope, so nothing is written into the project checkout. The skills are versioned
# on their own line and the CLI offers no way to pin them.
echo "::group::Install UiPath skills for Claude Code"
uip skills install --agent claude --output json
# Captured first: with pipefail, `grep -q` closing the pipe early can fail the listing.
plugins="$(claude plugin list 2>&1 || true)"
if ! grep -q "uipath@uipath-marketplace" <<<"$plugins"; then
  echo "::error::UiPath skills plugin (uipath@uipath-marketplace) is not installed"
  echo "$plugins"
  exit 1
fi
echo "::endgroup::"
