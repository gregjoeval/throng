import { describe, expect, it } from "vitest";
import {
  advertisedHead,
  commandList,
  concat,
  flushPkt,
  MAX_COMMANDS,
  pktLine,
  ProtocolError,
  readPushRequest,
  readReport,
  rejectionReport,
  renameRefs,
  updatedRefs,
  writeReport,
} from "../src/pkt-line.ts";
import { defined } from "./support/defined.ts";

const A = "a".repeat(40);
const B = "b".repeat(40);
const ZERO = "0".repeat(40);
const PACK = new TextEncoder().encode("PACK\0\0\0\x02rest-of-pack");
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

/** A stream of `bytes` delivered `size` bytes at a time, so lines straddle chunks. */
function stream(bytes: Uint8Array, size = 3): ReadableStreamDefaultReader<Uint8Array> {
  let at = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (at >= bytes.length) return controller.close();
      controller.enqueue(bytes.slice(at, at + size));
      at += size;
    },
  }).getReader();
}

function request(...lines: string[]): Uint8Array {
  return concat([...lines.map((l) => pktLine(l)), flushPkt(), PACK]);
}

describe("readPushRequest", () => {
  it("reads the commands and capabilities, and keeps every byte read", async () => {
    const body = request(
      `${A} ${B} refs/heads/main\0report-status side-band-64k agent=git/2.47\n`,
      `${ZERO} ${B} refs/heads/new\n`,
      `${A} ${ZERO} refs/heads/old\n`,
    );
    const reader = stream(body);
    const push = await readPushRequest(reader);
    expect(push.updates).toEqual([
      { ref: "refs/heads/main", before: A, after: B },
      { ref: "refs/heads/new", before: ZERO, after: B },
      { ref: "refs/heads/old", before: A, after: ZERO },
    ]);
    expect([...push.capabilities]).toEqual(["report-status", "side-band-64k", "agent=git/2.47"]);

    // What was read plus what's left is the request, byte for byte.
    const rest: Uint8Array[] = [];
    for (let r = await reader.read(); !r.done; r = await reader.read()) rest.push(r.value);
    expect(concat([push.consumed, ...rest])).toEqual(body);
    // The command list ends where the pack starts.
    expect(text(concat([push.consumed.subarray(push.commandLength), ...rest]).subarray(0, 4))).toBe("PACK");
  });

  it("reads a probe as no updates", async () => {
    const push = await readPushRequest(stream(flushPkt()));
    expect(push.updates).toEqual([]);
  });

  it("keeps a shallow clone's shallow lines apart from the commands", async () => {
    const push = await readPushRequest(stream(request(`shallow ${A}`, `${A} ${B} refs/heads/main\0report-status\n`)));
    expect(push.updates).toEqual([{ ref: "refs/heads/main", before: A, after: B }]);
    expect(push.shallow).toEqual([`shallow ${A}`]);
  });

  it("fails closed on what it can't check", async () => {
    const bad = [
      request("push-cert\0report-status\n"),
      request(`${A} ${B}\n`),
      request(`${A} ${B} main\n`),
      request(`${A} nothex refs/heads/main\n`),
      request(`${A} ${B} refs/heads/main extra\n`),
      request(`${A} ${B} refs/heads/main\n`, `shallow ${A}`),
      new TextEncoder().encode("zzzz"),
      new TextEncoder().encode("0002"),
      pktLine(`${A} ${B} refs/heads/main\n`),
      concat(Array.from({ length: MAX_COMMANDS + 1 }, (_, i) => pktLine(`${A} ${B} refs/heads/b${i}\n`))),
    ];
    for (const body of bad) {
      await expect(readPushRequest(stream(body, 4096)), text(body).slice(0, 60)).rejects.toBeInstanceOf(ProtocolError);
    }
  });
});

/** A push of two refs that asked for `capabilities`. */
function twoRefPush(capabilities: string[]) {
  return {
    updates: [
      { ref: "refs/heads/main", before: A, after: B },
      { ref: "refs/heads/x", before: ZERO, after: B },
    ],
    capabilities: new Set(capabilities),
    consumed: new Uint8Array(0),
    commandLength: 0,
    shallow: [],
  };
}

/** A report-status of `lines`, ended by a flush. */
function report(...lines: string[]): Uint8Array {
  return concat([...lines.map((l) => pktLine(l)), flushPkt()]);
}

describe("commandList", () => {
  it("rewrites the commands and keeps the shallow lines and capabilities, so the pack can follow", async () => {
    const body = request(`shallow ${A}`, `${ZERO} ${B} refs/heads/feature\0report-status side-band-64k\n`);
    const reader = stream(body);
    const push = await readPushRequest(reader);
    const rest: Uint8Array[] = [];
    for (let r = await reader.read(); !r.done; r = await reader.read()) rest.push(r.value);
    const rewritten = concat([
      commandList(push, [{ ref: "refs/heads/main", before: A, after: B }]),
      push.consumed.subarray(push.commandLength),
      ...rest,
    ]);
    expect(rewritten).toEqual(request(`shallow ${A}\n`, `${A} ${B} refs/heads/main\0report-status side-band-64k\n`));
  });
});

describe("readReport and writeReport", () => {
  const progress = concat([new Uint8Array([2]), new TextEncoder().encode("Resolving deltas\n")]);
  const inner = report("unpack ok\n", "ok refs/heads/main\n");
  const sideband = concat([pktLine(progress), pktLine(concat([new Uint8Array([1]), inner])), flushPkt()]);

  it("renames refs, keeps progress and adds messages on band 2", () => {
    const read = renameRefs(readReport(sideband, true), (ref) => (ref === "refs/heads/main" ? "refs/heads/x" : ref));
    expect(read).toEqual({ lines: ["unpack ok", "ok refs/heads/x"], other: [progress] });
    const written = writeReport(read, ["Created t1"], true);
    expect(updatedRefs(written, true)).toEqual(["refs/heads/x"]);
    expect(text(written)).toContain("Resolving deltas\n");
    expect(text(written)).toContain("\x02Created t1\n");
  });

  it("writes a bare report without side-band, dropping messages", () => {
    const read = readReport(inner, false);
    expect(read.lines).toEqual(["unpack ok", "ok refs/heads/main"]);
    expect(writeReport(read, ["dropped"], false)).toEqual(inner);
  });

  it("renames refs on ng and option lines too", () => {
    const renamed = renameRefs(
      { lines: ["ng refs/heads/main locked", "option refname refs/heads/main"], other: [] },
      () => "refs/heads/y",
    );
    expect(renamed.lines).toEqual(["ng refs/heads/y locked", "option refname refs/heads/y"]);
  });
});

describe("rejectionReport", () => {
  it("marks every ref ng with its reason", () => {
    const rejected = rejectionReport(twoRefPush(["report-status"]), ["no\nway", "nope"]);
    expect(text(defined(rejected, "a rejection report")).split(/(?=[0-9a-f]{4}(?:unpack|ng|$))/u)).toEqual([
      "000eunpack ok\n",
      "001eng refs/heads/main no way\n",
      "0019ng refs/heads/x nope\n",
      "0000",
    ]);
  });

  it("wraps the report in band 1 under side-band-64k", () => {
    const plain = defined(rejectionReport(twoRefPush(["report-status"]), ["a", "b"]));
    const banded = defined(rejectionReport(twoRefPush(["report-status", "side-band-64k"]), ["a", "b"]));
    expect(text(banded)).toBe(`${(plain.length + 5).toString(16).padStart(4, "0")}\x01${text(plain)}0000`);
    expect(updatedRefs(banded, true)).toEqual([]);
  });

  it("is null when the client asked for no report", () => {
    expect(rejectionReport(twoRefPush(["side-band-64k"]), ["a", "b"])).toBeNull();
  });
});

describe("updatedRefs", () => {
  it("lists the refs reported ok", () => {
    const body = report("unpack ok\n", "ok refs/heads/main\n", "ng refs/heads/x locked\n", "ok refs/heads/y\n");
    expect(updatedRefs(body, false)).toEqual(["refs/heads/main", "refs/heads/y"]);
  });

  it("reads band 1 and ignores progress on band 2", () => {
    const inner = report("unpack ok\n", "ok refs/heads/main\n");
    const progress = concat([new Uint8Array([2]), new TextEncoder().encode("Resolving deltas\n")]);
    const body = concat([pktLine(progress), pktLine(concat([new Uint8Array([1]), inner])), flushPkt()]);
    expect(updatedRefs(body, true)).toEqual(["refs/heads/main"]);
  });

  it("claims nothing when unpacking failed or the report is garbled", () => {
    expect(updatedRefs(report("unpack index-pack failed\n", "ok refs/heads/main\n"), false)).toEqual([]);
    expect(updatedRefs(new TextEncoder().encode("zzzzok refs/heads/main"), false)).toEqual([]);
  });
});

/** An upload-pack advertisement, as `GET info/refs?service=git-upload-pack` answers: header, flush, refs, flush. */
function advertisement(...refs: string[]): Uint8Array {
  return concat([
    pktLine("# service=git-upload-pack\n"),
    flushPkt(),
    ...refs.map((r) => pktLine(`${r}\n`)),
    flushPkt(),
  ]);
}

describe("advertisedHead", () => {
  it("reads the branch HEAD points at from the first ref's capabilities", () => {
    const main = advertisement(
      `${A} HEAD\0multi_ack side-band-64k symref=HEAD:refs/heads/main agent=git/2.47.0`,
      `${A} refs/heads/main`,
    );
    expect(advertisedHead(main)).toBe("main");
  });

  it("reads a branch other than main, whatever its name", () => {
    for (const branch of ["master", "trunk", "release/1.x"]) {
      const bytes = advertisement(
        `${A} HEAD\0symref=HEAD:refs/heads/${branch} agent=github`,
        `${A} refs/heads/${branch}`,
      );
      expect(advertisedHead(bytes), branch).toBe(branch);
    }
  });

  it("is null when the advertisement names no symref for HEAD", () => {
    expect(advertisedHead(advertisement(`${A} refs/heads/main\0multi_ack agent=git/1.8`))).toBeNull();
    expect(advertisedHead(advertisement(`${A} HEAD\0symref=refs/x:refs/heads/main`))).toBeNull();
    expect(advertisedHead(concat([pktLine("# service=git-upload-pack\n"), flushPkt(), flushPkt()]))).toBeNull();
  });

  it("reads an empty repo's advertisement, whose only line is capabilities^{}", () => {
    const empty = advertisement(`${ZERO} capabilities^{}\0symref=HEAD:refs/heads/trunk agent=git/2.47.0`);
    expect(advertisedHead(empty)).toBe("trunk");
  });

  it("throws on bytes that aren't an upload-pack advertisement", () => {
    for (const bytes of [
      new TextEncoder().encode("<!doctype html><title>Sign in</title>"),
      concat([pktLine("# service=git-receive-pack\n"), flushPkt()]),
      new Uint8Array(0),
    ]) {
      expect(() => advertisedHead(bytes)).toThrow(ProtocolError);
    }
  });

  it("reads only as far as the first ref, so a cut-off advertisement still answers", () => {
    const full = advertisement(`${A} HEAD\0symref=HEAD:refs/heads/master`, `${A} refs/heads/master`);
    const first = concat([
      pktLine("# service=git-upload-pack\n"),
      flushPkt(),
      pktLine(`${A} HEAD\0symref=HEAD:refs/heads/master\n`),
    ]);
    expect(advertisedHead(full.subarray(0, first.length + 7))).toBe("master");
  });
});
