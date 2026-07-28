/**
 * The SN76489 driver's stream player — the 68000 half.
 *
 * The fourth copy of one machine (`gb-driver.ts`, `nes-driver.ts`,
 * `sms-driver.ts` beside it): a pointer walking packed data, a rest counter, and
 * an order list saying which block comes next. It is written once and
 * specialised at emit time from the packed data — a schedule with no rests emits
 * no rest handling, a stream nothing can preempt emits no preemption test —
 * because the one thing doc 16 makes a contract is the register stream, and four
 * hand-written copies of a walk are four chances to disagree about it.
 *
 * The *chip* is the Master System's and everything the chip decides lives in
 * `psg.ts`. What is this processor's is small, and all of it makes the player
 * shorter rather than longer:
 *
 *   - **A move sets the flags.** `move.b (a0)+,d0` leaves Z set for the block
 *     terminator and N set for the rest opcode's top bit, so one instruction
 *     answers both of the dispatch's questions. The Z80 player needs an explicit
 *     `or a` and then a `bit 7,a` for the same two.
 *   - **A stream pointer is a longword, because the data is half a megabyte
 *     away.** The Sega 8-bits keep theirs in two bytes and the Game Boy in two;
 *     a Mega Drive cartridge runs to `$07FFFF`, so an order entry, a block
 *     pointer and the loop entry are all 32-bit — one `move.l` either way, and
 *     the only cost is that the tables have to start on an even address.
 *   - **The chip is an address, not a port.** `$C00011` is outside the two-byte
 *     absolute form's reach, so the write loop holds it in `a1` and each write is
 *     a two-byte `move.b d0,(a1)`. That in turn is why the packed data's register
 *     byte is *skipped* rather than used: this chip has one register and this
 *     console reaches it one way, so the byte carries nothing. Keeping it costs
 *     one byte per write on a cartridge with half a megabyte, and forking the
 *     packed format to save them would cost every other console's driver a second
 *     shape to be right about.
 *   - **Every conditional branch reaches.** `bcc.w` takes a sixteen-bit
 *     displacement, so nothing here needs the 6502 player's invert-and-jump
 *     dance.
 *
 * Sources:
 * - Plutiedev — the PSG at $C00011: https://plutiedev.com/psg-chip
 * - SMS Power! — SN76489: https://www.smspower.org/Development/SN76489
 */

import { Asm68k, eaA, eaAbs, eaD, eaImm, eaInd, eaPost, label } from "@demake/core";

import { RUN, type DriverData } from "./data.js";
import { AudioRomError } from "./gb.js";

/**
 * Where the sound chip answers, in the 68000's address space.
 *
 * Inside the VDP's range and reached on the *odd* byte, which is why it is a
 * byte store rather than the word store everything else at `$C000xx` takes.
 */
export const PSG_ADDRESS = 0xc00011;

/** Registers the player uses, named so the allocation is readable in one place. */
const REG = {
  /** The packed data pointer, walking a block. */
  data: 0,
  /** The chip, held across a write loop. */
  chip: 1,
  /** The fetched byte, and every scratch use. */
  byte: 0,
  /** Writes left in the run. */
  count: 1,
  /** The run's flags, live across it. */
  flags: 2,
  /** The preemption test's scratch. */
  steal: 3,
} as const;

/**
 * Where a stream keeps its position, in work RAM.
 *
 * Longwords for the three pointers, because the packed data is anywhere in a
 * half-megabyte cartridge and a sixteen-bit pointer would reach the first
 * sixty-four kilobytes of it. The base has to be even and the byte fields come
 * last for that reason — `md-game.ts`'s `layout` is where that is arranged.
 */
export interface MdStreamState {
  /** The block pointer. */
  data: number;
  /** The order-list pointer. */
  order: number;
  /**
   * Order entry playback returns to when the list runs out.
   *
   * Absent for a stream that stops instead of looping — a sound effect has no
   * loop entry, and a longword reserved for one would be a longword that could
   * be read.
   */
  loop?: number;
  rest: number;
  /**
   * Non-zero while the stream is playing.
   *
   * Absent for a stream that starts at boot and never stops, on the same terms
   * as the other three players'. It is also **how this player reports the end of
   * a stoppable stream**: the Z80 and the 6502 set the carry and this CPU has no
   * `scf`, so `NextBlock` clears the byte that already means exactly that and the
   * caller tests it. One instruction at the call site either way.
   */
  active?: number;
}

/** What to emit, and how this stream shares the chip. */
export interface MdStreamOptions {
  /** Label namespace, so one player can be emitted twice. */
  prefix: string;
  state: MdStreamState;
  data: DriverData;
  /**
   * Byte naming the channels another stream has taken.
   *
   * Supplying it makes this stream *preemptible*: a run whose channels appear
   * there is skipped rather than written. Only music needs it.
   *
   * Skipping a whole run is what makes preemption safe on a chip that latches
   * its channel selection — `psg.ts` §`checkLatchDiscipline` is the property it
   * rests on.
   */
  steal?: number;
  /** Routine called when a stoppable stream's order list runs out. */
  onEnd?: string;
}

/**
 * Emit `<prefix>Tick` and `<prefix>NextBlock`, and report what they pulled in.
 *
 * `Tick` performs one driver tick and returns; `NextBlock` takes the next order
 * entry, clearing a stoppable stream's `active` byte when the list runs out. The
 * caller supplies whatever drives them — on this console, the frame the picture
 * already runs on.
 */
export function emitStream(asm: Asm68k, options: MdStreamOptions): string[] {
  const { prefix: p, state, data } = options;
  const helpers: string[] = [];
  const stoppable = state.active !== undefined;
  const preemptible = options.steal !== undefined && data.runs;

  if (data.hasMerges) {
    // No register on this console carries two streams at once: the SN76489 here
    // is the mono part, with no Game Gear stereo latch beside it. A packed
    // schedule with merge runs in it would be performed as plain stores, which
    // is a silent difference rather than a missing feature.
    throw new AudioRomError(
      "E_INTERNAL",
      "an md audio schedule was packed with merge runs and this console has no shared register",
      "this is a bug in the ROM builder, not in the track.",
    );
  }

  asm.label(`${p}Tick`);
  if (stoppable) {
    asm.tst("b", eaAbs(state.active as number));
    asm.bcc("ne", `${p}TickGo`);
    asm.rts();
    asm.label(`${p}TickGo`);
    helpers.push("stoppable");
  }

  if (data.hasRests) {
    // The common case first: most ticks of most tracks write nothing at all.
    asm.move("b", eaAbs(state.rest), eaD(REG.byte));
    asm.bcc("eq", `${p}TickPlay`);
    asm.subq("b", 1, eaD(REG.byte));
    asm.move("b", eaD(REG.byte), eaAbs(state.rest));
    asm.rts();
    helpers.push("rests");
  }

  asm.label(`${p}TickPlay`);
  asm.movea("l", eaAbs(state.data), REG.data);

  // Both ways into the fetch pass through here, so the chip pointer is loaded in
  // one place: a block boundary can call `onEnd`, which writes the chip itself.
  asm.label(`${p}TickReload`);
  asm.movea("l", eaImm(PSG_ADDRESS), REG.chip);

  asm.label(`${p}TickFetch`);
  asm.move("b", eaPost(REG.data), eaD(REG.byte));
  // One move, two answers: Z for the block terminator, N for the rest opcode.
  asm.bcc("eq", `${p}TickBlock`);
  if (data.hasRests) asm.bcc("mi", `${p}TickRest`);
  asm.move("b", eaD(REG.byte), eaD(REG.count));

  if (data.runs) {
    emitRuns(asm, options, preemptible);
    helpers.push(preemptible ? "preemptible-runs" : "runs");
  } else {
    asm.label(`${p}TickWrite`);
    emitWrite(asm);
    asm.subq("b", 1, eaD(REG.count));
    asm.bcc("ne", `${p}TickWrite`);
    asm.bra(`${p}TickSave`);
  }

  if (data.hasRests) {
    asm.label(`${p}TickRest`);
    asm.andi("b", 0x7f, eaD(REG.byte));
    asm.move("b", eaD(REG.byte), eaAbs(state.rest));
  }

  asm.label(`${p}TickSave`);
  asm.move("l", eaA(REG.data), eaAbs(state.data));
  asm.label(`${p}TickDone`);
  asm.rts();

  // Reaching the end of a block consumes no tick, so the fetch resumes in the
  // next one — which is why a block always covers at least one tick and the walk
  // cannot spin. Nothing is saved first: `NextBlock` replaces the pointer whole.
  asm.label(`${p}TickBlock`);
  asm.bsr(`${p}NextBlock`);
  if (stoppable) {
    asm.tst("b", eaAbs(state.active as number));
    asm.bcc("eq", `${p}TickDone`);
  }
  asm.movea("l", eaAbs(state.data), REG.data);
  asm.bra(`${p}TickReload`);

  emitNextBlock(asm, options);
  helpers.push(data.hasOrder ? "order-walk" : "single-block");
  if (data.oneShot) helpers.push("one-shot-stop");
  return helpers;
}

/**
 * One packed write: step over the register byte, then the value out to the chip.
 *
 * The register byte is the one the Game Boy spends on a high-RAM offset and the
 * Z80 on a port number. Here there is nothing for it to say, so it is stepped
 * over — see this file's header for why it is still there.
 */
function emitWrite(asm: Asm68k): void {
  asm.addq("l", 1, eaA(REG.data));
  asm.move("b", eaPost(REG.data), eaD(REG.byte));
  asm.move("b", eaD(REG.byte), eaInd(REG.chip));
}

/**
 * The run walk: writes grouped by who they belong to.
 *
 * `d1` counts the run, `d2` carries its flags across it, `a0` walks the data,
 * `a1` holds the chip, and `d3` is borrowed only by the preemption test. That is
 * the other three players' allocation with different names on the registers,
 * which is not a coincidence — the walk is the same walk.
 */
function emitRuns(asm: Asm68k, options: MdStreamOptions, preemptible: boolean): void {
  const { prefix: p } = options;

  asm.label(`${p}TickRun`);
  asm.move("b", eaPost(REG.data), eaD(REG.flags));
  if (preemptible) {
    asm.move("b", eaD(REG.flags), eaD(REG.byte));
    asm.andi("b", RUN.channels, eaD(REG.byte));
    asm.bcc("eq", `${p}TickOwn`); // a run that names no channel is never preempted
    asm.move("b", eaAbs(options.steal as number), eaD(REG.steal));
    asm.and("b", eaD(REG.steal), REG.byte);
    asm.bcc("ne", `${p}TickSkip`);
  }
  asm.label(`${p}TickOwn`);

  asm.label(`${p}TickWrite`);
  emitWrite(asm);
  asm.subq("b", 1, eaD(REG.count));
  asm.bcc("ne", `${p}TickWrite`);
  asm.bra(`${p}TickNext`);

  if (preemptible) {
    // A skipped run still has to be stepped over, and two bytes per write is the
    // only thing the data says about its length.
    asm.label(`${p}TickSkip`);
    asm.addq("l", 2, eaA(REG.data));
    asm.subq("b", 1, eaD(REG.count));
    asm.bcc("ne", `${p}TickSkip`);
  }

  asm.label(`${p}TickNext`);
  asm.btst(7, eaD(REG.flags));
  asm.bcc("eq", `${p}TickSave`);
  asm.move("b", eaPost(REG.data), eaD(REG.count));
  asm.bra(`${p}TickRun`);
}

/**
 * Take the next order entry into the data pointer.
 *
 * The terminator is `$00000000` rather than a length, so the order list is
 * walked with a pointer and nothing counts. A looping stream reloads from its
 * stored loop entry; a stoppable one ends, clearing `active` so the caller — and
 * the next tick — stop asking.
 */
function emitNextBlock(asm: Asm68k, options: MdStreamOptions): void {
  const { prefix: p, state } = options;
  asm.label(`${p}NextBlock`);
  asm.movea("l", eaAbs(state.order), REG.data);
  asm.move("l", eaPost(REG.data), eaD(REG.byte));
  asm.bcc("ne", `${p}NextBlockGot`);

  if (state.active !== undefined && options.onEnd !== undefined) {
    asm.bsr(options.onEnd);
    asm.clr("b", eaAbs(state.active));
    asm.rts();
  } else {
    // The loop entry is an address *inside* the order list, so pointing at it
    // and reading resumes the walk as if the list had never ended.
    asm.movea("l", eaAbs(state.loop as number), REG.data);
    asm.move("l", eaPost(REG.data), eaD(REG.byte));
  }

  asm.label(`${p}NextBlockGot`);
  asm.move("l", eaA(REG.data), eaAbs(state.order));
  asm.move("l", eaD(REG.byte), eaAbs(state.data));
  asm.rts();
}

/**
 * Emit a stream's packed data, and return the label its order list starts at.
 *
 * The order list comes first so a caller can point at it without knowing how
 * many blocks follow, and the loop entry is an offset into it. Aligned first,
 * because the entries are longwords and the block bodies before them are a run
 * of bytes — an odd address here is an address error at the first `move.l`, not
 * a wrong note.
 */
export function emitStreamData(
  asm: Asm68k,
  prefix: string,
  index: number,
  data: DriverData,
): string {
  const orderLabel = `${prefix}Order${index}`;
  const blockLabel = (block: number) => `${prefix}Block${index}_${block}`;
  asm.align();
  asm.label(orderLabel);
  for (const block of data.order) asm.dl(label(blockLabel(block)));
  asm.dl(0);
  for (let block = 0; block < data.blocks.length; block += 1) {
    asm.label(blockLabel(block));
    asm.bytes(data.blocks[block] as Uint8Array);
  }
  return orderLabel;
}
