import { describe, expect, it } from "vitest";
import { ServiceError } from "../src/errors.ts";
import { checkSourceUrl, importError, resolveSource } from "../src/import-source.ts";
import { concat, flushPkt, pktLine } from "../src/pkt-line.ts";

function rejection(url: string): ServiceError {
  let thrown: unknown = null;
  try {
    checkSourceUrl(url);
  } catch (error) {
    thrown = error;
  }
  expect(thrown, url).toBeInstanceOf(ServiceError);
  return thrown as ServiceError;
}

describe("checkSourceUrl", () => {
  it("accepts a public HTTPS git URL on any host", () => {
    for (const url of [
      "https://github.com/octocat/Hello-World",
      "https://github.com/octocat/Hello-World.git",
      "https://gitlab.com/group/sub/project.git",
      "https://codeberg.org/forgejo/forgejo",
    ]) {
      expect(() => checkSourceUrl(url), url).not.toThrow();
    }
  });

  it("rejects anything but https", () => {
    for (const url of ["http://github.com/o/r", "git://github.com/o/r", "ssh://git@github.com/o/r", "file:///r"]) {
      expect(rejection(url).code, url).toBe("invalidRequest");
    }
  });

  it("rejects what isn't a URL", () => {
    for (const url of ["", "github.com/o/r", "git@github.com:o/r.git"]) {
      expect(rejection(url).code, url).toBe("invalidRequest");
    }
  });

  it("rejects credentials in the URL, so none is stored as the repo's source", () => {
    for (const url of ["https://x-access-token:ghp_secret@github.com/o/r", "https://user@github.com/o/r"]) {
      const err = rejection(url);
      expect(err.code, url).toBe("invalidRequest");
      expect(err.message).not.toContain("ghp_secret");
    }
  });

  it("rejects a query or a fragment", () => {
    for (const url of [
      "https://github.com/o/r?tab=readme",
      "https://github.com/o/r#readme",
      "https://github.com/o/r?",
    ]) {
      expect(rejection(url).code, url).toBe("invalidRequest");
    }
  });

  it("rejects an IP address or a single-label host, so the probe can't reach a private network", () => {
    for (const url of [
      "https://127.0.0.1/o/r",
      "https://10.0.0.1/o/r",
      "https://0x7f.1/o/r",
      "https://2130706433/o/r",
      "https://[::1]/o/r",
      "https://[fd00::1]/o/r",
      "https://localhost/o/r",
      "https://localhost./o/r",
      "https://metadata/o/r",
    ]) {
      expect(rejection(url).code, url).toBe("invalidRequest");
    }
  });

  it("returns the URL normalized", () => {
    expect(checkSourceUrl("HTTPS://GitHub.com/octocat/Hello-World")).toBe("https://github.com/octocat/Hello-World");
    expect(checkSourceUrl("https://github.com:443/o/r")).toBe("https://github.com/o/r");
  });

  it("rejects a URL over 2048 characters", () => {
    const base = "https://github.com/o/";
    expect(() => checkSourceUrl(base + "r".repeat(2048 - base.length))).not.toThrow();
    expect(rejection(base + "r".repeat(2049 - base.length)).code).toBe("invalidRequest");
  });
});

const SHA = "a".repeat(40);

/** A host answering the upload-pack advertisement with HEAD at `branch`, and recording what it was asked. */
function host(answer: (url: string) => Response) {
  const asked: { url: string; headers: Headers }[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    expect(init?.redirect).toBe("manual");
    asked.push({ url, headers: new Headers(init?.headers) });
    return answer(url);
  };
  return { fetcher, asked };
}

function advertising(branch: string | null, type = "application/x-git-upload-pack-advertisement"): Response {
  const capabilities = branch === null ? "multi_ack" : `multi_ack symref=HEAD:refs/heads/${branch}`;
  const body = concat([
    pktLine("# service=git-upload-pack\n"),
    flushPkt(),
    pktLine(`${SHA} HEAD\0${capabilities}\n`),
    flushPkt(),
  ]);
  return new Response(body, { headers: { "Content-Type": type } });
}

function redirect(location: string): Response {
  return new Response(null, { status: 301, headers: { Location: location } });
}

/** A host redirecting each repo to the next one, `r` to `r1` to `r2` and on, forever. */
function redirectLoop(url: string): Response {
  return redirect(url.replace(/\/r(\d*)\.git/u, (_m, n: string) => `/r${Number(n) + 1}.git`));
}

/** A host the network can't reach, as `fetch` reports it. */
const unreachableHost: typeof fetch = async () => {
  throw new TypeError("fetch failed");
};

async function probeFailure(fetcher: typeof fetch, url = "https://github.com/o/r"): Promise<ServiceError> {
  const err = await resolveSource(fetcher, checkSourceUrl(url)).then(
    () => null,
    (error: unknown) => error,
  );
  expect(err).toBeInstanceOf(ServiceError);
  return err as ServiceError;
}

describe("resolveSource", () => {
  it("asks the source's upload-pack advertisement, adding .git when the URL lacks it", async () => {
    const { fetcher, asked } = host(() => advertising("master"));
    for (const url of [
      "https://github.com/octocat/Hello-World",
      "https://codeberg.org/o/r.git",
      "https://gitlab.com/o/r/",
    ]) {
      expect(await resolveSource(fetcher, checkSourceUrl(url))).toEqual({ url, branch: "master" });
    }
    expect(asked.map((a) => a.url)).toEqual([
      "https://github.com/octocat/Hello-World.git/info/refs?service=git-upload-pack",
      "https://codeberg.org/o/r.git/info/refs?service=git-upload-pack",
      "https://gitlab.com/o/r.git/info/refs?service=git-upload-pack",
    ]);
    // Anonymously: no credential of any kind goes to the source's host.
    expect(asked.filter((a) => a.headers.has("Authorization"))).toEqual([]);
  });

  it("reads a Content-Type with parameters or in another case by its media type", async () => {
    for (const type of [
      "application/x-git-upload-pack-advertisement; charset=utf-8",
      "Application/X-Git-Upload-Pack-Advertisement",
    ]) {
      const { fetcher } = host(() => advertising("trunk", type));
      expect((await resolveSource(fetcher, checkSourceUrl("https://github.com/o/r"))).branch, type).toBe("trunk");
    }
  });

  it("follows a redirect on the same host over https, and returns the URL it ends at", async () => {
    const { fetcher, asked } = host((url) => {
      if (url.startsWith("https://github.com/old/")) {
        return redirect("https://github.com/new/r.git/info/refs?service=git-upload-pack");
      }
      if (url.startsWith("https://github.com/new/")) return redirect("/newer/r.git/info/refs?service=git-upload-pack");
      return advertising("main");
    });
    expect(await resolveSource(fetcher, checkSourceUrl("https://github.com/old/r"))).toEqual({
      url: "https://github.com/newer/r.git",
      branch: "main",
    });
    expect(asked.map((a) => a.url)).toEqual([
      "https://github.com/old/r.git/info/refs?service=git-upload-pack",
      "https://github.com/new/r.git/info/refs?service=git-upload-pack",
      "https://github.com/newer/r.git/info/refs?service=git-upload-pack",
    ]);
  });

  it("is notFound for a redirect to another host, to http, off the advertisement, or past 3 hops", async () => {
    const answers: [string, (url: string) => Response][] = [
      ["other host", () => redirect("https://evil.example.com/o/r.git/info/refs?service=git-upload-pack")],
      ["http", () => redirect("http://github.com/o/r.git/info/refs?service=git-upload-pack")],
      ["IP host", () => redirect("https://127.0.0.1/o/r.git/info/refs?service=git-upload-pack")],
      ["sign-in page", () => redirect("https://github.com/login")],
      ["no Location", () => new Response(null, { status: 302 })],
      ["hop cap", redirectLoop],
    ];
    for (const [why, answer] of answers) {
      const { fetcher, asked } = host(answer);
      const err = await probeFailure(fetcher);
      expect(err.code, why).toBe("notFound");
      expect(err.message, why).toBe(
        "https://github.com/o/r redirects elsewhere: use the repository's current https URL on its own host",
      );
      expect(asked.length, why).toBeLessThanOrEqual(4);
      for (const init of asked) expect(init.url, why).toMatch(/^https:\/\/github\.com\//u);
    }
    const { fetcher, asked } = host(redirectLoop);
    await probeFailure(fetcher);
    expect(asked).toHaveLength(4);
  });

  it("is notFound when the host wants credentials or has no such repo", async () => {
    for (const status of [401, 404]) {
      const err = await probeFailure(host(() => new Response("no", { status })).fetcher);
      expect(err.code, String(status)).toBe("notFound");
      expect(err.message).toContain("only public repositories can be imported");
    }
  });

  it("is invalidRequest when the URL doesn't serve a git repository", async () => {
    const html = new Response("<!doctype html>", { headers: { "Content-Type": "text/html" } });
    const garbled = new Response("not pkt-lines", {
      headers: { "Content-Type": "application/x-git-upload-pack-advertisement" },
    });
    for (const answer of [html, garbled]) {
      const err = await probeFailure(host(() => answer).fetcher);
      expect(err.code).toBe("invalidRequest");
      expect(err.message).toContain("not a git repository");
    }
  });

  it("is invalidRequest when the source doesn't say which branch is its default", async () => {
    const err = await probeFailure(host(() => advertising(null)).fetcher);
    expect(err.code).toBe("invalidRequest");
    expect(err.message).toContain("default branch");
  });

  it("is unavailable when the host can't be reached or fails", async () => {
    for (const fetcher of [unreachableHost, host(() => new Response("oops", { status: 502 })).fetcher]) {
      const err = await probeFailure(fetcher);
      expect(err.code).toBe("unavailable");
      expect(err.message).toBe("couldn't reach github.com; try again");
    }
  });
});

/** An error shaped like the binding's `ArtifactsError`. */
function artifactsError(code: string): Error {
  return Object.assign(new Error(`${code}: upstream said no`), { name: "ArtifactsError", code });
}

describe("importError", () => {
  const url = "https://github.com/o/r";

  it("maps each Artifacts import failure to a service error the caller can act on", () => {
    const cases: [string, string, string][] = [
      ["REMOTE_AUTH_REQUIRED", "notFound", "only public repositories can be imported"],
      ["NOT_FOUND", "notFound", "only public repositories can be imported"],
      ["INVALID_URL", "invalidRequest", "not a git repository"],
      ["INVALID_INPUT", "invalidRequest", "not a git repository"],
      ["MEMORY_LIMIT", "invalidRequest", "too large to import (Artifacts' limit is 1 GB per repo)"],
      ["UPSTREAM_UNAVAILABLE", "unavailable", "couldn't reach github.com; try again"],
    ];
    for (const [code, kind, message] of cases) {
      const mapped = importError(artifactsError(code), url);
      expect(mapped, code).toBeInstanceOf(ServiceError);
      expect((mapped as ServiceError).code, code).toBe(kind);
      expect((mapped as ServiceError).message, code).toContain(message);
    }
  });

  it("leaves any other error as it is", () => {
    for (const error of [artifactsError("ALREADY_EXISTS"), artifactsError("INTERNAL_ERROR"), new Error("boom"), "x"]) {
      expect(importError(error, url)).toBe(error);
    }
  });
});
