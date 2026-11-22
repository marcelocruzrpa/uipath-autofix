UiPath Orchestrator job `{{JOB_KEY}}` of process `{{PROCESS_KEY}}` faulted. Find the root cause, and determine whether a change to this repository's automation source would resolve it.

Use the **`uipath:uipath-troubleshoot`** skill through the Skill tool. It owns evidence collection, playbook routing and the verification checklist. The job key is your anchor, and the project source is the current directory. Its raw captures directory `.local/investigations/raw/` is already populated for this job.

Routing context from TypeSafe Jev (a fast classifier): {{ROUTING_REASON}}
Treat it as a prior, not as evidence. Your conclusion must rest on the correlated evidence the skill gathers.

This run's mode is **{{MODE}}**:
- `fix`: if you confirm a source-level root cause, a separate step will apply your `proposed_changes` and open a pull request for human review.
- `investigate`: your findings will be posted as a GitHub issue for a human to act on.

Rules for this phase:
1. **Do not edit any source file.** The skill's approval gate applies: describe the exact change in `proposed_changes`. Give the file path relative to the repository root, the precise edit, and a verbatim `before` / `after` snippet of the XAML or C# wherever you can. A separate phase applies it.
2. Set `is_code_fix: true` only when the skill's verification checklist confirms the root cause and the fix is a change to this repository's source. If the fault is operational (robot, credentials, assets, licences, an external system, input data), set it to false and put the recommended operational actions in `non_code_actions`.
3. Use `confidence: "low"` whenever the evidence does not single out one cause. In that case list the surviving candidates and their discriminating signals in `summary_md`, and do not propose source changes.
4. Cite evidence by raw capture file and field, for example `jobs-logs-error.json → Data[0].Message`.
5. Keep any suspicions that the checklist did not verify in `unverified_observations`, never in `proposed_changes`.
