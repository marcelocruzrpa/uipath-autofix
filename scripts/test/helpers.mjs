// Shared helpers for the script tests (node --test).
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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

/** The toolkit root as the scripts expect it in TOOLKIT_DIR. */
export const TOOLKIT = posix(ROOT).replace(/\/+$/, "");

// Puts a directory first on PATH for one script run. On Windows the directory arrives as a
// drive path, which a POSIX PATH cannot hold, so cygpath converts it where it exists.
const WITH_PATH = 'd="$1"; shift; command -v cygpath >/dev/null 2>&1 && d="$(cygpath -u "$d")"; PATH="$d:$PATH" exec bash "$@"';

/** Run scripts/<script> with bash. `opts.path` puts a directory first on PATH (for a fake CLI). */
export function bash(script, args = [], opts = {}) {
  const argv = [posix(join(ROOT, "scripts", script)), ...args.map(posix)];
  const r = spawnSync("bash", opts.path ? ["-c", WITH_PATH, "bash", posix(opts.path), ...argv] : argv, {
    cwd: opts.cwd ?? ROOT,
    encoding: "utf8",
    env: { ...process.env, ...opts.env },
  });
  return { code: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

const FAKE_GH = `#!/usr/bin/env bash
# A stand-in for the GitHub CLI. It appends each call to $FAKE_GH_LOG (arguments separated
# by "|") and answers from the environment:
#   FAKE_GH_OPEN    what the open-thread listing prints: "number<TAB>pr|issue<TAB>true|false" lines
#   FAKE_GH_MERGED  what the merged-PR listing prints: one number per line
#   FAKE_GH_PR_CREATE_FAILS=1  makes \`gh pr create\` fail the way a disabled setting does
set -u
{ printf '%s|' "$@"; echo; } >> "$FAKE_GH_LOG"
case "$1 \${2:-}" in
  "api "*)
    if [[ "$*" == *"state=open"* ]]; then [[ -n "\${FAKE_GH_OPEN:-}" ]] && printf '%s\\n' "$FAKE_GH_OPEN"
    elif [[ "$*" == *"state=closed"* ]]; then [[ -n "\${FAKE_GH_MERGED:-}" ]] && printf '%s\\n' "$FAKE_GH_MERGED"
    fi
    exit 0 ;;
  "label create"|"pr comment"|"issue comment"|"issue edit") exit 0 ;;
  "pr create")
    if [[ "\${FAKE_GH_PR_CREATE_FAILS:-}" == "1" ]]; then
      echo "pull request create failed: GitHub Actions is not permitted to create or approve pull requests" >&2
      exit 1
    fi
    echo "https://github.test/acme/invoice-bot/pull/7" ;;
  "issue create") echo "https://github.test/acme/invoice-bot/issues/8" ;;
  *) echo "fake gh: unexpected call: $*" >&2; exit 2 ;;
esac
`;

/** A directory holding a fake \`gh\`, and the log file it writes. Pass \`bin\` as \`opts.path\`. */
export function fakeGh() {
  const bin = tempDir();
  const file = join(bin, "gh");
  writeFileSync(file, FAKE_GH);
  chmodSync(file, 0o755);
  const log = join(tempDir(), "gh.log");
  writeFileSync(log, "");
  return { bin, log, calls: () => readFileSync(log, "utf8").split("\n").filter(Boolean) };
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
