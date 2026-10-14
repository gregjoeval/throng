import { describe, expect, it } from "vitest";
import { devAccessEmail } from "@/server/dev-access";

describe("devAccessEmail", () => {
  it("is set only under vite dev, and only to a non-empty email", () => {
    expect(devAccessEmail("serve", "ada@example.com")).toBe("ada@example.com");
    expect(devAccessEmail("build", "ada@example.com")).toBeNull();
    expect([devAccessEmail("serve", ""), devAccessEmail("serve", undefined)]).toEqual([null, null]);
  });
});
