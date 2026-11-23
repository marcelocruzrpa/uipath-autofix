import type { DerivedFacts } from "./state.js";

/**
 * Routing policy: Jev supplies calibrated judgments, this file owns the decision.
 * Pure and deterministic — thresholds live in policy.config.json so they can be tuned
 * (see eval/run.ts) without re-running inference on stored answers.
 */

export type Action = "skip" | "investigate" | "fix";
export type Tier = "sonnet" | "opus";

export interface PolicyConfig {
  jevModel: string;
  thresholds: { skipBelow: number; minNoiseForSkip: number; fixAtOrAbove: number; maxNoiseForFix: number; recurringAtLeast: number };
  noiseCategories: string[];
  escalation: { complexFromLevel: number; pComplexAtLeast: number; pinpointedBelow: number; complexityConfidenceBelow: number };
  models: Record<Tier, { id: string; maxTurns: number; budgetUsd: number }>;
  fallback: { action: Action; tier: Tier };
}

/** The subset of Jev's answers the policy reads (matches the SDK response shapes). */
export interface JevAnswers {
  fault_category: { choice: string; confidence: number; probabilities: Record<string, number> };
  needs_code_fix: { noul: number };
  fix_complexity: { score: number; confidence: number; probabilities: Record<string, number> };
  location_pinpointed: { noul: number };
}

export interface Overrides {
  action?: Action;
  tier?: Tier;
}

/** The facts computed in code that the policy reads. Only the recurrence count is required. */
export type PolicyFacts = Pick<DerivedFacts, "same_error_runs_last_24h"> & Partial<Pick<DerivedFacts, "project_found" | "workflow_missing_from_repo">>;

export interface Signals {
  needs_code_fix: number;
  noise_probability: number;
  top_category: string;
  top_category_probability: number;
  p_complex: number;
  complexity_score: number;
  complexity_confidence: number;
  location_pinpointed: number;
  same_error_runs_last_24h: number;
  recurring: boolean;
}

export interface Decision {
  action: Action;
  tier: Tier;
  model: string;
  max_turns: number;
  budget_usd: number;
  reason: string;
  /** Which rule produced the action / tier, for the summary and for eval debugging. */
  action_rule: string;
  tier_rule: string;
  signals: Signals | null;
  fallback: boolean;
  overridden: boolean;
}

const f2 = (n: number) => n.toFixed(2);

export function computeSignals(a: JevAnswers, facts: Pick<DerivedFacts, "same_error_runs_last_24h">, cfg: PolicyConfig): Signals {
  const probs = a.fault_category.probabilities;
  const noise = cfg.noiseCategories.reduce((sum, c) => sum + (probs[c] ?? 0), 0);
  const pComplex = Object.entries(a.fix_complexity.probabilities)
    .filter(([lvl]) => Number(lvl) >= cfg.escalation.complexFromLevel)
    .reduce((sum, [, p]) => sum + p, 0);
  return {
    needs_code_fix: a.needs_code_fix.noul,
    noise_probability: noise,
    top_category: a.fault_category.choice,
    top_category_probability: probs[a.fault_category.choice] ?? 0,
    p_complex: pComplex,
    complexity_score: a.fix_complexity.score,
    complexity_confidence: a.fix_complexity.confidence,
    location_pinpointed: a.location_pinpointed.noul,
    same_error_runs_last_24h: facts.same_error_runs_last_24h,
    recurring: facts.same_error_runs_last_24h >= cfg.thresholds.recurringAtLeast,
  };
}

export function chooseAction(sig: Signals, cfg: PolicyConfig): { action: Action; rule: string } {
  const t = cfg.thresholds;
  if (sig.needs_code_fix < t.skipBelow) {
    if (sig.recurring) {
      return { action: "investigate", rule: `needs_code_fix < ${t.skipBelow} but same error recurred ${sig.same_error_runs_last_24h}× in 24h` };
    }
    // Skipping means "nothing to fix in the code": Jev should also see a cause outside the
    // automation. A low fix probability with no such cause is uncertainty, not noise.
    if (sig.noise_probability < t.minNoiseForSkip) {
      return {
        action: "investigate",
        rule: `needs_code_fix < ${t.skipBelow} but the category does not point to noise (${f2(sig.noise_probability)} < ${t.minNoiseForSkip})`,
      };
    }
    return { action: "skip", rule: `needs_code_fix < ${t.skipBelow} and noise ≥ ${t.minNoiseForSkip}` };
  }
  if (sig.needs_code_fix >= t.fixAtOrAbove) {
    return sig.noise_probability < t.maxNoiseForFix
      ? { action: "fix", rule: `needs_code_fix ≥ ${t.fixAtOrAbove} and noise < ${t.maxNoiseForFix}` }
      : { action: "investigate", rule: `needs_code_fix ≥ ${t.fixAtOrAbove} but category points to noise (${f2(sig.noise_probability)})` };
  }
  return { action: "investigate", rule: `needs_code_fix in uncertain band [${t.skipBelow}, ${t.fixAtOrAbove})` };
}

/**
 * A fix can only be applied to source that is in this repository. Whether it is there is a
 * lookup, not a judgment, so code decides it: Jev is not asked, and no threshold is involved.
 */
export function repoGuard(chosen: { action: Action; rule: string }, facts: PolicyFacts): { action: Action; rule: string } {
  if (chosen.action !== "fix") return chosen;
  if (facts.project_found === false) {
    return { action: "investigate", rule: `${chosen.rule}, but this repository holds no UiPath project (no project.json), so there is nothing to fix here` };
  }
  if (facts.workflow_missing_from_repo === true) {
    return { action: "investigate", rule: `${chosen.rule}, but the workflow the error names is not in this repository` };
  }
  return chosen;
}

export function chooseTier(sig: Signals, cfg: PolicyConfig): { tier: Tier; rule: string } {
  const e = cfg.escalation;
  const reasons: string[] = [];
  if (sig.p_complex >= e.pComplexAtLeast) reasons.push(`P(complexity ≥ ${e.complexFromLevel}) ${f2(sig.p_complex)} ≥ ${e.pComplexAtLeast}`);
  if (sig.location_pinpointed < e.pinpointedBelow) reasons.push(`location_pinpointed ${f2(sig.location_pinpointed)} < ${e.pinpointedBelow}`);
  if (sig.complexity_confidence < e.complexityConfidenceBelow)
    reasons.push(`complexity confidence ${f2(sig.complexity_confidence)} < ${e.complexityConfidenceBelow}`);
  return reasons.length ? { tier: "opus", rule: reasons.join("; ") } : { tier: "sonnet", rule: "small, well-localized change" };
}

function finalize(
  cfg: PolicyConfig,
  action: Action,
  tier: Tier,
  parts: { action_rule: string; tier_rule: string; signals: Signals | null; fallback: boolean; overrides?: Overrides },
): Decision {
  const finalAction = parts.overrides?.action ?? action;
  const finalTier = parts.overrides?.tier ?? tier;
  const overridden = finalAction !== action || finalTier !== tier;
  const m = cfg.models[finalTier];
  const sig = parts.signals;
  const head = sig
    ? `needs_code_fix ${f2(sig.needs_code_fix)} · ${sig.top_category} ${f2(sig.top_category_probability)} · P(complex) ${f2(sig.p_complex)} · pinpointed ${f2(sig.location_pinpointed)}`
    : "Jev unavailable";
  return {
    action: finalAction,
    tier: finalTier,
    model: m.id,
    max_turns: m.maxTurns,
    budget_usd: m.budgetUsd,
    reason: `${head} → ${finalAction}${finalAction === "skip" ? "" : ` · ${finalTier}`}${overridden ? " (overridden)" : ""}${parts.fallback ? " (fallback)" : ""}`,
    action_rule: parts.action_rule,
    tier_rule: parts.tier_rule,
    signals: sig,
    fallback: parts.fallback,
    overridden,
  };
}

export function decide(answers: JevAnswers, facts: PolicyFacts, cfg: PolicyConfig, overrides: Overrides = {}): Decision {
  const signals = computeSignals(answers, facts, cfg);
  const a = repoGuard(chooseAction(signals, cfg), facts);
  const t = chooseTier(signals, cfg);
  return finalize(cfg, a.action, t.tier, { action_rule: a.rule, tier_rule: t.rule, signals, fallback: false, overrides });
}

/** Jev failed (network, auth, 5xx after retries): fail safe to a cheap diagnosis-only run. */
export function fallbackDecision(cfg: PolicyConfig, error: string, overrides: Overrides = {}): Decision {
  return finalize(cfg, cfg.fallback.action, cfg.fallback.tier, {
    action_rule: `fallback: ${error}`,
    tier_rule: "fallback",
    signals: null,
    fallback: true,
    overrides,
  });
}
