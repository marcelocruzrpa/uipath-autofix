import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/jev.js";
import { decide, fallbackDecision, type JevAnswers } from "../src/policy.js";

const cfg = loadConfig();

/** Build synthetic Jev answers. probabilities must sum to ~1 like the real API. */
function answers(o: {
  fix: number;
  category?: Record<string, number>;
  complexity?: [number, number, number, number];
  complexityConfidence?: number;
  pinpointed?: number;
}): JevAnswers {
  const category = o.category ?? { automation_logic: 0.8, ui_selector_drift: 0.1, input_data: 0.025, transient: 0.025, infrastructure: 0.025, external_system: 0.025 };
  const cx = o.complexity ?? [0.6, 0.3, 0.07, 0.03];
  const choice = Object.entries(category).sort((a, b) => b[1] - a[1])[0]![0];
  return {
    fault_category: { choice, confidence: 0.7, probabilities: category },
    needs_code_fix: { noul: o.fix },
    fix_complexity: {
      score: cx.reduce((s, p, i) => s + p * i, 0),
      confidence: o.complexityConfidence ?? 0.6,
      probabilities: { 0: cx[0], 1: cx[1], 2: cx[2], 3: cx[3] },
    },
    location_pinpointed: { noul: o.pinpointed ?? 0.9 },
  };
}

const noRecurrence = { same_error_runs_last_24h: 0 };
const noisy = { automation_logic: 0.05, ui_selector_drift: 0.05, input_data: 0.05, transient: 0.1, infrastructure: 0.7, external_system: 0.05 };

describe("action", () => {
  it("skips when Jev is confident no code change is needed", () => {
    const d = decide(answers({ fix: 0.1, category: noisy }), noRecurrence, cfg);
    expect(d.action).toBe("skip");
  });

  it("escalates recurring noise to investigate instead of skipping", () => {
    const d = decide(answers({ fix: 0.1, category: noisy }), { same_error_runs_last_24h: 3 }, cfg);
    expect(d.action).toBe("investigate");
    expect(d.action_rule).toMatch(/recurred 3×/);
  });

  it("fixes when needs_code_fix is high and category is not noise", () => {
    expect(decide(answers({ fix: 0.85 }), noRecurrence, cfg).action).toBe("fix");
  });

  it("treats the threshold as inclusive for fix", () => {
    expect(decide(answers({ fix: 0.7 }), noRecurrence, cfg).action).toBe("fix");
  });

  it("investigates in the uncertain band", () => {
    expect(decide(answers({ fix: 0.5 }), noRecurrence, cfg).action).toBe("investigate");
    expect(decide(answers({ fix: 0.3 }), noRecurrence, cfg).action).toBe("investigate");
  });

  it("investigates when needs_code_fix is high but the category is mostly noise", () => {
    const d = decide(answers({ fix: 0.8, category: noisy }), noRecurrence, cfg);
    expect(d.action).toBe("investigate");
    expect(d.action_rule).toMatch(/noise/);
  });
});

describe("repository guard", () => {
  const fix = answers({ fix: 0.9 });

  it("does not fix when the checkout holds no UiPath project", () => {
    const d = decide(fix, { ...noRecurrence, project_found: false }, cfg);
    expect(d.action).toBe("investigate");
    expect(d.action_rule).toMatch(/no UiPath project/);
  });

  it("does not fix when the workflow the error names is not in this repository", () => {
    const d = decide(fix, { ...noRecurrence, project_found: true, workflow_missing_from_repo: true }, cfg);
    expect(d.action).toBe("investigate");
    expect(d.action_rule).toMatch(/not in this repository/);
  });

  it("leaves the decision alone when the source is here, or when it was not a fix anyway", () => {
    expect(decide(fix, { ...noRecurrence, project_found: true, workflow_missing_from_repo: false }, cfg).action).toBe("fix");
    expect(decide(answers({ fix: 0.1, category: noisy }), { ...noRecurrence, project_found: false }, cfg).action).toBe("skip");
  });

  it("yields to a forced action", () => {
    expect(decide(fix, { ...noRecurrence, project_found: false }, cfg, { action: "fix" }).action).toBe("fix");
  });
});

describe("model tier", () => {
  it("uses sonnet for a small, well-localized change", () => {
    const d = decide(answers({ fix: 0.9 }), noRecurrence, cfg);
    expect(d.tier).toBe("sonnet");
    expect(d.model).toBe(cfg.models.sonnet.id);
    expect(d.max_turns).toBe(cfg.models.sonnet.maxTurns);
  });

  it("uses opus when most complexity mass is at level 2 or higher", () => {
    const d = decide(answers({ fix: 0.9, complexity: [0.05, 0.25, 0.5, 0.2] }), noRecurrence, cfg);
    expect(d.tier).toBe("opus");
    expect(d.tier_rule).toMatch(/P\(complexity ≥ 2\)/);
  });

  it("uses opus when the failing step is not pinpointed", () => {
    expect(decide(answers({ fix: 0.9, pinpointed: 0.2 }), noRecurrence, cfg).tier).toBe("opus");
  });

  it("uses opus when the complexity judgment is diffuse", () => {
    expect(decide(answers({ fix: 0.9, complexityConfidence: 0.1 }), noRecurrence, cfg).tier).toBe("opus");
  });
});

describe("overrides and fallback", () => {
  it("applies force overrides and flags them", () => {
    const d = decide(answers({ fix: 0.1, category: noisy }), noRecurrence, cfg, { action: "fix", tier: "opus" });
    expect(d).toMatchObject({ action: "fix", tier: "opus", overridden: true, model: cfg.models.opus.id });
    expect(d.reason).toMatch(/overridden/);
  });

  it("does not flag an override that matches the decision", () => {
    expect(decide(answers({ fix: 0.9 }), noRecurrence, cfg, { tier: "sonnet" }).overridden).toBe(false);
  });

  it("falls back to cheap diagnosis when Jev fails", () => {
    const d = fallbackDecision(cfg, "APIConnectionError: timeout");
    expect(d).toMatchObject({ action: "investigate", tier: "sonnet", fallback: true, signals: null });
    expect(d.reason).toMatch(/Jev unavailable/);
  });
});
