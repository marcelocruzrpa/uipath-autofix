// Shared helpers for the script tests (node --test).
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
