#!/usr/bin/env node
// Render what is published from the .autofix/ artifacts.
//   usage: render-body.mjs pr|issue|comment|comment-merged|title|diagnosis-summary <autofix_dir>
//     pr, issue, comment   the Markdown body
//     comment-merged       the comment for a fix PR that is already merged
//     title                one plain line for the PR/issue title and the commit subject
//     diagnosis-summary    Markdown for the Actions run summary
//   env:   SIGNATURE, RUN_URL, JOB_KEY, PROCESS_KEY, ORCHESTRATOR_URL, TIER
//
// decision.json is written by the triage job and is printed as trusted Markdown: the
// workflow verifies its hash before this script runs (accept-artifacts.sh). Every other
// file passed through the job that hosts the model, so each of their fields is scrubbed
// and nothing is assumed about its type.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { code, list, num, obj, redact, safeUrl, text, titleLine } from "./lib/scrub.mjs";

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

const triage = obj(read("decision.json"));
const dx = obj(read("diagnose.json"));
const dxRun = obj(read("diagnose-run.json"));
const fix = obj(read("fix.json"));
const fixRun = obj(read("fix-run.json"));
const validation = read("validation.txt");
const e = process.env;
const sig = e.SIGNATURE || "";
// The URL arrives with the webhook payload, so it is checked before it goes into a link.
const jobUrl = safeUrl(e.ORCHESTRATOR_URL);
const jobLink = jobUrl ? `[\`${e.JOB_KEY}\`](${jobUrl})` : `\`${e.JOB_KEY}\``;
const decision = obj(triage?.decision);
const emit = (s) => process.stdout.write(redact(s));

if (kind === "title") {
  // Empty when there is no diagnosis: the caller then falls back to the job key.
  emit(titleLine(dx?.root_cause));
  process.exit(0);
}

if (kind === "diagnosis-summary") {
  if (dx) {
    const tier = e.TIER ? ` (${code(e.TIER)})` : "";
    emit(`### Claude diagnosis${tier}\n\n**${text(dx.confidence)}** · code fix: **${dx.is_code_fix === true}**\n\n${text(dx.root_cause)}\n`);
  }
  process.exit(0);
}

const lines = [];
const out = (s = "") => lines.push(s);

if (kind === "comment" || kind === "comment-merged") {
  if (kind === "comment") {
    out(`🔁 **Seen again:** job ${jobLink} faulted with the same error signature \`${sig}\`.`);
  } else {
    // On a fix PR that is already merged: the fault recurs until the fixed package is deployed.
    out(`🔁 **Seen again after this fix was merged:** job ${jobLink} faulted with the same error signature \`${sig}\`.`);
    out("Check that the package built from this fix is published and deployed to the folder that runs the process. No new diagnosis was started.");
  }
  if (decision) out(`Jev: ${text(decision.reason)}`);
  if (dx?.root_cause) out(`Latest diagnosis (${text(dx.confidence)}): ${text(dx.root_cause)}`);
  out(`Run: ${e.RUN_URL}`);
  emit(lines.join("\n") + "\n");
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
  const evidence = list(dx.evidence);
  if (evidence.length) {
    out("### Evidence");
    for (const ev of evidence) out(`- \`${code(ev.source)}\`: ${text(ev.datum)}`);
    out();
  }
  const changes = list(dx.proposed_changes);
  if (changes.length) {
    out(kind === "pr" ? "### Changes in this PR" : "### Proposed source changes (not applied)");
    for (const c of changes) out(`- \`${code(c.file)}\`: ${text(c.change)}${c.rationale ? `. _${text(c.rationale)}_` : ""}`);
    out();
  }
  const actions = list(dx.non_code_actions);
  if (actions.length) {
    out("### Recommended operational actions");
    for (const a of actions) out(`- ${text(a)}`);
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
  const unverified = list(dx.unverified_observations);
  if (unverified.length) {
    out("<details><summary>Unverified observations (not part of the fix)</summary>");
    out();
    for (const o of unverified) out(`- ${text(o)}`);
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
  for (const c of list(fix.caveats)) out(`- ⚠️ ${text(c)}`);
  out();
}
if (kind === "issue" && typeof validation === "string" && /rejected|not well-formed|invalid JSON|not allowed/.test(validation)) {
  out("### Why there is no PR");
  out("A fix was attempted but failed validation:");
  out("```");
  // File names and parser messages in here come from the patch, so keep them from closing the fence.
  out(text(validation.trim().slice(0, 3000)).replace(/`/g, "'"));
  out("```");
  out();
}

if (typeof triage?.summary_md === "string") {
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
    const cost = num(r.total_cost_usd) ?? 0;
    total += cost;
    out(`| ${phase} | \`${code(decision?.model)}\` | ${num(r.num_turns) ?? "?"} | $${cost.toFixed(3)} |`);
  }
  out(`| **total** | | | **$${total.toFixed(3)}** |`);
  out();
}

out(
  kind === "pr"
    ? "_This PR was generated automatically from Orchestrator evidence. UiPath Studio validation did not run in CI, so validate in Studio before merging._"
    : "_Opened automatically by the UiPath Jev router. No source change was proposed as a PR._",
);
emit(lines.join("\n") + "\n");
