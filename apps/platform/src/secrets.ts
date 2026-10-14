// Project secrets: a name, a write-only value and the pipelines it may be used in, kept in the project
// Durable Object's SQLite and never in the D1 projection. Values are sealed with AES-256-GCM through Web
// Crypto: a random 12-byte IV each time, with `projectId/name/keyId` as additional data, under a key from
// the keyring in the `SECRETS_KEYRING` Worker secret. Each row names the key that sealed it, so a new
// key can become current while older ones still open the rows they sealed. The task store checks who
// may read and change them, and journals every change without its value.

/** The keyring's id of each key, and the key: 32 bytes, base64. */
const KEY_ID = /^[A-Za-z0-9_-]{1,64}$/u;
const KEY_BYTES = 32;
const IV_BYTES = 12;

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
  ciphertext: Uint8Array;
  iv: Uint8Array;
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

function decodeBase64(text: string): Uint8Array | null {
  try {
    return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

/** What a sealed value is bound to: its project, its name and the key that sealed it. */
function additionalData(project: string, name: string, keyId: string): Uint8Array {
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
