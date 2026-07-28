/**
 * The SN76489 driver's stream player — the Z80 half.
 *
 * `gb-driver.ts` and `nes-driver.ts` one console over, and the same machine
 * again: a pointer walking packed data, a rest counter, and an order list saying
 * which block comes next. It is written once and specialised at emit time from
 * the packed data — a schedule with no rests emits no rest handling, a stream
 * nothing can preempt emits no preemption test — because the one thing doc 16
 * makes a contract is the register stream, and three hand-written copies of a
 * walk are three chances to disagree about it.
 *
 * What is genuinely this machine's is small, and all of it is in the write loop:
 *
 *   - **A chip is a port, not an address.** The Z80 has a separate I/O space and
 *     one register-indirect way into it, `out (c), a`, so a write is `ld c,
 *     port` and then the value. The packed data therefore carries the *port*
 *     rather than a register number (`data.ts`'s `port` option), which costs the
 *     same byte the other two consoles spend and saves the translation.
 *   - **`b` is the run counter and also the high half of the port address.**
 *     `out (c), a` puts `b` on A8–A15, and the Sega 8-bits decode I/O from A7,
 *     A6 and A0 alone — so whatever the counter happens to hold is ignored by
 *     every device on the bus. Stated because it looks like a bug.
 *   - **A load says nothing about what it loaded.** `ld a,(hl)` sets no flags
 *     where the 6502's `lda` sets two, so the opcode dispatch says `or a`
 *     explicitly. The SM83 player has the same problem and the same line; the
 *     6502 player has the opposite one and solves it the other way round.
 *   - **Every conditional jump reaches.** `jp cc,nn` takes a sixteen-bit target,
 *     so nothing here needs the 6502 player's invert-and-jump dance. `jr` is
 *     kept for the loops whose target is a few instructions above.
 *
 * Sources:
 * - SMS Power! — SN76489: https://www.smspower.org/Development/SN76489
 * - SMS Power! — Z80 I/O port decoding: https://www.smspower.org/Development/Ports
 */

import { AsmZ80, label } from "@demake/core";

import { RUN, type DriverData } from "./data.js";

/**
 * Where a stream keeps its position, in work RAM.
 *
 * Words rather than the byte pairs the other two players keep, because this CPU
 * loads and stores sixteen bits in one instruction (`ld hl,(nn)`) and has no
 * cheap page to be economical in — a Z80 pays the same two address bytes wherever
 * a variable lives, which is why `SMS_MEMORY` reserves no fast region at all.
 */
export interface SmsStreamState {
  /** The block pointer. */
  data: number;
  /** The order-list pointer. */
  order: number;
  /**
   * Order entry playback returns to when the list runs out.
   *
   * Absent for a stream that stops instead of looping — a sound effect has no
   * loop entry, and a word reserved for one would be a word that could be read.
   */
  loop?: number;
  rest: number;
  /**
   * Non-zero while the stream is playing.
   *
   * Absent for a stream that starts at boot and never stops, on the same terms
   * as the other two players'.
   */
  active?: number;
}

/** What to emit, and how this stream shares the chip. */
export interface SmsStreamOptions {
  /** Label namespace, so one player can be emitted twice. */
  prefix: string;
  state: SmsStreamState;
  data: DriverData;
  /**
   * Byte naming the channels another stream has taken.
   *
   * Supplying it makes this stream *preemptible*: a run whose channels appear
   * there is skipped rather than written. Only music needs it.
   *
   * Skipping a whole run is what makes preemption safe on a chip that latches
   * its channel selection. Every run of an SN76489 stream opens with a latch
   * byte — the binding writes a channel's registers together and leads with one
   * — so a run that is skipped takes its own selection with it and the next run
   * that *is* written selects again before it writes anything.
   */
  steal?: number;
  /**
   * Routine that takes a merge run's value in `a` and folds it into the chip.
   *
   * The Game Gear's stereo port is the whole of it: one byte carries every
   * channel's left and right enables, so a stream that stored it would silence
   * the other stream's notes. A Master System has no such register and emits no
   * merge path at all. Called with `b`, `d` and `hl` live.
   */
  merge?: string;
  /** Routine called when a stoppable stream's order list runs out. */
  onEnd?: string;
}

/**
 * Emit `<prefix>Tick` and `<prefix>NextBlock`, and report what they pulled in.
 *
 * `Tick` performs one driver tick and returns; `NextBlock` takes the next order
 * entry and returns with carry set when a stoppable stream has ended. The caller
 * supplies whatever drives them — on this console, the frame the picture already
 * runs on.
 */
export function emitStream(asm: AsmZ80, options: SmsStreamOptions): string[] {
  const { prefix: p, state, data } = options;
  const helpers: string[] = [];
  const stoppable = state.active !== undefined;
  const preemptible = options.steal !== undefined && data.runs;

  asm.label(`${p}Tick`);
  if (stoppable) {
    asm.lda(state.active as number);
    asm.alu("or", "a");
    asm.ret("z");
    helpers.push("stoppable");
  }

  if (data.hasRests) {
    // The common case first: most ticks of most tracks write nothing at all.
    asm.lda(state.rest);
    asm.alu("or", "a");
    asm.jr(`${p}TickPlay`, "z");
    asm.dec("a");
    asm.sta(state.rest);
    asm.ret();
    helpers.push("rests");
  }

  asm.label(`${p}TickPlay`);
  asm.ld16From("hl", state.data);

  asm.label(`${p}TickFetch`);
  fetch(asm);
  asm.alu("or", "a"); // a load sets no flags on this CPU
  asm.jp(`${p}TickBlock`, "z");
  if (data.hasRests) {
    asm.bit(7, "a");
    asm.jp(`${p}TickRest`, "nz");
  }
  asm.ld("b", "a");

  if (data.runs) {
    emitRuns(asm, options, preemptible);
    helpers.push(preemptible ? "preemptible-runs" : "runs");
  } else {
    asm.label(`${p}TickWrite`);
    emitWrite(asm);
    asm.dec("b");
    asm.jr(`${p}TickWrite`, "nz");
    asm.jp(`${p}TickSave`);
  }

  if (data.hasRests) {
    asm.label(`${p}TickRest`);
    asm.aluN("and", 0x7f);
    asm.sta(state.rest);
  }

  asm.label(`${p}TickSave`);
  asm.st16To(state.data, "hl");
  asm.ret();

  // Reaching the end of a block consumes no tick, so the fetch resumes in the
  // next one — which is why a block always covers at least one tick and the walk
  // cannot spin. Nothing is saved first: `NextBlock` replaces the pointer whole.
  asm.label(`${p}TickBlock`);
  asm.call(`${p}NextBlock`);
  if (stoppable) asm.ret("c");
  asm.ld16From("hl", state.data);
  asm.jp(`${p}TickFetch`);

  emitNextBlock(asm, options);
  helpers.push(data.hasOrder ? "order-walk" : "single-block");
  if (data.oneShot) helpers.push("one-shot-stop");
  if (data.hasMerges) helpers.push("stereo-merge");
  return helpers;
}

/** Take the byte `hl` is on into `a`, and step past it. */
function fetch(asm: AsmZ80): void {
  asm.ld("a", "hlp");
  asm.inc16("hl");
}

/** One packed write: the port, then the value, straight out to the chip. */
function emitWrite(asm: AsmZ80): void {
  fetch(asm);
  asm.ld("c", "a");
  fetch(asm);
  asm.outC("a"); // `b` rides along on A8–A15, which nothing on this bus decodes
}

/**
 * The run walk: writes grouped by who they belong to.
 *
 * `b` counts the run, `d` carries its flags across it, `c` carries the port,
 * `hl` walks the data, and `e` is borrowed only by the preemption test. That is
 * the SM83 player's allocation exactly, which is not a coincidence — the same
 * registers exist for the same reasons, and this CPU merely has more of them
 * spare.
 */
function emitRuns(asm: AsmZ80, options: SmsStreamOptions, preemptible: boolean): void {
  const { prefix: p, data } = options;

  asm.label(`${p}TickRun`);
  fetch(asm);
  asm.ld("d", "a"); // flags
  if (preemptible) {
    asm.aluN("and", RUN.channels);
    asm.jr(`${p}TickOwn`, "z"); // a run that names no channel is never preempted
    asm.ld("e", "a");
    asm.lda(options.steal as number);
    asm.alu("and", "e");
    asm.jp(`${p}TickSkip`, "nz");
  }
  asm.label(`${p}TickOwn`);
  if (data.hasMerges) {
    asm.bit(6, "d");
    asm.jp(`${p}TickMerge`, "nz");
  }

  asm.label(`${p}TickWrite`);
  emitWrite(asm);
  asm.dec("b");
  asm.jr(`${p}TickWrite`, "nz");
  asm.jp(`${p}TickNext`);

  if (data.hasMerges) {
    asm.label(`${p}TickMerge`);
    asm.inc16("hl"); // the port is the merge routine's
    fetch(asm);
    asm.call(options.merge as string);
    asm.dec("b");
    asm.jr(`${p}TickMerge`, "nz");
    asm.jp(`${p}TickNext`);
  }

  if (preemptible) {
    // A skipped run still has to be stepped over, and two bytes per write is the
    // only thing the data says about its length.
    asm.label(`${p}TickSkip`);
    asm.inc16("hl");
    asm.inc16("hl");
    asm.dec("b");
    asm.jr(`${p}TickSkip`, "nz");
  }

  asm.label(`${p}TickNext`);
  asm.bit(7, "d");
  asm.jp(`${p}TickSave`, "z");
  fetch(asm);
  asm.ld("b", "a");
  asm.jp(`${p}TickRun`);
}

/**
 * Take the next order entry into the data pointer.
 *
 * The terminator is `$0000` rather than a length, so the order list is walked
 * with a pointer and nothing counts. A looping stream reloads from its stored
 * loop entry; a stoppable one ends, returning with carry set so the caller stops
 * asking.
 */
function emitNextBlock(asm: AsmZ80, options: SmsStreamOptions): void {
  const { prefix: p, state } = options;
  asm.label(`${p}NextBlock`);
  asm.ld16From("hl", state.order);
  emitReadEntry(asm);
  asm.jr(`${p}NextBlockGot`, "nz");

  if (state.active !== undefined && options.onEnd !== undefined) {
    asm.call(options.onEnd);
    asm.alu("xor", "a");
    asm.sta(state.active);
    asm.scf();
    asm.ret();
  } else {
    // The loop entry is an address *inside* the order list, so pointing at it
    // and reading resumes the walk as if the list had never ended.
    asm.ld16From("hl", state.loop as number);
    emitReadEntry(asm);
  }

  asm.label(`${p}NextBlockGot`);
  asm.st16To(state.order, "hl");
  asm.st16To(state.data, "de");
  asm.alu("or", "a"); // carry clear: the stream is still playing
  asm.ret();
}

/**
 * Read the entry `hl` is on into `de`, stepping past it.
 *
 * Leaves the two halves ored together in `a`, so the caller's branch tests the
 * `$0000` terminator without a second load — the same reason the SM83 player ends
 * its read with `or e`.
 */
function emitReadEntry(asm: AsmZ80): void {
  fetch(asm);
  asm.ld("e", "a");
  fetch(asm);
  asm.ld("d", "a");
  asm.alu("or", "e"); // `a` still holds the high byte
}

/**
 * Emit a stream's packed data, and return the label its order list starts at.
 *
 * The order list comes first so a caller can point at it without knowing how many
 * blocks follow, and the loop entry is an offset into it.
 */
export function emitStreamData(
  asm: AsmZ80,
  prefix: string,
  index: number,
  data: DriverData,
): string {
  const orderLabel = `${prefix}Order${index}`;
  const blockLabel = (block: number) => `${prefix}Block${index}_${block}`;
  asm.label(orderLabel);
  for (const block of data.order) asm.dw(label(blockLabel(block)));
  asm.dw(0x0000);
  for (let block = 0; block < data.blocks.length; block += 1) {
    asm.label(blockLabel(block));
    asm.bytes(data.blocks[block] as Uint8Array);
  }
  return orderLabel;
}
