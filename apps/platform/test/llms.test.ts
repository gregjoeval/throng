// `GET /llms.txt`: the public guide an agent reads first. It is plain text, needs no token, names this
// host's URLs, and stays in step with the MCP server's tools.

import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";
import { publicApp } from "../src/app.ts";
import { mintToken } from "../src/tokens.ts";
import { userForEmail } from "../src/users.ts";
import { FakeRepos } from "./fake-repos.ts";
import { testDatabase } from "./support/d1.ts";
import { testTaskBackends } from "./support/task-backend.ts";

const ORIGIN = "https://throng.test";
const now = () => new Date("2026-10-10T12:00:00.000Z");

function setup() {
  const repos = new FakeRepos();
  const { backend } = testTaskBackends(repos, now);
  const app = publicApp({ verifierFor: () => async () => null, now, repos: () => repos, tasks: () => backend });
  const env = { DB: testDatabase(), ACCESS_TEAM_DOMAIN: "throng.cloudflareaccess.com", ACCESS_AUD: "aud" };
  return { app, env };
}

describe("the Sandbox size", () => {
  it("names the config key, its sizes and their resources, its default and that it's read from main", async () => {
    const { text } = await llms();
    expect(text).toContain("sandbox: {size: standard-2}");
    expect(text).toContain("lite (256 MiB, 1/16 vCPU), standard-1 (4 GiB, 1/2 vCPU), standard-2 (6 GiB, 1 vCPU),");
    expect(text).toContain("standard-3 (8 GiB, 2 vCPU) or standard-4 (12 GiB, 4 vCPU)");
    expect(text).toContain("The default is standard-1.");
    expect(text).toContain("read from the origin's `main`");
  });
});

async function llms() {
  const { app, env } = setup();
  const res = await app.request(`${ORIGIN}/llms.txt`, {}, env);
  return { status: res.status, type: res.headers.get("Content-Type"), text: await res.text() };
}

/** The names of the tools `/mcp` lists, asked of the server itself. */
async function mcpTools(): Promise<string[]> {
  const { app, env } = setup();
  const user = await userForEmail(env.DB, "greg@example.com");
  const { plaintext } = await mintToken(env.DB, { userId: user.id, alias: "claude", ttlSeconds: 3600, now: now() });
  const transport = new StreamableHTTPClientTransport(new URL(`${ORIGIN}/mcp`), {
    fetch: (input, init) =>
      Promise.resolve(app.request(input instanceof Request ? input : new Request(input, init), undefined, env)),
    requestInit: { headers: { Authorization: `Bearer ${plaintext}` } },
  });
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(transport);
  const { tools } = await client.listTools();
  await client.close();
  return tools.map((t) => t.name);
}

describe("/llms.txt", () => {
  it("is served as plain text without a token", async () => {
    const res = await llms();
    expect(res.status).toBe(200);
    expect(res.type).toMatch(/^text\/plain/u);
    expect(res.text).toMatch(/^# Throng\n/u);
  });

  it("names this host's MCP URL, git remotes and OpenAPI document", async () => {
    const { text } = await llms();
    expect(text).toContain(`${ORIGIN}/mcp`);
    expect(text).toContain(
      `git clone -c http.extraHeader="Authorization: Bearer $THRONG_TOKEN" ${ORIGIN}/git/<owner>/<project>/t42a3.git`,
    );
    expect(text).toContain(`${ORIGIN}/git/<owner>/<project>/t42a3.git`);
    expect(text).toContain(`${ORIGIN}/api/openapi.json`);
  });

  it("says what a check may reach, and that a registry stays read-only even when network.allow lists it", async () => {
    const { text } = await llms();
    expect(text).toContain("## Network access");
    expect(text).toContain("`registry.npmjs.org`");
    expect(text).toContain("`.npmrc` on the origin's `main`");
    expect(text).toContain("`GET` and `HEAD` only, even when `network.allow` lists it too");
  });

  it("mentions every tool the MCP server lists", async () => {
    const [{ text }, tools] = await Promise.all([llms(), mcpTools()]);
    expect(tools).toContain("start_attempts");
    expect(tools.filter((name) => !text.includes(`\`${name}\``))).toEqual([]);
  });
});
