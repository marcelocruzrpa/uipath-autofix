import type { JevResult } from "./jev.js";
import type { Decision } from "./policy.js";
import { COMPLEXITY_LEVELS } from "./questions.js";
import type { DerivedFacts } from "./state.js";

const pct = (n: number) => `${Math.round(n * 100)}%`;
const bar = (n: number) => "█".repeat(Math.round(n * 10)).padEnd(10, "░");

/** A value that came from robot logs, kept on one line and inside its code span. */
const span = (s: string) => `\`${s.replace(/`/g, "'").replace(/\s+/g, " ").trim().slice(0, 120) || "?"}\``;

/**
 * The job link goes into a Markdown link, so the URL must not be able to end the link
 * early: https only, no whitespace, quotes or angle brackets, and balanced parentheses
 * (Orchestrator's own deep links contain a pair).
 */
export function safeUrl(url: string | undefined | null): string | null {
  if (!url || !/^https:\/\/[^\s<>"'`\\]{1,500}$/.test(url)) return null;
  let depth = 0;
  for (const c of url) {
    if (c === "(") depth++;
    else if (c === ")" && --depth < 0) return null;
  }
  return depth === 0 ? url : null;
}

const ACTION_LABEL: Record<Decision["action"], string> = {
  skip: "⏭️ **skip**: no code change needed",
  investigate: "🔎 **investigate**: diagnosis only (opens an issue)",
  fix: "🛠️ **fix**: diagnose and propose a PR",
};

/** Markdown routing report, written to $GITHUB_STEP_SUMMARY and embedded in PR/issue bodies. */
export function renderSummary(args: {
  processKey: string;
  jobKey: string;
  decision: Decision;
  jev: JevResult | null;
  facts: DerivedFacts;
  orchestratorUrl?: string;
}): string {
  const { decision: d, jev, facts } = args;
  const lines: string[] = [];
  lines.push(`### Jev routing: \`${args.processKey}\``);
  lines.push("");
  lines.push(`${ACTION_LABEL[d.action]}${d.action === "skip" ? "" : `, using **${d.tier}** (\`${d.model}\`, ≤${d.max_turns} turns, ≤$${d.budget_usd})`}`);
  lines.push("");
  const jobUrl = safeUrl(args.orchestratorUrl);
  lines.push(`- Job: ${jobUrl ? `[\`${args.jobKey}\`](${jobUrl})` : `\`${args.jobKey}\``}`);
  lines.push(`- Action rule: ${d.action_rule}`);
  if (d.action !== "skip") lines.push(`- Model rule: ${d.tier_rule}`);
  if (d.overridden) lines.push("- ⚠️ The decision was overridden by a workflow input.");
  if (d.fallback) lines.push("- ⚠️ Jev was unavailable, so the fallback policy applied.");
  lines.push(
    `- History: ${facts.same_error_runs_last_24h} earlier runs with the same error and ${facts.faulted_runs_last_24h} faulted runs in 24h; last success ${facts.last_successful_run_at ?? "unknown"}`,
  );
  if (facts.referenced_workflows.length)
    lines.push(
      // Names come from robot logs: keep each one inside its code span.
      `- Referenced workflows: ${facts.referenced_workflows.map(span).join(", ")}${facts.referenced_workflows_found_in_repo === false ? " (⚠️ not found in this repo)" : ""}`,
    );
  if (facts.failing_activity && facts.workflow_match !== "none") {
    const files = facts.workflow_match_files.map(span).join(", ");
    lines.push(
      facts.workflow_match === "unique"
        ? `- Failing activity: ${span(facts.failing_activity)}, found in ${files}`
        : `- Failing activity: ${span(facts.failing_activity)}, a name used in several workflows (${files})`,
    );
  }
  if (jev) {
    const a = jev.answers;
    lines.push("");
    lines.push("| Jev judgment | Answer | |");
    lines.push("|---|---|---|");
    lines.push(`| Needs a code fix? (Noul) | ${pct(a.needs_code_fix.noul)} | \`${bar(a.needs_code_fix.noul)}\` |`);
    lines.push(`| Failing step pinpointed? (Noul) | ${pct(a.location_pinpointed.noul)} | \`${bar(a.location_pinpointed.noul)}\` |`);
    lines.push(
      `| Fix complexity (Score 0–${COMPLEXITY_LEVELS.length - 1}) | ${a.fix_complexity.score.toFixed(2)} (confidence ${pct(a.fix_complexity.confidence)}) | \`${bar(a.fix_complexity.score / (COMPLEXITY_LEVELS.length - 1))}\` |`,
    );
    lines.push("");
    lines.push("<details><summary>Fault category distribution (Choice)</summary>");
    lines.push("");
    lines.push("| Category | P |");
    lines.push("|---|---|");
    for (const [c, p] of Object.entries(a.fault_category.probabilities).sort((x, y) => y[1] - x[1]))
      lines.push(`| ${c === a.fault_category.choice ? `**${c}**` : c} | ${pct(p)} |`);
    lines.push("");
    lines.push(
      `Model \`${jev.model}\`, ${jev.usage.input_tokens ?? "?"} input tokens (≈$${(((jev.usage.input_tokens ?? 0) * 0.042) / 1e6).toFixed(5)}).`,
    );
    lines.push("</details>");
  }
  lines.push("");
  return lines.join("\n");
}
