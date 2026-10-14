// Users: one per human, created the first time Access shows us their email.

/** The slice of D1 this module uses, so tests can run the same SQL on local SQLite. */
export interface Database {
  prepare: (sql: string) => Statement;
}

/** D1 with `batch`: the statements run in one round trip, as one transaction. */
export interface BatchDatabase extends Database {
  batch: (statements: Statement[]) => Promise<unknown>;
}

export interface Statement {
  bind: (...values: unknown[]) => Statement;
  first: <T = Record<string, unknown>>() => Promise<T | null>;
  all: <T = Record<string, unknown>>() => Promise<{ results: T[] }>;
}

export interface User {
  id: string;
  handle: string;
  email: string;
  created_at: string;
}

/** Handles for user ids, by id, read in one query; an id with no user (or null) has none. */
export async function userHandles(db: Database, ids: readonly (string | null)[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((id): id is string => id !== null))];
  if (unique.length === 0) return new Map();
  const { results } = await db
    .prepare(`SELECT id, handle FROM users WHERE id IN (${unique.map(() => "?").join(", ")})`)
    .bind(...unique)
    .all<Pick<User, "id" | "handle">>();
  return new Map(results.map((u) => [u.id, u.handle]));
}

const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const USER_ID_LENGTH = 8;
/** Bytes at or above this would bias the alphabet (256 isn't a multiple of 36), so they are redrawn. */
const ID_BYTE_LIMIT = 256 - (256 % ID_ALPHABET.length);
const MAX_INSERT_ATTEMPTS = 20;

/** A random string of `length` lowercase alphanumeric characters, uniformly drawn. */
export function randomId(length: number): string {
  let id = "";
  while (id.length < length) {
    for (const byte of crypto.getRandomValues(new Uint8Array(length))) {
      if (byte < ID_BYTE_LIMIT && id.length < length) id += ID_ALPHABET[byte % ID_ALPHABET.length];
    }
  }
  return id;
}

/** An opaque user id: 8 lowercase alphanumeric characters, never `-`, so it can't be mistaken for a handle. */
export function randomUserId(): string {
  return randomId(USER_ID_LENGTH);
}

/** The user for an Access email, creating one on first sight. */
export async function userForEmail(db: Database, email: string, newId: () => string = randomUserId): Promise<User> {
  const base = handleBase(email);
  let id = newId();
  let suffix = 1;
  for (let attempt = 0; attempt < MAX_INSERT_ATTEMPTS; attempt++) {
    const existing = await db.prepare("SELECT * FROM users WHERE email = ?").bind(email).first<User>();
    if (existing !== null) return existing;
    const handle = suffix === 1 ? base : `${base}${suffix}`;
    try {
      const created = await db
        .prepare("INSERT INTO users (id, handle, email) VALUES (?, ?, ?) RETURNING *")
        .bind(id, handle, email)
        .first<User>();
      if (created !== null) return created;
    } catch (error) {
      // Collisions are expected; anything else is a real failure. An email collision means another
      // request created this user first, which the next lookup finds.
      const column = /UNIQUE constraint failed: users\.(\w+)/u.exec(String(error))?.[1];
      if (column === "id") id = newId();
      else if (column === "handle") suffix++;
      else if (column !== "email") throw error;
    }
  }
  throw new Error(`could not create a user for ${email}`);
}

/** A handle from the email's local part, kept to lowercase letters, digits and single dashes. */
function handleBase(email: string): string {
  const local = email.slice(0, email.lastIndexOf("@")).toLowerCase();
  return local.replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "") || "user";
}
