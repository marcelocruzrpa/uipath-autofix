import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";

/**
 * Evidence = verbatim `uip ... --output json` captures written by scripts/gather-evidence.sh
 * into `.local/investigations/raw/`, plus `context.json` (the webhook-derived facts).
 * The uipath-troubleshoot skill reuses the same raw/ directory, so file names matter.
 */
export const EVIDENCE_FILES = {
  context: "context.json",
  job: "jobs-get.json",
  errorLogs: "jobs-logs-error.json",
  logs: "jobs-logs.json",
  history: "jobs-history.json",
  recentFaults: "jobs-list-faulted.json",
  recentSuccess: "jobs-list-successful.json",
} as const;

export interface FaultContext {
  job_key: string;
  process_key: string;
  signature?: string;
  info?: string;
  folder_id?: number | string;
  robot?: string;
  orchestrator_url?: string;
}

export type Json = Record<string, unknown>;

export interface LogEntry {
  level: string;
  at: string | null;
  message: string;
  file: string | null;
}

export interface JobSummary {
  key: string;
  state: string;
  info: string;
  /** Process (release) name of the job, or null when the capture does not carry it. */
  process: string | null;
  created_at: string | null;
  ended_at: string | null;
}

export interface Evidence {
  context: FaultContext;
  job: Json | null;
  errorLogs: LogEntry[];
  logs: LogEntry[];
  history: Json[];
  recentFaults: JobSummary[];
  recentSuccess: JobSummary[];
  missing: string[];
}

export interface RepoFacts {
  project_found: boolean;
  workflow_files: string[];
}

/** uip wraps every response as {Result, Code, Data, Pagination?}; fixtures may also be bare. */
export function unwrap(raw: unknown): unknown {
  if (raw && typeof raw === "object" && "Data" in raw && "Result" in raw) {
    return (raw as { Data: unknown }).Data;
  }
  return raw;
}

function pick(obj: Json, ...keys: string[]): unknown {
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null) return obj[k];
  }
  return undefined;
}

function str(v: unknown): string {
  if (v === undefined || v === null) return "";
  return typeof v === "string" ? v : JSON.stringify(v);
}

/** Orchestrator RobotLogs entry → LogEntry. RawMessage is a JSON string carrying fileName. */
export function toLogEntry(raw: Json): LogEntry {
  let file: string | null = null;
  let message = str(pick(raw, "Message", "message"));
  const rawMessage = pick(raw, "RawMessage", "rawMessage");
  if (typeof rawMessage === "string" && rawMessage.trim().startsWith("{")) {
    try {
      const parsed = JSON.parse(rawMessage) as Json;
      const f = pick(parsed, "fileName", "FileName");
      if (typeof f === "string" && f) file = f;
      if (!message) message = str(pick(parsed, "message"));
    } catch {
      /* keep Message as-is */
    }
  }
  const f2 = pick(raw, "FileName", "fileName");
  if (!file && typeof f2 === "string" && f2) file = f2;
  return {
    level: str(pick(raw, "Level", "level")) || "Unknown",
    at: (pick(raw, "TimeStamp", "Timestamp", "timeStamp") as string | undefined) ?? null,
    message,
    file,
  };
}

function toJobSummary(raw: Json): JobSummary {
  return {
    key: str(pick(raw, "Key")),
    state: str(pick(raw, "State")),
    info: str(pick(raw, "Info")),
    // `uip or jobs list` names it ProcessName in its curated rows and ReleaseName with --all-fields.
    process: str(pick(raw, "ProcessName", "ReleaseName")) || null,
    created_at: (pick(raw, "CreationTime") as string | undefined) ?? null,
    ended_at: (pick(raw, "EndTime") as string | undefined) ?? null,
  };
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

function asArray(v: unknown): Json[] {
  return Array.isArray(v) ? (v.filter((x) => x && typeof x === "object") as Json[]) : [];
}

/** Build Evidence from in-memory raw captures (used by fixtures and by loadEvidence). */
export function evidenceFromRaw(raw: Partial<Record<keyof typeof EVIDENCE_FILES, unknown>>): Evidence {
  const missing: string[] = [];
  const get = (k: keyof typeof EVIDENCE_FILES): unknown => {
    if (raw[k] === undefined) {
      missing.push(EVIDENCE_FILES[k]);
      return undefined;
    }
    return unwrap(raw[k]);
  };
  const context = get("context") as FaultContext | undefined;
  if (!context?.job_key || !context.process_key) {
    throw new Error("context.json must contain job_key and process_key");
  }
  const job = get("job");
  return {
    context,
    job: job && typeof job === "object" && !Array.isArray(job) ? (job as Json) : null,
    errorLogs: asArray(get("errorLogs")).map(toLogEntry),
    logs: asArray(get("logs")).map(toLogEntry),
    history: asArray(get("history")),
    recentFaults: asArray(get("recentFaults")).map(toJobSummary),
    recentSuccess: asArray(get("recentSuccess")).map(toJobSummary),
    missing,
  };
}

export function loadEvidence(dir: string): Evidence {
  const raw: Partial<Record<keyof typeof EVIDENCE_FILES, unknown>> = {};
  for (const [k, file] of Object.entries(EVIDENCE_FILES) as [keyof typeof EVIDENCE_FILES, string][]) {
    const p = join(dir, file);
    if (!existsSync(p)) continue;
    try {
      raw[k] = readJson(p);
    } catch (e) {
      // A capture that failed mid-write (e.g. uip error text) is a data gap, not fatal.
      if (k === "context") throw e;
    }
  }
  return evidenceFromRaw(raw);
}

const SKIP_DIRS = new Set([".git", ".local", ".autofix", "node_modules", ".objects", ".settings", ".tmh", ".entities"]);

/** List workflow source files (.xaml / .cs) in the checked-out project, relative paths. */
export function scanRepo(projectDir: string | undefined): RepoFacts {
  if (!projectDir || !existsSync(projectDir)) return { project_found: false, workflow_files: [] };
  const out: string[] = [];
  let projectJson = false;
  const walk = (dir: string, rel: string, depth: number) => {
    if (depth > 8 || out.length > 2000) return;
    for (const name of readdirSync(dir)) {
      if (SKIP_DIRS.has(name)) continue;
      const full = join(dir, name);
      const r = rel ? `${rel}/${name}` : name;
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(full, r, depth + 1);
      else if (name === "project.json") projectJson = true;
      else if (/\.(xaml|cs)$/i.test(name)) out.push(r);
    }
  };
  walk(projectDir, "", 0);
  return { project_found: projectJson, workflow_files: out.sort() };
}

/** Workflow file names referenced by the fault (log fileName fields and *.xaml mentions). */
export function referencedWorkflows(ev: Evidence): string[] {
  const names = new Set<string>();
  const add = (n: string) => {
    const b = basename(n.replace(/\\/g, "/")).trim();
    if (b) names.add(/\.(xaml|cs)$/i.test(b) ? b : `${b}.xaml`);
  };
  for (const l of ev.errorLogs) if (l.file) add(l.file);
  // Bound the scanned text and use a bounded, space-free token pattern: an unbounded lazy
  // class over megabytes of log text backtracks catastrophically, and allowing spaces
  // captured junk like "at Main.xaml". Names with spaces still arrive via log fileName.
  const text = [ev.context.info ?? "", str(ev.job?.["Info"]), ...ev.errorLogs.slice(-20).map((l) => l.message.slice(0, 5000))]
    .join("\n")
    .slice(0, 100_000);
  for (const m of text.matchAll(/[\w\-.\\/]{1,160}\.(?:xaml|cs)\b/gi)) add(m[0]);
  return [...names].slice(0, 20);
}
