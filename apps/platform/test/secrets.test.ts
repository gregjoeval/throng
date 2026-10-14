// Sealing a secret's value: AES-256-GCM under the keyring's current key, bound to the project, the
// name and the key id, and opened again with the key its row names, so the key can be rotated.

import { describe, expect, it } from "vitest";
import {
  keyringFrom,
  maskedDeep,
  masking,
  openSealed,
  openSecret,
  sealSecret,
  Secrets,
  secretUses,
} from "../src/secrets.ts";
import { testSql } from "./support/task-backend.ts";

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

describe("a step's secrets", () => {
  const keyring = keyringFrom(keyringJson("k1", ["k1"]));
  const NOW = new Date("2026-10-10T12:00:00.000Z");

  async function secrets() {
    const store = new Secrets({ sql: testSql(), keyring, now: () => NOW });
    await store.put("abc123", "DEPLOY_TOKEN", { value: VALUE, pipelines: ["default"] });
    await store.put("abc123", "PROD_TOKEN", { value: "prod-token-0123456789", pipelines: ["main"] });
    return store;
  }

  it("loads the sealed values a step names, unopened, which open to their values", async () => {
    const loaded = (await secrets()).sealedFor(["DEPLOY_TOKEN"], "default");
    if (!("sealed" in loaded)) throw new Error(loaded.error);
    expect(JSON.stringify(loaded)).not.toContain(VALUE);
    const [sealed] = loaded.sealed;
    if (sealed === undefined) throw new Error("nothing loaded");
    expect(sealed).toMatchObject({ name: "DEPLOY_TOKEN", keyId: "k1" });
    expect(await openSealed(keyring, "abc123", sealed)).toBe(VALUE);
  });

  it("refuses, naming the first, a secret with no value or not allowed in the run's pipeline", async () => {
    const store = await secrets();
    expect(store.sealedFor(["DEPLOY_TOKEN", "NOPE"], "default")).toEqual({
      secret: "NOPE",
      error: "secret NOPE has no value in the project settings",
    });
    expect(store.sealedFor(["PROD_TOKEN"], "default")).toEqual({
      secret: "PROD_TOKEN",
      error: "secret PROD_TOKEN isn't allowed in the default pipeline by the project settings",
    });
    expect(store.sealedFor([], "default")).toEqual({ sealed: [] });
  });

  it("says where main's config names each secret, and which have no value or aren't allowed where they run", async () => {
    const store = await secrets();
    const named = [
      { step: "setup deps", secrets: ["NPM_TOKEN"] },
      { step: "check deploy", secrets: ["DEPLOY_TOKEN", "PROD_TOKEN"] },
      { step: "check smoke", secrets: ["DEPLOY_TOKEN"] },
    ];
    expect(secretUses(named, store.list())).toEqual([
      { name: "DEPLOY_TOKEN", steps: ["check deploy", "check smoke"], hasValue: true, notAllowedIn: ["main"] },
      { name: "NPM_TOKEN", steps: ["setup deps"], hasValue: false, notAllowedIn: [] },
      { name: "PROD_TOKEN", steps: ["check deploy"], hasValue: true, notAllowedIn: ["default"] },
    ]);
  });
});

describe("masking", () => {
  const value = "dep/loy+tok=en&more?";
  const base64 = btoa(value);

  it("hides a value, its base64 with or without padding, and its URL encoding", () => {
    const mask = masking([value]);
    const text = `raw ${value} b64 ${base64} bare ${base64.replace(/=+$/u, "")} url ${encodeURIComponent(value)}`;
    expect(mask(text)).toBe("raw *** b64 *** bare *** url ***");
  });

  it("hides every value given, and leaves text without one alone", () => {
    const mask = masking([value, "npm-token-0123456789"]);
    expect(mask(`npm-token-0123456789 and ${value}`)).toBe("*** and ***");
    expect(mask("nothing secret here")).toBe("nothing secret here");
    expect(masking([])(value)).toBe(value);
  });

  it("masks every string in a value, at any depth", () => {
    const masked = maskedDeep({ a: { value }, b: [value, 3], c: null }, masking([value]));
    expect(masked).toEqual({ a: { value: "***" }, b: ["***", 3], c: null });
  });
});
