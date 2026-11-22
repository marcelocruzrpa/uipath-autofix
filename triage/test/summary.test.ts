import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/jev.js";
import { fallbackDecision } from "../src/policy.js";
import type { DerivedFacts } from "../src/state.js";
import { renderSummary, safeUrl } from "../src/summary.js";

const facts = (over: Partial<DerivedFacts> = {}): DerivedFacts => ({
  faulted_runs_last_24h: 0,
  same_error_runs_last_24h: 0,
  last_successful_run_at: null,
  referenced_workflows: [],
  referenced_workflows_found_in_repo: null,
  project_found: true,
  workflow_missing_from_repo: false,
  failing_activity: null,
  workflow_match: "none",
  workflow_match_files: [],
  ...over,
});
const render = (over: Partial<DerivedFacts> = {}, orchestratorUrl?: string) =>
  renderSummary({ processKey: "InvoiceBot", jobKey: "a1000000-0000-4000-8000-000000000001", decision: fallbackDecision(loadConfig(), "x"), jev: null, facts: facts(over), orchestratorUrl });

describe("safeUrl", () => {
  it("accepts an Orchestrator deep link, parentheses included", () => {
    const url = "https://cloud.uipath.com/acme/DefaultTenant/orchestrator_/jobs(sidepanel:sidepanel/jobs/9001/details)?fid=42";
    expect(safeUrl(url)).toBe(url);
  });

  it("refuses anything that could end a Markdown link early or is not https", () => {
    for (const url of ["http://cloud.uipath.com/x", "javascript:alert(1)", "https://x.test/a) ![i](https://evil.test", "https://x.test/a)b(", "https://x.test/<img>", 'https://x.test/"', "", undefined]) {
      expect(safeUrl(url), String(url)).toBeNull();
    }
  });
});

describe("routing summary", () => {
  it("links the job only when the URL is safe", () => {
    expect(render({}, "https://cloud.uipath.com/acme/t/orchestrator_/jobs(sidepanel:sidepanel/jobs/9/details)")).toContain("](https://cloud.uipath.com/");
    const unsafe = render({}, "https://x.test/a) ![i](https://evil.test/b");
    expect(unsafe).not.toContain("evil.test");
    expect(unsafe).toContain("- Job: `a1000000-0000-4000-8000-000000000001`");
  });

  it("reports where the failing activity was found", () => {
    expect(render({ failing_activity: "Click 'Submit invoice'", workflow_match: "unique", workflow_match_files: ["Workflows/SubmitInvoice.xaml"] })).toContain(
      "- Failing activity: `Click 'Submit invoice'`, found in `Workflows/SubmitInvoice.xaml`",
    );
    expect(render({ failing_activity: "Assign", workflow_match: "ambiguous", workflow_match_files: ["A.xaml", "B.xaml"] })).toContain("a name used in several workflows (`A.xaml`, `B.xaml`)");
    expect(render()).not.toContain("Failing activity");
  });

  it("keeps a display name from the logs on one line and inside its code span", () => {
    const md = render({ failing_activity: "Click `x`\n\n![i](https://evil.test)", workflow_match: "unique", workflow_match_files: ["Main.xaml"] });
    expect(md).toContain("- Failing activity: `Click 'x' ![i](https://evil.test)`, found in `Main.xaml`");
  });
});
