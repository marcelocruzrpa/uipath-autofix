/**
 * Jev routing eval: run every labeled fixture through the real Jev API and the policy,
 * and compare with the expected action and tier. Use it to tune policy.config.json.
 *
 *   TYPESAFE_API_KEY=... npm run eval -w triage
 *   npm run eval -w triage -- --save eval/answers.json   # store raw answers for offline re-tuning
 *   npm run eval -w triage -- --replay eval/answers.json # re-run policy only, no API calls
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { loadFixtures } from "../src/fixtures.js";
import { askJev, type JevResult, loadConfig } from "../src/jev.js";
import { decide } from "../src/policy.js";
import { buildState } from "../src/state.js";

const { values } = parseArgs({ options: { save: { type: "string" }, replay: { type: "string" }, config: { type: "string" } } });
const cfg = loadConfig(values.config);
// Compiled to dist/eval/run.js; fixtures stay at triage/fixtures.
const fixturesDir = fileURLToPath(new URL("../../fixtures", import.meta.url));
const fixtures = loadFixtures(fixturesDir);
const replay: Record<string, JevResult> = values.replay ? JSON.parse(readFileSync(values.replay, "utf8")) : {};
const saved: Record<string, JevResult> = {};

const pct = (n: number) => `${Math.round(n * 100)}`.padStart(3);
let pass = 0;
let tokens = 0;
console.log(`Jev model ${cfg.jevModel}; ${fixtures.length} fixtures${values.replay ? " (replay)" : ""}\n`);
console.log("fixture                              expected            got                 fix% noise% cplx pin%  top category");
console.log("-".repeat(124));

for (const fx of fixtures) {
  const { state, facts } = buildState(fx.evidence, fx.repo, fx.now);
  let jev: JevResult;
  try {
    jev = replay[fx.name] ?? (await askJev(state, cfg));
  } catch (e) {
    console.log(`${fx.name.padEnd(36)} ERROR ${e instanceof Error ? e.message : e}`);
    continue;
  }
  saved[fx.name] = jev;
  tokens += jev.usage.input_tokens ?? 0;
  const d = decide(jev.answers, facts, cfg);
  const exp = `${fx.expected.action}${fx.expected.tier ? `/${fx.expected.tier}` : ""}`;
  const got = `${d.action}${d.action === "skip" ? "" : `/${d.tier}`}`;
  const ok = d.action === fx.expected.action && (!fx.expected.tier || d.tier === fx.expected.tier);
  if (ok) pass++;
  const s = d.signals!;
  console.log(
    `${ok ? "✓" : "✗"} ${fx.name.padEnd(34)} ${exp.padEnd(19)} ${got.padEnd(19)} ${pct(s.needs_code_fix)}  ${pct(s.noise_probability)}  ${s.complexity_score.toFixed(1)}  ${pct(s.location_pinpointed)}  ${s.top_category} (${pct(s.top_category_probability)}%)`,
  );
  if (!ok) console.log(`    action: ${d.action_rule}\n    tier:   ${d.tier_rule}`);
}

console.log(`\n${pass}/${fixtures.length} routed as expected · ${tokens} input tokens ≈ $${((tokens * 0.042) / 1e6).toFixed(5)}`);
if (values.save) {
  writeFileSync(values.save, `${JSON.stringify(saved, null, 2)}\n`);
  console.log(`raw answers saved to ${values.save}`);
}
process.exit(pass === fixtures.length ? 0 : 1);
