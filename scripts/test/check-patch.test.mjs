// The patch guard decides what the write-capable job may push, so every rule has a test.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { bash, noBash, tempFile } from "./helpers.mjs";

/** One file's worth of `git diff --no-renames` output. `extra` lines go after the header. */
const fileDiff = (path, extra = []) =>
  [`diff --git a/${path} b/${path}`, ...extra, "index 1111111..2222222 100644", `--- a/${path}`, `+++ b/${path}`, "@@ -1 +1 @@", "-old", "+new", ""].join("\n");

const check = (patch, env = {}) => bash("check-patch.sh", [tempFile("fix.patch", patch)], { env });

describe("check-patch.sh", { skip: noBash }, () => {
  it("accepts ordinary workflow edits, including names with spaces", () => {
    const r = check(fileDiff("Main.xaml") + fileDiff("Workflows/Submit Invoice.xaml") + fileDiff("project.json"));
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /patch ok: 3 file\(s\)/);
  });

  it("accepts a non-ASCII file name written literally", () => {
    const r = check(fileDiff("Workflows/Validação.xaml"));
    assert.equal(r.code, 0, r.out);
  });

  it("splits the header correctly when the path itself contains ' b/'", () => {
    const r = check(fileDiff("a b/c.xaml"));
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /patch ok: 1 file\(s\)/);
  });

  it("accepts a deleted allowed file", () => {
    const patch = ["diff --git a/Old.xaml b/Old.xaml", "deleted file mode 100644", "index 1111111..0000000", "--- a/Old.xaml", "+++ /dev/null", "@@ -1 +0,0 @@", "-old", ""].join("\n");
    assert.equal(check(patch).code, 0);
  });

  for (const path of [".github/workflows/ci.yml", ".github/CODEOWNERS", ".git/config", ".local/x.json", ".autofix/decision.json", "sub/.git/config"]) {
    it(`rejects the protected path ${path}`, () => {
      const r = check(fileDiff(path));
      assert.equal(r.code, 1);
      assert.match(r.out, /protected path/);
    });
  }

  it("rejects a rename that moves a protected file to an allowed path", () => {
    const patch = ["diff --git a/.github/CODEOWNERS b/docs/owners.md", "similarity index 100%", "rename from .github/CODEOWNERS", "rename to docs/owners.md", ""].join("\n");
    const r = check(patch);
    assert.equal(r.code, 1);
    assert.match(r.out, /renames and copies are not allowed/);
    assert.match(r.out, /old and new paths differ/);
  });

  it("rejects a header whose two paths differ even without rename lines", () => {
    const patch = fileDiff("Main.xaml").replace("b/Main.xaml", "b/Other.xaml");
    const r = check(patch);
    assert.equal(r.code, 1);
    assert.match(r.out, /old and new paths differ/);
  });

  it("rejects a quoted (escaped) path instead of guessing at it", () => {
    const patch = fileDiff("x.xaml").replace("diff --git a/x.xaml b/x.xaml", 'diff --git "a/Valida\\303\\247\\303\\243o.xaml" "b/Valida\\303\\247\\303\\243o.xaml"');
    const r = check(patch);
    assert.equal(r.code, 1);
    assert.match(r.out, /quoted path is not supported/);
  });

  it("rejects file types outside the allowlist", () => {
    for (const path of ["run.ps1", "tools/helper.exe", "Makefile", "Main.xaml.sh"]) {
      const r = check(fileDiff(path));
      assert.equal(r.code, 1, path);
      assert.match(r.out, /file type not allowed/);
    }
  });

  it("matches the extension allowlist case-insensitively", () => {
    assert.equal(check(fileDiff("Main.XAML")).code, 0);
  });

  it("rejects path traversal", () => {
    const r = check(fileDiff("Workflows/../../outside.xaml"));
    assert.equal(r.code, 1);
    assert.match(r.out, /path traversal/);
  });

  it("rejects binary changes, symlinks and mode changes", () => {
    const binary = check(["diff --git a/data.json b/data.json", "index 1111111..2222222 100644", "GIT binary patch", "literal 4", "", ""].join("\n"));
    assert.match(binary.out, /binary changes are not allowed/);
    const symlink = check(fileDiff("link.xaml", ["new file mode 120000"]));
    assert.match(symlink.out, /symlinks are not allowed/);
    const mode = check(fileDiff("Main.xaml", ["old mode 100644", "new mode 100755"]));
    assert.match(mode.out, /file mode changes are not allowed/);
    for (const r of [binary, symlink, mode]) assert.equal(r.code, 1);
  });

  it("enforces the size and file-count limits", () => {
    const big = check(fileDiff("Main.xaml"), { PATCH_MAX_BYTES: "20" });
    assert.equal(big.code, 1);
    assert.match(big.out, /limit 20/);
    const many = check(fileDiff("A.xaml") + fileDiff("B.xaml"), { PATCH_MAX_FILES: "1" });
    assert.equal(many.code, 1);
    assert.match(many.out, /2 files changed \(limit 1\)/);
  });

  it("rejects an empty patch and a patch with no file headers", () => {
    const empty = check("");
    assert.equal(empty.code, 1);
    assert.match(empty.out, /patch is empty/);
    const junk = check("not a patch\n");
    assert.equal(junk.code, 1);
    assert.match(junk.out, /no file headers found/);
  });
});
