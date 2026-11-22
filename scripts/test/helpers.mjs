// Shared helpers for the script tests (node --test).
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = fileURLToPath(new URL("../..", import.meta.url));

/** bash handles forward slashes on every platform, backslashes only on Windows. */
export const posix = (p) => p.replace(/\\/g, "/");

export const tempDir = () => mkdtempSync(join(tmpdir(), "autofix-test-"));

export function tempFile(name, content) {
  const p = join(tempDir(), name);
  writeFileSync(p, content);
  return p;
}

/**
 * The shell scripts need a POSIX bash. On Windows that means Git Bash (MSYSTEM is set
 * there); from cmd or PowerShell `bash` may be WSL, which cannot see these paths.
 */
export const noBash = process.platform === "win32" && !process.env.MSYSTEM ? "needs a POSIX shell: run from Git Bash, or rely on CI" : false;

/** The XML check needs a Python with expat: $PYTHON, python3 or python (as check-staged.mjs resolves it). */
export const hasPython = [process.env.PYTHON, "python3", "python"].some(
  (c) => c && spawnSync(c, ["-c", "import xml.parsers.expat"], { encoding: "utf8" }).status === 0,
);

export function bash(script, args = [], opts = {}) {
  const r = spawnSync("bash", [posix(join(ROOT, "scripts", script)), ...args.map(posix)], {
    cwd: opts.cwd ?? ROOT,
    encoding: "utf8",
    env: { ...process.env, ...opts.env },
  });
  return { code: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

export function node(script, args = [], opts = {}) {
  const r = spawnSync(process.execPath, [join(ROOT, "scripts", script), ...args], {
    cwd: opts.cwd ?? ROOT,
    encoding: "utf8",
    env: { ...process.env, ...opts.env },
  });
  return { code: r.status, out: r.stdout ?? "", err: r.stderr ?? "" };
}

/** Run git in `dir`; throws on failure. `opts.input` feeds stdin; output is returned as a string. */
export function git(dir, args, opts = {}) {
  const r = spawnSync("git", args, { cwd: dir, encoding: opts.binary ? "buffer" : "utf8", input: opts.input, maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout;
}

/** Write `files` ({relative path: content}) under `dir`, creating folders as needed. */
export function writeFiles(dir, files) {
  for (const [name, content] of Object.entries(files)) {
    const p = join(dir, name);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
  }
}

/** A fresh git repository holding `files` in one commit; line endings are left alone. */
export function tempRepo(files) {
  const dir = tempDir();
  git(dir, ["init", "-q"]);
  for (const [k, v] of [["user.name", "test"], ["user.email", "test@example.test"], ["core.autocrlf", "false"], ["commit.gpgsign", "false"]]) {
    git(dir, ["config", k, v]);
  }
  writeFiles(dir, files);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "base"]);
  return dir;
}
