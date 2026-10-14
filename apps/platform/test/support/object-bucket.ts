import type { ObjectBucket } from "../../src/project-deletion.ts";

/** An R2 bucket's list and delete, in memory, listing two keys a page so deleting pages through. */
export class FakeBucket implements ObjectBucket {
  readonly keys = new Set<string>();
  async list({ prefix, cursor }: { prefix: string; cursor?: string }) {
    const all = [...this.keys].filter((k) => k.startsWith(prefix)).toSorted();
    const start = cursor === undefined ? 0 : Number(cursor);
    const page = all.slice(start, start + 2);
    const truncated = start + 2 < all.length;
    return { objects: page.map((key) => ({ key })), truncated, ...(truncated ? { cursor: String(start + 2) } : {}) };
  }
  async delete(keys: string[]) {
    for (const key of keys) this.keys.delete(key);
  }
}
