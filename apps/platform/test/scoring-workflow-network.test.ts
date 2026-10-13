// The Scoring Workflow's network access against fake bindings: what the score and preview containers
// may reach, and where that comes from. `cloudflare:workers`, the base lookup and the preview Workers
// are stubbed; the Artifacts binding is a `FakeRepos`, and each step retries as its config says.

import { describe, expect, it, vi } from "vitest";
import { CONFIG_PATH } from "../src/config.ts";
import type { OutboundAccess } from "../src/network.ts";
import { NPMRC_PATH } from "../src/npmrc.ts";
import type { ScoringOutcome, ScoringParams } from "../src/scoring.ts";
import { RESULT_PREFIX } from "../src/scripts.ts";
import { FakeRepos } from "./fake-repos.ts";
import { UnreadableRepos } from "./support/unreadable-repos.ts";

const binding = vi.hoisted(() => ({ repos: null as unknown }));

vi.mock("cloudflare:workers", () => ({
  WorkflowEntrypoint: class {
    env: unknown;
    constructor(_ctx: unknown, env: unknown) {
      this.env = env;
    }
  },
}));
vi.mock("../src/artifacts", () => ({ reposFor: () => binding.repos }));
vi.mock("../src/base", () => ({ attemptBase: async () => null }));
vi.mock("../src/preview-workers", () => ({ previewWorkersFor: () => ({ ensure: async () => {} }) }));

// Imported by a computed path: the module is Worker code, which this project's Node typecheck can't
// follow (`cloudflare:workers`), so it is typed here by what the test calls.
const WORKFLOW_MODULE = "../src/workflows.ts";
const { ScoringWorkflow } = (await import(WORKFLOW_MODULE)) as {
  ScoringWorkflow: new (
    ctx: unknown,
    env: unknown,
  ) => { run: (event: unknown, step: unknown) => Promise<ScoringOutcome> };
};

const ORIGIN = "abc123-main";
const FORK = "abc123-t1a1";
const params: ScoringParams = { project: "abc123", attempt: "t1a1", sha: "a".repeat(40), run: 7 };
const config = (host: string) =>
  `preview: {}\nnetwork:\n  allow: [${host}]\nchecks:\n  - { name: test, command: npm test }\n`;
const npmrc = (host: string) => `@acme:registry=https://${host}/\n`;

const result = (value: unknown) => ({ exitCode: 0, stdout: `${RESULT_PREFIX}${JSON.stringify(value)}\n`, stderr: "" });
const PASSED = {
  base: null,
  shortstat: "",
  builtinMs: 0,
  setupFailed: null,
  checks: [{ exit: 0, durationMs: 1, metrics: {} }],
};

/** A step that runs `fn`, trying again on failure up to its config's retry limit, as Workflows does. */
async function stepDo(_name: string, ...rest: unknown[]): Promise<unknown> {
  const fn = rest.at(-1) as () => Promise<unknown>;
  const retries = rest.length > 1 ? ((rest[0] as { retries?: { limit: number } }).retries?.limit ?? 0) : 0;
  for (let tries = 0; ; tries += 1) {
    try {
      return await fn();
    } catch (error) {
      if (tries === retries) throw error;
    }
  }
}

/** Scores `t1a1` against `repos`, recording the outbound access each container started with. */
async function score(repos: FakeRepos): Promise<{ access: Map<string, OutboundAccess>; outcome: ScoringOutcome }> {
  binding.repos = repos;
  const access = new Map<string, OutboundAccess>();
  const env = {
    CF_ACCOUNT_ID: "acct",
    SANDBOX: {
      getByName: (name: string) => {
        const role = name.split("/").at(-1) ?? name;
        return {
          run: async (script: string, options: { access: OutboundAccess }) => {
            if (script.includes("f=logs/")) return { exitCode: 0, stdout: "log\n", stderr: "" };
            access.set(role, options.access);
            return role === "score" ? result(PASSED) : result({ ok: true, url: "https://preview.invalid" });
          },
          destroy: async () => {},
        };
      },
    },
    PROJECT: {
      getByName: () => ({ definitionsOf: async () => ({ checks: [], metrics: [] }), scoringFinished: async () => {} }),
    },
    LOGS: { put: async () => {} },
  };
  const outcome = await new ScoringWorkflow({}, env).run(
    { payload: params, instanceId: "abc123-t1a1-7" },
    { do: stepDo },
  );
  return { access, outcome };
}

/** An origin whose `main` has `files`, and an attempt fork with its own config and `.npmrc`. */
async function project<R extends FakeRepos>(repos: R, files: Record<string, string>): Promise<R> {
  await repos.create(ORIGIN);
  await repos.create(FORK);
  repos.commit(ORIGIN, { files });
  repos.commit(FORK, { files: { [CONFIG_PATH]: config("evil.example.com"), [NPMRC_PATH]: npmrc("evil.example.com") } });
  return repos;
}

const MAIN = { [CONFIG_PATH]: config("api.example.com"), [NPMRC_PATH]: npmrc("npm.acme.dev") };

describe("ScoringWorkflow network access", () => {
  it("gives the score and preview containers main's network.allow and .npmrc registries, never the attempt's", async () => {
    const { access, outcome } = await score(await project(new FakeRepos(), MAIN));
    expect(outcome.status).toBe("done");
    for (const role of ["score", "preview"]) {
      expect({ role, access: access.get(role) }).toMatchObject({
        role,
        access: { registries: ["registry.npmjs.org", "npm.acme.dev"], allow: ["api.example.com"] },
      });
    }
  });

  it("reads the config and the .npmrc from one commit of main, even when main moves between the reads", async () => {
    /** Lands a new commit on `main` right after the first file read. */
    class MovingRepos extends FakeRepos {
      #moved = false;
      override async readFile(name: string, args: { ref: string; path: string }): Promise<Blob | null> {
        const file = await super.readFile(name, args);
        if (!this.#moved) {
          this.#moved = true;
          this.commit(ORIGIN, { files: { [CONFIG_PATH]: config("two.example.com"), [NPMRC_PATH]: npmrc("two.dev") } });
        }
        return file;
      }
    }
    const one = { [CONFIG_PATH]: config("one.example.com"), [NPMRC_PATH]: npmrc("one.dev") };
    const repos = await project(new MovingRepos(), one);
    const pinned = repos.ref(ORIGIN, "refs/heads/main");
    const { access, outcome } = await score(repos);
    expect(outcome.status).toBe("done");
    expect(access.get("score")).toMatchObject({
      registries: ["registry.npmjs.org", "one.dev"],
      allow: ["one.example.com"],
    });
    expect(repos.calls.filter((c) => c.method === "readFile")).toEqual([
      { method: "readFile", args: [ORIGIN, { ref: pinned, path: CONFIG_PATH }] },
      { method: "readFile", args: [ORIGIN, { ref: pinned, path: NPMRC_PATH }] },
    ]);
  });

  it("retries a failed .npmrc read rather than scoring without its registries", async () => {
    const repos = await project(new UnreadableRepos({ path: NPMRC_PATH, times: 1 }), MAIN);
    const { access, outcome } = await score(repos);
    expect(outcome.status).toBe("done");
    expect(access.get("score")).toMatchObject({ registries: ["registry.npmjs.org", "npm.acme.dev"] });
  });

  it("ends the run errored, running nothing, when the .npmrc keeps failing to read", async () => {
    const repos = await project(new UnreadableRepos({ path: NPMRC_PATH }), MAIN);
    const { access, outcome } = await score(repos);
    expect(outcome).toEqual({ status: "errored", error: String(repos.error) });
    expect(access.size).toBe(0);
  });

  it("gives only the npm registry when main has no .npmrc", async () => {
    const { access } = await score(await project(new FakeRepos(), { [CONFIG_PATH]: config("api.example.com") }));
    expect(access.get("score")).toMatchObject({ registries: ["registry.npmjs.org"], allow: ["api.example.com"] });
  });
});
