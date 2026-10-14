// Project secrets: a name, a write-only value and the pipelines it may be used in, kept in the project
// Durable Object's SQLite and never in the D1 projection. Values are sealed with AES-256-GCM through Web
// Crypto: a random 12-byte IV each time, with `projectId/name/keyId` as additional data, under a key from
// the keyring in the `SECRETS_KEYRING` Worker secret. Each row names the key that sealed it, so a new
// key can become current while older ones still open the rows they sealed. The task store checks who
// may read and change them, and journals every change without its value.
//
// A trusted run's step loads the sealed values its container needs (`Secrets.sealedFor`), as the
// settings are when the step starts, opens them, and puts them straight into the container's env;
// nothing a Workflow persists ever holds one. Logs, metric values and errors are masked (`masking`).

import type { NamedSecrets } from "./config.ts";
import { ServiceError } from "./errors.ts";
import { PIPELINES } from "./pipelines.ts";
import type { Pipeline } from "./pipelines.ts";
import type { Sql } from "./task-store.ts";

/** The keyring's id of each key, and the key: 32 bytes, base64. */
const KEY_ID = /^[A-Za-z0-9_-]{1,64}$/u;
const KEY_BYTES = 32;
const IV_BYTES = 12;

/** An imported key. Named from Web Crypto itself, so the Worker's, Node's and the DOM's typings all agree. */
type CryptoKey = Awaited<ReturnType<typeof crypto.subtle.importKey>>;

/**
 * The keys values are sealed under. `SECRETS_KEYRING` holds it as JSON:
 * `{"current": "k2", "keys": {"k1": "<base64>", "k2": "<base64>"}}`.
 */
export interface Keyring {
  /** The key new values are sealed under, with its id. */
  current: () => Promise<{ id: string; key: CryptoKey }>;
  /** The key with this id, which opens what it sealed. */
  key: (id: string) => Promise<CryptoKey>;
}

/** A sealed value as its row keeps it. */
export interface SealedValue {
  ciphertext: Uint8Array<ArrayBuffer>;
  iv: Uint8Array<ArrayBuffer>;
  keyId: string;
}

/**
 * The keyring `raw` (`SECRETS_KEYRING`) holds. It's read on first use, not here, so a Worker without
 * one still serves everything but secrets; using a missing or malformed one throws, naming it.
 */
export function keyringFrom(raw: string | undefined): Keyring {
  let keys: Promise<{ current: string; keys: Map<string, CryptoKey> }> | null = null;
  const load = () => (keys ??= importKeyring(raw));
  const key = async (id: string) => {
    const found = (await load()).keys.get(id);
    if (found === undefined) throw new Error(`SECRETS_KEYRING has no key ${id}`);
    return found;
  };
  return {
    current: async () => {
      const { current } = await load();
      return { id: current, key: await key(current) };
    },
    key,
  };
}

function invalid(why: string): Error {
  return new Error(`SECRETS_KEYRING is ${why}`);
}

async function importKeyring(raw: string | undefined) {
  if (raw === undefined || raw === "") throw invalid("not set");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw invalid("not JSON");
  }
  const { current, keys } = (parsed ?? {}) as { current?: unknown; keys?: unknown };
  if (typeof current !== "string" || typeof keys !== "object" || keys === null) {
    throw invalid("not {current, keys}");
  }
  const imported = new Map<string, CryptoKey>();
  for (const [id, encoded] of Object.entries(keys)) {
    if (!KEY_ID.test(id)) throw invalid(`naming a key ${JSON.stringify(id)}`);
    const bytes = typeof encoded === "string" ? decodeBase64(encoded) : null;
    if (bytes?.length !== KEY_BYTES) throw invalid(`holding key ${id} that isn't ${KEY_BYTES} bytes of base64`);
    imported.set(id, await crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]));
  }
  if (!imported.has(current)) throw invalid(`missing its current key ${current}`);
  return { current, keys: imported };
}

function decodeBase64(text: string): Uint8Array<ArrayBuffer> | null {
  try {
    return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

/** What a sealed value is bound to: its project, its name and the key that sealed it. */
function additionalData(project: string, name: string, keyId: string) {
  return new TextEncoder().encode(`${project}/${name}/${keyId}`);
}

/** Seals project `project`'s secret `name` under the keyring's current key. */
export async function sealSecret(keyring: Keyring, project: string, name: string, value: string): Promise<SealedValue> {
  const { id, key } = await keyring.current();
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const params = { name: "AES-GCM", iv, additionalData: additionalData(project, name, id) };
  const ciphertext = await crypto.subtle.encrypt(params, key, new TextEncoder().encode(value));
  return { ciphertext: new Uint8Array(ciphertext), iv, keyId: id };
}

/** Opens a value sealed for project `project`'s secret `name`; throws if it was sealed for another. */
export async function openSecret(
  keyring: Keyring,
  project: string,
  name: string,
  sealed: SealedValue,
): Promise<string> {
  const key = await keyring.key(sealed.keyId);
  const params = { name: "AES-GCM", iv: sealed.iv, additionalData: additionalData(project, name, sealed.keyId) };
  return new TextDecoder().decode(await crypto.subtle.decrypt(params, key, sealed.ciphertext));
}

/** The shortest value: masking a shorter one would hide common words in logs. */
export const MIN_SECRET_LENGTH = 8;
/** The longest value, in characters: 64 KB. */
export const MAX_SECRET_LENGTH = 65_536;
/** An environment variable's name: uppercase letters, digits and underscores, not starting with a digit. */
export const SECRET_NAME = /^[A-Z_][A-Z0-9_]{0,127}$/u;
/** The prefix of the variables Throng sets in every container, which no secret may take. */
export const RESERVED_SECRET_PREFIX = "THRONG_";

/** A secret as its readers see it: never its value. */
export interface SecretSummary {
  name: string;
  /** The pipelines it may be used in, in `PIPELINES` order. */
  pipelines: Pipeline[];
  /** When its value or pipelines last changed. */
  changedAt: string;
}

/** A change to a secret: a new value, new pipelines, or both. */
export interface SecretChange {
  value?: string | undefined;
  pipelines?: readonly Pipeline[] | undefined;
}

export interface StoredSecret {
  name: string;
  /** The sealed value, base64. */
  ciphertext: string;
  /** Its IV, base64. */
  iv: string;
  key_id: string;
  /** A JSON array of pipelines. */
  pipelines: string;
  changed_at: string;
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS secrets (
    name TEXT PRIMARY KEY,
    ciphertext TEXT NOT NULL,
    iv TEXT NOT NULL,
    key_id TEXT NOT NULL,
    pipelines TEXT NOT NULL,
    changed_at TEXT NOT NULL
  )`,
];

/** Why `name` can't name a secret, or null when it can. */
export function secretNameError(name: string): string | null {
  if (!SECRET_NAME.test(name)) {
    return "a secret's name is up to 128 uppercase letters, digits and underscores, not starting with a digit";
  }
  if (name.startsWith(RESERVED_SECRET_PREFIX)) return `a secret's name can't start with ${RESERVED_SECRET_PREFIX}`;
  return null;
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function summary(row: StoredSecret): SecretSummary {
  return { name: row.name, pipelines: JSON.parse(row.pipelines) as Pipeline[], changedAt: row.changed_at };
}

/** One project's secrets. What a secret may be is checked here; who may act, in the task store. */
export class Secrets {
  readonly #sql: Sql;
  readonly #keyring: Keyring;
  readonly #now: () => Date;

  constructor({ sql, keyring, now }: { sql: Sql; keyring: Keyring; now: () => Date }) {
    this.#sql = sql;
    this.#keyring = keyring;
    this.#now = now;
    for (const statement of SCHEMA) sql.exec(statement);
  }

  /** Every secret, by name. */
  list(): SecretSummary[] {
    return this.#sql.exec<StoredSecret>("SELECT * FROM secrets ORDER BY name").map(summary);
  }

  /**
   * Sets project `project`'s secret `name`. A new one needs a value, and is allowed in no pipeline
   * unless `change` names some; an existing one keeps what `change` leaves out.
   */
  async put(project: string, name: string, change: SecretChange): Promise<SecretSummary> {
    const invalidName = secretNameError(name);
    if (invalidName !== null) throw new ServiceError("invalidRequest", invalidName);
    const { value, pipelines } = change;
    if (value === undefined && pipelines === undefined) {
      throw new ServiceError("invalidRequest", "give a value, pipelines, or both");
    }
    if (value !== undefined && (value.length < MIN_SECRET_LENGTH || value.length > MAX_SECRET_LENGTH)) {
      const range = `${MIN_SECRET_LENGTH} to ${MAX_SECRET_LENGTH}`;
      throw new ServiceError("invalidRequest", `a secret's value must be ${range} characters long`);
    }
    const allowed = pipelines === undefined ? null : JSON.stringify(PIPELINES.filter((p) => pipelines.includes(p)));
    const changedAt = this.#now().toISOString();
    let row: StoredSecret | undefined;
    if (value === undefined) {
      [row] = this.#sql.exec<StoredSecret>(
        "UPDATE secrets SET pipelines = ?, changed_at = ? WHERE name = ? RETURNING *",
        allowed,
        changedAt,
        name,
      );
    } else {
      const sealed = await sealSecret(this.#keyring, project, name, value);
      [row] = this.#sql.exec<StoredSecret>(
        `INSERT INTO secrets (name, ciphertext, iv, key_id, pipelines, changed_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (name) DO UPDATE SET ciphertext = excluded.ciphertext, iv = excluded.iv,
           key_id = excluded.key_id, pipelines = CASE WHEN ? THEN excluded.pipelines ELSE pipelines END,
           changed_at = excluded.changed_at
         RETURNING *`,
        name,
        encodeBase64(sealed.ciphertext),
        encodeBase64(sealed.iv),
        sealed.keyId,
        allowed ?? "[]",
        changedAt,
        allowed === null ? 0 : 1,
      );
    }
    if (row === undefined) throw new ServiceError("notFound", `no secret ${name}; give it a value first`);
    return summary(row);
  }

  /** Deletes secret `name`, returning what it was. */
  delete(name: string): SecretSummary {
    const [row] = this.#sql.exec<StoredSecret>("DELETE FROM secrets WHERE name = ? RETURNING *", name);
    if (row === undefined) throw new ServiceError("notFound", `no secret ${name}`);
    return summary(row);
  }

  /**
   * The sealed values of `names` for a step of a run in `pipeline`, as the settings are now; or the
   * first that has no value or isn't allowed there, saying why. Never opened here: the step that
   * starts the container opens them.
   */
  sealedFor(names: readonly string[], pipeline: Pipeline): { sealed: SealedSecret[] } | SecretRefusal {
    if (names.length === 0) return { sealed: [] };
    const rows = new Map(
      this.#sql
        .exec<StoredSecret>(`SELECT * FROM secrets WHERE name IN (${names.map(() => "?").join(", ")})`, ...names)
        .map((row) => [row.name, row]),
    );
    const sealed: SealedSecret[] = [];
    for (const name of names) {
      const row = rows.get(name);
      const refused = secretRefused(name, row === undefined ? undefined : summary(row), pipeline);
      if (refused !== null) return refused;
      if (row !== undefined) sealed.push({ name, ciphertext: row.ciphertext, iv: row.iv, keyId: row.key_id });
    }
    return { sealed };
  }
}

/** A secret a step can't have, and why: `secret DEPLOY isn't allowed in the default pipeline by the project settings`. */
export interface SecretRefusal {
  secret: string;
  error: string;
}

/** Why secret `name`, which is `found` in the settings or not, can't reach a step of a run in `pipeline`; null when it can. */
export function secretRefused(
  name: string,
  found: SecretSummary | undefined,
  pipeline: Pipeline,
): SecretRefusal | null {
  if (found === undefined) return { secret: name, error: `secret ${name} has no value in the project settings` };
  if (!found.pipelines.includes(pipeline)) {
    return { secret: name, error: `secret ${name} isn't allowed in the ${pipeline} pipeline by the project settings` };
  }
  return null;
}

/** A sealed value as a run's step loads it from the project: its row's base64 fields. */
export interface SealedSecret {
  name: string;
  ciphertext: string;
  iv: string;
  keyId: string;
}

/** Opens a value project `project`'s step loaded (`Secrets.sealedFor`). */
export async function openSealed(keyring: Keyring, project: string, sealed: SealedSecret): Promise<string> {
  return openSecret(keyring, project, sealed.name, {
    ciphertext: columnBytes(sealed.ciphertext),
    iv: columnBytes(sealed.iv),
    keyId: sealed.keyId,
  });
}

/** A sealed value's base64 column as bytes. */
function columnBytes(text: string): Uint8Array<ArrayBuffer> {
  const bytes = decodeBase64(text);
  if (bytes === null) throw new Error("a sealed secret's column isn't base64");
  return bytes;
}

/** What a secret's value, or one of its encoded forms, reads as once masked. */
export const SECRET_MASK = "***";

/**
 * Masks every value in `values` in a text: the value itself, its base64 (with or without padding) and
 * its URL encoding. Longer forms go first, so one form inside another is masked whole. Masking is a
 * courtesy against accidental prints; what keeps a value from anyone else's code is trust.
 */
export function masking(values: readonly string[]): (text: string) => string {
  const forms = new Set<string>();
  for (const value of values) {
    const base64 = encodeBase64(new TextEncoder().encode(value));
    for (const form of [value, base64, base64.replace(/=+$/u, ""), encodeURIComponent(value)]) forms.add(form);
  }
  const longestFirst = [...forms].filter((form) => form !== "").toSorted((a, b) => b.length - a.length);
  return (text) => longestFirst.reduce((masked, form) => masked.replaceAll(form, SECRET_MASK), text);
}

/** `value` with `mask` applied to every string in it, at any depth. */
export function maskedDeep<T>(value: T, mask: (text: string) => string): T {
  if (typeof value === "string") return mask(value) as T;
  if (Array.isArray(value)) return value.map((item: unknown) => maskedDeep(item, mask)) as T;
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, maskedDeep(item, mask)])) as T;
  }
  return value;
}

/**
 * Where `main`'s config names a secret, for its settings: each name, the steps naming it, and what
 * would stop a run handing it to them. Every setup and check runs in every pipeline.
 */
export interface SecretUse {
  name: string;
  /** The steps naming it, as a run's errors name them: `setup deps`, `check test`. */
  steps: string[];
  /** Whether it has a value in the settings. */
  hasValue: boolean;
  /** The pipelines that run those steps but the settings don't allow it in. */
  notAllowedIn: Pipeline[];
}

/** Each secret the config's setups and checks name (see `namedSecrets`), by name, against the settings. */
export function secretUses(named: readonly NamedSecrets[], secrets: readonly SecretSummary[]): SecretUse[] {
  const steps = new Map<string, string[]>();
  for (const { step, secrets: names } of named) {
    for (const name of names) steps.set(name, [...(steps.get(name) ?? []), step]);
  }
  const byName = new Map(secrets.map((secret) => [secret.name, secret]));
  return [...steps]
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([name, used]) => {
      const found = byName.get(name);
      return {
        name,
        steps: used,
        hasValue: found !== undefined,
        notAllowedIn: found === undefined ? [] : PIPELINES.filter((p) => !found.pipelines.includes(p)),
      };
    });
}
