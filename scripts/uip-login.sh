#!/usr/bin/env bash
# Non-interactive UiPath login with an External Application (client credentials).
# Secrets are read by the CLI itself via env.<NAME>, so they never appear on a command line.
#   required: UIPATH_CLIENT_ID, UIPATH_CLIENT_SECRET, UIPATH_TENANT
#   optional: UIPATH_AUTHORITY (e.g. https://cloud.uipath.com, or staging/Automation Suite host)
#             UIPATH_ORG       (organization logical name)
#             UIPATH_SCOPES    (application scopes; default is the read-only set below)
set -euo pipefail

: "${UIPATH_CLIENT_ID:?UIPATH_CLIENT_ID secret is not set}"
: "${UIPATH_CLIENT_SECRET:?UIPATH_CLIENT_SECRET secret is not set}"
: "${UIPATH_TENANT:?UIPATH_TENANT variable is not set}"

# Read-only on purpose: Claude runs `uip` during diagnosis, and these scopes make any
# mutating command fail server-side regardless of what the prompt or logs say.
SCOPES="${UIPATH_SCOPES:-OR.Jobs.Read OR.Folders.Read OR.Execution.Read OR.Monitoring.Read OR.Robots.Read OR.Machines.Read}"

args=(login --client-id env.UIPATH_CLIENT_ID --client-secret env.UIPATH_CLIENT_SECRET --tenant "$UIPATH_TENANT" --scope "$SCOPES" --output json)
[[ -n "${UIPATH_AUTHORITY:-}" ]] && args+=(--authority "$UIPATH_AUTHORITY")
[[ -n "${UIPATH_ORG:-}" ]] && args+=(--organization "$UIPATH_ORG")

if ! out="$(uip "${args[@]}" 2>&1)"; then
  echo "::error::uip login failed. Check the External Application id/secret, its application scopes ($SCOPES), the tenant name and UIPATH_AUTHORITY."
  echo "$out" | sed -E 's/(eyJ[A-Za-z0-9_-]{10})[A-Za-z0-9._-]+/\1…/g'
  exit 1
fi

status="$(uip login status --output json)"
node -e '
  const s = JSON.parse(process.argv[1]).Data ?? {};
  if (s.Status !== "Logged in") { console.error("::error::uip login status: " + s.Status); process.exit(1); }
  console.log(`uip logged in: org=${s.Organization} tenant=${s.Tenant} via ${s.AuthFlow}`);
' "$status"
