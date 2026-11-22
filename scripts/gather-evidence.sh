#!/usr/bin/env bash
# Pre-fetch the faulted job's evidence with read-only uip calls.
#   usage: gather-evidence.sh <out_dir>        (normally <project>/.local/investigations/raw)
#   env:   JOB_KEY, PROCESS_KEY (required); FAULT_INFO, FAULT_SIGNATURE, FAULT_ROBOT,
#          FOLDER_ID, ORCHESTRATOR_URL (optional, from the webhook payload)
#
# Files are verbatim `--output json` captures named after the command, which is the
# layout the uipath-troubleshoot skill reuses instead of re-fetching. 7 API calls per
# fault, well inside the 100 req/min tenant budget; never uses `logs --export` (100/day).
set -uo pipefail

OUT="${1:?usage: gather-evidence.sh <out_dir>}"
: "${JOB_KEY:?JOB_KEY is required}"
: "${PROCESS_KEY:?PROCESS_KEY is required}"

# Values originate from the webhook: validate shape before they reach any command.
if [[ ! "$JOB_KEY" =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$ ]]; then
  echo "::error::JOB_KEY is not a GUID"; exit 1
fi
if [[ ! "$PROCESS_KEY" =~ ^[A-Za-z0-9][A-Za-z0-9\ ._-]{0,127}$ ]]; then
  echo "::error::PROCESS_KEY has unexpected characters"; exit 1
fi

mkdir -p "$OUT"

# context.json is written by node from env, so free-text fields never pass through the shell.
node -e '
  const e = process.env, out = {
    job_key: e.JOB_KEY, process_key: e.PROCESS_KEY,
    signature: e.FAULT_SIGNATURE || undefined, info: e.FAULT_INFO || undefined,
    robot: e.FAULT_ROBOT || undefined, folder_id: e.FOLDER_ID ? Number(e.FOLDER_ID) : undefined,
    orchestrator_url: e.ORCHESTRATOR_URL || undefined,
  };
  require("fs").writeFileSync(process.argv[1], JSON.stringify(out, null, 2) + "\n");
' "$OUT/context.json"

failures=0
cap() {
  local name="$1"; shift
  if uip "$@" --output json > "$OUT/$name.json" 2> "$OUT/$name.stderr"; then
    rm -f "$OUT/$name.stderr"
    echo "captured $name.json"
  else
    failures=$((failures + 1))
    echo "::warning::'uip $*' failed; see $name.stderr (treated as an evidence gap)"
    rm -f "$OUT/$name.json"
  fi
}

SINCE="$(node -e 'console.log(new Date(Date.now() - 24 * 3600e3).toISOString())')"

# --no-download: `jobs get` otherwise saves the job's OutputFile into the current directory.
cap jobs-get             or jobs get "$JOB_KEY" --no-download
# --level is an exact match, so Error does not include Fatal. Rows carry only Level,
# TimeStamp and Message: the CLI does not return the workflow file name.
cap jobs-logs-error      or jobs logs "$JOB_KEY" --level Error --limit 50
cap jobs-logs-fatal      or jobs logs "$JOB_KEY" --level Fatal --limit 20
cap jobs-logs            or jobs logs "$JOB_KEY" --limit 200
cap jobs-history         or jobs history "$JOB_KEY"

# --process-name filters on the process (release) name, which is not always the package id
# the webhook sends as PROCESS_KEY: a process can be renamed. The job record has the name.
PROCESS_NAME="$(node -e '
  try {
    const j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    const name = (j.Data ?? j).ReleaseName;
    if (typeof name === "string" && name.length <= 256 && !/[\u0000-\u001f]/.test(name)) process.stdout.write(name);
  } catch {}
' "$OUT/jobs-get.json" 2>/dev/null)"
NAME_FILTER="${PROCESS_NAME:-$PROCESS_KEY}"

# The filter is a "contains" match, so the lists can include similarly named processes.
# Each row carries its process name (ProcessName in the curated output, ReleaseName with
# --all-fields) and triage keeps only the rows of this exact process. The faulted rows
# also carry the folder name, which `jobs get` does not have.
cap jobs-list-faulted    or jobs list --all-folders --process-name "$NAME_FILTER" --state Faulted \
                            --created-after "$SINCE" --limit 50 --all-fields \
                            --output-filter "[].{Key: Key, State: State, Info: Info, ProcessName: ProcessName, ReleaseName: ReleaseName, Folder: OrganizationUnitFullyQualifiedName, CreationTime: CreationTime, EndTime: EndTime}"
cap jobs-list-successful or jobs list --all-folders --process-name "$NAME_FILTER" --state Successful \
                            --limit 10 --sort-by "EndTime desc" \
                            --output-filter "[].{Key: Key, State: State, ProcessName: ProcessName, ReleaseName: ReleaseName, CreationTime: CreationTime, EndTime: EndTime}"

if [[ ! -f "$OUT/jobs-get.json" ]]; then
  echo "::error::Could not read job $JOB_KEY. Check the External Application's folder access and scopes."
  exit 1
fi
echo "evidence: $(ls "$OUT" | tr '\n' ' ') ($failures gaps)"
