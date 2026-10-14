// Sealing a secret's value: AES-256-GCM under the keyring's current key, bound to the project, the
// name and the key id, and opened again with the key its row names, so the key can be rotated.

import { describe, expect, it } from "vitest";
import { keyringFrom, openSecret, sealSecret } from "../src/secrets.ts";

/** Key `id`: 32 bytes of its last character, in base64. */
const key = (id: string) => btoa(String.fromCharCode(...new Uint8Array(32).fill(id.charCodeAt(id.length - 1))));

/** A keyring as `SECRETS_KEYRING` holds it: `current` names one of `keys`, each 32 bytes in base64. */
function keyringJson(current: string, ids: string[]): string {
  return JSON.stringify({ current, keys: Object.fromEntries(ids.map((id) => [id, key(id)])) });
}

const VALUE = "cf-token-0123456789";

describe("sealing a secret", () => {
  it("encrypts under the current key with a fresh 12-byte IV, and opens again", async () => {
    const keyring = keyringFrom(keyringJson("k1", ["k1"]));
    const one = await sealSecret(keyring, "abc123", "DEPLOY_TOKEN", VALUE);
    const two = await sealSecret(keyring, "abc123", "DEPLOY_TOKEN", VALUE);
    expect(one.keyId).toBe("k1");
    expect(one.iv).toHaveLength(12);
    expect(one.iv).not.toEqual(two.iv);
    expect(new TextDecoder().decode(one.ciphertext)).not.toContain(VALUE);
    expect(await openSecret(keyring, "abc123", "DEPLOY_TOKEN", one)).toBe(VALUE);
  });

  it("won't open under another project or name", async () => {
    const keyring = keyringFrom(keyringJson("k1", ["k1"]));
    const sealed = await sealSecret(keyring, "abc123", "DEPLOY_TOKEN", VALUE);
    await expect(openSecret(keyring, "xyz789", "DEPLOY_TOKEN", sealed)).rejects.toThrow();
    await expect(openSecret(keyring, "abc123", "OTHER_TOKEN", sealed)).rejects.toThrow();
  });

  it("opens a value sealed under an older key once a new one is current", async () => {
    const sealed = await sealSecret(keyringFrom(keyringJson("k1", ["k1"])), "abc123", "DEPLOY_TOKEN", VALUE);
    const rotated = keyringFrom(keyringJson("k2", ["k1", "k2"]));
    expect(await openSecret(rotated, "abc123", "DEPLOY_TOKEN", sealed)).toBe(VALUE);
    expect((await sealSecret(rotated, "abc123", "DEPLOY_TOKEN", VALUE)).keyId).toBe("k2");
    // Its key id is bound in too: claiming another key's id doesn't open it.
    await expect(openSecret(rotated, "abc123", "DEPLOY_TOKEN", { ...sealed, keyId: "k2" })).rejects.toThrow();
  });

  it("imports keys that can't be exported", async () => {
    const { key: imported } = await keyringFrom(keyringJson("k1", ["k1"])).current();
    expect(imported.extractable).toBeFalsy();
    expect(imported.algorithm).toMatchObject({ name: "AES-GCM", length: 256 });
  });

  it.each([
    ["missing", undefined],
    ["not JSON", "nope"],
    ["without its current key", JSON.stringify({ current: "k2", keys: { k1: btoa("x".repeat(32)) } })],
    ["with a short key", JSON.stringify({ current: "k1", keys: { k1: btoa("x".repeat(16)) } })],
  ])("refuses a keyring %s, when it's used", async (_, raw) => {
    const keyring = keyringFrom(raw);
    await expect(sealSecret(keyring, "abc123", "DEPLOY_TOKEN", VALUE)).rejects.toThrow(/SECRETS_KEYRING/u);
  });
});
