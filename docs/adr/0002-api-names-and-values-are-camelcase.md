# API names and values are camelCase

Every name and value a client of the API sees is camelCase: JSON field names at any depth, in requests and responses; query and path parameters; and enum values on the wire, such as merge request states (`needsReview`), dequeue reasons (`failedChecks`, `newPush`), check outcomes (`timedOut`), scoring triggers (`scoreNow`), conflict types (`modifyDelete`) and error codes (`notFound`). We chose it because the API's clients and the codebase behind it are TypeScript, where camelCase is the language's own convention, so a value reads the same in a response, in `apps/web` and in the platform's code, with no mapping layer to keep in step. This supersedes the snake_case contract recorded in #189 (story 53 and its "Result shape (API contract, snake_case)") and in commit 7a08609. A test walks the generated OpenAPI document and fails on any property name, parameter name or enum value that isn't camelCase; only names someone else defines, such as HTTP header names, are allowed.

Inside the platform, SQL columns and the `Stored*` row types that mirror them stay snake_case, and all other TypeScript is camelCase. Rows are converted once, at the API boundary, by one function per row type (`publicTask`, `publicAttempt`, `publicMergeRequest`, `publicRun`, `publicToken`, `publicUser`). Anything already camelCase inside, such as a scoring result or a dequeue's details, is served as it is.

## Amendment: MCP names

The MCP server at `/mcp` is the one exception, and only for the names MCP itself gives a style to:

| MCP element     | Casing              | Example                              |
| --------------- | ------------------- | ------------------------------------ |
| Tool names      | snake_case          | `start_attempts`, `wait_for_attempt` |
| Tool parameters | camelCase           | `project`, `attempt`, `attemptLimit` |
| Server ID       | kebab-case          | `throng`                             |
| Resource names  | Title Case, or URIs | `Application Logs`, `file://path`    |

Tool names are snake_case because that is the MCP ecosystem's convention: the reference servers and most others name their tools that way, and the models that call them are trained on those names, so an agent finds and calls `list_tasks` more reliably than `listTasks`. Tool parameters stay camelCase: they are the API's request fields, reused from its schemas, and the data a tool returns is the API's own camelCase JSON. The server ID is kebab-case, as MCP clients key their server configs. The server has no resources yet; any it gains follow the table. A test lists the tools and fails on a tool name that isn't snake_case or a parameter name that isn't camelCase.

## Amendment: externally defined values

An enum value that names something another system defines is served as that system spells it, not camelCased:

| Value                     | Defined by                            | Example              |
| ------------------------- | ------------------------------------- | -------------------- |
| A config's `sandbox.size` | Cloudflare's container instance types | `lite`, `standard-1` |

A project writes the value in its `.throng/config.yml`, the platform passes it unchanged to the container API's `start({ instance })`, and Cloudflare's docs use the same spelling, so renaming it would add a mapping layer and a second name for one thing. Names Throng defines stay camelCase. The OpenAPI test allows each such value by where it appears in the document, and its reason points here.

## Considered options

- **Keep snake_case on the wire and map at the boundary.** Rejected: every camelCase object inside needed a `public*` mapping (results, file diffs, conflict hunks), and enum values would have needed a mapping layer too, or stayed in a third style.
- **Map enum values at the boundary, keeping snake_case constants inside.** Rejected: the domain constants are TypeScript like everything else, and one spelling everywhere removes a whole class of mismatch.

## Consequences

- Values already stored in a project's Durable Object were snake_case. Scalar columns are rewritten by an idempotent migration in the store's schema setup: merge request states, run triggers and every journal event name (`src/casing.ts`, `migrateValues`), and the open-merge-request index is rebuilt for the new state name. D1 and R2 hold no enum values.
- Values inside stored JSON are normalised on read instead of rewritten: a merge request's last dequeue (its reason, conflict types and failed check outcomes), a run's result (each check's outcome), a journal entry's detail keys, and a landing outcome reported by a Workflow started before the change.
- The names ADR 0001 uses follow this rule when they reach the API: the outcome `timed_out` is `timedOut`, and a built-in metric such as `_diff.files_changed` is `_diff.filesChanged`. Metric names a project or task defines are data, not part of the contract, and are served as written.
