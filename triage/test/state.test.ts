import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { evidenceFromRaw, toLogEntry, unwrap } from "../src/evidence.js";
import { loadFixtures } from "../src/fixtures.js";
import { buildRequest, loadConfig } from "../src/jev.js";
import { buildState, clip, LIMITS } from "../src/state.js";

const fixtures = loadFixtures(fileURLToPath(new URL("../fixtures", import.meta.url)));
const byName = (n: string) => fixtures.find((f) => f.name.startsWith(n))!;

describe("evidence parsing", () => {
  it("unwraps the uip {Result, Data} envelope", () => {
    expect(unwrap({ Result: "Success", Code: "JobGet", Data: { Key: "k" } })).toEqual({ Key: "k" });
    expect(unwrap([1, 2])).toEqual([1, 2]);
  });

  it("extracts fileName from an Orchestrator RawMessage", () => {
    const e = toLogEntry({
      Level: "Error",
      TimeStamp: "2026-11-21T10:00:00Z",
      Message: "boom",
      RawMessage: JSON.stringify({ message: "boom", fileName: "PostToERP", processVersion: "1.0.3" }),
    });
    expect(e).toEqual({ level: "Error", at: "2026-11-21T10:00:00Z", message: "boom", file: "PostToERP" });
  });

  it("requires job_key and process_key in context", () => {
    expect(() => evidenceFromRaw({ context: { job_key: "k" } })).toThrow(/process_key/);
  });

  it("records missing captures as evidence gaps", () => {
    const ev = evidenceFromRaw({ context: { job_key: "k", process_key: "P", info: "x" } });
    const { state } = buildState(ev, { project_found: false, workflow_files: [] });
    expect(state.evidence_gaps).toContain("jobs-logs-error.json");
  });
});

describe("state", () => {
  it("counts earlier occurrences of the same error, excluding the current job", () => {
    const fx = byName("08");
    const { facts } = buildState(fx.evidence, fx.repo, fx.now);
    expect(facts.same_error_runs_last_24h).toBe(4);
    expect(facts.faulted_runs_last_24h).toBe(4);
  });

  it("ignores faults older than 24h", () => {
    const fx = byName("09"); // one earlier fault at 2026-11-20T17:00Z
    expect(buildState(fx.evidence, fx.repo, fx.now).facts.same_error_runs_last_24h).toBe(1); // 19h earlier
    expect(buildState(fx.evidence, fx.repo, new Date("2026-11-21T18:00:00Z")).facts.same_error_runs_last_24h).toBe(0); // 25h
  });

  it("counts history for this exact process only, since the CLI's name filter is a contains match", () => {
    const info = "HTTP 503 Service Unavailable";
    const row = (Key: string, name: Record<string, string>, hour: string) => ({ Key, State: "Faulted", Info: info, CreationTime: `2026-11-21T${hour}:00:00Z`, ...name });
    const ev = evidenceFromRaw({
      context: { job_key: "current", process_key: "Invoice", info },
      recentFaults: [
        row("current", { ProcessName: "Invoice" }, "11"),
        row("a", { ProcessName: "Invoice" }, "10"),
        row("b", { ProcessName: "InvoiceBot" }, "09"),
        row("c", { ReleaseName: "InvoiceBot_Test" }, "08"), // --all-fields rows use ReleaseName
        row("d", { ReleaseName: "invoice" }, "07"),
      ],
      recentSuccess: [
        { Key: "s1", State: "Successful", ProcessName: "InvoiceBot", EndTime: "2026-11-21T11:30:00Z" },
        { Key: "s2", State: "Successful", ProcessName: "Invoice", EndTime: "2026-11-21T06:00:00Z" },
      ],
    });
    const { facts } = buildState(ev, { project_found: false, workflow_files: [] }, new Date("2026-11-21T12:00:00Z"));
    expect(facts.faulted_runs_last_24h).toBe(2); // a and d
    expect(facts.same_error_runs_last_24h).toBe(2);
    expect(facts.last_successful_run_at).toBe("2026-11-21T06:00:00Z");
  });

  it("takes the process name from the job record when it differs from the webhook's process key", () => {
    const ev = evidenceFromRaw({
      context: { job_key: "current", process_key: "InvoiceBot", info: "boom" },
      job: { Key: "current", State: "Faulted", ReleaseName: "InvoiceBot_Production" },
      recentFaults: [
        { Key: "a", State: "Faulted", Info: "boom", ProcessName: "InvoiceBot_Production", CreationTime: "2026-11-21T10:00:00Z" },
        { Key: "b", State: "Faulted", Info: "boom", ProcessName: "InvoiceBot_Test", CreationTime: "2026-11-21T09:00:00Z" },
      ],
    });
    const { facts } = buildState(ev, { project_found: false, workflow_files: [] }, new Date("2026-11-21T12:00:00Z"));
    expect(facts.same_error_runs_last_24h).toBe(1);
  });

  it("extracts clean workflow names from stack text", () => {
    const ev = evidenceFromRaw({
      context: { job_key: "k", process_key: "P", info: "boom\r\n   at Workflows\\SubmitInvoice.xaml\r\n   at Main.xaml: Assign; data.csv" },
    });
    const { facts } = buildState(ev, { project_found: false, workflow_files: [] });
    expect(facts.referenced_workflows.sort()).toEqual(["Main.xaml", "SubmitInvoice.xaml"]);
  });

  it("resolves referenced workflows against the repo", () => {
    const fx = byName("01");
    const { facts } = buildState(fx.evidence, fx.repo, fx.now);
    expect(facts.referenced_workflows).toContain("SubmitInvoice.xaml");
    expect(facts.referenced_workflows_found_in_repo).toBe(true);
  });

  it("flags referenced workflows missing from the repo", () => {
    const fx = byName("01");
    const { facts } = buildState(fx.evidence, { project_found: true, workflow_files: ["Other.xaml"] }, fx.now);
    expect(facts.referenced_workflows_found_in_repo).toBe(false);
  });

  it("falls back to Error-level lines from the full log when the error capture is empty", () => {
    const ev = evidenceFromRaw({
      context: { job_key: "k", process_key: "P", info: "x" },
      errorLogs: [],
      logs: [
        { Level: "Info", TimeStamp: "2026-01-01T00:00:01Z", Message: "a" },
        { Level: "Error", TimeStamp: "2026-01-01T00:00:02Z", Message: "b" },
      ],
    });
    expect(buildState(ev, { project_found: false, workflow_files: [] }).state.error_logs.map((l) => l.message)).toEqual(["b"]);
  });

  it("bounds the state size regardless of log volume", () => {
    const huge = "x".repeat(50_000);
    const ev = evidenceFromRaw({
      context: { job_key: "k", process_key: "P", info: huge },
      errorLogs: Array.from({ length: 200 }, (_, i) => ({ Level: "Error", TimeStamp: `2026-01-01T00:${String(i % 60).padStart(2, "0")}:00Z`, Message: huge })),
      logs: Array.from({ length: 5000 }, () => ({ Level: "Info", TimeStamp: "2026-01-01T00:00:00Z", Message: huge })),
    });
    const { state } = buildState(ev, { project_found: false, workflow_files: [] });
    expect(state.error_logs).toHaveLength(LIMITS.errorLogs);
    expect(state.recent_log_tail).toHaveLength(LIMITS.tailLines);
    // ~4 chars/token: comfortably under Jev's 32k tokens per (state + question).
    expect(JSON.stringify(state).length).toBeLessThan(60_000);
  });

  it("clip keeps head and tail", () => {
    const c = clip(`HEAD${"m".repeat(1000)}TAIL`, 100);
    expect(c.startsWith("HEAD")).toBe(true);
    expect(c.endsWith("TAIL")).toBe(true);
    expect(c.length).toBeLessThanOrEqual(130);
  });
});

describe("request", () => {
  it("pins the Jev model and sends all four questions in one request", () => {
    const fx = byName("02");
    const req = buildRequest(buildState(fx.evidence, fx.repo, fx.now).state, loadConfig());
    expect(req.model).toBe("jev-1.14.0");
    expect(Object.keys(req.questions).sort()).toEqual(["fault_category", "fix_complexity", "location_pinpointed", "needs_code_fix"]);
    expect(req.questions.fault_category.type).toBe("choice");
    expect(req.questions.needs_code_fix.type).toBe("noul");
    expect(req.questions.fix_complexity.type).toBe("score");
  });
});
