// Just enough of git's pkt-line protocol for the git proxy: reading a receive-pack command list
// before any pack data, answering a push ourselves with `report-status`, and reading the report
// the upstream sent back. See `gitprotocol-common`, `gitprotocol-pack` and `gitprotocol-http`.

const FLUSH = "0000";
/** The largest pkt-line git sends: 4 bytes of length and 65516 of payload. */
const MAX_PKT = 65520;
/** A side-band-64k packet carries at most this much data after its band byte. */
const MAX_BAND_DATA = MAX_PKT - 5;
/** Commands one push may carry before the proxy gives up on it. */
export const MAX_COMMANDS = 1000;
/** Bytes the proxy reads looking for the end of the command list before it gives up. */
const MAX_COMMAND_BYTES = 1024 * 1024;

const ZERO_ID = /^0+$/;
const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** One ref update a push asks for. A create has an all-zero `before`; a delete an all-zero `after`. */
export interface RefUpdate {
  ref: string;
  before: string;
  after: string;
}

export function isDelete(update: RefUpdate): boolean {
  return ZERO_ID.test(update.after);
}

/** A receive-pack request whose command list has been read; the pack (if any) is still unread. */
export interface PushRequest {
  updates: RefUpdate[];
  /** The capabilities the client asked for on its first command. */
  capabilities: Set<string>;
  /** Every byte read from the body so far, the command list and possibly the start of the pack. */
  consumed: Uint8Array;
}

/** A body the proxy refuses to read further: malformed, or using something it doesn't check. */
export class ProtocolError extends Error {
  override readonly name = "ProtocolError";
}

/** A pkt-line with `payload` (a string is UTF-8 encoded). */
export function pktLine(payload: string | Uint8Array): Uint8Array {
  const bytes = typeof payload === "string" ? encoder.encode(payload) : payload;
  if (bytes.length + 4 > MAX_PKT) throw new Error("pkt-line too long");
  const out = new Uint8Array(bytes.length + 4);
  out.set(encoder.encode((bytes.length + 4).toString(16).padStart(4, "0")));
  out.set(bytes, 4);
  return out;
}

export function flushPkt(): Uint8Array {
  return encoder.encode(FLUSH);
}

/**
 * Reads a receive-pack request's command list from `reader`, stopping at the flush that ends it,
 * and fails closed on anything it doesn't check: signed pushes, malformed lines, a body
 * that ends early, or more than `MAX_COMMANDS` commands. A probe (`0000` alone) has no updates.
 */
export async function readPushRequest(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<PushRequest> {
  const buffer = new ByteBuffer(reader);
  const updates: RefUpdate[] = [];
  let capabilities = new Set<string>();
  for (;;) {
    const line = await buffer.pkt();
    if (line === null) break;
    let text = decoder.decode(line);
    if (text.endsWith("\n")) text = text.slice(0, -1);
    // A push from a shallow clone names its shallow commits first. They update no ref, so they
    // pass through untouched.
    if (text.startsWith("shallow ")) {
      if (updates.length > 0 || !OBJECT_ID.test(text.slice(8))) throw new ProtocolError("malformed shallow line");
      continue;
    }
    if (text.startsWith("push-cert")) throw new ProtocolError("signed pushes aren't supported");
    if (updates.length === 0) {
      const nul = text.indexOf("\0");
      if (nul !== -1) {
        capabilities = new Set(
          text
            .slice(nul + 1)
            .split(" ")
            .filter(Boolean),
        );
        text = text.slice(0, nul);
      }
    }
    const [before, after, ref, ...rest] = text.split(" ");
    if (
      before === undefined ||
      after === undefined ||
      ref === undefined ||
      rest.length > 0 ||
      !OBJECT_ID.test(before) ||
      !OBJECT_ID.test(after) ||
      !ref.startsWith("refs/")
    ) {
      throw new ProtocolError("malformed receive-pack command");
    }
    updates.push({ ref, before, after });
    if (updates.length > MAX_COMMANDS) throw new ProtocolError(`a push may update at most ${MAX_COMMANDS} refs`);
  }
  return { updates, capabilities, consumed: buffer.consumed() };
}

/**
 * A `report-status` answering every update in `push` with `ng` and its reason, wrapped in band 1
 * when the client asked for side-band-64k. Null when the client asked for no report at all, so the
 * caller has to refuse some other way.
 */
export function rejectionReport(push: PushRequest, reasons: string[]): Uint8Array | null {
  if (!push.capabilities.has("report-status") && !push.capabilities.has("report-status-v2")) return null;
  const lines = [pktLine("unpack ok\n")];
  push.updates.forEach((update, i) => lines.push(pktLine(`ng ${update.ref} ${oneLine(reasons[i] ?? "rejected")}\n`)));
  lines.push(flushPkt());
  const report = concat(lines);
  if (!push.capabilities.has("side-band-64k")) return report;

  const packets: Uint8Array[] = [];
  for (let at = 0; at < report.length; at += MAX_BAND_DATA) {
    const chunk = report.subarray(at, at + MAX_BAND_DATA);
    const banded = new Uint8Array(chunk.length + 1);
    banded[0] = 1;
    banded.set(chunk, 1);
    packets.push(pktLine(banded));
  }
  packets.push(flushPkt());
  return concat(packets);
}

/**
 * The refs a receive-pack response reports as updated (`ok <ref>`), reading through side-band-64k
 * when `sideband` is set. Anything it can't read yields no refs, so a garbled report never claims
 * a push landed.
 */
export function updatedRefs(response: Uint8Array, sideband: boolean): string[] {
  try {
    const report = sideband ? band(response, 1) : response;
    const refs: string[] = [];
    for (const line of pktLines(report)) {
      const text = decoder.decode(line).replace(/\n$/, "");
      if (text.startsWith("unpack ") && text !== "unpack ok") return [];
      if (text.startsWith("ok ")) refs.push(text.slice(3));
    }
    return refs;
  } catch {
    return [];
  }
}

/** The data of one side-band, concatenated, from a sequence of side-band packets. */
function band(bytes: Uint8Array, wanted: number): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const packet of pktLines(bytes)) {
    if (packet[0] === wanted) parts.push(packet.subarray(1));
  }
  return concat(parts);
}

/** The payloads of the pkt-lines in `bytes` up to the first flush (or the end). */
function* pktLines(bytes: Uint8Array): Generator<Uint8Array> {
  let at = 0;
  while (at + 4 <= bytes.length) {
    const length = pktLength(bytes.subarray(at, at + 4));
    if (length === 0) return;
    if (length < 4 || at + length > bytes.length) throw new ProtocolError("malformed pkt-line");
    yield bytes.subarray(at + 4, at + length);
    at += length;
  }
}

function pktLength(header: Uint8Array): number {
  const text = decoder.decode(header);
  if (!/^[0-9a-f]{4}$/.test(text)) throw new ProtocolError("malformed pkt-line length");
  const length = parseInt(text, 16);
  if (length > 0 && length < 4) throw new ProtocolError(`unexpected pkt-line ${text}`);
  return length;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** Reads pkt-lines off a stream, keeping every byte it has read so the body can be replayed. */
class ByteBuffer {
  readonly #reader: ReadableStreamDefaultReader<Uint8Array>;
  readonly #chunks: Uint8Array[] = [];
  #bytes: Uint8Array = new Uint8Array(0);
  #at = 0;
  #read = 0;

  constructor(reader: ReadableStreamDefaultReader<Uint8Array>) {
    this.#reader = reader;
  }

  /** The next pkt-line's payload, or null for a flush. */
  async pkt(): Promise<Uint8Array | null> {
    const length = pktLength(await this.#take(4));
    if (length === 0) return null;
    return this.#take(length - 4);
  }

  /** Every byte read off the stream, including any past the last pkt-line taken. */
  consumed(): Uint8Array {
    return concat(this.#chunks);
  }

  async #take(n: number): Promise<Uint8Array> {
    while (this.#bytes.length - this.#at < n) {
      if (this.#read >= MAX_COMMAND_BYTES) throw new ProtocolError("the command list is too long");
      const { done, value } = await this.#reader.read();
      if (done) throw new ProtocolError("the request ended inside the command list");
      this.#read += value.length;
      this.#chunks.push(value);
      this.#bytes = concat([this.#bytes.subarray(this.#at), value]);
      this.#at = 0;
    }
    const out = this.#bytes.slice(this.#at, this.#at + n);
    this.#at += n;
    return out;
  }
}
