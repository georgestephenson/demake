/**
 * The SN76489 driver's stream player — the 68000 half.
 *
 * The fourth copy of one machine (`gb-driver.ts`, `mos-player.ts`,
 * `sms-driver.ts` beside it): a pointer walking packed data, a rest counter, and
 * an order list saying which block comes next. It is written once and
 * specialised at emit time from the packed data — a schedule with no rests emits
 * no rest handling, a stream nothing can preempt emits no preemption test —
 * because the one thing doc 16 makes a contract is the register stream, and four
 * hand-written copies of a walk are four chances to disagree about it.
 *
 * The *chips* are a YM2612 and an SN76489, and everything they decide lives in
 * `md-chips.ts` and `psg.ts`. What is this processor's is small:
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
 *   - **There are two chips and five ways in.** The FM chip's four bus addresses
 *     are consecutive at `$A04000`, so a write to one is an indexed store off a
 *     held base; the PSG at `$C00011` is a comparison away. Both live in address
 *     registers across the write loop, and the packed data's register byte says
 *     which — the same byte the Game Boy spends on a high-RAM offset and the Z80
 *     on a port number, carrying more here because this console has more
 *     hardware to reach.
 *   - **Every conditional branch reaches.** `bcc.w` takes a sixteen-bit
 *     displacement, so nothing here needs the 6502 player's invert-and-jump
 *     dance.
 *
 * Sources:
 * - Plutiedev — the PSG at $C00011: https://plutiedev.com/psg-chip
 * - Plutiedev — the YM2612 at $A04000: https://plutiedev.com/ym2612-registers
 * - SMS Power! — SN76489: https://www.smspower.org/Development/SN76489
 */

import { Asm68k, eaA, eaAbs, eaD, eaIdx, eaImm, eaInd, eaPost, label } from "@demake/core";

import { RUN, type DriverData } from "./data.js";
import { PSG_SHADOW } from "./psg.js";
import type { MdShadowChannel, MdShadowWrite } from "./md-chips.js";
import { AudioRomError } from "./gb.js";

/**
 * Where the sound chip answers, in the 68000's address space.
 *
 * Inside the VDP's range and reached on the *odd* byte, which is why it is a
 * byte store rather than the word store everything else at `$C000xx` takes.
 */
export const PSG_ADDRESS = 0xc00011;

/**
 * Where the FM chip's four bus addresses start.
 *
 * `$A04000`/`$A04001` latch and write for voices 1-3, `$A04002`/`$A04003` for
 * 4-6 — four consecutive bytes, which is why the packed port byte can simply be
 * an index off this base and the PSG is the one destination that needs a test.
 */
export const YM_ADDRESS = 0xa04000;

/** The packed port byte that means the PSG rather than one of the FM's four. */
export const PSG_PORT = 4;

/** Registers the player uses, named so the allocation is readable in one place. */
const REG = {
  /** The packed data pointer, walking a block. */
  data: 0,
  /** The FM chip's bus base, held across a write loop. */
  chip: 1,
  /** The PSG's address, held beside it. */
  psg: 2,
  /** The fetched byte, and every scratch use. */
  byte: 0,
  /** Writes left in the run. */
  count: 1,
  /** The run's flags, live across it. */
  flags: 2,
  /** The preemption test's scratch. */
  steal: 3,
  /** Which of the five destinations this write goes to. */
  port: 4,
  /** The copy's base, while a run is being recorded. */
  shadow: 3,
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
  /**
   * Where this stream keeps a copy of the voices another stream can borrow.
   *
   * A run naming one of these is recorded as well as written, and a run that is
   * *skipped* is recorded instead of written, so the copy is the music's own
   * state whether or not the chip currently holds it (doc 13 §Handing a borrowed
   * channel back). Neither chip on this board has a register number the packed
   * byte carries, so what a copy is indexed by is `md-chips.ts`'s answer.
   */
  shadow?: {
    /** Where the copies live. */
    at: number;
    /**
     * One byte holding the FM address the bus last latched.
     *
     * In memory rather than in a register, and updated by **every** FM write this
     * stream makes rather than only the recorded ones, because an address and its
     * data can land in different runs. `$28` is the case that forces it: the key
     * register belongs to no voice until its *datum* names one, so the address
     * write is tagged "no channel" and goes down the plain write path while the
     * data write goes down the recording one. A latch kept only by the recorder
     * would still be holding the previous register — and the key byte would be
     * copied into the frequency's slot, which is what it did.
     */
    latch: number;
    channels: readonly MdShadowChannel[];
  };
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
  asm.movea("l", eaImm(YM_ADDRESS), REG.chip);
  asm.movea("l", eaImm(PSG_ADDRESS), REG.psg);

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
    emitWrite(asm, `${p}TickFlat`);
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
 * One packed write: the destination, then the value out to it.
 *
 * The register byte is the one the Game Boy spends on a high-RAM offset and the
 * Z80 on a port number; here it says *which of five places* the byte goes — the
 * FM chip's four bus addresses, or the PSG. Four of them are consecutive so the
 * common case is an indexed store, and the PSG is one comparison away.
 *
 * The FM address is the more common by a wide margin — a four-operator patch is
 * twenty-nine registers and a tone is two — so it is the fall-through.
 */
function emitWrite(asm: Asm68k, label: string, latch?: number): void {
  asm.move("b", eaPost(REG.data), eaD(REG.port));
  asm.move("b", eaPost(REG.data), eaD(REG.byte));
  asm.cmpi("b", PSG_PORT, eaD(REG.port));
  asm.bcc("ne", `${label}Fm`);
  asm.move("b", eaD(REG.byte), eaInd(REG.psg));
  asm.bra(`${label}Done`);
  asm.label(`${label}Fm`);
  // The index has to be widened: `move.b` leaves a register's high three bytes
  // alone, and an indexed address mode reads the whole long.
  asm.andi("l", 3, eaD(REG.port));
  asm.move("b", eaD(REG.byte), eaIdx(REG.chip, 0, REG.port));
  if (latch !== undefined) {
    // An even port is an address: remember it, because the data byte that names
    // this register may be in a different run (`MdStreamOptions.shadow`).
    asm.btst(0, eaD(REG.port));
    asm.bcc("ne", `${label}Done`);
    asm.move("b", eaD(REG.byte), eaAbs(latch));
  }
  asm.label(`${label}Done`);
}

/**
 * Emit one body per borrowable voice, routed on the run's channel bits.
 *
 * The last voice falls through rather than being tested, because a run only
 * reaches here when it named one of them — so with a single borrowable voice,
 * which is what a game with one pitched effect has, there is no test at all.
 */
function mdPerChannel(
  asm: Asm68k,
  shadow: { at: number; channels: readonly MdShadowChannel[] },
  prefix: string,
  body: (name: string, channel: MdShadowChannel) => void,
): void {
  const { channels } = shadow;
  for (let index = 0; index < channels.length - 1; index += 1) {
    asm.move("b", eaD(REG.flags), eaD(REG.byte));
    asm.andi("b", (channels[index] as MdShadowChannel).channel, eaD(REG.byte));
    asm.bcc("ne", `${prefix}${index}`);
  }
  for (let index = 0; index < channels.length; index += 1) {
    body(`${prefix}${index}`, channels[index] as MdShadowChannel);
  }
}

/**
 * Put the byte in `d0` into whichever of a voice's copies it is.
 *
 * Two shapes, because this board's two chips name a register two ways. An FM
 * data byte belongs to whatever the address port last latched, so the copy is
 * indexed by that byte and an address write stores nothing at all; a tone byte
 * says what it is in its own top bits ({@link psgShadowSlot}), so three constant
 * addresses and two bit tests are the whole of it.
 *
 * `d4` holds the port and `d0` the byte, as the fetch left them.
 */
function emitRecord(
  asm: Asm68k,
  shadow: { at: number; latch: number },
  channel: MdShadowChannel,
  name: string,
): void {
  const done = `${name}Kept`;
  if (channel.kind === "fm") {
    // An address write is a selector and not state: nothing to copy.
    asm.btst(0, eaD(REG.port));
    asm.bcc("eq", done);
    asm.move("b", eaAbs(shadow.latch), eaD(REG.steal));
    // Widened, because an indexed address mode reads the whole long and
    // `move.b` leaves a register's high three bytes alone.
    asm.andi("l", 0xff, eaD(REG.steal));
    asm.movea("l", eaImm(shadow.at + channel.slot - channel.base), REG.shadow);
    asm.move("b", eaD(REG.byte), eaIdx(REG.shadow, 0, REG.steal));
    asm.label(done);
    return;
  }
  const has = (slot: number): boolean => channel.writes.some((write) => write.key === slot);
  const slotOf = (slot: number): number =>
    shadow.at + (channel.writes.find((write) => write.key === slot) as MdShadowWrite).slot;
  if (has(PSG_SHADOW.DATA)) {
    asm.btst(7, eaD(REG.byte));
    asm.bcc("eq", `${name}Data`);
  }
  if (has(PSG_SHADOW.LEVEL) && has(PSG_SHADOW.TONE)) {
    asm.btst(4, eaD(REG.byte));
    asm.bcc("ne", `${name}Level`);
  }
  if (has(PSG_SHADOW.TONE)) {
    asm.move("b", eaD(REG.byte), eaAbs(slotOf(PSG_SHADOW.TONE)));
    if (has(PSG_SHADOW.LEVEL) || has(PSG_SHADOW.DATA)) asm.bra(done);
  }
  if (has(PSG_SHADOW.LEVEL)) {
    if (has(PSG_SHADOW.TONE)) asm.label(`${name}Level`);
    asm.move("b", eaD(REG.byte), eaAbs(slotOf(PSG_SHADOW.LEVEL)));
    if (has(PSG_SHADOW.DATA)) asm.bra(done);
  }
  if (has(PSG_SHADOW.DATA)) {
    asm.label(`${name}Data`);
    asm.move("b", eaD(REG.byte), eaAbs(slotOf(PSG_SHADOW.DATA)));
  }
  asm.label(done);
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
  const shadow = preemptible ? options.shadow : undefined;

  asm.label(`${p}TickRun`);
  asm.move("b", eaPost(REG.data), eaD(REG.flags));
  if (preemptible) {
    asm.move("b", eaD(REG.flags), eaD(REG.byte));
    asm.andi("b", RUN.channels, eaD(REG.byte));
    asm.bcc("eq", `${p}TickOwn`); // a run that names no channel is never preempted
    asm.move("b", eaAbs(options.steal as number), eaD(REG.steal));
    asm.and("b", eaD(REG.steal), REG.byte);
    asm.bcc("ne", `${p}TickSkip`);
    if (shadow) {
      // Ours right now, but borrowable: the chip and the copy both take it, so
      // the copy is still true the next time an effect hands the voice back.
      asm.move("b", eaD(REG.flags), eaD(REG.byte));
      asm.andi(
        "b",
        shadow.channels.reduce((bits, one) => bits | one.channel, 0),
        eaD(REG.byte),
      );
      asm.bcc("ne", `${p}TickRecord`);
    }
  }
  asm.label(`${p}TickOwn`);

  asm.label(`${p}TickWrite`);
  emitWrite(asm, `${p}TickRunW`, shadow?.latch);
  asm.subq("b", 1, eaD(REG.count));
  asm.bcc("ne", `${p}TickWrite`);
  asm.bra(`${p}TickNext`);

  if (shadow) {
    // Written *and* recorded, one loop per borrowable voice because each has a
    // window of its own.
    asm.label(`${p}TickRecord`);
    mdPerChannel(asm, shadow, `${p}TickRecordOn`, (name, channel) => {
      asm.label(name);
      emitWrite(asm, `${name}W`, shadow.latch);
      emitRecord(asm, shadow, channel, name);
      asm.subq("b", 1, eaD(REG.count));
      asm.bcc("ne", name);
      asm.bra(`${p}TickNext`);
    });
  }

  if (preemptible) {
    // A skipped run is recorded and not written: the chip belongs to the effect
    // until it lets go, but the music's own idea of the voice has to keep moving
    // or the replay would restore a note that ended while it played.
    asm.label(`${p}TickSkip`);
    if (shadow) {
      mdPerChannel(asm, shadow, `${p}TickSkipOn`, (name, channel) => {
        asm.label(name);
        asm.move("b", eaPost(REG.data), eaD(REG.port));
        asm.move("b", eaPost(REG.data), eaD(REG.byte));
        // The latch still moves, because the chip's would have: this run's
        // address writes are the music's own even when the chip never sees them.
        if (channel.kind === "fm") {
          asm.btst(0, eaD(REG.port));
          asm.bcc("ne", `${name}Data`);
          asm.move("b", eaD(REG.byte), eaAbs(shadow.latch));
          asm.bra(`${name}Stepped`);
          asm.label(`${name}Data`);
        }
        emitRecord(asm, shadow, channel, name);
        asm.label(`${name}Stepped`);
        asm.subq("b", 1, eaD(REG.count));
        asm.bcc("ne", name);
        asm.bra(`${p}TickNext`);
      });
    } else {
      // Two bytes per write is the only thing the data says about its length.
      asm.addq("l", 2, eaA(REG.data));
      asm.subq("b", 1, eaD(REG.count));
      asm.bcc("ne", `${p}TickSkip`);
    }
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
