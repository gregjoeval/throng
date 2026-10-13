import type { PreviewWorkers } from "../../src/preview-workers.ts";

/** Projects' preview Workers, in memory, by project id. */
export class FakePreviewWorkers implements PreviewWorkers {
  readonly projects = new Set<string>();

  async ensure(project: string): Promise<boolean> {
    if (this.projects.has(project)) return false;
    this.projects.add(project);
    return true;
  }

  async delete(project: string): Promise<void> {
    this.projects.delete(project);
  }
}
