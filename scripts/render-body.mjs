#!/usr/bin/env node
// Render the PR / issue / comment markdown from the .autofix/ artifacts.
//   usage: render-body.mjs pr|issue|comment <autofix_dir>
//   env:   SIGNATURE, RUN_URL, JOB_KEY, PROCESS_KEY, ORCHESTRATOR_URL
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const [, , kind, dir = ".autofix"] = process.argv;
const read = (f) => {
  const p = join(dir, f);
  if (!existsSync(p)) return null;
  try {
    return f.endsWith(".json") ? JSON.parse(readFileSync(p, "utf8")) : readFileSync(p, "utf8");
  } catch {
    return null;
  }
};

const triage = read("decision.json");
const dx = read("diagnose.json");
const dxRun = read("diagnose-run.json");
const fix = read("fix.json");
const fixRun = read("fix-run.json");
const validation = read("validation.txt");
const e = process.env;
const sig = e.SIGNATURE || "";
const jobLink = e.ORCHESTRATOR_URL ? `[\`${e.JOB_KEY}\`](${e.ORCHESTRATOR_URL})` : `\`${e.JOB_KEY}\``;
const decision = triage?.decision;

// Everything below that comes from Claude was derived from robot logs, so it is untrusted
// Markdown. A zero-width space after "<", between "!" and "[", and after "@" is invisible
// to a reader, but the text can then no longer form raw HTML (an <img> included), an image
// or a mention. Images matter most: GitHub fetches them through its proxy as soon as
// someone opens the thread, which would hand whatever is in the URL to that host. The
// insertion does not depend on Markdown context, so it holds inside and outside code.
const ZWSP = "​";
const text = (s) =>
  String(s ?? "")
    .replace(/</g, `<${ZWSP}`)
    .replace(/!\[/g, `!${ZWSP}[`)
    .replace(/@(?=[A-Za-z0-9-])/g, `@${ZWSP}`);
// For a value this script wraps in a `code span`: one line, and unable to close the span.
const code = (s) => text(s).replace(/`/g, "'").replace(/\s+/g, " ").trim() || "?";
const lines = [];
const out = (s = "") => lines.push(s);

if (kind === "comment") {
  out(`🔁 **Seen again:** job ${jobLink} faulted with the same error signature \`${sig}\`.`);
  if (decision) out(`Jev: ${decision.reason}`);
  if (dx?.root_cause) out(`Latest diagnosis (${text(dx.confidence)}): ${text(dx.root_cause)}`);
  out(`Run: ${e.RUN_URL}`);
  process.stdout.write(redact(lines.join("\n")) + "\n");
  process.exit(0);
}

out(`<!-- autofix-signature: ${sig} -->`);
out(
  kind === "pr"
    ? "## 🤖 Proposed fix for a faulted UiPath job"
    : "## 🔎 Investigation of a faulted UiPath job",
);
out();
out(`- **Process:** \`${e.PROCESS_KEY}\` · **Job:** ${jobLink} · **Fault signature:** \`${sig}\``);
out(`- **Run:** ${e.RUN_URL}`);
out();

if (dx) {
  out(`### Root cause (confidence: ${text(dx.confidence)})`);
  out(text(dx.root_cause));
  if (dx.cause_quote) out(`\n> ${text(dx.cause_quote)}${dx.playbook ? `\n> (playbook: \`${code(dx.playbook)}\`)` : ""}`);
  out();
  if (dx.evidence?.length) {
    out("### Evidence");
    for (const ev of dx.evidence) out(`- \`${code(ev.source)}\`: ${text(ev.datum)}`);
    out();
  }
  if (dx.proposed_changes?.length) {
    out(kind === "pr" ? "### Changes in this PR" : "### Proposed source changes (not applied)");
    for (const c of dx.proposed_changes) out(`- \`${code(c.file)}\`: ${text(c.change)}${c.rationale ? `. _${text(c.rationale)}_` : ""}`);
    out();
  }
  if (dx.non_code_actions?.length) {
    out("### Recommended operational actions");
    for (const a of dx.non_code_actions) out(`- ${text(a)}`);
    out();
  }
  if (dx.summary_md) {
    out("<details><summary>Full diagnosis</summary>");
    out();
    out(text(dx.summary_md));
    out();
    out("</details>");
    out();
  }
  if (dx.unverified_observations?.length) {
    out("<details><summary>Unverified observations (not part of the fix)</summary>");
    out();
    for (const o of dx.unverified_observations) out(`- ${text(o)}`);
    out("</details>");
    out();
  }
} else {
  out("### ⚠️ No diagnosis was produced");
  out("Claude did not return a structured diagnosis (turn or budget limit, or an error). See the run log.");
  out();
}

if (kind === "pr" && fix) {
  out("### Applied");
  out(text(fix.summary));
  if (fix.caveats?.length) for (const c of fix.caveats) out(`- ⚠️ ${text(c)}`);
  out();
}
if (kind === "issue" && validation && /rejected|not well-formed|invalid JSON|not allowed/.test(validation)) {
  out("### Why there is no PR");
  out("A fix was attempted but failed validation:");
  out("```");
  // File names and parser messages in here come from the patch, so keep them from closing the fence.
  out(text(validation.trim().slice(0, 3000)).replace(/`/g, "'"));
  out("```");
  out();
}

if (triage?.summary_md) {
  out("---");
  out(triage.summary_md.replace(/^### /m, "#### "));
}

const runs = [
  ["diagnose", dxRun],
  ["fix", fixRun],
].filter(([, r]) => r);
if (runs.length) {
  out("#### Claude Code cost");
  out("| Phase | Model | Turns | Cost |");
  out("|---|---|---|---|");
  let total = 0;
  for (const [phase, r] of runs) {
    total += r.total_cost_usd ?? 0;
    out(`| ${phase} | \`${decision?.model ?? "?"}\` | ${r.num_turns ?? "?"} | $${(r.total_cost_usd ?? 0).toFixed(3)} |`);
  }
  out(`| **total** | | | **$${total.toFixed(3)}** |`);
  out();
}

out(
  kind === "pr"
    ? "_This PR was generated automatically from Orchestrator evidence. UiPath Studio validation did not run in CI, so validate in Studio before merging._"
    : "_Opened automatically by the UiPath Jev router. No source change was proposed as a PR._",
);
process.stdout.write(redact(lines.join("\n")) + "\n");

/**
 * Defense in depth: the body is published (possibly to a public repo) and part of it was
 * written by a model that read untrusted robot logs. Strip anything that looks like a
 * credential before it leaves the runner. (Function declaration: hoisted above its uses.)
 */
function redact(body) {
  return body
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "[REDACTED_JWT]")
    .replace(/\bsk-ant-[A-Za-z0-9_-]{10,}/g, "[REDACTED_ANTHROPIC_KEY]")
    .replace(/\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, "[REDACTED_GITHUB_TOKEN]")
    .replace(/\b(UIPATH_CLIENT_SECRET|UIPATH_ACCESS_TOKEN|TYPESAFE_API_KEY|ANTHROPIC_API_KEY)\s*[=:]\s*\S+/g, "$1=[REDACTED]");
}
