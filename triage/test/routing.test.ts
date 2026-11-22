/**
 * Routing regression test: every labeled fixture must route as labeled, using Jev's answers
 * recorded from the live API in eval/answers.json. No API call is made here.
 *
 * - A policy or threshold change that reroutes a fixture fails this test.
 * - A question, state or model change makes the recording stale, which also fails it: such a
 *   change has to be measured with a new live run (`npm run eval -w triage -- --save
 *   eval/answers.json`), not assumed.
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadFixtures } from "../src/fixtures.js";
import { loadConfig } from "../src/jev.js";
import { decide } from "../src/policy.js";
import { loadRecorded, recordedFor } from "../src/recorded.js";
import { buildState } from "../src/state.js";

const answersPath = fileURLToPath(new URL("../eval/answers.json", import.meta.url));
const fixtures = loadFixtures(fileURLToPath(new URL("../fixtures", import.meta.url)));
const cfg = loadConfig();

describe("fixture routing on recorded Jev answers", () => {
  if (!existsSync(answersPath)) {
    it.skip("no recorded answers yet: run the live eval once with --save eval/answers.json", () => {});
    return;
  }
  const recorded = loadRecorded(answersPath);

  it.each(fixtures.map((fx) => [fx.name, fx] as const))("%s routes as labeled", (_name, fx) => {
    const { state, facts } = buildState(fx.evidence, fx.repo, fx.now);
    const jev = recordedFor(recorded, fx.name, state, cfg);
    const d = decide(jev.answers, facts, cfg);
    const got = { action: d.action, ...(fx.expected.tier ? { tier: d.tier } : {}) };
    expect(got, `${d.reason}\naction: ${d.action_rule}\ntier: ${d.tier_rule}`).toEqual(fx.expected);
  });

  it("holds no answer for a fixture that no longer exists", () => {
    expect(Object.keys(recorded.fixtures).sort()).toEqual(fixtures.map((f) => f.name).sort());
  });
});
