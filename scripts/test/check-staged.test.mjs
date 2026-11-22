// The staged-change check decides what the write-capable job may push, so every rule has a
// test. The rules read the git index, so the cases drive stage-patch.sh in a real repository:
// a patch can be written so that what git applies differs from what its headers show.
import assert from "node:assert/strict";
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { checkEntry, checkPath, parseRaw } from "../check-staged.mjs";
import { bash, git, hasPython, noBash, ROOT, tempFile, tempRepo, writeFiles } from "./helpers.mjs";

const XAML = (label) =>
  `<Activity x:Class="Main" xmlns="http://schemas.microsoft.com/netfx/2009/xaml/activities" xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"><Sequence DisplayName="${label}" /></Activity>`;
const TOKEN = `sk-ant-api03-${"x".repeat(30)}`;

const BASE = {
  "Main.xaml": `${XAML("old")}\n`,
  "Workflows/Submit Invoice.xaml": `${XAML("old")}\n`,
  "Workflows/Validação.xaml": `${XAML("old")}\n`,
  "a b/c.xaml": `${XAML("old")}\n`,
  "Old.xaml": `${XAML("old")}\n`,
  "project.json": '{"name":"old"}\n',
  "notes.txt": "old\n",
  "legacy.txt": `${TOKEN}\nold\n`,
  ".github/CODEOWNERS": "old\n",
};

/** One-line edit of an existing file. `header` lets a case lie in the `diff --git` line. */
const edit = (path, from, to, header = path) =>
  [`diff --git a/${header} b/${header}`, "index 1111111..2222222 100644", `--- a/${path}`, `+++ b/${path}`, "@@ -1 +1 @@", `-${from}`, `+${to}`, ""].join("\n");
const editXaml = (path, header) => edit(path, XAML("old"), XAML("new"), header);
const add = (path, line, mode = "100644") =>
  [`diff --git a/${path} b/${path}`, `new file mode ${mode}`, "index 0000000..2222222", "--- /dev/null", `+++ b/${path}`, "@@ -0,0 +1 @@", `+${line}`, ""].join("\n");
const del = (path, line) =>
  [`diff --git a/${path} b/${path}`, "deleted file mode 100644", "index 1111111..0000000", `--- a/${path}`, "+++ /dev/null", "@@ -1 +0,0 @@", `-${line}`, ""].join("\n");

const skip = noBash || (hasPython ? false : "python is not available for the XML check");

describe("check-staged rules", () => {
  it("parses git's raw records, including paths with spaces", () => {
    const id = "a".repeat(40);
    const raw = `:100644 100644 ${id} ${id} M\0Main.xaml\0:000000 100644 ${"0".repeat(40)} ${id} A\0Workflows/Submit Invoice.xaml\0`;
    assert.deepEqual(
      parseRaw(raw).map((e) => [e.status, e.oldMode, e.newMode, e.path]),
      [
        ["M", "100644", "100644", "Main.xaml"],
        ["A", "000000", "100644", "Workflows/Submit Invoice.xaml"],
      ],
    );
    assert.deepEqual(parseRaw(""), []);
  });

  it("accepts ordinary project paths, matching extensions case-insensitively", () => {
    for (const p of ["Main.xaml", "Main.XAML", "Workflows/Submit Invoice.xaml", "Workflows/Validação.xaml", "project.json", "Docs/Readme.md", ".objects/abc/.data/selector.json"]) {
      assert.deepEqual(checkPath(p), [], p);
    }
  });

  it("refuses protected paths in any letter case and at any depth", () => {
    for (const p of [
      ".github/workflows/ci.yml",
      ".GitHub/CODEOWNERS.md",
      ".git/config.json",
      "sub/.git/config.json",
      ".local/x.json",
      ".autofix/decision.json",
      ".claude/settings.json",
      "sub/.Claude/settings.json",
      ".cursor/rules.md",
      ".vscode/tasks.json",
      ".devcontainer/devcontainer.json",
      ".mcp.json",
      "CLAUDE.md",
      "docs/AGENTS.md",
      "claude.local.md",
      "GEMINI.md",
      "NuGet.Config",
      "sub/nuget.config",
    ]) {
      assert.deepEqual(checkPath(p), ["protected path"], p);
    }
  });

  it("refuses file types outside the allowlist, traversal and odd characters", () => {
    for (const p of ["run.ps1", "tools/helper.exe", "Makefile", "Main.xaml.sh", ".gitattributes", ".xaml"]) {
      assert.deepEqual(checkPath(p), ["file type not allowed"], p);
    }
    for (const p of ["Workflows/../../outside.xaml", "./Main.xaml", "a//b.xaml"]) assert.deepEqual(checkPath(p), ["path traversal"], p);
    for (const p of ["Workflows\\Main.xaml", "a\nb.xaml", ""]) assert.deepEqual(checkPath(p), ["unexpected characters in the path"], p);
  });

  it("judges statuses and modes", () => {
    const e = (status, oldMode, newMode) => checkEntry({ status, oldMode, newMode, path: "Main.xaml" });
    assert.deepEqual(e("A", "000000", "100644"), []);
    assert.deepEqual(e("M", "100644", "100644"), []);
    assert.deepEqual(e("M", "100755", "100755"), [], "an existing executable keeps its mode");
    assert.deepEqual(e("D", "100644", "000000"), []);
    assert.match(e("A", "000000", "100755")[0], /must not be executable/);
    assert.match(e("A", "000000", "120000")[0], /symlinks are not allowed/);
    assert.match(e("A", "000000", "160000")[0], /submodule entries are not allowed/);
    assert.match(e("M", "100644", "100755")[0], /file mode changes are not allowed/);
    assert.match(e("M", "100644", "120000")[0], /symlinks are not allowed/);
    assert.match(e("D", "120000", "000000")[0], /symlinks are not allowed/);
    assert.match(e("T", "100644", "120000")[0], /only added, modified or deleted/);
  });
});

describe("stage-patch.sh", { skip }, () => {
  const repo = skip ? null : tempRepo(BASE);
  const staged = () => git(repo, ["-c", "core.quotePath=false", "diff", "--cached", "--name-only"]).split("\n").filter(Boolean);
  /** Stage `patch` (string or Buffer) from a clean index and return {code, out}. */
  const stage = (patch, env = {}) => {
    git(repo, ["reset", "-q"]);
    return bash("stage-patch.sh", [tempFile("fix.patch", patch)], { cwd: repo, env });
  };
  const rejected = (patch, pattern, env) => {
    const r = stage(patch, env);
    assert.equal(r.code, 1, r.out);
    if (pattern) assert.match(r.out, pattern);
    assert.deepEqual(staged(), [], "a rejected patch leaves nothing staged");
    return r;
  };
  /** A real `git diff --binary` patch for content that git treats as binary. */
  const binaryPatch = (path, bytes) => {
    git(repo, ["reset", "-q"]);
    writeFileSync(join(repo, path), bytes);
    git(repo, ["add", "-A"]);
    const patch = git(repo, ["diff", "--cached", "--binary", "--no-renames"], { binary: true });
    git(repo, ["reset", "-q", "--hard"]);
    git(repo, ["clean", "-fdq"]);
    return patch;
  };

  it("accepts ordinary workflow edits, including names with spaces", () => {
    const r = stage(editXaml("Main.xaml") + editXaml("Workflows/Submit Invoice.xaml") + edit("project.json", '{"name":"old"}', '{"name":"new"}'));
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /staged ok: 3 file\(s\)/);
    assert.deepEqual(staged().sort(), ["Main.xaml", "Workflows/Submit Invoice.xaml", "project.json"]);
  });

  it("stages in the index only and leaves the worktree alone", () => {
    assert.equal(stage(editXaml("Main.xaml")).code, 0);
    assert.match(git(repo, ["show", ":Main.xaml"]), /DisplayName="new"/);
    assert.match(git(repo, ["diff", "--name-only"]), /Main\.xaml/, "the worktree still holds the base file");
  });

  it("accepts a non-ASCII file name written literally", () => {
    const r = stage(editXaml("Workflows/Validação.xaml"));
    assert.equal(r.code, 0, r.out);
  });

  it("handles a path that itself contains ' b/'", () => {
    const r = stage(editXaml("a b/c.xaml"));
    assert.equal(r.code, 0, r.out);
    assert.deepEqual(staged(), ["a b/c.xaml"]);
  });

  it("accepts a deleted file and a new file, matching the extension case-insensitively", () => {
    const r = stage(del("Old.xaml", XAML("old")) + add("Second.XAML", XAML("new")));
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /staged ok: 2 file\(s\)/);
  });

  it("judges the path git applies, not the one the diff header shows", () => {
    rejected(edit(".github/CODEOWNERS", "old", "new", "Main.xaml"), /\.github\/CODEOWNERS: protected path/);
  });

  it("judges sections that carry no diff header at all", () => {
    const headerless = ["--- /dev/null", "+++ b/tools/run.ps1", "@@ -0,0 +1 @@", "+calc.exe", ""].join("\n");
    rejected(editXaml("Main.xaml") + headerless, /tools\/run\.ps1: file type not allowed/);
  });

  it("rejects a new executable file", () => {
    rejected(add("helper.cs", "class X {}", "100755"), /helper\.cs: new files must not be executable/);
  });

  for (const path of [
    ".github/workflows/ci.yml",
    ".local/x.json",
    ".autofix/decision.json",
    ".claude/settings.json",
    ".mcp.json",
    "CLAUDE.md",
    "docs/AGENTS.md",
    ".vscode/tasks.json",
    ".devcontainer/devcontainer.json",
    "NuGet.Config",
  ]) {
    it(`rejects the protected path ${path}`, () => {
      rejected(add(path, "{}"), /protected path/);
    });
  }

  it("rejects an edit of an existing protected file", () => {
    rejected(edit(".github/CODEOWNERS", "old", "new"), /\.github\/CODEOWNERS: protected path/);
  });

  it("rejects a rename that moves a protected file to an allowed path", () => {
    const patch = ["diff --git a/.github/CODEOWNERS b/docs/owners.md", "similarity index 100%", "rename from .github/CODEOWNERS", "rename to docs/owners.md", ""].join("\n");
    rejected(patch, /\.github\/CODEOWNERS: protected path/);
  });

  it("rejects paths git itself refuses: inside .git and traversal", () => {
    for (const path of [".git/config", "sub/.git/config", "Workflows/../../outside.xaml"]) rejected(add(path, "x"));
  });

  it("rejects file types outside the allowlist", () => {
    for (const path of ["run.ps1", "tools/helper.exe", "Makefile", "Main.xaml.sh"]) {
      rejected(add(path, "x"), /file type not allowed/);
    }
  });

  it("rejects binary content, whatever its extension", () => {
    rejected(binaryPatch("data.json", Buffer.from([0x7b, 0x00, 0x7d])), /data\.json: binary content is not allowed/);
    const utf16 = Buffer.from(`﻿<?xml version="1.0" encoding="utf-16"?><!DOCTYPE a [<!ENTITY x "y">]><a>&x;</a>`, "utf16le");
    rejected(binaryPatch("Evil.xaml", utf16), /Evil\.xaml: binary content is not allowed/);
  });

  it("rejects symlinks, submodule entries and mode changes", () => {
    const symlink = add("link.xaml", "Main.xaml", "120000").trimEnd() + "\n\\ No newline at end of file\n";
    rejected(symlink, /link\.xaml: symlinks are not allowed/);
    rejected(add("vendor.json", `Subproject commit ${"1".repeat(40)}`, "160000"));
    rejected(["diff --git a/Main.xaml b/Main.xaml", "old mode 100644", "new mode 100755", ""].join("\n"), /Main\.xaml: file mode changes are not allowed/);
  });

  it("enforces the size and file-count limits", () => {
    rejected(edit("notes.txt", "old", "new"), /limit 20/, { PATCH_MAX_BYTES: "20" });
    rejected(edit("notes.txt", "old", "new") + edit("project.json", '{"name":"old"}', '{"name":"new"}'), /2 files changed \(limit 1\)/, { PATCH_MAX_FILES: "1" });
  });

  it("rejects an empty patch and input that is not a patch", () => {
    rejected("", /patch is empty/);
    rejected("not a patch\n", /does not apply/);
  });

  it("rejects a patch that does not apply to the checked-out commit", () => {
    rejected(edit("notes.txt", "something else", "new"), /does not apply/);
  });

  it("rejects XML that is not well-formed", () => {
    rejected(edit("Main.xaml", XAML("old"), "<Activity><Sequence></Activity>"), /Main\.xaml: not well-formed XML: mismatched tag/);
  });

  it("rejects an element whose namespace prefix is not declared", () => {
    rejected(edit("Main.xaml", XAML("old"), "<Activity><ui:Click /></Activity>"), /unbound prefix/);
  });

  it("rejects a DTD or entity declaration", () => {
    rejected(edit("Main.xaml", XAML("old"), `<!DOCTYPE a [<!ENTITY x "y">]>${XAML("new")}`), /Main\.xaml: DTD\/entity declarations are not allowed/);
  });

  it("rejects invalid JSON and accepts JSON with a byte order mark", () => {
    rejected(edit("project.json", '{"name":"old"}', "{ not json"), /project\.json: invalid JSON/);
    assert.equal(stage(edit("project.json", '{"name":"old"}', '﻿{"name":"new"}')).code, 0);
  });

  it("rejects added content that looks like a credential, but not one that was already there", () => {
    rejected(edit("notes.txt", "old", `key = ${TOKEN}`), /notes\.txt: added content looks like a credential/);
    const untouched = ["diff --git a/legacy.txt b/legacy.txt", "index 1111111..2222222 100644", "--- a/legacy.txt", "+++ b/legacy.txt", "@@ -1,2 +1,2 @@", ` ${TOKEN}`, "-old", "+new", ""].join("\n");
    const r = stage(untouched);
    assert.equal(r.code, 0, r.out);
  });
});

describe("collect-patch.sh", { skip }, () => {
  const collect = (files) => {
    const repo = tempRepo(BASE);
    appendFileSync(join(repo, ".git", "info", "exclude"), ".local/\n.autofix/\n");
    writeFiles(repo, files);
    const r = bash("collect-patch.sh", [], { cwd: repo, env: { TOOLKIT_DIR: ROOT.replace(/[\\/]+$/, "").replace(/\\/g, "/"), GITHUB_OUTPUT: "" } });
    return { ...r, repo };
  };

  it("captures the edits as a patch and reports the staged check's verdict", () => {
    const r = collect({ "Main.xaml": `${XAML("new")}\n`, ".autofix/diagnose.json": "{}" });
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /has_patch=true/);
    assert.match(r.out, /validation=ok/);
    assert.deepEqual(git(r.repo, ["diff", "--cached", "--name-only"]), "", "the index is reset afterwards");
    // The patch it wrote is one publish can stage.
    git(r.repo, ["checkout", "-q", "--", "."]);
    assert.equal(bash("stage-patch.sh", [join(r.repo, ".autofix", "fix.patch")], { cwd: r.repo }).code, 0);
  });

  it("flags a change outside the allowlist and reports no patch when nothing changed", () => {
    const bad = collect({ "tools/run.ps1": "calc.exe\n" });
    assert.match(bad.out, /tools\/run\.ps1: file type not allowed/);
    assert.match(bad.out, /validation=failed/);
    const none = collect({});
    assert.match(none.out, /has_patch=false/);
    assert.match(none.out, /validation=none/);
  });
});
