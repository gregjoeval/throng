# Every scoring result is a metric

Scoring used to produce two kinds of result: a check's pass/fail outcome, which counted towards the gate or the score depending on `required`, and the numbers a check reported, which only counted towards the score. That left no place for results that are neither, such as whether a Preview deployed. So a check is now only a process, and everything scoring produces is a typed, nullable **metric**. Each check produces an enum metric named after itself for its outcome (`passed > failed > timed_out > errored > skipped`). It also writes JSON files into the `$THRONG_OUTPUT` directory, and metrics are declared on their own, apart from checks, by pointing into those files (`from: test.coverage-summary.total.lines.pct` is the check, then the file, then the keys). The values are read inside the container as soon as the check exits, and the files are thrown away with the sandbox. The **gate** is a set of conditions over metrics; for now the only condition is `required: true`, meaning the check's outcome must be `passed`. The **score** is every metric. A task adds checks and metrics on top of the project's `.throng/config.yml`, but never under a name the project uses, so it can tighten the bar and never loosen it.

## Considered options

- **Keep check outcomes and metrics apart, and add types to metrics.** Rejected: the Preview, and any future pass/fail signal outside the gate, would still need its own special place in the result.
- **Nest results by layer (`platform`, `project`, `task`) and resolve a name by looking in each in turn.** Rejected: every reader would repeat the lookup, and precedence would let a task override the project's checks by accident.
- **Declare metrics inside the check that reports them, as before.** Rejected: a task couldn't add a metric over a check the project already runs without redefining the check.

## Consequences

- Throng's own measurements are built-in checks whose names start with `_` (`_diff`, `_preview`), and their metrics are `_<check>.<key>`, such as `_diff.files_changed` and `_preview.url`. A project or task name may not start with `_`.
- Definitions are merged once per run, and a clash between layers makes the config invalid. The result is flat, and every check and metric carries its `source` (`platform`, `project` or `task`).
- Types are `boolean`, `number`, `string` and `enum`, and decide how values compare. Formats (`format: url`) decide only how values are shown, so new display needs add formats, not types. `string` never ranks or appears in a condition.
- A missing path, a value that doesn't fit its type, or a skipped check makes a metric null. Null ranks last, and a condition on a null metric fails.
- Only the values and notes are kept; a null's note says which part of the path failed and which keys were there instead. Raw output can't be inspected after the run, and adding a metric means re-running the checks.
- Inline `metrics:` under a check and `$THRONG_METRICS` are replaced outright, with no compatibility period.
