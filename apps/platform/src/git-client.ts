// Just enough of a git smart-HTTP client to copy one ref between two repos from inside the Worker:
// what archiving an attempt (fork `main` → origin `refs/attempts/t42a3`) and restoring it (the
// reverse) need. The Artifacts binding has no ref-writing method, so this talks git's own protocol
// to the repos' remotes with tokens Throng mints, and never goes through the public `/git` proxy.
//
// The copy is a fetch followed by a force push: `ls-refs` (protocol v2) reads the source ref, the
// target's receive-pack advertisement gives its refs and capabilities, a v2 `fetch` asks the source
// for a pack of what the target lacks (the target's refs are sent as haves), and that pack is
// streamed straight into the target's receive-pack (v1, the only push protocol Artifacts speaks).
// See `gitprotocol-v2`, `gitprotocol-pack` and `gitprotocol-http`.

import { concat, flushPkt, pktLine } from "./pkt-line.ts";
import type { CopyRef, Repos } from "./repos.ts";

/** A repo's HTTPS git remote and a token for it, sent as `Authorization: Bearer`. */
export interface GitRemote {
  url: string;
  token: string;
}

export interface CopyRefArgs {
  from: GitRemote;
  /** A full ref name in `from`, such as `refs/heads/main`. */
  fromRef: string;
  to: GitRemote;
  /** The full ref name to set in `to`; it is created or force-updated. */
  toRef: string;
  /** When set, the copy fails unless `fromRef` points at this sha. */
  expect?: string | undefined;
}

/** The git server refused or broke the exchange. The message never carries a token. */
export class GitClientError extends Error {
  override readonly name = "GitClientError";
}

const ZERO_ID = /^0+$/;
const OBJECT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
/** At most this many of the target's ref tips are offered to the source as haves. */
const MAX_HAVES = 256;
const AGENT = "agent=throng";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Copies the commit `fromRef` points at in one repo to `toRef` in another, objects and all, and
 * returns its sha. Null when `fromRef` doesn't exist, so there is nothing to copy. Nothing is
 * pushed when `toRef` already points at that commit.
 */
export async function copyRef(fetcher: typeof fetch, args: CopyRefArgs): Promise<string | null> {
  const sha = await lsRef(fetcher, args.from, args.fromRef);
  if (sha === null) return null;
  if (args.expect !== undefined && sha !== args.expect) {
    throw new GitClientError(`${args.fromRef} is at ${sha}, expected ${args.expect}`);
  }
  const target = await receivePackRefs(fetcher, args.to);
  const before = target.refs.get(args.toRef) ?? "0".repeat(sha.length);
  if (before === sha) return sha;
  if (!target.capabilities.has("report-status")) throw new GitClientError("the target doesn't report push status");

  const haves = [...new Set(target.refs.values())].filter((id) => !ZERO_ID.test(id)).slice(0, MAX_HAVES);
  const pack = await fetchPack(fetcher, args.from, sha, haves);
  await pushPack(fetcher, args.to, { ref: args.toRef, before, after: sha }, pack);
  return sha;
}

/** Tokens minted for a copy last this long; Artifacts' minimum is 60 seconds. */
export const COPY_TOKEN_TTL_SECONDS = 10 * 60;

/**
 * `Repos.copyRef` for any `Repos` whose remotes speak smart HTTP with bearer tokens: mints a read
 * token on the source and a write token on the target, then runs `copyRef` with them.
 */
export async function copyRepoRef(
  repos: Pick<Repos, "get" | "mintToken">,
  fetcher: typeof fetch,
  { from, fromRef, to, toRef, expect }: CopyRef,
): Promise<string | null> {
  const remote = async (name: string, scope: "read" | "write"): Promise<GitRemote> => {
    const [info, token] = await Promise.all([repos.get(name), repos.mintToken(name, scope, COPY_TOKEN_TTL_SECONDS)]);
    return { url: info.remote, token: token.token };
  };
  const [source, target] = await Promise.all([remote(from, "read"), remote(to, "write")]);
  return copyRef(fetcher, { from: source, fromRef, to: target, toRef, expect });
}

/** The sha a ref points at, through protocol v2 `ls-refs`; null if there's no such ref. */
async function lsRef(fetcher: typeof fetch, remote: GitRemote, ref: string): Promise<string | null> {
  const body = concat([
    pktLine("command=ls-refs\n"),
    pktLine(`${AGENT}\n`),
    delimPkt(),
    pktLine(`ref-prefix ${ref}\n`),
    flushPkt(),
  ]);
  const response = await post(fetcher, remote, "git-upload-pack", body, { "Git-Protocol": "version=2" });
  const reader = new PktReader(response.body);
  let found: string | null = null;
  for (;;) {
    const pkt = await reader.next();
    if (pkt === "flush") return found;
    if (pkt === null || pkt === "delim") throw new GitClientError("malformed ls-refs response");
    const [id, name] = text(pkt).split(" ");
    if (name === ref && id !== undefined && OBJECT_ID.test(id)) found = id;
  }
}

/** The target's refs (and `.have` objects) and push capabilities, from its receive-pack advertisement. */
async function receivePackRefs(
  fetcher: typeof fetch,
  remote: GitRemote,
): Promise<{ refs: Map<string, string>; capabilities: Set<string> }> {
  const response = await request(fetcher, remote, "info/refs?service=git-receive-pack", { method: "GET" });
  const reader = new PktReader(response.body);
  const refs = new Map<string, string>();
  let capabilities = new Set<string>();
  const first = await reader.next();
  if (first === null || first === "flush" || first === "delim" || !text(first).startsWith("# service=")) {
    throw new GitClientError("not a smart HTTP receive-pack advertisement");
  }
  if ((await reader.next()) !== "flush") throw new GitClientError("malformed receive-pack advertisement");
  for (let index = 0; ; index++) {
    const pkt = await reader.next();
    if (pkt === "flush" || pkt === null) break;
    if (pkt === "delim") throw new GitClientError("malformed receive-pack advertisement");
    let line = text(pkt);
    if (index === 0) {
      const nul = line.indexOf("\0");
      if (nul !== -1) {
        capabilities = new Set(
          line
            .slice(nul + 1)
            .split(" ")
            .filter(Boolean),
        );
        line = line.slice(0, nul);
      }
    }
    const [id, name] = line.split(" ");
    if (id === undefined || name === undefined || !OBJECT_ID.test(id)) continue;
    if (name === "capabilities^{}") continue;
    // `.have` lines name objects the target can reach without a ref; they still make good haves.
    refs.set(name === ".have" ? `.have ${id}` : name, id);
  }
  return { refs, capabilities };
}

/**
 * A pack holding `want` and everything it reaches that `haves` don't, through a protocol v2
 * `fetch`. Thin packs aren't asked for, so the pack never refers to objects outside itself. The
 * pack streams out of the response's side-band as it arrives.
 */
async function fetchPack(
  fetcher: typeof fetch,
  remote: GitRemote,
  want: string,
  haves: string[],
): Promise<ReadableStream<Uint8Array>> {
  const body = concat([
    pktLine("command=fetch\n"),
    pktLine(`${AGENT}\n`),
    delimPkt(),
    pktLine("no-progress\n"),
    pktLine(`want ${want}\n`),
    ...haves.map((id) => pktLine(`have ${id}\n`)),
    pktLine("done\n"),
    flushPkt(),
  ]);
  const response = await post(fetcher, remote, "git-upload-pack", body, { "Git-Protocol": "version=2" });
  const reader = new PktReader(response.body);
  // Having sent `done`, the server skips acknowledgments; other sections may still come first.
  for (;;) {
    const pkt = await reader.next();
    if (pkt === null || pkt === "flush") throw new GitClientError("the fetch response has no packfile");
    if (pkt !== "delim" && text(pkt) === "packfile") break;
  }
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      for (;;) {
        const pkt = await reader.next();
        if (pkt === null) throw new GitClientError("the pack ended early");
        if (pkt === "flush") return controller.close();
        if (pkt === "delim") throw new GitClientError("malformed packfile section");
        const band = pkt[0];
        if (band === 1) return controller.enqueue(pkt.subarray(1));
        if (band === 3) throw new GitClientError(`the source failed: ${decoder.decode(pkt.subarray(1)).trim()}`);
        // Band 2 is progress, which `no-progress` should already have silenced.
      }
    },
    cancel: () => reader.cancel(),
  });
}

/** Sends one ref update and its pack to the target's receive-pack, and checks it was applied. */
async function pushPack(
  fetcher: typeof fetch,
  remote: GitRemote,
  update: { ref: string; before: string; after: string },
  pack: ReadableStream<Uint8Array>,
): Promise<void> {
  const commands = concat([
    pktLine(`${update.before} ${update.after} ${update.ref}\0report-status ${AGENT}\n`),
    flushPkt(),
  ]);
  const packReader = pack.getReader();
  let sentCommands = false;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!sentCommands) {
        sentCommands = true;
        return controller.enqueue(commands);
      }
      const { done, value } = await packReader.read();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    cancel: (reason) => packReader.cancel(reason),
  });
  const response = await post(fetcher, remote, "git-receive-pack", body, {});
  const reader = new PktReader(response.body);
  const lines: string[] = [];
  for (;;) {
    const pkt = await reader.next();
    if (pkt === null || pkt === "flush") break;
    if (pkt !== "delim") lines.push(text(pkt));
  }
  const unpack = lines.find((l) => l.startsWith("unpack "));
  if (unpack !== "unpack ok") throw new GitClientError(`the target couldn't unpack: ${unpack ?? "no report"}`);
  if (!lines.includes(`ok ${update.ref}`)) {
    const ng = lines.find((l) => l.startsWith(`ng ${update.ref} `));
    throw new GitClientError(`the target refused ${update.ref}: ${ng?.slice(update.ref.length + 4) ?? "no status"}`);
  }
}

// --- transport ---------------------------------------------------------------------------------

async function post(
  fetcher: typeof fetch,
  remote: GitRemote,
  service: "git-upload-pack" | "git-receive-pack",
  body: Uint8Array | ReadableStream<Uint8Array>,
  headers: Record<string, string>,
): Promise<Response> {
  return request(fetcher, remote, service, {
    method: "POST",
    headers: {
      "Content-Type": `application/x-${service}-request`,
      Accept: `application/x-${service}-result`,
      ...headers,
    },
    body,
    // A streamed request body needs this in Node's fetch; the Workers runtime ignores it.
    ...(body instanceof ReadableStream ? { duplex: "half" } : {}),
  } as RequestInit);
}

async function request(fetcher: typeof fetch, remote: GitRemote, path: string, init: RequestInit): Promise<Response> {
  const url = `${remote.url.replace(/\/+$/, "")}/${path}`;
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${remote.token}`);
  headers.set("User-Agent", "throng");
  // Never follow a redirect: it would carry the token to wherever it points.
  const response = await fetcher(url, { ...init, headers, redirect: "manual" });
  if (response.status !== 200 || response.body === null) {
    await response.body?.cancel();
    throw new GitClientError(`${init.method ?? "GET"} ${path.split("?")[0]} answered ${response.status}`);
  }
  return response;
}

function delimPkt(): Uint8Array {
  return encoder.encode("0001");
}

function text(payload: Uint8Array): string {
  const line = decoder.decode(payload);
  if (line.startsWith("ERR ")) throw new GitClientError(`the server said: ${line.slice(4).trim()}`);
  return line.endsWith("\n") ? line.slice(0, -1) : line;
}

/** Reads pkt-lines off a response body: a payload, `flush`, `delim`, or null at the end. */
class PktReader {
  readonly #reader: ReadableStreamDefaultReader<Uint8Array>;
  #bytes: Uint8Array = new Uint8Array(0);
  #at = 0;

  constructor(body: ReadableStream<Uint8Array> | null) {
    if (body === null) throw new GitClientError("empty response");
    this.#reader = body.getReader();
  }

  async next(): Promise<Uint8Array | "flush" | "delim" | null> {
    if (!(await this.#fill(4))) {
      if (this.#bytes.length - this.#at === 0) return null;
      throw new GitClientError("the response ended inside a pkt-line");
    }
    const header = decoder.decode(this.#bytes.subarray(this.#at, this.#at + 4));
    if (!/^[0-9a-f]{4}$/.test(header)) throw new GitClientError("malformed pkt-line length");
    const length = parseInt(header, 16);
    this.#at += 4;
    if (length === 0) return "flush";
    if (length === 1) return "delim";
    if (length < 4) throw new GitClientError(`unexpected pkt-line ${header}`);
    if (!(await this.#fill(length - 4))) throw new GitClientError("the response ended inside a pkt-line");
    const payload = this.#bytes.slice(this.#at, this.#at + length - 4);
    this.#at += length - 4;
    return payload;
  }

  async cancel(): Promise<void> {
    await this.#reader.cancel();
  }

  /** Buffers until `n` unread bytes are available; false if the stream ends first. */
  async #fill(n: number): Promise<boolean> {
    while (this.#bytes.length - this.#at < n) {
      const { done, value } = await this.#reader.read();
      if (done) return false;
      this.#bytes = concat([this.#bytes.subarray(this.#at), value]);
      this.#at = 0;
    }
    return true;
  }
}
