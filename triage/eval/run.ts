/**
 * Jev routing eval: run every labeled fixture through Jev and the policy, and compare with
 * the expected action and tier. Use it to tune policy.config.json.
 *
 *   TYPESAFE_API_KEY=... npm run eval -w triage                 # live, nothing stored
 *   npm run eval -w triage -- --save eval/answers.json          # live, and record the answers
 *   npm run eval -w triage -- --replay eval/answers.json        # recorded answers only, no API calls
 *   ... --detail                                                # also print each rule that fired
 *
 * --replay is strict: a fixture with no recorded answer, or one recorded for a different
 * request, is an error rather than a silent API call (see src/recorded.ts).
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { loadFixtures } from "../src/fixtures.js";
import { askJev, type JevResult, loadConfig } from "../src/jev.js";
import { decide } from "../src/policy.js";
import { loadRecorded, type RecordedAnswers, recordedFor, requestHash } from "../src/recorded.js";
import { buildState } from "../src/state.js";

const { values } = parseArgs({
  options: { save: { type: "string" }, replay: { type: "string" }, config: { type: "string" }, detail: { type: "boolean", default: false } },
});
const cfg = loadConfig(values.config);
// Compiled to dist/eval/run.js; fixtures stay at triage/fixtures.
const fixturesDir = fileURLToPath(new URL("../../fixtures", import.meta.url));
const fixtures = loadFixtures(fixturesDir);
let recorded: RecordedAnswers | null = null;
if (values.replay) {
  try {
    recorded = loadRecorded(values.replay);
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    process.exit(2);
  }
}
const saved: RecordedAnswers = { recorded_at: new Date().toISOString(), fixtures: {} };

const pct = (n: number) => `${Math.round(n * 100)}`.padStart(3);
let pass = 0;
let failed = 0;
let tokens = 0;
console.log(`Jev model ${cfg.jevModel}; ${fixtures.length} fixtures${recorded ? ` (replay of ${recorded.recorded_at})` : ""}\n`);
console.log("fixture                              expected            got                 fix% noise% cplx pin%  top category");
console.log("-".repeat(124));

for (const fx of fixtures) {
  const { state, facts } = buildState(fx.evidence, fx.repo, fx.now);
  let jev: JevResult;
  try {
    jev = recorded ? recordedFor(recorded, fx.name, state, cfg) : await askJev(state, cfg);
  } catch (e) {
    failed++;
    console.log(`✗ ${fx.name.padEnd(34)} ERROR ${e instanceof Error ? e.message : e}`);
    continue;
  }
  saved.fixtures[fx.name] = { request_sha256: requestHash(state, cfg), result: jev };
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
  if (!ok || values.detail) console.log(`    action: ${d.action_rule}\n    tier:   ${d.tier_rule}`);
}

console.log(`\n${pass}/${fixtures.length} routed as expected · ${tokens} input tokens ≈ $${((tokens * 0.042) / 1e6).toFixed(5)}`);
if (values.save) {
  if (failed) {
    console.log(`not saving ${values.save}: ${failed} fixture(s) got no answer`);
  } else {
    writeFileSync(values.save, `${JSON.stringify(saved, null, 2)}\n`);
    console.log(`answers recorded in ${values.save}`);
  }
}
process.exit(pass === fixtures.length ? 0 : 1);
