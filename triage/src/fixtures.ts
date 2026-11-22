import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { type Evidence, evidenceFromRaw, type RepoFacts } from "./evidence.js";
import type { Action, Tier } from "./policy.js";

export interface Fixture {
  name: string;
  description: string;
  expected: { action: Action; tier?: Tier };
  now: Date;
  repo: RepoFacts;
  evidence: Evidence;
}

interface FixtureFile {
  description: string;
  expected: { action: Action; tier?: Tier };
  now: string;
  repo: RepoFacts;
  raw: Parameters<typeof evidenceFromRaw>[0];
}

export function loadFixtures(dir: string): Fixture[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => {
      const file = JSON.parse(readFileSync(join(dir, f), "utf8")) as FixtureFile;
      return {
        name: f.replace(/\.json$/, ""),
        description: file.description,
        expected: file.expected,
        now: new Date(file.now),
        repo: file.repo,
        evidence: evidenceFromRaw(file.raw),
      };
    });
}
