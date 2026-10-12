# API names and values are camelCase

Every name and value a client of the API sees is camelCase: JSON field names at any depth, in requests and responses; query and path parameters; and enum values on the wire, such as merge request states (`needsReview`), dequeue reasons (`failedChecks`, `newPush`), check outcomes (`timedOut`), scoring triggers (`scoreNow`), conflict types (`modifyDelete`) and error codes (`notFound`). We chose it because the API's clients and the codebase behind it are TypeScript, where camelCase is the language's own convention, so a value reads the same in a response, in `apps/web` and in the platform's code, with no mapping layer to keep in step. This supersedes the snake_case contract recorded in #189 (story 53 and its "Result shape (API contract, snake_case)") and in commit 7a08609. A test walks the generated OpenAPI document and fails on any property name, parameter name or enum value that isn't camelCase; only names someone else defines, such as HTTP header names, are allowed.

Inside the platform, SQL columns and the `Stored*` row types that mirror them stay snake_case, and all other TypeScript is camelCase. Rows are converted once, at the API boundary, by one function per row type (`publicTask`, `publicAttempt`, `publicMergeRequest`, `publicRun`, `publicToken`, `publicUser`). Anything already camelCase inside, such as a scoring result or a dequeue's details, is served as it is.

## Considered options

- **Keep snake_case on the wire and map at the boundary.** Rejected: every camelCase object inside needed a `public*` mapping (results, file diffs, conflict hunks), and enum values would have needed a mapping layer too, or stayed in a third style.
- **Map enum values at the boundary, keeping snake_case constants inside.** Rejected: the domain constants are TypeScript like everything else, and one spelling everywhere removes a whole class of mismatch.

## Consequences

- Values already stored in a project's Durable Object were snake_case. Scalar columns are rewritten by an idempotent migration in the store's schema setup: merge request states, run triggers and every journal event name (`src/casing.ts`, `migrateValues`), and the open-merge-request index is rebuilt for the new state name. D1 and R2 hold no enum values.
- Values inside stored JSON are normalised on read instead of rewritten: a merge request's last dequeue (its reason, conflict types and failed check outcomes), a run's result (each check's outcome), a journal entry's detail keys, and a landing outcome reported by a Workflow started before the change.
- The names ADR 0001 uses follow this rule when they reach the API: the outcome `timed_out` is `timedOut`, and a built-in metric such as `_diff.files_changed` is `_diff.filesChanged`. Metric names a project or task defines are data, not part of the contract, and are served as written.
