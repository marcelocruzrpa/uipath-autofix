import { choice, noul, score } from "@typesafe-ai/sdk";

/**
 * The four judgments Jev makes for every faulted job, sent in ONE request (speculative
 * fan-out: they run in parallel and cannot see each other's answers; code composes them).
 *
 * Question ids are for code only and are not sent to the model, so every instruction
 * carries its full meaning. Backticked names refer to fields of the state built in state.ts.
 */

export const FAULT_CATEGORIES = {
  automation_logic:
    "A defect in the automation's own workflow logic: an unhandled null or empty value, a wrong expression, a type or cast error, an index out of range, a missing or mis-wired argument, or an unhandled branch. Re-running with the same input would fail the same way.",
  ui_selector_drift:
    "A UI element could not be found, matched or interacted with because the target application's screen changed (new layout, renamed control, changed attributes), so the automation's selectors, anchors or UI descriptors need updating.",
  input_data:
    "The automation correctly rejected invalid input data or a business rule was violated (for example a BusinessRuleException or a validation message about the data itself); the automation behaved as designed and has no defect.",
  transient:
    "A temporary condition such as a timeout under load, a locked file or record, throttling, or a brief network interruption, which would most likely succeed on a retry without any change.",
  infrastructure:
    "A robot, machine, session, Windows logon, licence, credential, Orchestrator asset or folder configuration problem, resolved by an administrator rather than by changing the workflow.",
  external_system:
    "A downstream application, API or service was unavailable or returned an error (for example HTTP 5xx or a service outage) that the automation did not cause.",
} as const;

export type FaultCategory = keyof typeof FAULT_CATEGORIES;

export const COMPLEXITY_LEVELS = [
  "A single value in a single activity must change, such as one selector attribute, one timeout, one constant or one configuration key.",
  "A logic change confined to one workflow file, such as adding a null or empty check, fixing one expression, or wrapping one activity in a retry scope.",
  "Coordinated changes across several workflow files, or changes to the arguments or data passed between workflows.",
  "A redesign of error handling or of the framework, a package dependency upgrade, or a root cause that is unclear and needs deep investigation before any change.",
] as const;

export const questions = {
  fault_category: choice(
    "A UiPath automation job faulted. Using `job.info`, `error_logs` and `recent_log_tail`, classify the root cause of this fault.",
    FAULT_CATEGORIES,
  ),

  needs_code_fix: noul(
    "A UiPath automation job faulted. Using `job.info`, `error_logs`, `recent_log_tail` and `history`, decide whether resolving this fault and preventing it from recurring requires changing the automation's source code (its workflow files, selectors or project dependencies).",
    {
      true: "Yes. The automation's source must change, for example to handle a null or unexpected value, correct its logic, update a selector, or add retry handling around a step that keeps failing repeatedly.",
      false:
        "No. The fault is resolved without touching the source: by simply retrying, by correcting the input data, or by fixing robot, machine, credential, asset, licence or external-system configuration.",
    },
  ),

  fix_complexity: score(
    "Assume the faulted UiPath automation described by `job.info` and `error_logs` will be fixed in its source code. How large and how difficult is the required change?",
    COMPLEXITY_LEVELS,
  ),

  location_pinpointed: noul(
    "Do `job.info` and `error_logs` identify the specific workflow file and the specific activity where this fault originated, so a developer could go straight to the failing step?",
    {
      true: "Yes. The failing workflow file and the failing activity (by name or display name) are both identifiable from the error text.",
      false: "No. The error text is generic or only names the process, so the failing workflow or activity would have to be found by investigation.",
    },
  ),
};

export type JevQuestions = typeof questions;
