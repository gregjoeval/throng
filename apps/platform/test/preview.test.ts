import { describe, expect, it } from "vitest";
import { previewName, previewPathAllowed } from "../src/preview.ts";

const grant = { accountId: "acct", workerName: "fixture" };

describe("previewPathAllowed", () => {
  it("allows the previewed Worker and the subdomain lookup", () => {
    expect(previewPathAllowed("/client/v4/accounts/acct/workers/scripts/fixture", grant)).toBe(true);
    expect(previewPathAllowed("/client/v4/accounts/acct/workers/workers/fixture/previews", grant)).toBe(true);
    expect(previewPathAllowed("/client/v4/accounts/acct/workers/subdomain", grant)).toBe(true);
  });

  it("refuses other Workers, other accounts, and everything else", () => {
    expect(previewPathAllowed("/client/v4/accounts/acct/workers/scripts/throng", grant)).toBe(false);
    expect(previewPathAllowed("/client/v4/accounts/acct/workers/scripts/fixture-other", grant)).toBe(false);
    expect(previewPathAllowed("/client/v4/accounts/other/workers/scripts/fixture", grant)).toBe(false);
    expect(previewPathAllowed("/client/v4/user/tokens", grant)).toBe(false);
    expect(previewPathAllowed("/client/v4/accounts/acct/r2/buckets", grant)).toBe(false);
  });
});

describe("previewName", () => {
  it("makes a short DNS-safe label", () => {
    expect(previewName({ project: "Spike_X", attempt: "A1" })).toBe("spike-x-a1");
    expect(previewName({ project: "p".repeat(40), attempt: "a" })).toHaveLength(30);
  });
});
