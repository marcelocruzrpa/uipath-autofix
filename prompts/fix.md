Apply an approved fix to this UiPath project for the faulted job `{{JOB_KEY}}` of process `{{PROCESS_KEY}}`.

The approved diagnosis is in `.autofix/diagnose.json`. Read it first. Its `root_cause`, `evidence` and `proposed_changes` are the specification. A human reviews the resulting pull request before anything is merged.

Edit the workflow files following the **`uipath:uipath-rpa`** skill's conventions for `.xaml` / `.cs` (load it through the Skill tool). UiPath Studio is **not** available on this runner, so skip any step that needs Studio (validate, build, run, pack, UI exploration). A CI step checks well-formedness after you finish.

Rules:
1. Implement exactly the `proposed_changes`, as the smallest edit that does so. Make no refactors, no reformatting, no renames, and no changes to files the diagnosis does not name.
2. Preserve XAML structure: namespaces, `x:Class`, `sap2010:WorkflowViewState.IdRef` values, and existing attributes. The file must remain well-formed XML. Do not add a DTD.
3. Change `project.json` dependencies only if a proposed change explicitly requires it.
4. If a proposed change cannot be applied as described (the file or snippet is not found, or it would contradict the code you see), do not improvise. Skip it and explain why in `caveats`.
5. Do not touch `.github/`, `.local/` or `.autofix/`, and do not run git.

Return the structured output, listing every file you changed.
