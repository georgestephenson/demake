/**
 * A project as a zip (doc 19 §Opening, saving, and the parity claim).
 *
 * The transfer format for a browser that cannot open a directory: export writes
 * exactly the folder, import reads one back, and the tree either way is the same
 * tree the CLI builds. There is no page-side project format to convert to or
 * from — the folder *is* the format, so this file is a container and nothing more.
 *
 * **No dependency, and no second compressor.** `@demake/core` already carries
 * `deflateStored`, `inflateRaw` and `crc32` for the PNG codec, so writing a zip
 * is a header format over code that exists and reading one is the same inflate a
 * PNG uses. Entries are written *stored* rather than deflated: a project is a few
 * hundred kilobytes and most of it is already-compressed WAV, so the saving would
 * be small and the code to get it would be a real deflate. Reading handles both,
 * because other tools write deflated entries.
 *
 * **Deterministic by construction.** Every entry takes the DOS epoch rather than
 * the wall clock, so exporting the same project twice produces the same bytes —
 * the determinism rule the engine runs under, applied to the one artifact the page
 * writes that is not an engine's (doc 02 §Determinism).
 */

import { crc32, inflateRaw } from "@demake/core";

/** The DOS timestamp for 1980-01-01 00:00:00, which is the format's own zero. */
const DOS_EPOCH_TIME = 0;
const DOS_EPOCH_DATE = 0x0021;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Grow-as-needed byte sink, so the writer stays a straight line. */
class Sink {
  #bytes = new Uint8Array(1024);
  #at = 0;

  #room(extra: number): void {
    if (this.#at + extra <= this.#bytes.length) return;
    let size = this.#bytes.length * 2;
    while (size < this.#at + extra) size *= 2;
    const grown = new Uint8Array(size);
    grown.set(this.#bytes.subarray(0, this.#at));
    this.#bytes = grown;
  }

  get length(): number {
    return this.#at;
  }

  u16(value: number): void {
    this.#room(2);
    this.#bytes[this.#at] = value & 0xff;
    this.#bytes[this.#at + 1] = (value >>> 8) & 0xff;
    this.#at += 2;
  }

  u32(value: number): void {
    this.#room(4);
    for (let byte = 0; byte < 4; byte += 1) {
      this.#bytes[this.#at + byte] = (value >>> (byte * 8)) & 0xff;
    }
    this.#at += 4;
  }

  raw(bytes: Uint8Array): void {
    this.#room(bytes.length);
    this.#bytes.set(bytes, this.#at);
    this.#at += bytes.length;
  }

  done(): Uint8Array {
    return this.#bytes.slice(0, this.#at);
  }
}

/** One file going into, or coming out of, a zip. */
export interface ZipEntry {
  /** `/`-separated, relative to the archive root. */
  path: string;
  bytes: Uint8Array;
}

/**
 * Write a zip holding these files, under a single top-level folder.
 *
 * The folder is what makes an export unzip to a *project* rather than scattering
 * `src/` and `art/` into whatever directory it was opened in.
 */
export function writeZip(folder: string, entries: readonly ZipEntry[]): Uint8Array {
  const local = new Sink();
  const central = new Sink();
  // Sorted, so an export does not depend on the order a Map happened to hold.
  const sorted = [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  let count = 0;

  for (const entry of sorted) {
    const name = encoder.encode(`${folder}/${entry.path}`);
    const sum = crc32(entry.bytes);
    const offset = local.length;

    local.u32(0x04034b50);
    local.u16(20); // version needed
    local.u16(0); // flags
    local.u16(0); // stored
    local.u16(DOS_EPOCH_TIME);
    local.u16(DOS_EPOCH_DATE);
    local.u32(sum);
    local.u32(entry.bytes.length);
    local.u32(entry.bytes.length);
    local.u16(name.length);
    local.u16(0); // extra
    local.raw(name);
    local.raw(entry.bytes);

    central.u32(0x02014b50);
    central.u16(20); // version made by
    central.u16(20); // version needed
    central.u16(0);
    central.u16(0); // stored
    central.u16(DOS_EPOCH_TIME);
    central.u16(DOS_EPOCH_DATE);
    central.u32(sum);
    central.u32(entry.bytes.length);
    central.u32(entry.bytes.length);
    central.u16(name.length);
    central.u16(0); // extra
    central.u16(0); // comment
    central.u16(0); // disk
    central.u16(0); // internal attributes
    central.u32(0); // external attributes
    central.u32(offset);
    central.raw(name);
    count += 1;
  }

  const out = new Sink();
  const body = local.done();
  const directory = central.done();
  out.raw(body);
  out.raw(directory);
  out.u32(0x06054b50);
  out.u16(0); // this disk
  out.u16(0); // directory's disk
  out.u16(count);
  out.u16(count);
  out.u32(directory.length);
  out.u32(body.length);
  out.u16(0); // comment
  return out.done();
}

/** Read a little-endian integer. */
function read(bytes: Uint8Array, at: number, width: number): number {
  let value = 0;
  for (let byte = width - 1; byte >= 0; byte -= 1)
    value = value * 256 + (bytes[at + byte] as number);
  return value;
}

/** Thrown when a zip is not one, or holds something this reader will not take. */
export class ZipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZipError";
  }
}

/**
 * Read a zip, returning its files with the common leading folder removed.
 *
 * Stripping the folder is what makes import the inverse of export: a zip holding
 * `pong/src/pong.dmt` opens as a project called `pong` whose entry is
 * `src/pong.dmt`, which is the same tree the CLI would walk.
 *
 * The **central directory** is what is read, not the stream of local headers: a
 * local header may say the sizes are in a trailing descriptor instead, and the
 * directory always knows. Directory entries and anything with a path that climbs
 * out of the archive are skipped rather than trusted.
 */
export function readZip(bytes: Uint8Array): { folder: string; entries: ZipEntry[] } {
  let end = bytes.length - 22;
  while (end >= 0 && read(bytes, end, 4) !== 0x06054b50) end -= 1;
  if (end < 0) throw new ZipError("this file has no zip directory in it");

  const count = read(bytes, end + 10, 2);
  let at = read(bytes, end + 16, 4);
  const entries: ZipEntry[] = [];

  for (let index = 0; index < count; index += 1) {
    if (read(bytes, at, 4) !== 0x02014b50) throw new ZipError("the zip directory is damaged");
    const method = read(bytes, at + 10, 2);
    const compressed = read(bytes, at + 20, 4);
    const size = read(bytes, at + 24, 4);
    const nameLength = read(bytes, at + 28, 2);
    const extraLength = read(bytes, at + 30, 2);
    const commentLength = read(bytes, at + 32, 2);
    const offset = read(bytes, at + 42, 4);
    const name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength));
    at += 46 + nameLength + extraLength + commentLength;

    if (name.endsWith("/")) continue; // a directory entry carries no bytes
    if (name.split("/").some((part) => part === ".." || part === "")) continue;

    const localName = read(bytes, offset + 26, 2);
    const localExtra = read(bytes, offset + 28, 2);
    const from = offset + 30 + localName + localExtra;
    const raw = bytes.subarray(from, from + compressed);
    if (method === 0) entries.push({ path: name, bytes: raw.slice() });
    else if (method === 8) entries.push({ path: name, bytes: inflateRaw(raw, 0, size) });
    else
      throw new ZipError(
        `'${name}' uses compression method ${String(method)}, which is not one this reads`,
      );
  }

  // The common leading folder, if every entry shares one.
  const first = entries[0]?.path.split("/")[0] ?? "";
  const shared =
    first !== "" && entries.every((entry) => entry.path.startsWith(`${first}/`)) ? first : "";
  return {
    folder: shared,
    entries:
      shared === ""
        ? entries
        : entries.map((entry) => ({ ...entry, path: entry.path.slice(shared.length + 1) })),
  };
}
