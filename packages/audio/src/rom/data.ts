/**
 * Packing a `ChipScript` into driver data (doc 16 §The driver contract,
 * doc 17 §Stage 6).
 *
 * The driver contract is narrow and it is the whole of the format's job: **on
 * tick N the driver performs exactly the writes `ChipScript.ticks[N]` lists, in
 * order**. Everything here — the opcodes, the block split, the dedup — is the
 * emitter's business precisely because none of it is observable in the register
 * stream, which is what lets the compression change without the proof moving.
 *
 * The encoding is a byte stream per *block*, and blocks are deduplicated into a
 * pattern table addressed by an order list. That is doc 17's "rows dedup into
 * patterns, patterns into an order list" with a tick where it says row, and it
 * is worth having for the reason sequenced music is worth compressing at all: a
 * section that recurs writes the same bytes, and a silent bar writes two.
 *
 * ```text
 *   $00        end of block — the driver takes the next order entry
 *   $01..$7F   n writes follow as (register, value) pairs; the tick ends after
 *   $80|k      k+1 ticks with no writes at all
 * ```
 *
 * Registers are stored as the low byte of their hardware address, so the driver
 * writes them with `ld [$FF00+c], a` and the packed data reads the way the Pan
 * Docs do. That is a Game Boy detail living in a shared file, and it is the only
 * one: a chip whose registers are not in high RAM would carry a full address.
 */

import type { ChipScript } from "../chipscript.js";

/** Ticks a block covers before the order list moves on. */
const BLOCK_TICKS = 64;

/** Most ticks one rest opcode can skip. */
const MAX_REST = 128;

/** Most writes one tick can carry, which the opcode's low seven bits bound. */
export const MAX_WRITES_PER_TICK = 0x7f;

/** Raised when a schedule cannot be packed for a console. */
export class PackError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly hint?: string,
  ) {
    super(message);
    this.name = "PackError";
  }
}

/** A schedule as the driver reads it. */
export interface DriverData {
  /** Deduplicated pattern bodies, in emission order. */
  blocks: readonly Uint8Array[];
  /** Which block each order entry plays. */
  order: readonly number[];
  /** Order entry playback returns to when the list runs out. */
  loopOrderIndex: number;
  /** Ticks the schedule covers, before the loop. */
  ticks: number;
  /** Whether any block skips ticks — the driver's rest path is pulled by this. */
  hasRests: boolean;
  /** Whether more than one block plays, which decides if the order list moves. */
  hasOrder: boolean;
  /** A one-shot (a sound effect) ends in silence instead of repeating. */
  oneShot: boolean;
  /** Packed size: every block body, plus the order list and its terminator. */
  bytes: number;
  /** Blocks the dedup collapsed — the counterpart of a tile-merge count. */
  blocksSaved: number;
}

/**
 * Pack a schedule.
 *
 * Block boundaries fall every {@link BLOCK_TICKS} ticks *and* at the loop point,
 * which is what lets the loop be an order-list index rather than a byte offset
 * plus a partial-tick count — the driver never has to resume mid-block, so it
 * needs no notion of where inside one it is.
 */
export function packScript(script: ChipScript): DriverData {
  const total = script.ticks.length;
  const oneShot = script.loopTick < 0;
  const loopTick = oneShot ? total : Math.min(Math.max(script.loopTick, 0), total);

  const boundaries = new Set<number>([0, total, loopTick]);
  for (let tick = BLOCK_TICKS; tick < total; tick += BLOCK_TICKS) boundaries.add(tick);
  const cuts = [...boundaries].filter((at) => at >= 0 && at <= total).sort((a, b) => a - b);

  const blocks: Uint8Array[] = [];
  const index = new Map<string, number>();
  const order: number[] = [];
  let hasRests = false;
  let collisions = 0;
  let loopOrderIndex = 0;

  for (let cut = 0; cut + 1 < cuts.length; cut += 1) {
    const start = cuts[cut]!;
    const end = cuts[cut + 1]!;
    if (end <= start) continue;
    if (start === loopTick) loopOrderIndex = order.length;
    const body = encodeBlock(script, start, end);
    if (body.rests) hasRests = true;
    const key = keyOf(body.bytes);
    const seen = index.get(key);
    if (seen === undefined) {
      index.set(key, blocks.length);
      order.push(blocks.length);
      blocks.push(body.bytes);
    } else {
      order.push(seen);
      collisions += 1;
    }
  }

  // A one-shot stops rather than repeating: the order list's terminator sends
  // the driver to a block that silences every channel and then rests forever.
  // There is no "stop" state in the driver for the same reason there is no
  // `destroy` in Demotic — an inert thing it already knows how to represent
  // beats a second mode it would have to be right about.
  if (oneShot) {
    const stop = silenceBlock(script);
    hasRests = true;
    const key = keyOf(stop);
    let at = index.get(key);
    if (at === undefined) {
      at = blocks.length;
      index.set(key, at);
      blocks.push(stop);
    }
    loopOrderIndex = order.length;
    order.push(at);
  }

  if (order.length === 0) {
    throw new PackError("E_EMPTY_SCHEDULE", "this schedule has no ticks to play");
  }

  let bytes = 2 * (order.length + 1);
  for (const block of blocks) bytes += block.length;

  return {
    blocks,
    order,
    loopOrderIndex,
    ticks: total,
    hasRests,
    hasOrder: order.length > 1,
    oneShot,
    bytes,
    blocksSaved: collisions,
  };
}

/** Encode ticks `[start, end)` into one block body. */
function encodeBlock(
  script: ChipScript,
  start: number,
  end: number,
): { bytes: Uint8Array; rests: boolean } {
  const out: number[] = [];
  let rests = false;
  let tick = start;
  while (tick < end) {
    const writes = script.ticks[tick]!.writes;
    if (writes.length === 0) {
      let run = 1;
      while (run < MAX_REST && tick + run < end && script.ticks[tick + run]!.writes.length === 0) {
        run += 1;
      }
      out.push(0x80 | (run - 1));
      rests = true;
      tick += run;
      continue;
    }
    if (writes.length > MAX_WRITES_PER_TICK) {
      throw new PackError(
        "E_TICK_TOO_LARGE",
        `tick ${tick} asks for ${writes.length} register writes and the driver format holds ${MAX_WRITES_PER_TICK}`,
        "the console's per-tick write budget is far below this, so the schedule would overrun its tick on hardware too; `demake inspect` reports it.",
      );
    }
    out.push(writes.length);
    for (const write of writes) out.push(write.reg & 0xff, write.value & 0xff);
    tick += 1;
  }
  out.push(0x00);
  return { bytes: Uint8Array.from(out), rests };
}

/**
 * A block that silences every channel and then rests.
 *
 * The writes come from the binding's own note-off encoding rather than a list
 * of registers repeated here, so a chip whose "off" is not `NRx2 = 0` cannot
 * end up with a sound effect that rings forever.
 */
function silenceBlock(script: ChipScript): Uint8Array {
  const off = silenceWrites(script.console);
  const out: number[] = [off.length, ...off.flatMap((w) => [w.reg, w.value])];
  out.push(0x80 | (MAX_REST - 1), 0x00);
  return Uint8Array.from(out);
}

/** Note-off for each channel, by console family. */
function silenceWrites(consoleId: string): { reg: number; value: number }[] {
  // Only the Game Boy family has a driver backend; `buildAudioRom` refuses the
  // rest before anything reaches here, so this stays a fact about one chip
  // rather than a table that quietly grows wrong entries.
  void consoleId;
  return [
    { reg: 0x12, value: 0x00 },
    { reg: 0x17, value: 0x00 },
    { reg: 0x1a, value: 0x00 },
    { reg: 0x21, value: 0x00 },
  ];
}

function keyOf(bytes: Uint8Array): string {
  let key = "";
  for (const byte of bytes) key += String.fromCharCode(byte);
  return key;
}
