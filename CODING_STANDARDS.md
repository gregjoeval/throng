# Coding standards

The rules here are the ones no tool checks. Formatting is oxfmt's job (`pnpm fmt`), and every rule a linter can check
is in `.oxlintrc.json` (`pnpm lint`). Apply each rule below when writing code and check each one when reviewing a diff.

## Casing

- **API:** every name and value a client sees is camelCase. [ADR 0002](docs/adr/0002-api-names-and-values-are-camelcase.md)
  holds the rule and its exceptions.
- **SQL:** columns, and the `Stored*` row types that mirror them, are snake_case.
- **All other TypeScript** is camelCase: variables, functions, properties and enum values. Types and classes are
  PascalCase.
- **Module-level constants** that hold a fixed value (a number, string, regular expression or list of literals) are
  UPPER_SNAKE (`DIFF_FLAGS`, `TASK_REF`). Module-level functions and object instances (`encoder`) stay camelCase.
- **File names** are kebab-case (`merge-requests.ts`). TanStack route files under `apps/web/src/routes/` take the names
  the router gives them (`$owner/$project/index.tsx`, `__root.tsx`). Generated files keep the names their generator
  gives them (`apps/web/src/routeTree.gen.ts`, `worker-configuration.d.ts`).

## Conventions

- **Enums come from the domain type.** A domain module declares the values once (`DIFF_FLAGS`, with
  `type DiffFlag = (typeof DIFF_FLAGS)[number]`), and zod and OpenAPI schemas build from that constant
  (`z.enum(DIFF_FLAGS)`). Check: a list of literal values in a schema imports its constant.
- **A field whose shape depends on another field is a union keyed on that field.** `DequeueCause` keys `details` on
  `reason`, so a `switch` on `reason` narrows `details`. Check: a value typed `unknown` and then cast is a missing
  discriminated union.
- **HTTP plumbing shared by route modules lives in one module.** Schemas, content negotiation and response helpers used
  by more than one route module go in `api-shared.ts`. Check: a helper copied into a second route module moves there.

## Design checks

- **DRY:** each rule, constant and mapping has one source of truth. Check: the change edits one place to change one
  behaviour.
- **KISS:** the code takes the plainest shape that does the job. Check: each layer, generic and indirection in the diff
  serves a caller that exists today.
- **YAGNI:** the change builds what the issue asks for. Check: every option, parameter and branch in the diff has a
  caller or a test that needs it.
- **SOLID:** a module has one reason to change, and depends on the narrow interface it uses (`Sql`, `Repos`), not on a
  concrete backend. Check: a new dependency arrives through an interface the module declares, so a test can pass a fake.
