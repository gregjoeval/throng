import { describe, expect, it } from "vitest";
import { resolveProject } from "../src/projects.ts";
import { originRepo } from "../src/repos.ts";
import { spikeProject, spikeToken } from "../src/spike.ts";
import { authenticateToken } from "../src/tokens.ts";
import { FakeRepos } from "./fake-repos.ts";
import { testDatabase } from "./support/d1.ts";

const NOW = new Date("2026-10-10T12:00:00.000Z");

describe("spikeToken", () => {
  it("mints a Throng token for the e2e suite's own user, the same user every time", async () => {
    const db = testDatabase();
    const first = await spikeToken(db, NOW);
    const second = await spikeToken(db, NOW);
    expect(first.user.id).toBe(second.user.id);
    expect(first.token).not.toBe(second.token);
    const found = await authenticateToken(db, first.token, NOW);
    expect(found?.actor).toMatchObject({ user: { id: first.user.id }, agent: null });
  });
});

describe("spikeProject", () => {
  it("makes a real project owned by the e2e user, whose id and handle are both the name asked for", async () => {
    const db = testDatabase();
    const repos = new FakeRepos();
    const { user } = await spikeToken(db, NOW);

    const made = await spikeProject(db, repos, "e2eabc123");

    expect(made.project).toMatchObject({ id: "e2eabc123", handle: "e2eabc123", owner: { id: user.id } });
    expect(await resolveProject(db, user.handle, "e2eabc123")).toMatchObject({ id: "e2eabc123" });
    // The origin exists and the write token lets the suite seed its main directly.
    expect((await repos.get(originRepo("e2eabc123"))).remote).toBe(made.remote);
    expect(made.token).toEqual(expect.any(String));
  });
});
