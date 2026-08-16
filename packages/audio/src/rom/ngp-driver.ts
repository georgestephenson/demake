/**
 * The T6W28 driver's stream player — the TLCS-900/H half.
 *
 * `gb-driver.ts`, `mos-player.ts`, `sms-driver.ts`, `md-driver.ts`,
 * `arm-player.ts` and `wsc-driver.ts` are the same machine on six other
 * processors: a pointer walking packed data, a rest counter, and an order list
 * saying which block comes next. It is written once and specialised at emit time
 * from the packed data — a schedule with no rests emits no rest handling, a
 * stream nothing can preempt emits no preemption test — because the one thing
 * doc 16 makes a contract is the register stream, and seven hand-written copies
 * of a walk are seven chances to disagree about it.
 *
 * What is genuinely this machine's is small, and almost all of it is in the
 * write loop:
 *
 *   - **A chip is an address, and the address is a byte.** This console's sound
 *     ports are `$A0` and `$A1` in its own I/O page, which is the
 *     first 256 bytes of the address space — so the packed data stores the *low
 *     byte of the port's address*, `XDE` holds it with its upper three bytes
 *     zero, and a write is one store through it. That is the Game Boy's
 *     arrangement (`ld [$FF00+c], a`) reached by a machine that needs no base at
 *     all, and it is why {@link ngpPortByte} maps the schedule's register
 *     rather than the driver translating one per write.
 *   - **`(xhl+)` is the walk.** Post-increment is an addressing mode here, so
 *     taking the next packed byte is one instruction rather than a load and an
 *     increment — which is what makes this the shortest of the seven players
 *     despite doing the most per write.
 *   - **`djnz` counts the run**, so a loop of writes costs one instruction at
 *     the bottom and nothing at the top.
 *   - **A load says nothing about what it loaded.** `ld R,(mem)` sets no flags
 *     here, exactly as `ld a,(hl)` does not on a Z80 and unlike the 6502's
 *     `lda` — so every dispatch below states its own comparison. Omitting one
 *     does not fail: it branches on whatever the *previous* instruction decided,
 *     which is usually right by accident until it is not, and here it was
 *     wrong immediately (the walk read a block pointer and branched on the flags
 *     a `stmi` had left).
 *   - **A branch never has to be inverted.** `jrl cc` reaches ±32 KiB, which
 *     covers any routine here, so every conditional below is one instruction —
 *     the 6502, the Z80 and the V30MZ players all spend an inverted branch over
 *     a jump somewhere.
 *
 * And one rule that is not this machine's at all: **every branch here is `jrl`,
 * never `jr`.** This walk's length *is* the schedule — a recording body per
 * borrowable channel, a preemption test, each pulled or not — so the distance to
 * `TickBlock` is data rather than something visible in the emitter. It was `jr`
 * for exactly one build, which assembled for a game with no audio and refused
 * `pong` at 186 bytes out of range. The SM83 player learned the same thing the
 * same way (AGENTS.md §Working on audio).
 *
 * And one thing is the *chip's* rather than the processor's, and it is why this
 * file exists at all rather than the Sega one being pointed at a different
 * address: **there are two ports and they carry different registers**, so a
 * channel's copy is six bytes rather than three and the classification that
 * files a byte into it has to know which port the byte went to (`t6w28.ts`).
 */

import {
  Asm900,
  label,
  NGP_SOUND_RIGHT,
  t9Abs as abs,
  t9At as at,
  t9Postinc as postinc,
  type Ref,
} from "@demake/core";

import { RUN, type DriverData } from "./data.js";
import { T6W28_SHADOW } from "./t6w28.js";

/**
 * Where a stream keeps its position, in work RAM.
 *
 * Longwords, because a pointer on this machine is twenty-four bits — the packed
 * data is in a cartridge at `$200000` and the order list beside it, so neither
 * fits in the sixteen the other 8-bit players get away with. The rest counter
 * and the active flag are still bytes.
 */
export interface NgpStreamState {
  /** The block pointer. */
  data: number;
  /** The order-list pointer. */
  order: number;
  /**
   * Order entry playback returns to when the list runs out.
   *
   * Absent for a stream that stops instead of looping — a sound effect has no
   * loop entry, and a longword reserved for one would be one that could be read.
   */
  loop?: number;
  rest: number;
  /**
   * Non-zero while the stream is playing.
   *
   * Absent for a stream that starts at boot and never stops, on the same terms
   * as the other six players'.
   */
  active?: number;
}

/** What to emit, and how this stream shares the chip. */
export interface NgpStreamOptions {
  /** Label namespace, so one player can be emitted twice. */
  prefix: string;
  state: NgpStreamState;
  data: DriverData;
  /**
   * Byte naming the channels another stream has taken.
   *
   * Supplying it makes this stream *preemptible*: a run whose channels appear
   * there is skipped rather than written. Only music needs it.
   *
   * Skipping a whole run is what makes preemption safe on a chip that latches
   * its channel selection. Every run opens with a latch byte — the binding
   * writes a channel's registers together and leads with one — so a run that is
   * skipped takes its own selection with it and the next run that *is* written
   * selects again before it writes anything. `t6w28.ts`'s `checkLatchDiscipline`
   * refuses a schedule where that is not true, per port.
   */
  steal?: number;
  /**
   * Where this stream keeps a copy of the channels another stream can borrow.
   *
   * A run naming one of `channels` is recorded as well as written, and a run
   * that is *skipped* is recorded instead of written, so the copy is the music's
   * own state whether or not the chip currently holds it (`shared.ts`
   * §`shadowPlan`). This chip has no register numbers to index a copy by, so the
   * bytes of a channel are told apart by what each byte *is* and which port it
   * went to — which is `t6w28.ts`'s job.
   */
  shadow?: {
    /** One per borrowable channel: its bit, and where its copies live. */
    channels: readonly { bit: number; at: number; slots: readonly number[] }[];
  };
  /** Routine called when a stoppable stream's order list runs out. */
  onEnd?: string;
}

/**
 * The port byte the packed data carries, given the schedule's register.
 *
 * The chip's two ports are `$A0` (right) and `$A1` (left) in the console's own
 * I/O page, and `binding/t6w28.ts` numbers them 0 and 1 — so this is the whole
 * of the translation, done once at pack time rather than once a write.
 *
 * **Taken from `@demake/core` rather than spelled out**, and it was spelled out
 * once: `$20`/`$21`, sixteen bytes below the truth, which is where the
 * *processor's* own timer registers live. Nothing could see it, because the core
 * had the same two addresses wrong in the same direction — a demade cartridge
 * wrote where a demade emulator read, and the whole in-game battery passed on a
 * pair of ports no Neo Geo Pocket has (§Gotchas, wrong and consistent).
 */
export function ngpPortByte(reg: number): number {
  return NGP_SOUND_RIGHT | (reg & 1);
}

/**
 * Emit `<prefix>Tick` and `<prefix>NextBlock`, and report what they pulled in.
 *
 * `Tick` performs one driver tick and returns; `NextBlock` takes the next order
 * entry and returns with carry set when a stoppable stream has ended. The caller
 * supplies whatever drives them — on this console, the frame the picture already
 * runs on.
 */
export function emitStream(asm: Asm900, options: NgpStreamOptions): string[] {
  const { prefix: p, state, data } = options;
  const helpers: string[] = [];
  const stoppable = state.active !== undefined;
  const preemptible = options.steal !== undefined && data.runs;

  asm.label(`${p}Tick`);
  if (stoppable) {
    asm.aluMemImm("cp", abs(state.active as number), "b", 0);
    asm.retc("z");
    helpers.push("stoppable");
  }

  if (data.hasRests) {
    // The common case first: most ticks of most tracks write nothing at all.
    asm.aluMemImm("cp", abs(state.rest), "b", 0);
    asm.jrl("z", `${p}TickPlay`);
    asm.decMem(1, abs(state.rest), "b");
    asm.ret();
    helpers.push("rests");
  }

  asm.label(`${p}TickPlay`);
  asm.ldm("xhl", abs(state.data));
  // The upper three bytes of the write destination are zero for the whole tick,
  // because every port this driver touches is in the first page of the address
  // space. Only `E` moves after this.
  asm.ldn("xde", 0);

  asm.label(`${p}TickFetch`);
  asm.ldm("a", postinc("xhl"));
  asm.aluImm("cp", "a", 0); // a load sets no flags on this CPU
  asm.jrl("z", `${p}TickBlock`);
  if (data.hasRests) {
    asm.bit(7, "a");
    asm.jrl("nz", `${p}TickRest`);
  }
  asm.ld("b", "a");

  if (data.runs) {
    emitRuns(asm, options, preemptible);
    helpers.push(preemptible ? "preemptible-runs" : "runs");
    if (preemptible && options.shadow) helpers.push("borrowed-channel-shadow");
  } else {
    asm.label(`${p}TickWrite`);
    emitWrite(asm);
    asm.djnz("b", `${p}TickWrite`);
    asm.jrl("t", `${p}TickSave`);
  }

  if (data.hasRests) {
    asm.label(`${p}TickRest`);
    asm.aluImm("and", "a", 0x7f);
    asm.stm(abs(state.rest), "a");
  }

  asm.label(`${p}TickSave`);
  asm.stm(abs(state.data), "xhl");
  asm.ret();

  // Reaching the end of a block consumes no tick, so the fetch resumes in the
  // next one — which is why a block always covers at least one tick and the walk
  // cannot spin. Nothing is saved first: `NextBlock` replaces the pointer whole.
  asm.label(`${p}TickBlock`);
  asm.calr(label(`${p}NextBlock`));
  if (stoppable) asm.retc("c");
  asm.ldm("xhl", abs(state.data));
  asm.jrl("t", `${p}TickFetch`);

  emitNextBlock(asm, options);
  helpers.push(data.hasOrder ? "order-walk" : "single-block");
  if (data.oneShot) helpers.push("one-shot-stop");
  return helpers;
}

/**
 * One packed write: the port's low byte, then the value, straight to the chip.
 *
 * `XDE`'s upper bytes were zeroed at the top of the tick and nothing since has
 * touched them, so putting the port in `E` addresses the I/O page directly and
 * the store is one instruction with no base to add.
 */
function emitWrite(asm: Asm900): void {
  asm.ldm("e", postinc("xhl"));
  asm.ldm("a", postinc("xhl"));
  asm.stm(at("xde"), "a");
}

/**
 * The run walk: writes grouped by who they belong to.
 *
 * `B` counts the run, `C` carries its flags across it, `XDE` carries the
 * destination, `XHL` walks the data, and `A` is the byte in flight. That is the
 * SM83 player's allocation with a wider pointer, which is not a coincidence —
 * the same registers exist for the same reasons.
 */
function emitRuns(asm: Asm900, options: NgpStreamOptions, preemptible: boolean): void {
  const { prefix: p } = options;
  const shadow = preemptible ? options.shadow : undefined;

  asm.label(`${p}TickRun`);
  asm.ldm("a", postinc("xhl"));
  asm.ld("c", "a"); // flags
  if (preemptible) {
    asm.aluImm("and", "a", RUN.channels);
    asm.jrl("z", `${p}TickOwn`); // a run that names no channel is never preempted
    asm.aluMem("and", "a", abs(options.steal as number));
    asm.jrl("nz", `${p}TickSkip`);
    if (shadow) {
      // Ours right now, but borrowable: the chip and the copy both take it, so
      // the copy is still true the next time an effect hands the channel back.
      asm.ld("a", "c");
      asm.aluImm(
        "and",
        "a",
        shadow.channels.reduce((bits, one) => bits | one.bit, 0),
      );
      asm.jrl("nz", `${p}TickRecord`);
    }
  }
  asm.label(`${p}TickOwn`);

  asm.label(`${p}TickWrite`);
  emitWrite(asm);
  asm.djnz("b", `${p}TickWrite`);
  asm.jrl("t", `${p}TickNext`);

  if (shadow) {
    // Written *and* recorded, one loop per borrowable channel. Which of the six
    // copies a byte is depends on the port as well as the byte, so the port has
    // to be tested — which is the one place this driver does more work per write
    // than the Sega one, and the price of stereo being a level.
    asm.label(`${p}TickRecord`);
    perChannel(asm, shadow.channels, `${p}TickRecordOn`, (name, entry) => {
      asm.label(name);
      emitWrite(asm);
      emitRecord(asm, name, entry);
      asm.djnz("b", name);
      asm.jrl("t", `${p}TickNext`);
    });
  }

  if (preemptible) {
    // A skipped run is recorded and not written: the chip belongs to the effect
    // until it lets go, but the music's own idea of the channel has to keep
    // moving or the replay would restore a note that ended while it played.
    asm.label(`${p}TickSkip`);
    if (shadow) {
      perChannel(asm, shadow.channels, `${p}TickSkipOn`, (name, entry) => {
        asm.label(name);
        asm.ldm("e", postinc("xhl")); // the port, which the classification wants
        asm.ldm("a", postinc("xhl"));
        emitRecord(asm, name, entry);
        asm.djnz("b", name);
        asm.jrl("t", `${p}TickNext`);
      });
    } else {
      // Two bytes per write is the only thing the data says about its length.
      asm.label(`${p}TickSkipStep`);
      asm.aluImm("add", "xhl", 2);
      asm.djnz("b", `${p}TickSkipStep`);
    }
  }

  asm.label(`${p}TickNext`);
  asm.bit(7, "c");
  asm.jrl("z", `${p}TickSave`);
  asm.ldm("a", postinc("xhl"));
  asm.ld("b", "a");
  asm.jrl("t", `${p}TickRun`);
}

/**
 * Emit one body per borrowable channel, routed on the run's channel bits.
 *
 * The **first** channel falls through rather than being tested, because a run only
 * reaches here when it named one of them — so with a single borrowable channel,
 * which is what a game with one pitched effect has, there is no test at all. It
 * has to be the first and not the last, because the bodies are emitted in index
 * order directly below: testing every one but the *last* would send a run that
 * named it into the *first* channel's body, which no schedule in the example
 * library reaches and which nothing but a two-channel effect set can see.
 * `C` still holds the run's flags, so the bits are read from there rather than
 * from a register set aside for them.
 */
function perChannel(
  asm: Asm900,
  channels: readonly { bit: number; at: number; slots: readonly number[] }[],
  prefix: string,
  body: (name: string, entry: { at: number; slots: readonly number[] }) => void,
): void {
  for (let index = 1; index < channels.length; index += 1) {
    asm.ld("a", "c");
    asm.aluImm("and", "a", (channels[index] as { bit: number }).bit);
    asm.jrl("nz", `${prefix}${index}`);
  }
  for (let index = 0; index < channels.length; index += 1) {
    body(`${prefix}${index}`, channels[index] as { at: number; slots: readonly number[] });
  }
}

/**
 * Put the byte in `A` into whichever of a channel's copies it is.
 *
 * Constant addresses and a handful of bit tests, because between them the port
 * and the byte say what it is: `E`'s low bit separates the two ports (`$A0` and
 * `$A1`), bit 7 of the byte separates a latch from the data that continues it,
 * and bit 4 separates an attenuation latch from a period one. Only the copies a
 * channel really writes get a branch — a tone channel never touches the noise
 * slots, and the noise channel never touches the period ones.
 */
function emitRecord(
  asm: Asm900,
  name: string,
  entry: { at: number; slots: readonly number[] },
): void {
  const has = (slot: number): boolean => entry.slots.includes(slot);
  const done = `${name}Kept`;
  const left = [T6W28_SHADOW.TONE, T6W28_SHADOW.DATA, T6W28_SHADOW.LEFT].filter(has);
  const right = [T6W28_SHADOW.RIGHT, T6W28_SHADOW.NOISE, T6W28_SHADOW.NOISE_DATA].filter(has);

  // A store is a jump away and the last case falls through, so a channel that
  // only ever writes one port emits no port test at all.
  if (left.length > 0 && right.length > 0) {
    asm.bit(0, "e");
    asm.jrl("nz", `${name}Left`);
    emitSide(asm, `${name}R`, entry, right, done);
    asm.label(`${name}Left`);
    emitSide(asm, `${name}L`, entry, left, done);
  } else {
    emitSide(asm, `${name}S`, entry, left.length > 0 ? left : right, done);
  }
  asm.label(done);
}

/** One port's worth of the classification: at most three slots, two tests. */
function emitSide(
  asm: Asm900,
  name: string,
  entry: { at: number },
  slots: readonly number[],
  done: string,
): void {
  const isData = (slot: number): boolean =>
    slot === T6W28_SHADOW.DATA || slot === T6W28_SHADOW.NOISE_DATA;
  const isLevel = (slot: number): boolean =>
    slot === T6W28_SHADOW.LEFT || slot === T6W28_SHADOW.RIGHT;
  const data = slots.find(isData);
  const level = slots.find(isLevel);
  const period = slots.find((slot) => !isData(slot) && !isLevel(slot));

  if (data !== undefined && (level !== undefined || period !== undefined)) {
    asm.bit(7, "a");
    asm.jrl("z", `${name}Data`);
  }
  if (level !== undefined && period !== undefined) {
    asm.bit(4, "a");
    asm.jrl("nz", `${name}Level`);
  }
  if (period !== undefined) {
    asm.stm(abs(entry.at + period), "a");
    asm.jrl("t", done);
  }
  if (level !== undefined) {
    if (period !== undefined) asm.label(`${name}Level`);
    asm.stm(abs(entry.at + level), "a");
    asm.jrl("t", done);
  }
  if (data !== undefined) {
    if (level !== undefined || period !== undefined) asm.label(`${name}Data`);
    asm.stm(abs(entry.at + data), "a");
    asm.jrl("t", done);
  }
}

/**
 * Take the next order entry into the data pointer.
 *
 * The terminator is `$00000000` rather than a length, so the order list is
 * walked with a pointer and nothing counts. A looping stream reloads from its
 * stored loop entry; a stoppable one ends, returning with carry set so the
 * caller stops asking.
 */
function emitNextBlock(asm: Asm900, options: NgpStreamOptions): void {
  const { prefix: p, state } = options;
  asm.label(`${p}NextBlock`);
  asm.ldm("xiy", abs(state.order));
  asm.ldm("xiz", postinc("xiy", 4));
  asm.aluImm("cp", "xiz", 0);
  asm.jrl("nz", `${p}NextBlockGot`);

  if (state.active !== undefined && options.onEnd !== undefined) {
    asm.calr(label(options.onEnd));
    asm.stmi(abs(state.active), "b", 0);
    asm.scf();
    asm.ret();
  } else {
    // The loop entry is an address *inside* the order list, so pointing at it
    // and reading resumes the walk as if the list had never ended.
    asm.ldm("xiy", abs(state.loop as number));
    asm.ldm("xiz", postinc("xiy", 4));
  }

  asm.label(`${p}NextBlockGot`);
  asm.stm(abs(state.order), "xiy");
  asm.stm(abs(state.data), "xiz");
  asm.rcf(); // carry clear: the stream is still playing
  asm.ret();
}

/**
 * Emit a stream's packed data, and return the label its order list starts at.
 *
 * The order list comes first so a caller can point at it without knowing how
 * many blocks follow, and the loop entry is an offset into it. Entries are
 * *longwords* here, because a block lives in a cartridge at `$200000` and a
 * sixteen-bit pointer could not name it.
 */
export function emitStreamData(
  asm: Asm900,
  prefix: string,
  index: number,
  data: DriverData,
): string {
  const orderLabel = `${prefix}Order${index}`;
  const blockLabel = (block: number): string => `${prefix}Block${index}_${block}`;
  asm.label(orderLabel);
  for (const block of data.order) asm.dd(label(blockLabel(block)) as Ref);
  asm.dd(0x00000000);
  for (let block = 0; block < data.blocks.length; block += 1) {
    asm.label(blockLabel(block));
    asm.bytes(data.blocks[block] as Uint8Array);
  }
  return orderLabel;
}
