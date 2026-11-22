import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as triageSig from "../../triage/src/signature.js";
import worker, { type Env } from "../src/index.js";
import { faultSignature, normalizeInfo, sign } from "../src/signature.js";

const SECRET = "test-secret";

class MemoryKV {
  store = new Map<string, string>();
  async get(k: string) {
    return this.store.get(k) ?? null;
  }
  async put(k: string, v: string, _o?: unknown) {
    this.store.set(k, v);
  }
  async delete(k: string) {
    this.store.delete(k);
  }
}

function makeEnv(overrides: Partial<Env> = {}): Env & { DEDUPE: MemoryKV } {
  return {
    UIPATH_WEBHOOK_SECRET: SECRET,
    GITHUB_DISPATCH_TOKEN: "ghp_test",
    PROCESS_REPO_MAP: { InvoiceBot: "acme/invoice-bot" },
    DEDUPE: new MemoryKV() as unknown as KVNamespace,
    DEDUPE_TTL_SECONDS: "3600",
    ORCHESTRATOR_BASE_URL: "https://cloud.uipath.com/acme/DefaultTenant/orchestrator_",
    ...overrides,
  } as Env & { DEDUPE: MemoryKV };
}

const faulted = (over: Record<string, unknown> = {}) => ({
  Type: "job.faulted",
  EventId: "evt-1",
  Timestamp: "2026-11-21T12:00:00Z",
  OrganizationUnitId: 42,
  Job: {
    Id: 9001,
    Key: "a1000000-0000-4000-8000-000000000001",
    State: "Faulted",
    Info: "Click 'Submit': Could not find the user-interface (UI) element for this action.",
    Release: { Id: 7, Key: "rel-key", ProcessKey: "InvoiceBot" },
    Robot: { Id: 3, Name: "ROBOT01" },
  },
  ...over,
});

async function deliver(env: Env, body: unknown, opts: { encoding?: "hex" | "base64"; prefix?: boolean; signature?: string } = {}) {
  const text = JSON.stringify(body);
  const sig = opts.signature ?? `${opts.prefix ? "sha256=" : ""}${await sign(SECRET, text, opts.encoding ?? "hex")}`;
  return worker.fetch(
    new Request("https://worker.example/uipath/webhook", { method: "POST", body: text, headers: { "X-UiPath-Signature": sig } }),
    env,
    {} as ExecutionContext,
  );
}

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("signature verification", () => {
  it.each([
    ["hex", false],
    ["hex", true],
    ["base64", false],
    ["base64", true],
  ] as const)("accepts %s signatures (sha256= prefix: %s)", async (encoding, prefix) => {
    const res = await deliver(makeEnv(), faulted(), { encoding, prefix });
    expect(res.status).toBe(202);
  });

  it("rejects a bad signature with 401 and does not dispatch", async () => {
    const res = await deliver(makeEnv(), faulted(), { signature: "sha256=" + "0".repeat(64) });
    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a missing signature", async () => {
    const res = await worker.fetch(
      new Request("https://w/uipath/webhook", { method: "POST", body: JSON.stringify(faulted()) }),
      makeEnv(),
      {} as ExecutionContext,
    );
    expect(res.status).toBe(401);
  });

  it("rejects a signature computed with a different secret", async () => {
    const text = JSON.stringify(faulted());
    const res = await deliver(makeEnv(), faulted(), { signature: await sign("other", text) });
    expect(res.status).toBe(401);
  });
});

describe("routing", () => {
  it("dispatches a mapped faulted job to its repo with a ≤10-key client_payload", async () => {
    const res = await deliver(makeEnv(), faulted());
    expect(res.status).toBe(202);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.github.com/repos/acme/invoice-bot/dispatches");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer ghp_test");
    const body = JSON.parse(init.body as string);
    expect(body.event_type).toBe("uipath-job-faulted");
    expect(Object.keys(body.client_payload).length).toBeLessThanOrEqual(10);
    expect(body.client_payload).toMatchObject({
      job_key: "a1000000-0000-4000-8000-000000000001",
      job_id: 9001,
      process_key: "InvoiceBot",
      folder_id: 42,
      robot: "ROBOT01",
      orchestrator_url: "https://cloud.uipath.com/acme/DefaultTenant/orchestrator_/jobs(sidepanel:sidepanel/jobs/9001/details)?fid=42",
    });
    expect(body.client_payload.signature).toMatch(/^[0-9a-f]{12}$/);
  });

  it("accepts PROCESS_REPO_MAP as a JSON string", async () => {
    const res = await deliver(makeEnv({ PROCESS_REPO_MAP: '{"InvoiceBot":"acme/invoice-bot"}' }), faulted());
    expect(res.status).toBe(202);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns 204 for non-faulted events", async () => {
    const res = await deliver(makeEnv(), faulted({ Type: "job.completed" }));
    expect(res.status).toBe(204);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("answers ping events", async () => {
    const res = await deliver(makeEnv(), { Type: "ping", EventId: "p" });
    expect(res.status).toBe(200);
  });

  it("acknowledges unmapped processes without dispatching", async () => {
    const res = await deliver(makeEnv({ PROCESS_REPO_MAP: { Other: "acme/other" } }), faulted());
    expect(res.status).toBe(202);
    expect(((await res.json()) as { outcomes: { status: string }[] }).outcomes[0]!.status).toBe("unmapped");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("truncates long Info to 2000 chars", async () => {
    const ev = faulted();
    (ev.Job as { Info: string }).Info = "x".repeat(10_000);
    await deliver(makeEnv(), ev);
    const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.client_payload.info).toHaveLength(2000);
  });

  it("404s unknown routes and answers /health", async () => {
    const env = makeEnv();
    expect((await worker.fetch(new Request("https://w/nope"), env, {} as ExecutionContext)).status).toBe(404);
    expect((await worker.fetch(new Request("https://w/health"), env, {} as ExecutionContext)).status).toBe(200);
  });
});

describe("dedupe", () => {
  it("suppresses the same fault signature within the TTL", async () => {
    const env = makeEnv();
    await deliver(env, faulted());
    const second = faulted();
    (second.Job as { Key: string }).Key = "a1000000-0000-4000-8000-0000000000ff"; // different job, same error
    const res = await deliver(env, second);
    expect(((await res.json()) as { outcomes: { status: string }[] }).outcomes[0]!.status).toBe("suppressed");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not suppress a different error from the same process", async () => {
    const env = makeEnv();
    await deliver(env, faulted());
    const other = faulted();
    (other.Job as { Info: string }).Info = "Object reference not set to an instance of an object.";
    await deliver(env, other);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("releases the claim and returns 502 when GitHub rejects the dispatch", async () => {
    fetchMock.mockResolvedValueOnce(new Response("Bad credentials", { status: 401 }));
    const env = makeEnv();
    const res = await deliver(env, faulted());
    expect(res.status).toBe(502);
    expect(env.DEDUPE.store.size).toBe(0);
    // A retry can now get through.
    expect((await deliver(env, faulted())).status).toBe(202);
  });
});

describe("fault signature", () => {
  it("ignores volatile tokens (ids, numbers, timestamps)", async () => {
    const a = await faultSignature("P", "Timeout after 30000 ms for job 3f1c2a9e-1111-4222-8333-444455556666 at 2026-11-21T10:00:00Z");
    const b = await faultSignature("P", "Timeout after 45000 ms for job 9a9a9a9a-1111-4222-8333-444455556666 at 2026-11-22T11:30:00.123Z");
    expect(a).toBe(b);
  });

  it("matches the triage implementation byte for byte", async () => {
    const samples = [
      "Click 'Submit': Could not find the user-interface (UI) element for this action.",
      "Job stopped with an unexpected exit code: 0xE0434352",
      "HTTP 503 at 2026-11-21 10:00:00 for 3f1c2a9e-1111-4222-8333-444455556666\r\n\tretry 3",
      "",
    ];
    for (const s of samples) {
      expect(normalizeInfo(s)).toBe(triageSig.normalizeInfo(s));
      expect(await faultSignature("InvoiceBot", s)).toBe(triageSig.faultSignature("InvoiceBot", s));
    }
  });
});
