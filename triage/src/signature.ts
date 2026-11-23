import { createHash } from "node:crypto";

/**
 * The stable part of a UiPath fault text. The same fault arrives in two forms:
 * - `uip or jobs get` and `jobs list`: real CRLF line breaks;
 * - the job.faulted webhook: one line, JSON-escaped a second time (a literal backslash-r
 *   backslash-n for each line break, backslash-quote for each quote), and with a different
 *   first and last segment.
 * Both carry the same exception line ("System.NullReferenceException: ...") and the same
 * workflow frames (`at Assign "Normalize Customer Note"`), so those make the signature.
 * A text with neither, such as a plain message, is used whole.
 *
 * MUST stay byte-for-byte identical to worker/src/signature.ts#canonicalInfo.
 */
export function canonicalInfo(info: string): string {
  let text = info;
  if (!text.includes("\n") && /\\r\\n|\\n/.test(text)) {
    try {
      text = JSON.parse(`"${text}"`) as string;
    } catch {
      text = text.replace(/\\r\\n|\\n|\\r/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    }
  }
  const lines = text.split(/\r?\n/);
  const exception = lines.find((l) => /^\s*[A-Za-z_][\w.`]*(Exception|Error)\b[^:]*:/.test(l));
  const frames = lines.filter((l) => /^\s*at [^\s"(][^"(]*"[^"]*"\s*$/.test(l));
  const key = exception === undefined ? frames : [exception, ...frames];
  return key.length ? key.join("\n") : text;
}

/**
 * Normalize a UiPath job `Info` / error message so that repeated occurrences of the
 * same fault produce the same text: the stable part only (canonicalInfo), with volatile
 * tokens (GUIDs, timestamps, numbers, hex) replaced with placeholders.
 *
 * MUST stay byte-for-byte identical to worker/src/signature.ts#normalizeInfo — the
 * Worker computes the dedupe signature and triage recomputes it to count recurrences.
 * The "fault signature" tests in worker/test/index.test.ts enforce parity.
 */
export function normalizeInfo(info: string): string {
  return canonicalInfo(info)
    .toLowerCase()
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<guid>")
    .replace(/\d{4}-\d{2}-\d{2}[t ]\d{2}:\d{2}:\d{2}(\.\d+)?z?/g, "<ts>")
    .replace(/\b0x[0-9a-f]+\b/g, "<hex>")
    .replace(/\d+/g, "<n>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}

/**
 * 12-hex-char fault signature: sha256(processKey + "\n" + normalizedInfo). Triage uses it
 * when a run has no signature from the Worker (a manual replay).
 */
export function faultSignature(processKey: string, info: string): string {
  return createHash("sha256")
    .update(`${processKey}\n${normalizeInfo(info)}`)
    .digest("hex")
    .slice(0, 12);
}
