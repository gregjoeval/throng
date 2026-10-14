import { describe, expect, it } from "vitest";
import { randomUserId, userForEmail, userHandles } from "../src/users.ts";
import { testDatabase } from "./support/d1.ts";

describe("userForEmail", () => {
  it("creates a user the first time an email is seen, then returns the same one", async () => {
    const db = testDatabase();
    const first = await userForEmail(db, "greg@example.com");
    expect(first).toMatchObject({ handle: "greg", email: "greg@example.com" });
    expect(first.id).toMatch(/^[a-z0-9]{8}$/u);
    expect(await userForEmail(db, "greg@example.com")).toEqual(first);
  });

  it("de-duplicates handles with a numeric suffix", async () => {
    const db = testDatabase();
    await userForEmail(db, "greg@example.com");
    expect((await userForEmail(db, "greg@work.example")).handle).toBe("greg2");
    expect((await userForEmail(db, "greg@home.example")).handle).toBe("greg3");
  });

  it("retries the id when a random one is already taken", async () => {
    const db = testDatabase();
    expect((await userForEmail(db, "a@example.com", () => "aaaaaaaa")).id).toBe("aaaaaaaa");
    const ids = ["aaaaaaaa", "bbbbbbbb"];
    expect((await userForEmail(db, "b@example.com", () => ids.shift() ?? "cccccccc")).id).toBe("bbbbbbbb");
  });

  it("makes a handle from local parts that aren't valid handles", async () => {
    const db = testDatabase();
    expect((await userForEmail(db, "Greg.Joe+throng@example.com")).handle).toBe("greg-joe-throng");
    expect((await userForEmail(db, "+++@example.com")).handle).toBe("user");
  });
});

describe("randomUserId", () => {
  it("is 8 lowercase alphanumeric characters", () => {
    for (let i = 0; i < 100; i++) expect(randomUserId()).toMatch(/^[a-z0-9]{8}$/u);
  });
});

describe("userHandles", () => {
  it("reads each user's handle by id, once each, skipping unknown ids and nulls", async () => {
    const db = testDatabase();
    const greg = await userForEmail(db, "greg@example.com");
    const ada = await userForEmail(db, "ada@example.com");
    expect(await userHandles(db, [greg.id, ada.id, greg.id, null, "nobody01"])).toEqual(
      new Map([
        [greg.id, "greg"],
        [ada.id, "ada"],
      ]),
    );
    expect(await userHandles(db, [])).toEqual(new Map());
  });
});
