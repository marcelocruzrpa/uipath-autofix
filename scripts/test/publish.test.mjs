// publish.sh is the only script that writes to the repository, so its branches are driven
// here against a local bare remote, with a fake `gh` that records what would be sent.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { bash, fakeGh, git, hasPython, noBash, posix, tempDir, tempRepo, TOOLKIT, writeFiles } from "./helpers.mjs";

const XAML = (label) =>
  `<Activity x:Class="Main" xmlns="http://schemas.microsoft.com/netfx/2009/xaml/activities" xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"><Sequence DisplayName="${label}" /></Activity>`;
const GOOD_PATCH = ["diff --git a/Main.xaml b/Main.xaml", "index 1111111..2222222 100644", "--- a/Main.xaml", "+++ b/Main.xaml", "@@ -1 +1 @@", `-${XAML("old")}`, `+${XAML("new")}`, ""].join("\n");
const BAD_PATCH = ["diff --git a/tools/run.ps1 b/tools/run.ps1", "new file mode 100644", "index 0000000..2222222", "--- /dev/null", "+++ b/tools/run.ps1", "@@ -0,0 +1 @@", "+calc.exe", ""].join("\n");
const SIG = "abc123def456";
const BRANCH = `autofix/invoicebot/${SIG}-42-1`;
const DIAGNOSIS = { is_code_fix: true, confidence: "high", root_cause: "Selector changed.", evidence: [], proposed_changes: [{ file: "Main.xaml", change: "Update the selector" }], summary_md: "" };

const skip = noBash || (hasPython ? false : "python is not available for the XML check");

/** Run publish.sh in a fresh repository. `autofix` are the files in .autofix/; returns what happened. */
function publish({ autofix = {}, env = {}, open = "", merged = "", prCreateFails = false }) {
  const repo = tempRepo({ "Main.xaml": `${XAML("old")}\n` });
  const remote = tempDir();
  git(remote, ["init", "-q", "--bare"]);
  git(repo, ["remote", "add", "origin", posix(remote)]);
  writeFiles(repo, Object.fromEntries(Object.entries(autofix).map(([k, v]) => [`.autofix/${k}`, typeof v === "string" ? v : JSON.stringify(v)])));
  const gh = fakeGh();
  const r = bash("publish.sh", [], {
    cwd: repo,
    path: gh.bin,
    env: {
      GH_TOKEN: "x",
      TOOLKIT_DIR: TOOLKIT,
      JOB_KEY: "a1000000-0000-4000-8000-000000000001",
      PROCESS_KEY: "InvoiceBot",
      SIGNATURE: SIG,
      TIER: "sonnet",
      RUN_URL: "https://example.test/run/42",
      BASE_BRANCH: "main",
      GITHUB_REPOSITORY: "acme/invoice-bot",
      GITHUB_SERVER_URL: "https://github.com",
      GITHUB_RUN_ID: "42",
      GITHUB_RUN_ATTEMPT: "1",
      GITHUB_STEP_SUMMARY: "",
      GITHUB_OUTPUT: "",
      ORCHESTRATOR_URL: "",
      FAKE_GH_LOG: posix(gh.log),
      FAKE_GH_OPEN: open,
      FAKE_GH_MERGED: merged,
      FAKE_GH_PR_CREATE_FAILS: prCreateFails ? "1" : "",
      ...env,
    },
  });
  const calls = gh.calls();
  const read = (f) => (existsSync(join(repo, ".autofix", f)) ? readFileSync(join(repo, ".autofix", f), "utf8") : null);
  return {
    code: r.code,
    out: r.out,
    calls,
    call: (prefix) => calls.find((c) => c.startsWith(prefix)),
    pushed: git(remote, ["branch", "--list", "--format=%(refname:short)"]).split("\n").filter(Boolean),
    remote,
    body: read("body.md"),
    comment: read("comment.md"),
  };
}

const fixRun = { "diagnose.json": DIAGNOSIS, "diagnose-run.json": { num_turns: 9, total_cost_usd: 0.4 }, "fix.patch": GOOD_PATCH };
const fixEnv = { ACTION: "fix", HAS_PATCH: "true", VALIDATION: "ok" };

describe("publish.sh", { skip }, () => {
  it("pushes a validated fix on its own branch and opens a pull request", () => {
    const r = publish({ autofix: fixRun, env: fixEnv });
    assert.equal(r.code, 0, r.out);
    assert.deepEqual(r.pushed, [BRANCH]);
    assert.equal(git(r.remote, ["show", "--name-only", "--format=%s", BRANCH]).trim(), "fix(InvoiceBot): Selector changed.\n\nMain.xaml");
    const pr = r.call("pr|create|");
    assert.match(pr, /--title\|fix\(InvoiceBot\): Selector changed\.\|/);
    assert.match(pr, /--label\|uipath-autofix\|--label\|model:sonnet\|/);
    assert.ok(r.body.startsWith(`<!-- autofix-signature: ${SIG} -->`), "the body starts with the marker find-thread.sh matches");
    assert.match(r.out, /Opened PR: https:\/\/github\.test\/acme\/invoice-bot\/pull\/7/);
    assert.equal(r.call("issue|"), undefined);
  });

  it("hands the fix over in an issue when the pull request cannot be opened", () => {
    const r = publish({ autofix: fixRun, env: fixEnv, prCreateFails: true });
    assert.equal(r.code, 0, r.out);
    assert.deepEqual(r.pushed, [BRANCH], "the branch is still there to open the pull request from");
    const issue = r.call("issue|create|");
    assert.match(issue, /--label\|uipath-autofix:investigate\|--label\|uipath-autofix:fix-attempted\|/);
    assert.match(r.body, /A fix is ready, but the pull request could not be opened/);
    assert.ok(r.body.includes(`https://github.com/acme/invoice-bot/compare/main...${BRANCH}?expand=1`));
    assert.match(r.out, /Opened issue/);
  });

  it("only comments when an open pull request already tracks the fault", () => {
    const r = publish({ autofix: fixRun, env: fixEnv, open: "5\tpr\tfalse" });
    assert.equal(r.code, 0, r.out);
    assert.match(r.call("pr|comment|"), /^pr\|comment\|5\|/);
    assert.deepEqual(r.pushed, []);
    assert.match(r.comment, /Seen again/);
    assert.equal(r.call("pr|create|"), undefined);
  });

  it("opens the pull request next to an issue that only held a diagnosis, and marks the issue", () => {
    const r = publish({ autofix: fixRun, env: fixEnv, open: "9\tissue\tfalse" });
    assert.equal(r.code, 0, r.out);
    assert.ok(r.call("pr|create|"));
    assert.match(r.body, /\nRelated: #9\n/);
    assert.match(r.call("issue|edit|"), /^issue\|edit\|9\|--add-label\|uipath-autofix:fix-attempted\|/);
  });

  it("comments on a recently merged fix instead of opening a new thread when Claude was skipped", () => {
    const r = publish({ autofix: { "decision.json": { decision: { reason: "needs_code_fix 0.91 → fix · sonnet" } } }, env: { ACTION: "fix" }, merged: "3" });
    assert.equal(r.code, 0, r.out);
    assert.match(r.call("pr|comment|"), /^pr\|comment\|3\|/);
    assert.match(r.comment, /after this fix was merged/);
    assert.match(r.comment, /Jev: needs_code_fix 0\.91/);
    assert.equal(r.call("issue|create|"), undefined);
  });

  it("opens a new thread after a merged fix when Claude did run", () => {
    const r = publish({ autofix: fixRun, env: fixEnv, merged: "3" });
    assert.equal(r.code, 0, r.out);
    assert.ok(r.call("pr|create|"));
    assert.equal(r.call("pr|comment|"), undefined);
  });

  it("opens an issue that says why when the patch is rejected, and pushes nothing", () => {
    const r = publish({ autofix: { ...fixRun, "fix.patch": BAD_PATCH }, env: fixEnv });
    assert.equal(r.code, 0, r.out);
    assert.deepEqual(r.pushed, []);
    assert.ok(r.call("issue|create|"));
    assert.match(r.body, /### Why there is no PR/);
    assert.match(r.body, /tools\/run\.ps1: file type not allowed/);
  });

  it("opens a diagnosis-only issue in investigate mode, without the fix-attempted label", () => {
    const r = publish({ autofix: { "diagnose.json": { ...DIAGNOSIS, is_code_fix: false }, "diagnose-run.json": { num_turns: 5, total_cost_usd: 0.2 } }, env: { ACTION: "investigate" } });
    assert.equal(r.code, 0, r.out);
    const issue = r.call("issue|create|");
    assert.match(issue, /--title\|\[autofix\] InvoiceBot: Selector changed\.\|/);
    assert.doesNotMatch(issue, /fix-attempted/);
    assert.match(r.body, /Investigation of a faulted UiPath job/);
  });

  it("comments on the issue that already tracks the fault and does not repeat a fix attempt label", () => {
    const r = publish({ autofix: { "diagnose.json": DIAGNOSIS, "diagnose-run.json": { num_turns: 5, total_cost_usd: 0.2 } }, env: { ACTION: "investigate" }, open: "9\tissue\ttrue" });
    assert.equal(r.code, 0, r.out);
    assert.match(r.call("issue|comment|"), /^issue\|comment\|9\|/);
    assert.equal(r.call("issue|edit|"), undefined);
  });
});

describe("find-thread.sh", { skip: noBash }, () => {
  const find = ({ signature = SIG, open = "", merged = "" }) => {
    const gh = fakeGh();
    const r = bash("find-thread.sh", [], { path: gh.bin, env: { SIGNATURE: signature, GITHUB_OUTPUT: "", FAKE_GH_LOG: posix(gh.log), FAKE_GH_OPEN: open, FAKE_GH_MERGED: merged } });
    return { ...r, calls: gh.calls() };
  };

  it("asks for the labelled threads and matches the exact marker line", () => {
    const r = find({});
    assert.equal(r.code, 0, r.out);
    assert.match(r.calls[0], /^api\|--paginate\|repos\/\{owner\}\/\{repo\}\/issues\?state=open&labels=uipath-autofix&per_page=100\|--jq\|/);
    assert.ok(r.calls[0].includes(`startswith("<!-- autofix-signature: ${SIG} -->")`), r.calls[0]);
    assert.match(r.out, /^pr=\nissue=\nmerged_pr=\nfix_attempted=false\n$/);
  });

  it("reports the newest open pull request and issue, and whether a fix was attempted", () => {
    const r = find({ open: "12\tpr\tfalse\n9\tissue\ttrue\n4\tissue\tfalse" });
    assert.match(r.out, /^pr=12\nissue=9\nmerged_pr=\nfix_attempted=true\n$/);
    assert.equal(r.calls.length, 1, "an open pull request makes the merged lookup unnecessary");
  });

  it("falls back to a fix merged in the last days", () => {
    const r = find({ merged: "3\n2" });
    assert.match(r.out, /^pr=\nissue=\nmerged_pr=3\nfix_attempted=false\n$/);
    assert.match(r.calls[1], /issues\?state=closed&labels=uipath-autofix&since=\d{4}-\d\d-\d\dT/);
  });

  it("refuses a signature that is not the expected shape", () => {
    const r = find({ signature: 'x" | halt_error' });
    assert.equal(r.code, 1);
    assert.equal(r.calls.length, 0);
  });
});
