#!/usr/bin/env node
// Judge what is staged in the git index before it is committed and pushed.
//   usage: check-staged.mjs        cwd = the repository; compares the index with HEAD
//   env:   PATCH_MAX_FILES (default 20), PYTHON (interpreter for the XML check)
//   exit 0 = acceptable, 1 = rejected (reasons on stdout)
//
// Claude's input came partly from untrusted robot logs, so anything outside the blast
// radius of an automation fix is refused. The rules read git's own record of the staged
// change and the staged blobs, never patch text: a patch can be written so that the paths
// git applies differ from the ones its headers show. Run by the `claude` job after
// `git add -A` (early feedback) and by `publish` after `git apply --cached` (the verdict
// that counts).
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { hasCredential } from "./lib/scrub.mjs";

export const ALLOWED_EXTENSIONS = ["xaml", "cs", "vb", "json", "md", "txt", "config", "xml", "csv"];

/** Directory names refused at any depth: git and CI internals, and tool configuration. */
export const PROTECTED_DIRS = [".git", ".github", ".local", ".autofix", ".claude", ".cursor", ".vscode", ".devcontainer"];

/**
 * File names refused at any depth although their extension is allowed: once merged they
 * instruct coding agents, start MCP servers or redirect package feeds.
 */
export const PROTECTED_FILES = [".mcp.json", "claude.md", "claude.local.md", "agents.md", "gemini.md", "nuget.config"];

const REGULAR_MODES = new Set(["100644", "100755"]);
const MAX_BLOB_BYTES = 20 * 1024 * 1024;

/** Parse `git diff --raw -z --no-renames --no-abbrev`: ":<old mode> <new mode> <old id> <new id> <status>\0<path>\0". */
export function parseRaw(output) {
  const parts = output.split("\0");
  const entries = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const meta = parts[i];
    const m = /^:(\d{6}) (\d{6}) ([0-9a-f]+) ([0-9a-f]+) ([A-Z])\d*$/.exec(meta);
    if (!m) throw new Error(`unexpected git output: ${JSON.stringify(meta)}`);
    entries.push({ oldMode: m[1], newMode: m[2], oldId: m[3], newId: m[4], status: m[5], path: parts[i + 1] });
  }
  return entries;
}

/** Reasons to refuse a path, whatever was done to it. */
export function checkPath(path) {
  if (!path || /[\u0000-\u001f\u007f\\]/.test(path)) return ["unexpected characters in the path"];
  const segments = path.toLowerCase().split("/");
  if (segments.some((s) => s === "" || s === "." || s === "..")) return ["path traversal"];
  if (segments.some((s) => PROTECTED_DIRS.includes(s))) return ["protected path"];
  const name = segments.at(-1);
  if (PROTECTED_FILES.includes(name)) return ["protected path"];
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || !ALLOWED_EXTENSIONS.includes(name.slice(dot + 1))) return ["file type not allowed"];
  return [];
}

const modeReason = (mode) =>
  mode === "120000" ? "symlinks are not allowed" : mode === "160000" ? "submodule entries are not allowed" : `unexpected file mode ${mode}`;

/** Reasons to refuse one staged change, from its status, modes and path. */
export function checkEntry(e) {
  const reasons = [];
  if (e.status === "A") {
    if (e.newMode === "100755") reasons.push("new files must not be executable");
    else if (e.newMode !== "100644") reasons.push(modeReason(e.newMode));
  } else if (e.status === "M") {
    if (!REGULAR_MODES.has(e.newMode)) reasons.push(modeReason(e.newMode));
    else if (e.oldMode !== e.newMode) reasons.push("file mode changes are not allowed");
  } else if (e.status === "D") {
    if (!REGULAR_MODES.has(e.oldMode)) reasons.push(modeReason(e.oldMode));
  } else {
    reasons.push(`only added, modified or deleted files are allowed (status ${e.status})`);
  }
  return [...reasons, ...checkPath(e.path)];
}

let pythonCommand;
/** The interpreter for the XML check: $PYTHON, else python3, else python. Null when none runs. */
function python() {
  if (pythonCommand !== undefined) return pythonCommand;
  for (const candidate of [process.env.PYTHON, "python3", "python"]) {
    if (!candidate) continue;
    const r = spawnSync(candidate, ["-c", "import xml.parsers.expat"], { encoding: "utf8" });
    if (r.status === 0) return (pythonCommand = candidate);
  }
  return (pythonCommand = null);
}

// Namespace-aware, so an undeclared prefix fails. The handlers refuse a DTD whatever the
// file's encoding declares, which rules out entity-expansion and external-entity tricks.
const XML_CHECK = `
import sys
from xml.parsers import expat

def forbid(*_):
    raise ValueError("DTD/entity declarations are not allowed")

p = expat.ParserCreate(namespace_separator="}")
p.StartDoctypeDeclHandler = forbid
p.EntityDeclHandler = forbid
try:
    p.ParseFile(sys.stdin.buffer)
except Exception as e:
    print(e)
    sys.exit(1)
`;

function checkXml(bytes) {
  const py = python();
  if (!py) return ["cannot check XML: python3 is not available"];
  const r = spawnSync(py, ["-c", XML_CHECK], { input: bytes, encoding: "utf8" });
  if (r.status === 0) return [];
  const detail = (r.stdout || r.stderr || "").trim().split(/\r?\n/)[0] || "parser failed";
  return [/DTD\/entity/.test(detail) ? detail : `not well-formed XML: ${detail}`];
}

/** Reasons to refuse the new content of a file. `oldBytes` is its previous content, if any. */
export function checkContent(path, bytes, oldBytes = null) {
  if (bytes.length > MAX_BLOB_BYTES) return [`file is larger than ${MAX_BLOB_BYTES} bytes`];
  if (bytes.includes(0)) return ["binary content is not allowed"];
  let content;
  try {
    content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return ["content is not UTF-8 text"];
  }
  const reasons = [];
  const ext = path.toLowerCase().slice(path.lastIndexOf(".") + 1);
  if (ext === "json") {
    try {
      JSON.parse(content.replace(/^﻿/, ""));
    } catch (e) {
      reasons.push(`invalid JSON: ${e.message}`);
    }
  } else if (ext === "xaml" || ext === "xml" || ext === "config") {
    // XAML never carries a DTD. The pattern gives a clear message; the parser refuses the same.
    if (/<!\s*(DOCTYPE|ENTITY)/i.test(content)) reasons.push("DTD/entity declarations are not allowed");
    else reasons.push(...checkXml(bytes));
  }
  // The patch is published too, and the body's redaction never sees it. Only lines that
  // are new to the file count, so a token-shaped value that was already there does not
  // block an unrelated fix.
  const before = new Set(oldBytes ? Buffer.from(oldBytes).toString("utf8").split(/\r?\n/) : []);
  if (content.split(/\r?\n/).some((l) => !before.has(l) && hasCredential(l))) reasons.push("added content looks like a credential");
  return reasons;
}

function git(args) {
  const r = spawnSync("git", args, { maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${String(r.stderr ?? r.error ?? "").trim()}`);
  return r.stdout;
}

function main() {
  const maxFiles = Number(process.env.PATCH_MAX_FILES) || 20;
  const entries = parseRaw(git(["diff", "--cached", "--raw", "-z", "--no-renames", "--no-abbrev"]).toString("utf8"));
  const rejections = [];
  if (entries.length === 0) rejections.push("nothing is staged");
  if (entries.length > maxFiles) rejections.push(`${entries.length} files changed (limit ${maxFiles})`);
  for (const e of entries.slice(0, maxFiles)) {
    let reasons = checkEntry(e);
    if (reasons.length === 0 && e.status !== "D") {
      const old = e.status === "M" ? git(["cat-file", "blob", e.oldId]) : null;
      reasons = checkContent(e.path, git(["cat-file", "blob", e.newId]), old);
    }
    for (const reason of reasons) rejections.push(`${e.path}: ${reason}`);
  }
  for (const r of rejections) console.log(`rejected: ${r}`);
  if (rejections.length === 0) console.log(`staged ok: ${entries.length} file(s)`);
  process.exit(rejections.length === 0 ? 0 : 1);
}

const invokedDirectly = (() => {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (invokedDirectly) {
  try {
    main();
  } catch (e) {
    // Fail closed: a check that could not run is a rejection.
    console.log(`rejected: the staged change could not be checked (${e.message})`);
    process.exit(1);
  }
}
