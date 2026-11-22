// `publish` takes only known files from the claude job's artifact, and keeps the triage
// decision only when it is the copy the triage job wrote.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { bash, noBash, tempDir, writeFiles } from "./helpers.mjs";

const TRUSTED = '{"decision":{"reason":"needs_code_fix 0.91 → fix · sonnet"}}\n';
const sha256 = (s) => createHash("sha256").update(s).digest("hex");

function accept({ hash, trusted = TRUSTED }) {
  const incoming = tempDir();
  const out = tempDir();
  writeFiles(incoming, {
    "diagnose.json": "{}",
    "diagnose-run.json": "{}",
    "fix.json": "{}",
    "fix-run.json": "{}",
    "fix.patch": "patch",
    "decision.json": '{"decision":{"reason":"![x](https://evil.test)"}}',
    "validation.txt": "patch ok",
    "evil.sh": "#!/bin/sh",
    "nested/diagnose.json": "{}",
  });
  if (trusted !== null) writeFiles(out, { "decision.json": trusted });
  const r = bash("accept-artifacts.sh", [incoming, out], { env: { DECISION_SHA256: hash } });
  return { code: r.code, log: r.out, dir: out, files: readdirSync(out).sort() };
}

describe("accept-artifacts.sh", { skip: noBash }, () => {
  it("copies only the files publish knows how to judge and keeps the verified decision", () => {
    const r = accept({ hash: sha256(TRUSTED) });
    assert.equal(r.code, 0, r.log);
    assert.deepEqual(r.files, ["decision.json", "diagnose-run.json", "diagnose.json", "fix-run.json", "fix.json", "fix.patch"]);
    assert.equal(readFileSync(join(r.dir, "decision.json"), "utf8"), TRUSTED, "the claude job's copy did not replace it");
    assert.match(r.log, /decision\.json verified/);
  });

  it("drops a decision that does not match the triage job's hash", () => {
    const r = accept({ hash: sha256("something else") });
    assert.equal(r.code, 0, r.log);
    assert.ok(!existsSync(join(r.dir, "decision.json")));
    assert.match(r.log, /::warning::decision\.json does not match/);
  });

  it("drops the decision when the triage job reported no hash", () => {
    const r = accept({ hash: "" });
    assert.ok(!existsSync(join(r.dir, "decision.json")));
  });

  it("works when there is no decision at all", () => {
    const r = accept({ hash: "", trusted: null });
    assert.equal(r.code, 0, r.log);
    assert.deepEqual(r.files, ["diagnose-run.json", "diagnose.json", "fix-run.json", "fix.json", "fix.patch"]);
  });
});
