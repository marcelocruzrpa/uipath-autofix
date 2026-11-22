import { type Evidence, type JobSummary, type LogEntry, type RepoFacts, referencedWorkflows } from "./evidence.js";
import { normalizeInfo } from "./signature.js";

/** Facts computed in code. They go into Jev's state and are also consumed by the policy. */
export interface DerivedFacts {
  faulted_runs_last_24h: number;
  same_error_runs_last_24h: number;
  last_successful_run_at: string | null;
  referenced_workflows: string[];
  referenced_workflows_found_in_repo: boolean | null;
}

export interface JevState {
  process: { name: string; folder: string | null };
  job: {
    key: string;
    state: string;
    info: string;
    source: string | null;
    runtime_type: string | null;
    started_at: string | null;
    ended_at: string | null;
    duration_seconds: number | null;
    robot: string | null;
    host_machine: string | null;
  };
  error_logs: { at: string | null; level: string; file: string | null; message: string }[];
  recent_log_tail: string[];
  history: Omit<DerivedFacts, "referenced_workflows" | "referenced_workflows_found_in_repo">;
  repository: {
    project_found: boolean;
    workflow_file_count: number;
    referenced_workflows: string[];
    referenced_workflows_found_in_repo: boolean | null;
  };
  evidence_gaps: string[];
}

export const LIMITS = {
  info: 4000,
  errorLogs: 10,
  errorMessage: 1500,
  tailLines: 40,
  tailLine: 300,
};

/** Keep head and tail of long text: exception summary is at the top, origin frame near the end. */
export function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  const head = Math.floor(max * 0.7);
  const tail = max - head - 20;
  return `${s.slice(0, head)} …[${s.length - head - tail} chars]… ${s.slice(-tail)}`;
}

function s(v: unknown): string | null {
  return typeof v === "string" && v ? v : null;
}

function durationSeconds(start: string | null, end: string | null): number | null {
  if (!start || !end) return null;
  const d = (Date.parse(end) - Date.parse(start)) / 1000;
  return Number.isFinite(d) && d >= 0 ? Math.round(d) : null;
}

function within24h(ts: string | null, now: Date): boolean {
  if (!ts) return false;
  const t = Date.parse(ts);
  return Number.isFinite(t) && now.getTime() - t <= 24 * 3600 * 1000 && t <= now.getTime() + 60_000;
}

/** The fault's error text: the webhook's `Job.Info`, or the job record's on a manual replay. */
export function faultInfo(ev: Evidence): string {
  return ev.context.info || s(ev.job?.["Info"]) || "";
}

/**
 * `uip or jobs list --process-name` is a "contains" match, so the history captures can hold
 * jobs of similarly named processes ("Invoice" also matches "InvoiceBot"). Keep only rows
 * of this job's own process. Its name comes from the job record, else from the job's own
 * row in the faulted list, else from the webhook's process key. Rows that carry no process
 * name are kept, since there is nothing to tell them apart by.
 */
function sameProcess(ev: Evidence): (j: JobSummary) => boolean {
  const own =
    s(ev.job?.["ReleaseName"]) ?? ev.recentFaults.find((j) => j.key === ev.context.job_key)?.process ?? ev.context.process_key;
  const name = own.toLowerCase();
  return (j) => j.process === null || j.process.toLowerCase() === name;
}

export function deriveFacts(ev: Evidence, repo: RepoFacts, now: Date): DerivedFacts {
  const info = faultInfo(ev);
  const sig = normalizeInfo(info);
  const ours = sameProcess(ev);
  // Exclude the current job so counts mean "previous occurrences".
  const others = ev.recentFaults.filter((j) => j.key !== ev.context.job_key && ours(j) && within24h(j.created_at, now));
  const sameError = info ? others.filter((j) => j.info && normalizeInfo(j.info) === sig).length : 0;
  const lastSuccess = ev.recentSuccess
    .filter(ours)
    .map((j) => j.ended_at ?? j.created_at)
    .filter((t): t is string => !!t)
    .sort()
    .at(-1);
  const refs = referencedWorkflows(ev);
  const repoBasenames = new Set(repo.workflow_files.map((f) => f.split("/").at(-1)!.toLowerCase()));
  const found = refs.length === 0 || !repo.project_found ? null : refs.some((r) => repoBasenames.has(r.toLowerCase()));
  return {
    faulted_runs_last_24h: others.length,
    same_error_runs_last_24h: sameError,
    last_successful_run_at: lastSuccess ?? null,
    referenced_workflows: refs,
    referenced_workflows_found_in_repo: found,
  };
}

function tailLine(l: LogEntry): string {
  return clip(`${l.at ?? ""} ${l.level}${l.file ? ` [${l.file}]` : ""} ${l.message}`.trim(), LIMITS.tailLine);
}

/** Evidence → the JSON state Jev evaluates. Bounded so state + one question stays far below 32k tokens. */
export function buildState(ev: Evidence, repo: RepoFacts, now: Date = new Date()): { state: JevState; facts: DerivedFacts } {
  const facts = deriveFacts(ev, repo, now);
  const job = ev.job ?? {};
  const started = s(job["StartTime"]);
  const ended = s(job["EndTime"]);
  // The CLI's log ordering is undocumented; sort ascending by ISO timestamp (lexicographic is fine).
  const byTime = (a: LogEntry, b: LogEntry) => (a.at ?? "").localeCompare(b.at ?? "");
  const logs = [...ev.logs].sort(byTime);
  const errorLogs = (ev.errorLogs.length ? [...ev.errorLogs] : logs.filter((l) => /^(error|fatal)$/i.test(l.level))).sort(byTime);
  const state: JevState = {
    process: { name: ev.context.process_key, folder: s(job["OrganizationUnitFullyQualifiedName"]) },
    job: {
      key: ev.context.job_key,
      state: s(job["State"]) ?? "Faulted",
      info: clip(faultInfo(ev), LIMITS.info),
      source: s(job["Source"]),
      runtime_type: s(job["RuntimeType"]),
      started_at: started,
      ended_at: ended,
      duration_seconds: durationSeconds(started, ended),
      robot: ev.context.robot ?? s(job["RobotName"]),
      host_machine: s(job["HostMachineName"]),
    },
    error_logs: errorLogs.slice(-LIMITS.errorLogs).map((l) => ({
      at: l.at,
      level: l.level,
      file: l.file,
      message: clip(l.message, LIMITS.errorMessage),
    })),
    recent_log_tail: logs.slice(-LIMITS.tailLines).map(tailLine),
    history: {
      faulted_runs_last_24h: facts.faulted_runs_last_24h,
      same_error_runs_last_24h: facts.same_error_runs_last_24h,
      last_successful_run_at: facts.last_successful_run_at,
    },
    repository: {
      project_found: repo.project_found,
      workflow_file_count: repo.workflow_files.length,
      referenced_workflows: facts.referenced_workflows,
      referenced_workflows_found_in_repo: facts.referenced_workflows_found_in_repo,
    },
    evidence_gaps: ev.missing.filter((m) => m !== "context.json"),
  };
  return { state, facts };
}
