import { describe, expect, it } from "vitest";
import { platformUrl } from "../scripts/e2e-browser.ts";

describe("platformUrl", () => {
  it("sends a page's /api request to the platform, keeping its path and query", () => {
    expect(
      platformUrl(
        "https://throng-web-ci.example.workers.dev/api/projects/e2e1/e2e1/compare/aaa...bbb?attempt=t1a1",
        "https://throng-ci.example.workers.dev",
      ),
    ).toBe("https://throng-ci.example.workers.dev/api/projects/e2e1/e2e1/compare/aaa...bbb?attempt=t1a1");
  });

  it("keeps percent-encoding as the page sent it", () => {
    expect(platformUrl("http://localhost:5173/api/projects/a%20b/p/tasks/t1", "https://throng-ci.example")).toBe(
      "https://throng-ci.example/api/projects/a%20b/p/tasks/t1",
    );
  });
});
