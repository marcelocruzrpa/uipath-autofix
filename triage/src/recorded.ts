import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { buildRequest, type JevResult } from "./jev.js";
import type { PolicyConfig } from "./policy.js";
import type { JevState } from "./state.js";

/**
 * Jev's answers for the labeled fixtures, recorded once from the live API (eval/run.ts
 * --save) and replayed without any API call (eval/run.ts --replay, test/routing.test.ts).
 *
 * Each answer is stored with a hash of the request it answered. A change to the policy or
 * its thresholds leaves the request alone, so the recording still applies and the replay
 * shows the new routing. A change to the questions, the state or the model changes the
 * request, and the replay then refuses the stale answer instead of pretending it applies:
 * such a change needs a new live run.
 */
export interface RecordedAnswers {
  recorded_at: string;
  fixtures: Record<string, { request_sha256: string; result: JevResult }>;
}

/** Hash of the exact request body `askJev` sends for this state. */
export function requestHash(state: JevState, cfg: PolicyConfig): string {
  return createHash("sha256").update(JSON.stringify(buildRequest(state, cfg))).digest("hex");
}

export function loadRecorded(path: string): RecordedAnswers {
  if (!existsSync(path)) throw new Error(`${path} does not exist: record it once with a live eval (--save ${path})`);
  const rec = JSON.parse(readFileSync(path, "utf8")) as RecordedAnswers;
  if (!rec || typeof rec !== "object" || typeof rec.fixtures !== "object" || rec.fixtures === null) {
    throw new Error(`${path} is not a recorded-answers file (expected { recorded_at, fixtures })`);
  }
  return rec;
}

/** The recorded answer for a fixture; throws when there is none or it answers another request. */
export function recordedFor(rec: RecordedAnswers, fixture: string, state: JevState, cfg: PolicyConfig): JevResult {
  const entry = Object.hasOwn(rec.fixtures, fixture) ? rec.fixtures[fixture] : undefined;
  if (!entry) throw new Error(`no recorded answer for fixture ${fixture}: record it with a live eval (--save)`);
  if (entry.request_sha256 !== requestHash(state, cfg)) {
    throw new Error(`the recorded answer for ${fixture} is stale: the questions, the state or the model changed since it was recorded, so re-run the live eval (--save)`);
  }
  return entry.result;
}
