// Vote selection in the arena: the banner with its tallies, Vote on each lane and card, and opening,
// adding to and closing a vote.

import { screen, within } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import type { HttpHandler } from "msw";
import { describe, expect, it } from "vitest";
import type { ArenaAttempt, TaskArena } from "@/lib/arena";
import { renderApp } from "./app";
import { arenaAttempt, bob, me, result, serveArena, serveCompare, server, task } from "./server";

type Vote = NonNullable<TaskArena["vote"]>;

const passing = (n: number, fields: Partial<ArenaAttempt> = {}) =>
  arenaAttempt(1, n, { status: "done", result: result(), ...fields });

const VOTE_BY_ANYONE: TaskArena["selection"] = { policy: "vote", eligible: "anyone" };

/** t1's open vote among anyone, with t1a1 to t1a3 as candidates at their arena heads, by `votes`. */
function openVote(votes: number[], fields: Partial<Vote> = {}): Vote {
  return {
    task: "t1",
    state: "open",
    eligible: "anyone",
    deadline: null,
    openedBy: { ...me.user, alias: null },
    openedAt: me.user.createdAt,
    closedBy: null,
    closedAt: null,
    winner: null,
    candidates: votes.map((count, i) => ({
      attempt: `t1a${i + 1}`,
      head: passing(i + 1).sha ?? "",
      addedAt: me.user.createdAt,
      votes: count,
      withdrawn: false,
    })),
    myBallot: null,
    ...fields,
  };
}

/** Every vote request the platform got, as `<path tail> <body>`. */
function serveVoting(asked: string[]) {
  const record = (tail: string) =>
    http.post(`*/api/projects/:owner/:project/tasks/:t/${tail}`, async ({ request }) => {
      asked.push(`${tail} ${await request.text()}`);
      return HttpResponse.json({});
    });
  return [record("vote/open"), record("vote/close"), record("vote/candidates"), record("vote")];
}

const lane = (ref: string) => screen.getByRole("region", { name: `Lane ${ref}` });
const card = (ref: string) =>
  within(screen.getByRole("list", { name: "Attempts" }))
    .getByRole("button", { name: ref })
    .closest("li") as HTMLElement;
const banner = () => screen.getByRole("region", { name: "Vote" });

/** The arena of t1 with `attempts` and `voting`; `handlers` go before the default vote handlers. */
async function arenaWith(
  attempts: ArenaAttempt[],
  voting: Partial<Pick<TaskArena, "selection" | "vote">>,
  handlers: HttpHandler[] = [],
) {
  const asked: string[] = [];
  server.use(
    ...handlers,
    ...serveVoting(asked),
    serveCompare(() => []),
    ...serveArena(task(1), attempts, [], {}, voting),
  );
  const app = await renderApp("/ada/alpha/tasks/t1");
  await screen.findByRole("region", { name: "Lanes" });
  return { ...app, asked };
}

describe("the vote banner", () => {
  it("shows each candidate's tally, the eligibility, the deadline and your ballot", async () => {
    const vote = openVote([2, 0, 1], {
      eligible: "humans",
      deadline: "2026-10-11T12:00:00.000Z",
      myBallot: { attempt: "t1a3", head: passing(3).sha ?? "", alias: null, at: me.user.createdAt },
    });
    vote.candidates = vote.candidates.map((c) => (c.attempt === "t1a2" ? { ...c, withdrawn: true } : c));
    await arenaWith([passing(1), passing(2), passing(3)], { selection: VOTE_BY_ANYONE, vote });

    expect(banner()).toHaveTextContent("Vote open");
    expect(banner()).toHaveTextContent("Users acting as themselves may vote");
    expect(banner()).toHaveTextContent("Ballots close");
    const tallies = within(banner()).getByRole("list", { name: "Tallies" });
    expect(
      within(tallies)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual(["t1a12 votes", "t1a2withdrawn", "t1a31 vote"]);
    expect(banner()).toHaveTextContent("You voted for t1a3.");
  });

  it("shows a candidate a follow of the task branch moved as being scored, not withdrawn", async () => {
    const vote = openVote([2, 1]);
    vote.candidates = vote.candidates.map((c) => (c.attempt === "t1a1" ? { ...c, votes: 0, withdrawn: true } : c));
    const followed = arenaAttempt(1, 1, { status: "running" });
    await arenaWith([followed, passing(2)], { selection: VOTE_BY_ANYONE, vote });

    const tallies = within(banner()).getByRole("list", { name: "Tallies" });
    const items = within(tallies).getAllByRole("listitem");
    expect(items.map((item) => item.textContent)).toEqual(["t1a1being scored", "t1a21 vote"]);
    expect(items[0]).not.toHaveClass("line-through");
  });

  it("offers the task's creator to open a vote under the vote policy, with an optional deadline", async () => {
    const { user, asked } = await arenaWith([passing(1), passing(2)], { selection: VOTE_BY_ANYONE });
    expect(banner()).toHaveTextContent("Selection is by vote, among anyone.");
    expect(screen.queryByRole("button", { name: "Select" })).toBeNull();
    await user.click(within(banner()).getByRole("button", { name: "Open vote" }));
    await user.type(within(banner()).getByLabelText("Deadline (optional)"), "2026-10-20T09:30");
    await user.click(within(banner()).getByRole("button", { name: "Open the vote" }));
    await expect.poll(() => asked).toEqual([`vote/open {"deadline":"${new Date("2026-10-20T09:30").toISOString()}"}`]);
  });

  it("shows nothing under the creator's policy, and keeps Select", async () => {
    await arenaWith([passing(1), passing(2)], {});
    expect(screen.queryByRole("region", { name: "Vote" })).toBeNull();
    expect(within(lane("t1a1")).getByRole("button", { name: "Select" })).toBeInTheDocument();
  });

  it("closes the vote, naming the attempt it selects", async () => {
    const { user, asked } = await arenaWith([passing(1), passing(2), passing(3)], {
      selection: VOTE_BY_ANYONE,
      vote: openVote([1, 3, 0]),
    });
    await user.click(within(banner()).getByRole("button", { name: "Close vote" }));
    const confirm = within(banner()).getByRole("group", { name: "Confirm closing the vote" });
    expect(confirm).toHaveTextContent(
      "Close the vote? t1a2 has the most votes and will be selected. The other 2 attempts will be closed and archived.",
    );
    await user.click(within(confirm).getByRole("button", { name: "Close and select t1a2" }));
    await expect.poll(() => asked).toEqual(["vote/close {}"]);
  });

  it("breaks a tie with the creator's pick", async () => {
    const { user, asked } = await arenaWith([passing(1), passing(2), passing(3)], {
      selection: VOTE_BY_ANYONE,
      vote: openVote([2, 0, 2]),
    });
    await user.click(within(banner()).getByRole("button", { name: "Close vote" }));
    const confirm = within(banner()).getByRole("group", { name: "Confirm closing the vote" });
    expect(confirm).toHaveTextContent("The vote is tied between t1a1 and t1a3. Pick the one to select.");
    await user.click(within(confirm).getByRole("button", { name: "Close and select t1a3" }));
    await expect.poll(() => asked).toEqual(['vote/close {"attempt":"t1a3"}']);
  });

  it("shows no open or close controls to anyone but the creator and the project owner", async () => {
    server.use(
      http.get("*/api/projects/:owner/:project", () =>
        HttpResponse.json({ id: "p", handle: "alpha", owner: bob, createdAt: me.user.createdAt }),
      ),
    );
    const t = task(1, { creator: bob });
    server.use(
      serveCompare(() => []),
      ...serveArena(t, [passing(1), passing(2)], [], {}, { selection: VOTE_BY_ANYONE }),
    );
    await renderApp("/ada/alpha/tasks/t1");
    await screen.findByRole("region", { name: "Lanes" });
    expect(banner()).toHaveTextContent("Selection is by vote, among anyone. No vote is open yet.");
    expect(within(banner()).queryByRole("button")).toBeNull();
  });
});

describe("the vote in the single-attempt view", () => {
  it("replaces Merge with the banner and Vote under the vote policy", async () => {
    const voting = { selection: VOTE_BY_ANYONE, vote: openVote([0]) };
    server.use(
      serveCompare(() => []),
      ...serveArena(task(1), [passing(1)], [], {}, voting),
    );
    await renderApp("/ada/alpha/tasks/t1");
    const view = await screen.findByTestId("single-attempt-view");
    expect(within(view).queryByRole("button", { name: "Merge" })).toBeNull();
    expect(within(view).getByRole("region", { name: "Vote" })).toHaveTextContent("Vote open");
    expect(within(view).getByRole("button", { name: "Vote" })).toBeInTheDocument();
  });
});

describe("voting", () => {
  it("stops offering Vote once the deadline passes, and says ballots closed", async () => {
    await arenaWith([passing(1), passing(2)], {
      selection: VOTE_BY_ANYONE,
      vote: openVote([1, 0], { deadline: "2020-01-01T00:00:00.000Z" }),
    });
    expect(banner()).toHaveTextContent("Ballots closed");
    expect(screen.queryByRole("button", { name: "Vote" })).toBeNull();
  });

  it("casts a ballot from a lane or a rail card, and hides Select while the vote is open", async () => {
    const { user, asked } = await arenaWith([passing(1), passing(2), passing(3)], {
      selection: VOTE_BY_ANYONE,
      vote: openVote([0, 0, 0]),
    });
    expect(screen.queryByRole("button", { name: "Select" })).toBeNull();
    await user.click(within(lane("t1a1")).getByRole("button", { name: "Vote" }));
    await user.click(within(card("t1a3")).getByRole("button", { name: "Vote" }));
    expect(
      within(screen.getByRole("list", { name: "Attempts" })).getByRole("button", { name: "t1a3" }),
    ).toHaveAttribute("aria-pressed", "false");
    await expect.poll(() => asked).toEqual(['vote {"attempt":"t1a1"}', 'vote {"attempt":"t1a3"}']);
  });

  it("marks your ballot, and offers no Vote on your own attempt or a withdrawn candidate", async () => {
    const vote = openVote([0, 1, 0], {
      myBallot: { attempt: "t1a2", head: passing(2).sha ?? "", alias: null, at: me.user.createdAt },
    });
    vote.candidates = vote.candidates.map((c) => (c.attempt === "t1a3" ? { ...c, withdrawn: true } : c));
    const mine = passing(1, { author: { id: me.user.id, handle: me.user.handle } });
    await arenaWith([mine, passing(2), passing(3)], { selection: VOTE_BY_ANYONE, vote });
    expect(within(lane("t1a1")).queryByRole("button", { name: "Vote" })).toBeNull();
    expect(within(lane("t1a2")).getByRole("button", { name: "Your vote" })).toBeDisabled();
    expect(within(card("t1a3")).queryByRole("button", { name: "Vote" })).toBeNull();
  });

  it("offers no Vote when only aliases may vote", async () => {
    await arenaWith([passing(1), passing(2)], {
      selection: { policy: "vote", eligible: "aliases" },
      vote: openVote([0, 0], { eligible: "aliases" }),
    });
    expect(screen.queryByRole("button", { name: "Vote" })).toBeNull();
  });

  it("lets the creator add an attempt that passes after the vote opened", async () => {
    const { user, asked } = await arenaWith([passing(1), passing(2), passing(3)], {
      selection: VOTE_BY_ANYONE,
      vote: openVote([0, 0]),
    });
    expect(within(card("t1a1")).queryByRole("button", { name: "Add to vote" })).toBeNull();
    await user.click(within(card("t1a3")).getByRole("button", { name: "Add to vote" }));
    await expect.poll(() => asked).toEqual(['vote/candidates {"attempt":"t1a3"}']);
  });

  it("shows why the platform refused a ballot", async () => {
    const refused = http.post("*/api/projects/:owner/:project/tasks/:t/vote", () =>
      HttpResponse.json({ error: { code: "invalidState", message: "t1a1 isn't a candidate" } }, { status: 409 }),
    );
    const voting = { selection: VOTE_BY_ANYONE, vote: openVote([0, 0]) };
    const { user } = await arenaWith([passing(1), passing(2)], voting, [refused]);
    await user.click(within(lane("t1a1")).getByRole("button", { name: "Vote" }));
    expect(await within(lane("t1a1")).findByRole("alert")).toHaveTextContent("t1a1 isn't a candidate");
  });
});
