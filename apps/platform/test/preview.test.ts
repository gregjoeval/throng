import { describe, expect, it } from "vitest";
import { MAX_LABEL, previewGrant, previewName, previewPathAllowed } from "../src/preview.ts";

const grant = { accountId: "acct", workerName: "fixture" };

describe("previewPathAllowed", () => {
  it("allows the previewed Worker and the subdomain lookup", () => {
    expect(previewPathAllowed("/client/v4/accounts/acct/workers/scripts/fixture", grant)).toBeTruthy();
    expect(previewPathAllowed("/client/v4/accounts/acct/workers/workers/fixture/previews", grant)).toBeTruthy();
    expect(previewPathAllowed("/client/v4/accounts/acct/workers/subdomain", grant)).toBeTruthy();
  });

  it("refuses other Workers, other accounts, and everything else", () => {
    expect(previewPathAllowed("/client/v4/accounts/acct/workers/scripts/throng", grant)).toBeFalsy();
    expect(previewPathAllowed("/client/v4/accounts/acct/workers/scripts/fixture-other", grant)).toBeFalsy();
    expect(previewPathAllowed("/client/v4/accounts/other/workers/scripts/fixture", grant)).toBeFalsy();
    expect(previewPathAllowed("/client/v4/user/tokens", grant)).toBeFalsy();
    expect(previewPathAllowed("/client/v4/accounts/acct/r2/buckets", grant)).toBeFalsy();
  });
});

describe("previewGrant", () => {
  it("names the project's own Worker, p<projectId>", () => {
    expect(previewGrant("acct", "abc123")).toEqual({ accountId: "acct", workerName: "pabc123" });
  });
});

describe("previewName", () => {
  it("names a Preview after the attempt fork, so its host label is <forkName>-p<projectId>", () => {
    const name = previewName({ project: "abc123", attempt: "t42a3" });
    expect(name).toBe("t42a3");
    expect(`${name}-${previewGrant("acct", "abc123").workerName}`).toBe("t42a3-pabc123");
  });

  it("shortens a name whose host label would pass 63 characters, keeping its start and a hash of it", () => {
    const project = "p".repeat(40);
    const attempt = "t1234567a12345678901234";
    const name = previewName({ project, attempt });
    expect(`${name}-p${project}`).toHaveLength(MAX_LABEL);
    expect(name).toMatch(/^t1234567a123-[a-z0-9]{8}$/u);
    expect(previewName({ project, attempt })).toBe(name);
    expect(previewName({ project, attempt: "t1234567a12345678901235" })).not.toBe(name);
  });

  it("keeps a name that fits exactly", () => {
    const project = "a".repeat(MAX_LABEL - "t1a1-p".length);
    expect(previewName({ project, attempt: "t1a1" })).toBe("t1a1");
  });
});
