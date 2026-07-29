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
 * What the register byte *means* is the console's, through
 * {@link PackOptions.port}. The Game Boy stores the low byte of the register's
 * hardware address, so the driver writes it with `ld [$FF00+c], a` and the packed
 * data reads the way the Pan Docs do; the NES stores the same byte for an
 * unrelated reason, its registers being `$4000 + reg`. The SN76489 has no
 * register numbers at all — one port, and the addressing is inside the value — so
 * it stores the port. One byte in every case, and no driver pays to translate.
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

/**
 * Which channels a write belongs to; `0` for one that belongs to none.
 *
 * A *function of the value as well as the register*, because on one of these
 * chips the register number says nothing at all: an SN76489 is written through a
 * single port and carries the channel in the top bits of the data byte — and
 * carries it *latched*, so a byte with bit 7 clear continues whatever the byte
 * before it selected. And of the *chip*, because a console may have two.
 *
 * What the four bits mean is the console's, exactly as {@link PackOptions.port}
 * decides what the register byte means. A console with four voices numbers them
 * one per bit; a Mega Drive has ten and cannot, so its tag returns a bit only for
 * the channels an effect may actually take and zero — never preempted — for
 * everything else. Which is the only distinction preemption needs.
 */
export type ChannelTag = (reg: number, value: number, chip: number) => number;

/** How a stream shares the chip with the other one, when there is another. */
export interface PackOptions {
  /**
   * Channel bits a register belongs to, as a **factory**.
   *
   * Supplying it packs the stream in runs (see the format note above), which is
   * what a driver needs to skip a preempted channel cheaply. Leaving it out
   * packs the flat format, which is what a cartridge that owns the whole chip
   * wants.
   *
   * A factory rather than a plain function because a {@link ChannelTag} may
   * carry a latch, and a latch is per *schedule*: two calls to `packScript`
   * sharing one would tag the second stream's opening bytes from the first
   * stream's last write. `packScript` asks for a fresh tag once and walks the
   * ticks in order, which is exactly the order the chip will see them in.
   */
  channelOf?: () => ChannelTag;
  /**
   * Registers whose writes are merges under a mask rather than plain stores.
   *
   * The Game Boy's `NR51` is the case this exists for: one byte carries every
   * channel's panning, so two streams that both store it erase each other, and
   * a stream must only ever change its own bits.
   */
  mergeRegs?: ReadonlySet<number>;
  /**
   * How a register number is written into the packed data.
   *
   * The Game Boy and the NES store the register itself, because their drivers
   * turn it into an address by adding a base (`$FF00` and `$4000`). A Z80 reaches
   * its chip through `out (c), a`, so the SN76489's driver stores the **port** —
   * one byte either way, and a translation the write loop would otherwise pay for
   * on every write of every tick. A Mega Drive has two chips and five destinations
   * between them, so it stores which one. Defaults to the register unchanged.
   *
   * It never reaches {@link PackOptions.channelOf} or
   * {@link PackOptions.mergeRegs}: both are asked about the schedule's own
   * register, so a console that renumbers here does not renumber those.
   */
  port?: (reg: number, chip: number) => number;
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
  // One tag for this schedule, walked in tick order — see `PackOptions.channelOf`
  // for why it cannot be shared with the next call.
  const tag = options.channelOf?.();
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
    const body = encodeBlock(ticks, start, end, options, tag);
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
    const stop = silenceBlock(script, options, tag);
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
  tag: ChannelTag | undefined,
): { bytes: Uint8Array; rests: boolean; merges: boolean } {
  const port = options.port ?? ((reg: number) => reg);
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
    if (tag === undefined && writes.length > MAX_WRITES_PER_TICK) {
      // Only the *flat* format is bounded here: its opcode is a count and a
      // block terminator, so there is nowhere to put a hundred and twenty-eighth
      // write. The run format chains with its `more` bit instead — see below.
      throw new PackError(
        "E_TICK_TOO_LARGE",
        `tick ${tick} asks for ${writes.length} register writes and the driver format holds ${MAX_WRITES_PER_TICK}`,
        "the console's per-tick write budget is far below this, so the schedule would overrun its tick on hardware too; `demake inspect` reports it.",
      );
    }
    if (tag === undefined) {
      out.push(writes.length);
      for (const write of writes) {
        out.push(port(write.reg, write.chip ?? 0) & 0xff, write.value & 0xff);
      }
    } else if (encodeRuns(out, writes, options, tag)) {
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
  channelOf: ChannelTag,
): boolean {
  const port = options.port ?? ((reg: number) => reg);
  const merge = options.mergeRegs ?? new Set<number>();
  // Tagged in the order the chip will see them, and every write is offered to
  // the tag even when it turns out to belong to no channel: a latching chip
  // updates its selection from writes the run format then never asks about.
  const tags = writes.map((write) => ({
    channels: channelOf(write.reg, write.value, write.chip ?? 0) & RUN.channels,
    merge: merge.has(write.reg),
  }));

  const starts: number[] = [];
  for (let index = 0; index < writes.length; index += 1) {
    const previous = index === 0 ? undefined : tags[index - 1]!;
    const tag = tags[index]!;
    if (
      previous === undefined ||
      previous.channels !== tag.channels ||
      previous.merge !== tag.merge ||
      // A run's length is seven bits, so a long enough stretch of writes that
      // agree about everything is still two runs. The `more` bit already says
      // "another follows in this tick", which is exactly what that is — so a
      // tick of four hundred writes needs no second format, only more runs.
      index - (starts[starts.length - 1] as number) >= MAX_WRITES_PER_TICK
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
      const write = writes[index]!;
      out.push(port(write.reg, write.chip ?? 0) & 0xff, write.value & 0xff);
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
function silenceBlock(
  script: ChipScript,
  options: PackOptions,
  tag: ChannelTag | undefined,
): Uint8Array {
  const port = options.port ?? ((reg: number) => reg);
  const off = silenceWrites(script.console);
  const out: number[] = [];
  if (tag === undefined) {
    out.push(off.length, ...off.flatMap((w) => [port(w.reg, 0), w.value]));
  } else {
    encodeRuns(out, off, options, tag);
  }
  out.push(0x80 | (MAX_REST - 1), 0x00);
  return Uint8Array.from(out);
}

/** Note-off for each channel, by console family. */
function silenceWrites(consoleId: string): { reg: number; value: number }[] {
  // Reached only by a *cartridge* whose one job is a sound effect, and the Game
  // Boy family is the only one that builds such a cartridge — `buildAudioRom`
  // refuses the rest before anything gets here, and a game's effects ask for
  // `end: "stop"` instead, because a block that silenced every channel would
  // take the music with it. So this stays a fact about one chip rather than a
  // table that quietly grows wrong entries for the other two.
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
