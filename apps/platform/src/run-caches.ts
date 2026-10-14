// A run's caches as its containers use them: restored into a container before its command, saved
// from the one container that saves each once its command passed, and the notes each step gets.
// The Pipeline Workflow decides when; this is the cache policy, over a narrow view of the
// containers and of the project's cache index, so a test can pass fakes.

import { CACHE_ERROR_CHARS, cacheObjectKey, restoreNote, saveNote } from "./caches.ts";
import type { CacheEntry, CacheRestore, CacheSave, RunCache } from "./caches.ts";
import type { SandboxSize, SetupConfig } from "./config.ts";
import { pipelineSandboxName } from "./grants.ts";
import type { OutboundAccess } from "./network.ts";
import type { SetupRun } from "./run-outcome.ts";

/** A note on a step about one of its caches, kept apart from its text until it's written, masked. */
export interface CacheNote {
  cache: string;
  text: string;
}

/** How to start a container a cache is restored into, should it not be running yet (`StartOptions`, with its script's timeout). */
export interface CacheStart {
  access: OutboundAccess;
  size: SandboxSize;
  timeoutMs?: number;
}

/** The part of the `SANDBOX` binding caches use: restoring into and saving from a run's containers. */
export interface CacheContainers {
  getByName: (name: string) => {
    restoreCache: (key: string, paths: readonly string[], start: CacheStart) => Promise<CacheRestore>;
    saveCache: (key: string, paths: readonly string[]) => Promise<CacheSave>;
  };
}

type EntryKey = Pick<CacheEntry, "scope" | "name" | "keyHash">;

/** The part of the project Durable Object caches use: reserving a key to save, then recording or releasing it. */
export interface CacheIndexClient {
  pipelineCacheSaving: (run: number, entry: EntryKey) => Promise<boolean>;
  pipelineCacheSaved: (run: number, entry: EntryKey & Pick<CacheEntry, "size">) => Promise<boolean>;
  pipelineCacheUnsaved: (run: number, entry: EntryKey) => Promise<void>;
}

/** What uses caches in a run's plan: its setups, checks and post-gate steps. */
interface CacheUsers {
  setup: readonly Pick<SetupConfig, "caches">[];
  checks: readonly { name: string; caches: readonly string[] }[];
  steps: readonly { name: string; caches: readonly string[] }[];
}

/** The caches the setups use, each once, in order: what the setups' snapshot holds. */
export function setupCaches(plan: Pick<CacheUsers, "setup">): string[] {
  return [...new Set(plan.setup.flatMap((setup) => setup.caches))];
}

/**
 * The container that saves each cache the plan uses, by cache: each is saved from one container of
 * a run, so its entry is written once: the setup container's when a setup uses it, else the first
 * check's in the plan that does, else the first post-gate step's.
 */
export function cacheSavers(instanceId: string, plan: CacheUsers): Map<string, string> {
  const savers = new Map<string, string>();
  const claim = (caches: readonly string[], sandbox: string) => {
    for (const cache of caches) if (!savers.has(cache)) savers.set(cache, sandbox);
  };
  claim(setupCaches(plan), pipelineSandboxName(instanceId, { kind: "setup" }));
  for (const check of plan.checks)
    claim(check.caches, pipelineSandboxName(instanceId, { kind: "check", name: check.name }));
  for (const step of plan.steps) claim(step.caches, pipelineSandboxName(instanceId, { kind: "step", name: step.name }));
  return savers;
}

export interface RunCachesDeps {
  containers: CacheContainers;
  index: CacheIndexClient;
  project: string;
  run: number;
  /** The caches the run uses, with where each restores from and saves to. */
  caches: readonly RunCache[];
  /** The caches the setups' snapshot holds. */
  inSnapshot: readonly string[];
  /** The container that saves each cache (`cacheSavers`). */
  savers: ReadonlyMap<string, string>;
}

/** One run's caches: restoring them into its containers and saving them from them. */
export class RunCaches {
  readonly #deps: RunCachesDeps;

  constructor(deps: RunCachesDeps) {
    this.#deps = deps;
  }

  /**
   * Restores the caches named `names` into the container `sandbox`, starting it from the image with
   * `start` if it isn't running, and returns a note on each: a hit with its time, or a miss and why.
   */
  async restore(sandbox: string, names: readonly string[], start: CacheStart): Promise<CacheNote[]> {
    const notes: CacheNote[] = [];
    const container = this.#deps.containers.getByName(sandbox);
    for (const cache of this.#named(names)) {
      if (cache.kind === "unkeyed" || cache.restore === null) {
        notes.push({ cache: cache.name, text: restoreNote(cache, null) });
        continue;
      }
      const key = cacheObjectKey(this.#deps.project, { ...cache, scope: cache.restore });
      notes.push({ cache: cache.name, text: restoreNote(cache, await container.restoreCache(key, cache.path, start)) });
    }
    return notes;
  }

  /**
   * Restores the caches a check's or post-gate step's container uses, `names`, once it came up. One
   * from the setups' snapshot already holds the setups' caches, so only its own others are restored;
   * one that will re-run the setups gets the setups' caches too.
   */
  async prepare(
    sandbox: string,
    names: readonly string[],
    start: CacheStart,
    fromSnapshot: boolean,
  ): Promise<CacheNote[]> {
    const { inSnapshot } = this.#deps;
    if (!fromSnapshot) return this.restore(sandbox, [...new Set([...inSnapshot, ...names])], start);
    const held = names
      .filter((name) => inSnapshot.includes(name))
      .map((name) => ({ cache: name, text: `cache ${name}: in the setups' snapshot` }));
    const restored = await this.restore(
      sandbox,
      names.filter((name) => !inSnapshot.includes(name)),
      start,
    );
    return [...held, ...restored];
  }

  /**
   * Saves those of the caches `names` that the running container `sandbox` saves, where the run may
   * save them, once the command using them passed, and records each saved entry with the project.
   * The key is reserved first, so no other run writes its object meanwhile; an entry is never written
   * over. Returns a note on each that says something; a save problem is only ever a note.
   */
  async save(sandbox: string, names: readonly string[]): Promise<CacheNote[]> {
    const { containers, index, project, run, savers } = this.#deps;
    const notes: CacheNote[] = [];
    for (const cache of this.#named(names.filter((name) => savers.get(name) === sandbox))) {
      if (cache.kind === "unkeyed" || cache.save === null) {
        const text = saveNote(cache, null);
        if (text !== null) notes.push({ cache: cache.name, text });
        continue;
      }
      const entry = { scope: cache.save, name: cache.name, keyHash: cache.keyHash };
      let saved: CacheSave;
      try {
        if (!(await index.pipelineCacheSaving(run, entry))) {
          const text = `cache ${cache.name}: not saved: ${cache.save} already has an entry for its key, or another run is saving one`;
          notes.push({ cache: cache.name, text });
          continue;
        }
        saved = await containers.getByName(sandbox).saveCache(cacheObjectKey(project, entry), cache.path);
        if (saved.kind !== "saved") await index.pipelineCacheUnsaved(run, entry);
        else if (!(await index.pipelineCacheSaved(run, { ...entry, size: saved.bytes }))) {
          saved = { kind: "failed", error: "the project didn't record it" };
        }
      } catch (error) {
        saved = { kind: "failed", error: String(error).slice(0, CACHE_ERROR_CHARS) };
        await index.pipelineCacheUnsaved(run, entry).catch(() => {});
      }
      const text = saveNote(cache, saved);
      if (text !== null) notes.push({ cache: cache.name, text });
    }
    return notes;
  }

  /** The run's caches named `names`. */
  #named(names: readonly string[]): RunCache[] {
    return this.#deps.caches.filter((cache) => names.includes(cache.name));
  }
}

/** The setups' runs with `notes` (about their caches), masked, on the first setup that uses each cache. */
export function withCacheNotes(
  setups: readonly Pick<SetupConfig, "caches">[],
  runs: readonly SetupRun[],
  notes: readonly CacheNote[],
  mask: (text: string) => string,
): SetupRun[] {
  return runs.map((run, i) => {
    const earlier = new Set(setups.slice(0, i).flatMap((setup) => setup.caches));
    const own = (setups[i]?.caches ?? []).filter((cache) => !earlier.has(cache));
    const noted = notes.filter((note) => own.includes(note.cache)).map((note) => mask(note.text));
    return noted.length === 0 ? run : { ...run, notes: noted };
  });
}
