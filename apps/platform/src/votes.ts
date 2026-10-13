// Votes, kept in the project Durable Object's SQLite next to tasks and attempts: a task's selection
// made by vote, under the `vote` selection policy. This module holds the records and the rules a vote
// counts by, which the web app shares; the task store decides who may act, which attempts are
// candidates and when a candidate is withdrawn, and calls it inside its own transactions.

import type { VoteEligibility } from "./config.ts";
import type { ActedBy } from "./merge-requests.ts";
import type { Sql } from "./task-store.ts";
import type { Actor } from "./tokens.ts";

export const VOTE_STATES = ["open", "closed"] as const;
export type VoteState = (typeof VOTE_STATES)[number];

export interface StoredVote {
  id: number;
  task: number;
  state: VoteState;
  /** Who may cast a ballot, fixed when the vote opened. */
  eligible: VoteEligibility;
  /** When ballots stop being taken, or null for none. */
  deadline: string | null;
  opened_by: ActedBy;
  opened_at: string;
  /** Who closed it, or null while open or when it closed with its task. */
  closed_by: ActedBy | null;
  closed_at: string | null;
  /** The selected attempt's number, once closed with a selection. */
  winner: number | null;
}

/** An attempt in a vote, pinned to the head it was passing at. */
export interface StoredCandidate {
  attempt: number;
  head: string;
  added_at: string;
}

/** A user's one ballot in a vote: for an attempt at the head it was a candidate at. */
export interface StoredBallot {
  /** The user id: an alias's ballot is its user's. */
  voter: string;
  alias: string | null;
  attempt: number;
  head: string;
  at: string;
}

/**
 * A candidate with its tally: the ballots for its pinned head, none while it is withdrawn. A closed
 * vote's candidates stay as they were when it closed.
 */
export interface CandidateTally extends StoredCandidate {
  votes: number;
  withdrawn: boolean;
}

/** A vote with its candidates' tallies and one voter's own ballot. */
export interface VoteDetail extends StoredVote {
  candidates: CandidateTally[];
  ballot: Omit<StoredBallot, "voter"> | null;
}

interface VoteRow {
  id: number;
  task: number;
  state: VoteState;
  eligible: VoteEligibility;
  deadline: string | null;
  opened_by_user: string;
  opened_by_alias: string | null;
  opened_at: string;
  closed_by_user: string | null;
  closed_by_alias: string | null;
  closed_at: string | null;
  winner: number | null;
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS votes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task INTEGER NOT NULL,
    state TEXT NOT NULL,
    eligible TEXT NOT NULL,
    deadline TEXT,
    opened_by_user TEXT NOT NULL,
    opened_by_alias TEXT,
    opened_at TEXT NOT NULL,
    closed_by_user TEXT,
    closed_by_alias TEXT,
    closed_at TEXT,
    winner INTEGER
  )`,
  // One open vote per task.
  `CREATE UNIQUE INDEX IF NOT EXISTS votes_open_task ON votes (task) WHERE state = 'open'`,
  `CREATE TABLE IF NOT EXISTS vote_candidates (
    vote INTEGER NOT NULL,
    attempt INTEGER NOT NULL,
    head TEXT NOT NULL,
    added_at TEXT NOT NULL,
    withdrawn INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (vote, attempt)
  )`,
  `CREATE TABLE IF NOT EXISTS ballots (
    vote INTEGER NOT NULL,
    voter TEXT NOT NULL,
    alias TEXT,
    attempt INTEGER NOT NULL,
    head TEXT NOT NULL,
    at TEXT NOT NULL,
    PRIMARY KEY (vote, voter)
  )`,
];

/** Who each eligibility lets vote. */
export const ELIGIBLE_VOTERS: Record<VoteEligibility, string> = {
  humans: "users acting as themselves",
  aliases: "users acting under an alias",
  anyone: "anyone",
};

/**
 * Whether a user acting under `alias` (null: as themselves) may cast a ballot in a vote among
 * `eligible`.
 */
export function mayVote(eligible: VoteEligibility, alias: string | null): boolean {
  if (eligible === "humans") return alias === null;
  if (eligible === "aliases") return alias !== null;
  return true;
}

/**
 * The candidates with the most ballots among those not withdrawn: one is the winner, more are a tie.
 * None when every candidate is withdrawn.
 */
export function voteLeaders<C extends { votes: number; withdrawn: boolean }>(candidates: readonly C[]): C[] {
  const standing = candidates.filter((c) => !c.withdrawn);
  const most = Math.max(...standing.map((c) => c.votes));
  return standing.filter((c) => c.votes === most);
}

/** One project's votes. Checks no permission and no attempt state: the task store does. */
export class Votes {
  readonly #sql: Sql;

  constructor({ sql }: { sql: Sql }) {
    this.#sql = sql;
    for (const statement of SCHEMA) sql.exec(statement);
  }

  /** The task's open vote, if any. */
  open(task: number): StoredVote | null {
    const [row] = this.#sql.exec<VoteRow>("SELECT * FROM votes WHERE task = ? AND state = 'open'", task);
    return row === undefined ? null : toVote(row);
  }

  /** The task's latest vote, open or not. */
  latest(task: number): StoredVote | null {
    const [row] = this.#sql.exec<VoteRow>("SELECT * FROM votes WHERE task = ? ORDER BY id DESC LIMIT 1", task);
    return row === undefined ? null : toVote(row);
  }

  /** Opens a vote on the task among `candidates`. */
  create(
    actor: Actor,
    input: { task: number; eligible: VoteEligibility; deadline: string | null; candidates: StoredCandidate[] },
    at: string,
  ): StoredVote {
    const [row] = this.#sql.exec<VoteRow>(
      `INSERT INTO votes (task, state, eligible, deadline, opened_by_user, opened_by_alias, opened_at)
       VALUES (?, 'open', ?, ?, ?, ?, ?) RETURNING *`,
      input.task,
      input.eligible,
      input.deadline,
      actor.user.id,
      actor.alias,
      at,
    );
    if (row === undefined) throw new Error("vote insert returned no row");
    for (const candidate of input.candidates) this.addCandidate(row.id, candidate);
    return toVote(row);
  }

  /** Makes an attempt a candidate at `head`, or pins a candidate again at its new head. */
  addCandidate(vote: number, { attempt, head, added_at }: StoredCandidate): void {
    this.#sql.exec(
      `INSERT INTO vote_candidates (vote, attempt, head, added_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (vote, attempt) DO UPDATE SET head = excluded.head, added_at = excluded.added_at`,
      vote,
      attempt,
      head,
      added_at,
    );
  }

  /** The vote's candidates, in the order they were first added. */
  candidates(vote: number): StoredCandidate[] {
    return this.#sql.exec<StoredCandidate>(
      "SELECT attempt, head, added_at FROM vote_candidates WHERE vote = ? ORDER BY rowid",
      vote,
    );
  }

  /** Stores a voter's ballot, replacing their earlier one in the vote. */
  cast(vote: number, ballot: StoredBallot): void {
    this.#sql.exec(
      `INSERT INTO ballots (vote, voter, alias, attempt, head, at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (vote, voter) DO UPDATE SET
         alias = excluded.alias, attempt = excluded.attempt, head = excluded.head, at = excluded.at`,
      vote,
      ballot.voter,
      ballot.alias,
      ballot.attempt,
      ballot.head,
      ballot.at,
    );
  }

  /**
   * Closes the vote with the attempt it selected, or none, keeping which candidates were withdrawn
   * then; `actor` is null when it closed with its task.
   */
  close(
    vote: number,
    actor: Actor | null,
    { winner, withdrawn, at }: { winner: number | null; withdrawn: number[]; at: string },
  ): StoredVote {
    for (const attempt of withdrawn) {
      this.#sql.exec("UPDATE vote_candidates SET withdrawn = 1 WHERE vote = ? AND attempt = ?", vote, attempt);
    }
    const [row] = this.#sql.exec<VoteRow>(
      `UPDATE votes SET state = 'closed', closed_by_user = ?, closed_by_alias = ?, closed_at = ?, winner = ?
       WHERE id = ? RETURNING *`,
      actor?.user.id ?? null,
      actor?.alias ?? null,
      at,
      winner,
      vote,
    );
    if (row === undefined) throw new Error(`no vote ${vote}`);
    return toVote(row);
  }

  /**
   * The vote with each candidate's tally and `voter`'s own ballot. A candidate is out while the vote
   * is open if `withdrawn` says so (its head moved, say), and once closed if it was out then; it has
   * no votes. A ballot counts only for the head it was cast at.
   */
  detail(vote: StoredVote, voter: string, withdrawn: (candidate: StoredCandidate) => boolean): VoteDetail {
    const ballots = this.#sql.exec<StoredBallot>(
      "SELECT voter, alias, attempt, head, at FROM ballots WHERE vote = ?",
      vote.id,
    );
    const rows = this.#sql.exec<StoredCandidate & { withdrawn: number }>(
      "SELECT attempt, head, added_at, withdrawn FROM vote_candidates WHERE vote = ? ORDER BY rowid",
      vote.id,
    );
    const candidates = rows.map(({ withdrawn: closedOut, ...candidate }) => {
      const out = vote.state === "open" ? withdrawn(candidate) : closedOut === 1;
      const votes = out
        ? 0
        : ballots.filter((b) => b.attempt === candidate.attempt && b.head === candidate.head).length;
      return { ...candidate, votes, withdrawn: out };
    });
    const mine = ballots.find((b) => b.voter === voter);
    return {
      ...vote,
      candidates,
      ballot: mine === undefined ? null : { alias: mine.alias, attempt: mine.attempt, head: mine.head, at: mine.at },
    };
  }
}

function toVote(row: VoteRow): StoredVote {
  return {
    id: row.id,
    task: row.task,
    state: row.state,
    eligible: row.eligible,
    deadline: row.deadline,
    opened_by: { user: row.opened_by_user, alias: row.opened_by_alias },
    opened_at: row.opened_at,
    closed_by: row.closed_by_user === null ? null : { user: row.closed_by_user, alias: row.closed_by_alias },
    closed_at: row.closed_at,
    winner: row.winner,
  };
}
