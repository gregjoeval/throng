import type { PreviewWorkers } from "../../src/preview-workers.ts";

/** Projects' preview Workers, in memory, by project id. */
export class FakePreviewWorkers implements PreviewWorkers {
  readonly projects = new Set<string>();

  async ensure(project: string): Promise<void> {
    this.projects.add(project);
  }

  async delete(project: string): Promise<void> {
    this.projects.delete(project);
  }
}
