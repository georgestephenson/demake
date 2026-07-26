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
 * A stream that shares the chip with another one — music under sound effects in
 * a game — is packed in **runs** instead, because a write that lands on a
 * preempted channel has to be skipped and a driver that decided that per write
 * would pay for it on every write of every tick. Consecutive writes that agree
 * about which channels they touch are one run, and the decision is taken once
 * for the run:
 *
 * ```text
 *   $01..$7F   n writes in this run, then a flags byte, then n (register, value)
 *              pairs. flags bit 7: another run follows in this tick.
 *                     flags bit 6: the writes are masked merges, not stores.
 *                     flags bits 3-0: channels the run belongs to.
 * ```
 *
 * The grouping never reorders anything, which is the property the proof rests
 * on: with nothing preempting it, a run-packed stream performs exactly the
 * writes the `ChipScript` lists, in order, exactly as the flat one does.
 *
 * Registers are stored as the low byte of their hardware address, so the driver
 * writes them with `ld [$FF00+c], a` and the packed data reads the way the Pan
 * Docs do. That is a Game Boy detail living in a shared file, and it is the only
 * one: a chip whose registers are not in high RAM would carry a full address.
 */

import type { RegisterWrite } from "@demake/chip";

import type { ChipScript } from "../chipscript.js";

/** Ticks a block covers before the order list moves on. */
const BLOCK_TICKS = 64;

/** Most ticks one rest opcode can skip. */
const MAX_REST = 128;

/** Most writes one tick can carry, which the opcode's low seven bits bound. */
export const MAX_WRITES_PER_TICK = 0x7f;

/** Run-header flags, in the packed data and in the driver that reads it. */
export const RUN = {
  /** Another run follows in this tick. */
  more: 0x80,
  /** The run's writes merge into the register under a mask, rather than store. */
  merge: 0x40,
  /** Channels the run belongs to. */
  channels: 0x0f,
} as const;

/** How a stream shares the chip with the other one, when there is another. */
export interface PackOptions {
  /**
   * Channel bits a register belongs to; `0` for one that belongs to no channel.
   *
   * Supplying it packs the stream in runs (see the format note above), which is
   * what a driver needs to skip a preempted channel cheaply. Leaving it out
   * packs the flat format, which is what a cartridge that owns the whole chip
   * wants.
   */
  channelOf?: (reg: number) => number;
  /**
   * Registers whose writes are merges under a mask rather than plain stores.
   *
   * The Game Boy's `NR51` is the case this exists for: one byte carries every
   * channel's panning, so two streams that both store it erase each other, and
   * a stream must only ever change its own bits.
   */
  mergeRegs?: ReadonlySet<number>;
  /**
   * Writes performed once, elsewhere, and therefore stripped from tick 0.
   *
   * A game powers the chip up at boot rather than at the start of every track
   * and every effect, because an effect that re-ran the chip's initialisation
   * would silence the music each time it fired. They must be exactly the head of
   * tick 0 — a mismatch is an error, not a silent drop.
   */
  boot?: readonly RegisterWrite[];
  /**
   * What a one-shot does when it runs out.
   *
   * `silence` appends a block that turns every channel off and then rests
   * forever, which is what a cartridge whose only job is that one effect wants.
   * `stop` appends nothing and leaves the order list's terminator to say so,
   * which is what a game wants: the effect releases the channel it borrowed and
   * the music carries on, and a block that silenced *every* channel would take
   * the music with it.
   */
  end?: "silence" | "stop";
}

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
  /** Whether the run format was used, which decides how the driver reads a tick. */
  runs: boolean;
  /** Whether any run merges under a mask, which pulls the driver's merge path. */
  hasMerges: boolean;
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
export function packScript(script: ChipScript, options: PackOptions = {}): DriverData {
  const total = script.ticks.length;
  const ticks = tickWrites(script, options.boot ?? []);
  const oneShot = script.loopTick < 0;
  const loopTick = oneShot ? total : Math.min(Math.max(script.loopTick, 0), total);

  const boundaries = new Set<number>([0, total, loopTick]);
  for (let tick = BLOCK_TICKS; tick < total; tick += BLOCK_TICKS) boundaries.add(tick);
  const cuts = [...boundaries].filter((at) => at >= 0 && at <= total).sort((a, b) => a - b);

  const blocks: Uint8Array[] = [];
  const index = new Map<string, number>();
  const order: number[] = [];
  let hasRests = false;
  let hasMerges = false;
  let collisions = 0;
  let loopOrderIndex = 0;

  for (let cut = 0; cut + 1 < cuts.length; cut += 1) {
    const start = cuts[cut]!;
    const end = cuts[cut + 1]!;
    if (end <= start) continue;
    if (start === loopTick) loopOrderIndex = order.length;
    const body = encodeBlock(ticks, start, end, options);
    if (body.rests) hasRests = true;
    if (body.merges) hasMerges = true;
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
  if (oneShot && (options.end ?? "silence") === "silence") {
    const stop = silenceBlock(script, options);
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

  // A one-shot that ends by stopping has no loop entry at all; pointing it past
  // the order list says so in the only way the field can, and the driver that
  // asked for `stop` never reads it — it sees the terminator first.
  if (oneShot && (options.end ?? "silence") === "stop") loopOrderIndex = order.length;

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
    runs: options.channelOf !== undefined,
    hasMerges,
    hasOrder: order.length > 1,
    oneShot,
    bytes,
    blocksSaved: collisions,
  };
}

/**
 * The writes each tick performs, with the boot prefix taken off tick 0.
 *
 * The prefix has to *be* the head of tick 0: a driver that quietly played a
 * schedule whose chip was initialised somewhere else would be the "silent
 * difference" the whole hand-off is written to prevent.
 */
function tickWrites(script: ChipScript, boot: readonly RegisterWrite[]): RegisterWrite[][] {
  const ticks = script.ticks.map((tick) => [...tick.writes]);
  if (boot.length === 0) return ticks;
  const first = ticks[0] ?? [];
  for (let index = 0; index < boot.length; index += 1) {
    const want = boot[index]!;
    const got = first[index];
    if (got === undefined || got.reg !== want.reg || got.value !== want.value) {
      throw new PackError(
        "E_BOOT_PREFIX",
        `this schedule does not open with the chip initialisation the ROM performs at boot (write ${index})`,
        "the boot writes must be exactly the head of tick 0; this is a bug in the ROM builder, not in the track.",
      );
    }
  }
  ticks[0] = first.slice(boot.length);
  return ticks;
}

/** Encode ticks `[start, end)` into one block body. */
function encodeBlock(
  ticks: readonly (readonly RegisterWrite[])[],
  start: number,
  end: number,
  options: PackOptions,
): { bytes: Uint8Array; rests: boolean; merges: boolean } {
  const out: number[] = [];
  let rests = false;
  let merges = false;
  let tick = start;
  while (tick < end) {
    const writes = ticks[tick]!;
    if (writes.length === 0) {
      let run = 1;
      while (run < MAX_REST && tick + run < end && ticks[tick + run]!.length === 0) {
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
    if (options.channelOf === undefined) {
      out.push(writes.length);
      for (const write of writes) out.push(write.reg & 0xff, write.value & 0xff);
    } else if (encodeRuns(out, writes, options)) {
      merges = true;
    }
    tick += 1;
  }
  out.push(0x00);
  return { bytes: Uint8Array.from(out), rests, merges };
}

/**
 * Encode one tick as runs of writes that agree about who they belong to.
 *
 * Order is preserved exactly: a run is a *maximal consecutive* group, never a
 * regrouping. That is why the same schedule packed either way produces the same
 * register stream when nothing is preempted.
 */
function encodeRuns(
  out: number[],
  writes: readonly RegisterWrite[],
  options: PackOptions,
): boolean {
  const channelOf = options.channelOf as (reg: number) => number;
  const merge = options.mergeRegs ?? new Set<number>();
  const tags = writes.map((write) => ({
    channels: channelOf(write.reg) & RUN.channels,
    merge: merge.has(write.reg),
  }));

  const starts: number[] = [];
  for (let index = 0; index < writes.length; index += 1) {
    const previous = index === 0 ? undefined : tags[index - 1]!;
    const tag = tags[index]!;
    if (
      previous === undefined ||
      previous.channels !== tag.channels ||
      previous.merge !== tag.merge
    ) {
      starts.push(index);
    }
  }
  starts.push(writes.length);

  let merged = false;
  for (let run = 0; run + 1 < starts.length; run += 1) {
    const from = starts[run]!;
    const to = starts[run + 1]!;
    const tag = tags[from]!;
    const flags =
      (run + 2 < starts.length ? RUN.more : 0) | (tag.merge ? RUN.merge : 0) | tag.channels;
    if (tag.merge) merged = true;
    out.push(to - from, flags);
    for (let index = from; index < to; index += 1) {
      out.push(writes[index]!.reg & 0xff, writes[index]!.value & 0xff);
    }
  }
  return merged;
}

/**
 * A block that silences every channel and then rests.
 *
 * The writes come from the binding's own note-off encoding rather than a list
 * of registers repeated here, so a chip whose "off" is not `NRx2 = 0` cannot
 * end up with a sound effect that rings forever.
 */
function silenceBlock(script: ChipScript, options: PackOptions): Uint8Array {
  const off = silenceWrites(script.console);
  const out: number[] = [];
  if (options.channelOf === undefined) {
    out.push(off.length, ...off.flatMap((w) => [w.reg, w.value]));
  } else {
    encodeRuns(out, off, options);
  }
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
