#!/usr/bin/env node
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { loadEvidence, scanRepo } from "./evidence.js";
import { askJev, buildRequest, type JevResult, loadConfig } from "./jev.js";
import { type Action, type Decision, decide, fallbackDecision, type Overrides, type Tier } from "./policy.js";
import { faultSignature } from "./signature.js";
import { buildState, faultInfo } from "./state.js";
import { renderSummary } from "./summary.js";

const USAGE = `jev-triage --evidence <raw dir> [--project <repo dir>] [--out decision.json]
           [--force-action skip|investigate|fix] [--force-model sonnet|opus] [--config path] [--dry-run]`;

function parseOverrides(action?: string, model?: string): Overrides {
  const o: Overrides = {};
  if (action) {
    if (!["skip", "investigate", "fix"].includes(action)) throw new Error(`invalid --force-action: ${action}`);
    o.action = action as Action;
  }
  if (model) {
    if (!["sonnet", "opus"].includes(model)) throw new Error(`invalid --force-model: ${model}`);
    o.tier = model as Tier;
  }
  return o;
}

/** GitHub Actions output: single-line values only, which is all we emit. */
function writeOutputs(d: Decision, signature: string) {
  const file = process.env.GITHUB_OUTPUT;
  if (!file) return;
  const kv: Record<string, string | number> = {
    action: d.action,
    tier: d.tier,
    model: d.model,
    max_turns: d.max_turns,
    budget_usd: d.budget_usd,
    reason: d.reason.replace(/\r?\n/g, " "),
    signature,
  };
  appendFileSync(file, Object.entries(kv).map(([k, v]) => `${k}=${v}\n`).join(""));
}

async function main() {
  const { values } = parseArgs({
    options: {
      evidence: { type: "string" },
      project: { type: "string" },
      out: { type: "string" },
      config: { type: "string" },
      "force-action": { type: "string" },
      "force-model": { type: "string" },
      "dry-run": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help || !values.evidence) {
    console.error(USAGE);
    process.exit(values.help ? 0 : 2);
  }

  const cfg = loadConfig(values.config);
  const overrides = parseOverrides(values["force-action"] || undefined, values["force-model"] || undefined);
  const evidence = loadEvidence(values.evidence);
  const repo = scanRepo(values.project);
  const { state, facts } = buildState(evidence, repo);

  if (values["dry-run"]) {
    process.stdout.write(`${JSON.stringify(buildRequest(state, cfg), null, 2)}\n`);
    return;
  }

  let jev: JevResult | null = null;
  let decision: Decision;
  try {
    jev = await askJev(state, cfg);
    decision = decide(jev.answers, facts, cfg, overrides);
    console.error(`[jev] model=${jev.model} input_tokens=${jev.usage.input_tokens ?? "?"}`);
  } catch (e) {
    const raw = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    console.error(`[jev] call failed, applying fallback policy: ${raw}`);
    // The message lands in the run summary and in PR/issue bodies, and an API error can
    // echo parts of the request, so keep it short and free of Markdown and HTML.
    const msg = raw.replace(/[<>`[\]|@]/g, " ").replace(/\s+/g, " ").trim().slice(0, 300);
    decision = fallbackDecision(cfg, msg, overrides);
  }

  // The Worker sends the fault signature with the webhook. A manual replay has none, so
  // compute the same value here: the thread lookup and the PR/issue marker depend on it.
  const given = evidence.context.signature;
  const signature =
    typeof given === "string" && /^[0-9a-f]{12}$/.test(given) ? given : faultSignature(evidence.context.process_key, faultInfo(evidence));

  const summary = renderSummary({
    processKey: evidence.context.process_key,
    jobKey: evidence.context.job_key,
    decision,
    jev,
    facts,
    orchestratorUrl: evidence.context.orchestrator_url,
  });

  const record = {
    decided_at: new Date().toISOString(),
    context: evidence.context,
    signature,
    decision,
    facts,
    jev,
    summary_md: summary,
  };
  if (values.out) {
    mkdirSync(dirname(values.out), { recursive: true });
    writeFileSync(values.out, `${JSON.stringify(record, null, 2)}\n`);
  }
  writeOutputs(decision, signature);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  console.log(decision.reason);
}

main().catch((e) => {
  console.error(e instanceof Error ? (e.stack ?? e.message) : e);
  process.exit(1);
});
