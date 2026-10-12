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
  it("names a Preview after the attempt fork and the project: <forkName>-p<projectId>", () => {
    expect(previewName({ project: "abc123", attempt: "t42a3" }, "fixture")).toBe("t42a3-pabc123");
  });

  it("shortens a name whose host label would pass 63 characters, keeping its start and a hash of it", () => {
    const worker = "throng-fixture-worker";
    const long = { project: "p".repeat(40), attempt: "t42a3" };
    const name = previewName(long, worker);
    expect(`${name}-${worker}`).toHaveLength(63);
    expect(name).toMatch(/^t42a3-pppp+-[a-z0-9]{8}$/);
    expect(previewName(long, worker)).toBe(name);
    expect(previewName({ ...long, attempt: "t42a4" }, worker)).not.toBe(name);
    expect(previewName({ project: "p".repeat(40), attempt: "t1a1" }, worker)).not.toBe(
      previewName({ project: `${"p".repeat(39)}q`, attempt: "t1a1" }, worker),
    );
  });

  it("keeps a name that fits exactly", () => {
    const worker = "w".repeat(63 - "t1a1-pabcdef".length - 1);
    expect(previewName({ project: "abcdef", attempt: "t1a1" }, worker)).toBe("t1a1-pabcdef");
  });
});
