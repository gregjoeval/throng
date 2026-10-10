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
  it("treats an origin push to main as main advancing", () => {
    const route = routePush(pushed("k3x9q2-main"));
    expect(route).toMatchObject({ kind: "main-advanced", project: "k3x9q2", push: { after: sha("b") } });
    expect(route.push?.emittedAt).toBe(Date.parse("2026-10-04T12:00:00.000Z"));
  });

  it("treats a fork push as an attempt wanting a check", () => {
    expect(routePush(pushed("k3x9q2-t42a3"))).toMatchObject({ kind: "attempt", project: "k3x9q2", attempt: "t42a3" });
  });

  it("ignores ref deletions, other origin branches, and other events", () => {
    expect(routePush(pushed("k3x9q2-main", "refs/heads/main", sha("0"))).kind).toBe("ignored");
    expect(routePush(pushed("k3x9q2-main", "refs/heads/wip")).kind).toBe("ignored");
    expect(routePush(pushed("k3x9q2-main", "refs/attempts/t42a3")).kind).toBe("ignored");
    expect(routePush({ type: "cf.artifacts.repo.forked" }).kind).toBe("ignored");
  });

  it("ignores repos whose names aren't an origin or attempt fork", () => {
    for (const name of ["k3x9q2", "demo--a1", "-t1a1", "k3x9q2-wip"]) {
      expect(routePush(pushed(name)), name).toMatchObject({ kind: "ignored", reason: `unrecognised repo ${name}` });
    }
  });
});
