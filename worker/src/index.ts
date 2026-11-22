import { type DispatchPayload, eventType, INFO_MAX, jobsOf, orchestratorJobUrl, processKeyOf, type UiPathWebhookEvent } from "./payload.js";
import { faultSignature, verifySignature } from "./signature.js";

export interface Env {
  /** Shared secret configured on the Orchestrator webhook (`--secret`). */
  UIPATH_WEBHOOK_SECRET: string;
  /** Fine-grained PAT with Contents: read & write on the project repos (repository_dispatch). */
  GITHUB_DISPATCH_TOKEN: string;
  /** {"<Release.ProcessKey>": "owner/repo"} — JSON string or object (wrangler.jsonc vars). */
  PROCESS_REPO_MAP: string | Record<string, string>;
  DEDUPE: KVNamespace;
  DEDUPE_TTL_SECONDS?: string;
  EVENT_TYPE?: string;
  ORCHESTRATOR_BASE_URL?: string;
  LOG_RAW_PAYLOAD?: string;
}

type Outcome =
  | { job_key: string; status: "dispatched"; repo: string; signature: string }
  | { job_key: string; status: "suppressed"; signature: string }
  | { job_key: string; status: "unmapped"; process_key: string | null }
  | { job_key: string; status: "error"; error: string };

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function repoMap(env: Env): Record<string, string> {
  if (typeof env.PROCESS_REPO_MAP === "object" && env.PROCESS_REPO_MAP) return env.PROCESS_REPO_MAP;
  try {
    return JSON.parse(env.PROCESS_REPO_MAP || "{}") as Record<string, string>;
  } catch {
    console.error("PROCESS_REPO_MAP is not valid JSON");
    return {};
  }
}

async function dispatch(env: Env, repo: string, payload: DispatchPayload): Promise<void> {
  const res = await fetch(`https://api.github.com/repos/${repo}/dispatches`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.GITHUB_DISPATCH_TOKEN}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "uipath-jev-router",
      "content-type": "application/json",
    },
    body: JSON.stringify({ event_type: env.EVENT_TYPE || "uipath-job-faulted", client_payload: payload }),
  });
  if (res.status !== 204) throw new Error(`GitHub dispatch ${res.status}: ${(await res.text()).slice(0, 300)}`);
}

async function handleWebhook(request: Request, env: Env): Promise<Response> {
  const raw = await request.arrayBuffer();
  if (!(await verifySignature(env.UIPATH_WEBHOOK_SECRET, raw, request.headers.get("x-uipath-signature")))) {
    return json({ error: "invalid signature" }, 401);
  }
  const text = new TextDecoder().decode(raw);
  if (env.LOG_RAW_PAYLOAD === "true") {
    console.log(`raw delivery headers=${JSON.stringify(Object.fromEntries(request.headers))} body=${text}`);
  }
  let ev: UiPathWebhookEvent;
  try {
    ev = JSON.parse(text) as UiPathWebhookEvent;
  } catch {
    return json({ error: "body is not JSON" }, 400);
  }
  const type = eventType(ev);
  if (type === "ping") return json({ ok: true, pong: true });
  if (type !== "job.faulted") return new Response(null, { status: 204 });

  const map = repoMap(env);
  const ttl = Math.max(60, Number(env.DEDUPE_TTL_SECONDS) || 3600);
  const outcomes: Outcome[] = [];

  for (const job of jobsOf(ev)) {
    const jobKey = job.Key ?? "";
    const processKey = processKeyOf(job);
    const repo = processKey ? map[processKey] : undefined;
    if (!jobKey || !processKey || !repo) {
      console.log(`unmapped fault job=${jobKey} process=${processKey}`);
      outcomes.push({ job_key: jobKey, status: "unmapped", process_key: processKey });
      continue;
    }
    const info = job.Info ?? "";
    const signature = await faultSignature(processKey, info);
    const dedupeKey = `sig:${repo}:${signature}`;
    if (await env.DEDUPE.get(dedupeKey)) {
      console.log(`suppressed duplicate job=${jobKey} sig=${signature}`);
      outcomes.push({ job_key: jobKey, status: "suppressed", signature });
      continue;
    }
    // Claim the signature before dispatching so a burst of identical faults usually
    // dispatches once. KV has no atomic check-and-set, so two concurrent deliveries can both
    // get through; the workflow's concurrency group and thread lookup absorb the duplicate.
    await env.DEDUPE.put(dedupeKey, jobKey, { expirationTtl: ttl });
    const folderId = typeof ev.OrganizationUnitId === "number" ? ev.OrganizationUnitId : null;
    const jobId = typeof job.Id === "number" ? job.Id : null;
    try {
      await dispatch(env, repo, {
        job_key: jobKey,
        job_id: jobId,
        process_key: processKey,
        folder_id: folderId,
        info: info.slice(0, INFO_MAX),
        robot: job.Robot?.Name ?? null,
        event_id: ev.EventId ?? null,
        timestamp: ev.Timestamp ?? null,
        signature,
        orchestrator_url: orchestratorJobUrl(env.ORCHESTRATOR_BASE_URL, jobId, folderId),
      });
      console.log(`dispatched job=${jobKey} repo=${repo} sig=${signature}`);
      outcomes.push({ job_key: jobKey, status: "dispatched", repo, signature });
    } catch (e) {
      // Release the claim so Orchestrator's retry (or the next occurrence) can get through.
      await env.DEDUPE.delete(dedupeKey);
      const error = e instanceof Error ? e.message : String(e);
      console.error(`dispatch failed job=${jobKey}: ${error}`);
      outcomes.push({ job_key: jobKey, status: "error", error });
    }
  }

  const failed = outcomes.some((o) => o.status === "error");
  return json({ outcomes }, failed ? 502 : 202);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (request.method === "GET" && pathname === "/health") return json({ ok: true });
    if (request.method === "POST" && pathname === "/uipath/webhook") return handleWebhook(request, env);
    return json({ error: "not found" }, 404);
  },
} satisfies ExportedHandler<Env>;
