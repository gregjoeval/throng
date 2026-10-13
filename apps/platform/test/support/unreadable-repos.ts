import { FakeRepos } from "../fake-repos.ts";

/**
 * A `FakeRepos` whose `readFile` fails with `error`, as an Artifacts outage would: every read, or
 * only reads of `path`, and only the first `times` of them when that's given.
 */
export class UnreadableRepos extends FakeRepos {
  readonly error = new Error("artifacts unavailable");
  #left: number;

  constructor(readonly only: { path?: string; times?: number } = {}) {
    super();
    this.#left = only.times ?? Number.POSITIVE_INFINITY;
  }

  override async readFile(name: string, args: { ref: string; path: string }): Promise<Blob | null> {
    if ((this.only.path === undefined || args.path === this.only.path) && this.#left > 0) {
      this.#left -= 1;
      throw this.error;
    }
    return super.readFile(name, args);
  }
}
