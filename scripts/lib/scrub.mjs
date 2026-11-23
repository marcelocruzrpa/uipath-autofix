// Scrubbing shared by everything that leaves the runner as GitHub text: PR and issue
// bodies, comments, titles, commit subjects and the run summary. The patch guard uses the
// same credential patterns on staged content.
//
// Text written by Claude was derived from robot logs, so it is untrusted. Values read from
// the claude job's artifacts are untrusted too, whatever their expected type.

export const ZWSP = "​";

/**
 * Untrusted text shown as Markdown. A zero-width space after "<", between "!" and "[", and
 * after "@" is invisible to a reader, but the text can then no longer form raw HTML (an
 * <img> included), an image or a mention. Images matter most: GitHub fetches them through
 * its proxy as soon as someone opens the thread, which would hand whatever is in the URL to
 * that host. The insertion does not depend on Markdown context, so it holds inside and
 * outside code.
 */
export const text = (s) =>
  String(s ?? "")
    .replace(/</g, `<${ZWSP}`)
    .replace(/!\[/g, `!${ZWSP}[`)
    .replace(/@(?=[A-Za-z0-9-])/g, `@${ZWSP}`);

/** For a value wrapped in a `code span`: one line, and unable to close the span. */
export const code = (s) => text(s).replace(/`/g, "'").replace(/\s+/g, " ").trim() || "?";

const CREDENTIALS = [
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "[REDACTED_JWT]"],
  [/\bsk-ant-[A-Za-z0-9_-]{10,}/g, "[REDACTED_ANTHROPIC_KEY]"],
  [/\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, "[REDACTED_GITHUB_TOKEN]"],
  [
    /\b(UIPATH_CLIENT_SECRET|UIPATH_ACCESS_TOKEN|UIPATH_REFRESH_TOKEN|TYPESAFE_API_KEY|ANTHROPIC_API_KEY)\s*[=:]\s*\S+/g,
    "$1=[REDACTED]",
  ],
];

/**
 * Defense in depth: the text is published (possibly to a public repo) and part of it was
 * written by a model that read untrusted robot logs. Strip anything that looks like a
 * credential before it leaves the runner.
 */
export function redact(s) {
  let out = String(s ?? "");
  for (const [pattern, replacement] of CREDENTIALS) out = out.replace(pattern, replacement);
  return out;
}

/** True when the text contains something `redact` would replace. */
export const hasCredential = (s) => redact(s) !== String(s ?? "");

/**
 * One plain-text line for a PR or issue title and a commit subject. Titles are not
 * Markdown, but GitHub still links "@name" and "#123" in them, and a closing keyword next
 * to "#123" in a commit message closes that issue on merge.
 */
export function titleLine(s, max = 72) {
  const first = String(s ?? "").split(/\r?\n/)[0] ?? "";
  const line = redact(first)
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    // Titles are plain text: a code span shows as literal backticks, and a cut one dangles.
    .replace(/`/g, "")
    .replace(/@(?=[A-Za-z0-9-])/g, `@${ZWSP}`)
    .replace(/#(?=\d)/g, `#${ZWSP}`)
    .replace(/\s+/g, " ")
    .trim();
  if (line.length <= max) return line;
  // Cut at a word boundary and mark the cut, rather than ending mid-word.
  const room = line.slice(0, max - 1);
  const space = room.lastIndexOf(" ");
  return `${(space > max / 2 ? room.slice(0, space) : room).replace(/[\s,;:.(-]+$/, "")}…`;
}

/**
 * A URL that is safe inside a Markdown link, or null: https only, no whitespace, quotes or
 * angle brackets, and balanced parentheses (Orchestrator's own deep links contain a pair),
 * so it cannot end the link early. Mirrors safeUrl in triage/src/summary.ts.
 */
export function safeUrl(url) {
  if (typeof url !== "string" || !/^https:\/\/[^\s<>"'`\\]{1,500}$/.test(url)) return null;
  let depth = 0;
  for (const c of url) {
    if (c === "(") depth++;
    else if (c === ")" && --depth < 0) return null;
  }
  return depth === 0 ? url : null;
}

/** A finite number, or null: artifact fields are not trusted to have the expected type. */
export const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** A plain object, or null. */
export const obj = (v) => (v !== null && typeof v === "object" && !Array.isArray(v) ? v : null);

/** An array without null entries, or an empty array. */
export const list = (v) => (Array.isArray(v) ? v.filter((x) => x !== null && x !== undefined) : []);
