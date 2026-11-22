import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { APIConnectionError, APIError, TypeSafeClient } from "@typesafe-ai/sdk";
import type { JevAnswers, PolicyConfig } from "./policy.js";
import { questions } from "./questions.js";
import type { JevState } from "./state.js";

export interface JevResult {
  model: string;
  answers: JevAnswers;
  usage: { input_tokens: number | null; output_tokens: number | null };
}

/** The exact request body sent to POST /v1/systemone (printed by --dry-run). */
export function buildRequest(state: JevState, cfg: PolicyConfig) {
  return { model: cfg.jevModel, state, questions };
}

export async function askJev(state: JevState, cfg: PolicyConfig, client = new TypeSafeClient()): Promise<JevResult> {
  // The SDK reads TYPESAFE_API_KEY, retries 429/5xx with backoff and honours retry-after.
  // No casts: the SDK types the answers from `questions`, so the compiler checks that they
  // still have the shape the policy reads (JevAnswers) when the SDK or a question changes.
  const res = await client.systemOne({ model: cfg.jevModel, state, questions }, { timeout: 60_000 });
  return { model: res.model, answers: res.answers, usage: res.usage };
}

/**
 * Whether a failed Jev call is an outage worth falling back from: no connection, a timeout,
 * a rate limit or a server error, each after the SDK's own retries. Everything else is a
 * mistake on our side (a missing or rejected key, an unknown model, a malformed request,
 * an answer the policy cannot read). Falling back on those would quietly turn every fault
 * into a Claude run while Jev is never asked, so the caller fails the step instead.
 */
export function isJevOutage(e: unknown): boolean {
  if (e instanceof APIConnectionError) return true; // includes APITimeoutError
  return e instanceof APIError && (e.status === 408 || e.status === 429 || e.status >= 500);
}

/** policy.config.json lives at triage/ root; resolve it from src/ (tests) or dist/src/ (built). */
export function loadConfig(path?: string): PolicyConfig {
  const candidates = [
    path,
    process.env.JEV_POLICY_CONFIG,
    fileURLToPath(new URL("../policy.config.json", import.meta.url)),
    fileURLToPath(new URL("../../policy.config.json", import.meta.url)),
  ].filter((p): p is string => !!p);
  const found = candidates.find((p) => existsSync(p));
  if (!found) throw new Error(`policy.config.json not found (tried: ${candidates.join(", ")})`);
  return JSON.parse(readFileSync(found, "utf8")) as PolicyConfig;
}
