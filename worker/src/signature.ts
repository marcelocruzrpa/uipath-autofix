/**
 * Webhook HMAC verification + fault signature. Web-standard APIs only (crypto.subtle),
 * so this runs unchanged on Workers and under vitest/Node.
 */

const enc = new TextEncoder();

async function hmacSha256(secret: string, body: ArrayBuffer | Uint8Array): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, body));
}

function hexToBytes(hex: string): Uint8Array | null {
  if (!/^[0-9a-f]{64}$/i.test(hex)) return null;
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function base64ToBytes(b64: string): Uint8Array | null {
  try {
    const bin = atob(b64.replace(/-/g, "+").replace(/_/g, "/"));
    if (bin.length !== 32) return null;
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

/** How a signature header is encoded, without its value: for the setup log. */
export function describeSignature(header: string | null): string {
  if (!header) return "missing";
  const trimmed = header.trim();
  const value = trimmed.replace(/^sha256=/i, "");
  const encoding = /^[0-9a-f]{64}$/i.test(value) ? "hex" : base64ToBytes(value) ? "base64" : "unrecognised";
  return `${value === trimmed ? "" : "sha256= prefix, "}${encoding}, ${value.length} chars`;
}

/**
 * Verify `X-UiPath-Signature` = HMAC-SHA256(secret, raw body).
 * Accepts hex or base64, with or without a `sha256=` prefix — the encoding is confirmed
 * from the first real delivery (LOG_PAYLOAD_SHAPE) and both forms are equally strong.
 */
export async function verifySignature(secret: string, rawBody: ArrayBuffer, header: string | null): Promise<boolean> {
  if (!secret || !header) return false;
  const value = header.trim().replace(/^sha256=/i, "");
  const provided = hexToBytes(value) ?? base64ToBytes(value);
  if (!provided) return false;
  return timingSafeEqual(await hmacSha256(secret, rawBody), provided);
}

/** Exposed for tests and for signing local test deliveries. */
export async function sign(secret: string, body: string, encoding: "hex" | "base64" = "hex"): Promise<string> {
  const mac = await hmacSha256(secret, enc.encode(body));
  return encoding === "hex" ? [...mac].map((b) => b.toString(16).padStart(2, "0")).join("") : btoa(String.fromCharCode(...mac));
}

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
 * MUST stay byte-for-byte identical to triage/src/signature.ts#canonicalInfo.
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
 * MUST stay byte-for-byte identical to triage/src/signature.ts#normalizeInfo
 * (triage counts recurrences with it). The "fault signature" tests in
 * worker/test/index.test.ts enforce parity.
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

/** 12-hex-char fault signature: sha256(processKey + "\n" + normalizedInfo). */
export async function faultSignature(processKey: string, info: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(`${processKey}\n${normalizeInfo(info)}`)));
  return [...digest].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 12);
}
