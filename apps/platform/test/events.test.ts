import { describe, expect, it } from "vitest";
import { routePush } from "../src/events.ts";

const sha = (c: string) => c.repeat(40);

function pushed(repoName: string, ref = "refs/heads/main", after = sha("b")) {
  return {
    type: "cf.artifacts.repo.pushed",
    source: { type: "artifacts.repo", namespace: "throng-spike", repoName },
    payload: { ref, before: sha("a"), after },
    metadata: { eventTimestamp: "2026-10-04T12:00:00.000Z" },
  };
}

describe("routePush", () => {
  it("treats a canonical push to main as main advancing", () => {
    const route = routePush(pushed("demo"));
    expect(route).toMatchObject({ kind: "main-advanced", project: "demo", push: { after: sha("b") } });
    expect(route.push?.emittedAt).toBe(Date.parse("2026-10-04T12:00:00.000Z"));
  });

  it("treats a fork push as an attempt wanting a check", () => {
    expect(routePush(pushed("demo--a1"))).toMatchObject({ kind: "attempt", project: "demo", attempt: "a1" });
  });

  it("ignores ref deletions, other canonical branches, and other events", () => {
    expect(routePush(pushed("demo", "refs/heads/main", sha("0"))).kind).toBe("ignored");
    expect(routePush(pushed("demo", "refs/heads/wip")).kind).toBe("ignored");
    expect(routePush({ type: "cf.artifacts.repo.forked" }).kind).toBe("ignored");
    expect(routePush(pushed("--a1")).kind).toBe("ignored");
  });
});
