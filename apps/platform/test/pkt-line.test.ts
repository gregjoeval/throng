import { describe, expect, it } from "vitest";
import {
  concat,
  flushPkt,
  MAX_COMMANDS,
  pktLine,
  ProtocolError,
  readPushRequest,
  rejectionReport,
  updatedRefs,
} from "../src/pkt-line.ts";

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
  });

  it("reads a probe as no updates", async () => {
    const push = await readPushRequest(stream(flushPkt()));
    expect(push.updates).toEqual([]);
  });

  it("skips a shallow clone's shallow lines", async () => {
    const push = await readPushRequest(stream(request(`shallow ${A}`, `${A} ${B} refs/heads/main\0report-status\n`)));
    expect(push.updates).toEqual([{ ref: "refs/heads/main", before: A, after: B }]);
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
  };
}

/** A report-status of `lines`, ended by a flush. */
function report(...lines: string[]): Uint8Array {
  return concat([...lines.map((l) => pktLine(l)), flushPkt()]);
}

describe("rejectionReport", () => {
  it("marks every ref ng with its reason", () => {
    const rejected = rejectionReport(twoRefPush(["report-status"]), ["no\nway", "nope"]);
    expect(text(rejected!).split(/(?=[0-9a-f]{4}(?:unpack|ng|$))/)).toEqual([
      "000eunpack ok\n",
      "001eng refs/heads/main no way\n",
      "0019ng refs/heads/x nope\n",
      "0000",
    ]);
  });

  it("wraps the report in band 1 under side-band-64k", () => {
    const plain = rejectionReport(twoRefPush(["report-status"]), ["a", "b"])!;
    const banded = rejectionReport(twoRefPush(["report-status", "side-band-64k"]), ["a", "b"])!;
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
