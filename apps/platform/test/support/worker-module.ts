/**
 * Imports a Worker module from `src/` (`"workflows"` for `src/workflows.ts`) by a computed path:
 * Worker code imports `cloudflare:workers`, which this project's Node typecheck can't follow, so the
 * caller types the module by what its test calls. Mock `cloudflare:workers` before calling it.
 */
export async function importWorkerModule<T>(name: string): Promise<T> {
  return (await import(`../../src/${name}.ts`)) as T;
}
