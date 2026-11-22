/**
 * UiPath Orchestrator webhook payloads (job events). Field casing is PascalCase in
 * Orchestrator's documented samples; we read defensively and confirm with the first real
 * delivery (LOG_PAYLOAD_SHAPE=true).
 */

/**
 * The key structure of a payload with value types only, for the setup log. Job `Info` and
 * arguments can hold business data, so no value leaves the Worker through its logs.
 */
export function shapeOf(value: unknown, depth = 0): unknown {
  if (value === null) return "null";
  if (Array.isArray(value)) return depth >= 6 ? "array" : [value.length ? shapeOf(value[0], depth + 1) : "empty"];
  if (typeof value === "object") {
    if (depth >= 6) return "object";
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .slice(0, 60)
        .map(([k, v]) => [k.slice(0, 60), shapeOf(v, depth + 1)]),
    );
  }
  return typeof value === "string" ? `string(${value.length})` : typeof value;
}

export interface UiPathJob {
  Id?: number;
  Key?: string;
  State?: string;
  Info?: string;
  StartTime?: string;
  EndTime?: string;
  Release?: { Id?: number; Key?: string; ProcessKey?: string; Name?: string };
  Robot?: { Id?: number; Name?: string; MachineName?: string };
  [k: string]: unknown;
}

export interface UiPathWebhookEvent {
  Type?: string;
  EventId?: string;
  Timestamp?: string;
  Job?: UiPathJob;
  Jobs?: UiPathJob[];
  OrganizationUnitId?: number;
  TenantId?: number;
  [k: string]: unknown;
}

/** repository_dispatch client_payload: GitHub allows at most 10 top-level properties. */
export interface DispatchPayload {
  job_key: string;
  job_id: number | null;
  process_key: string;
  folder_id: number | null;
  info: string;
  robot: string | null;
  event_id: string | null;
  timestamp: string | null;
  signature: string;
  orchestrator_url: string | null;
}

export const INFO_MAX = 2000;

export function eventType(ev: UiPathWebhookEvent): string {
  return String(ev.Type ?? (ev as { type?: string }).type ?? "").toLowerCase();
}

export function jobsOf(ev: UiPathWebhookEvent): UiPathJob[] {
  const list = ev.Jobs?.length ? ev.Jobs : ev.Job ? [ev.Job] : [];
  return list.slice(0, 5); // a single faulted event carries one job; cap defensively
}

export function processKeyOf(job: UiPathJob): string | null {
  return job.Release?.ProcessKey || job.Release?.Name || null;
}

/**
 * Deep link into Orchestrator's job details panel. `base` is e.g.
 * https://cloud.uipath.com/<org>/<tenant>/orchestrator_
 */
export function orchestratorJobUrl(base: string | undefined, jobId: number | null, folderId: number | null): string | null {
  if (!base || jobId == null) return null;
  const b = base.replace(/\/+$/, "");
  return `${b}/jobs(sidepanel:sidepanel/jobs/${jobId}/details)${folderId != null ? `?fid=${folderId}` : ""}`;
}
