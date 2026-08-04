/**
 * The 6502 family's stream player — one implementation, two consoles.
 *
 * The 6502 half of `gb-driver.ts`, and it exists for the same reason: a stream is
 * a pointer walking packed data, a rest counter, and an order list that says
 * which block comes next, and writing that twice is how two callers come to
 * disagree about the one thing doc 16 makes a contract — *on tick N the driver
 * performs exactly the writes `ChipScript.ticks[N]` lists, in order*.
 *
 * It belongs to the **processor** rather than to either machine, which is
 * `arm-player.ts`'s arrangement one architecture over: a NES drives a 2A03 with
 * it and a PC Engine drives a HuC6280 PSG, and what each console adds is in
 * `nes-game.ts` and `pce-game.ts`. That the same instructions serve both is not
 * a coincidence — a HuC6280 is a 6502 with a memory mapper — and it is the same
 * argument `codegen/mos/` rests on in the game backend.
 *
 * What differs is not the algorithm but the machine, and three of the
 * differences decide the shape of the code:
 *
 *   - **The pointer lives in page zero or it does not exist.** `($nn),y` is the
 *     6502's one indirect mode, so a stream's data pointer *is* two zero-page
 *     bytes and the walk indexes them with Y. Y is an offset from the pointer
 *     rather than part of it, which is why a tick ends by folding Y back in
 *     rather than by keeping a pointer up to date as it goes.
 *   - **Y wraps, and a block is longer than a page.** Sixty-four ticks of a busy
 *     track runs past 256 bytes, so every step carries into the pointer's high
 *     byte. Four instructions a byte against the Game Boy's one `ld a, [hl+]`,
 *     and there is no cheaper form on this CPU.
 *   - **A register is an index, not an address.** Every sound register is
 *     `base + reg`, so a write is `ldx reg` then `sta base,x` — which makes
 *     the packed format's low-byte register numbers (`data.ts`) the right
 *     encoding here as well as on the Game Boy, for an unrelated reason. The
 *     base is the *console's* ({@link MosStreamOptions.base}): `$4000` on a NES
 *     and `$0800` on a PC Engine, where the hardware page is mapped at zero.
 *
 * Everything below is specialised at emit time from the packed data, exactly as
 * the SM83 player is: a schedule with no rests emits no rest handling, and a
 * stream nothing can preempt emits no preemption test.
 *
 * Sources:
 * - NESdev Wiki — APU: https://www.nesdev.org/wiki/APU
 * - NESdev Wiki — CPU addressing modes: https://www.nesdev.org/wiki/CPU_addressing_modes
 */

import { Asm6502, absX, imm, indY, label, zp } from "@demake/core";

import { RUN, type DriverData } from "./data.js";

/**
 * Where the NES's sound registers start; every one of them is an index off this.
 *
 * Two indices inside the window are *not* sound registers — `$4014` starts an
 * object DMA and `$4016` strobes the controllers — so a schedule that named one
 * would reach into the rest of the machine. Nothing can: the binding emits
 * `$00`–`$0F`, `$15` and `$17` and nothing else, which is a fact about
 * `binding/nes.ts` rather than a check this loop could afford to make.
 */
export const APU_BASE = 0x4000;

/**
 * Where the PC Engine's are, which is inside the hardware page the boot code
 * maps at logical zero.
 *
 * The whole page is the console's own — video, sound, timer, pad and interrupt
 * controller — and the ten sound registers occupy `$0800`–`$0809`, mirrored
 * through `$0BFF`. A schedule names those ten and nothing else.
 */
export const PSG_BASE = 0x0800;

/**
 * Where a stream keeps its position — one byte per field, in page zero.
 *
 * `dataLo`/`dataHi` are not merely *stored* in page zero, they are dereferenced
 * there: the walk does `lda (dataLo),y`, so the pair has to be a zero-page
 * pointer and the two bytes have to be adjacent. `orderLo`/`orderHi` likewise.
 */
export interface MosStreamState {
  /** The block pointer. Adjacent, page zero, dereferenced in place. */
  dataLo: number;
  dataHi: number;
  /** The order-list pointer. Same constraints. */
  orderLo: number;
  orderHi: number;
  /**
   * Order entry playback returns to when the list runs out.
   *
   * Absent for a stream that stops instead of looping — a sound effect has no
   * loop entry, and a byte reserved for one would be a byte that could be read.
   */
  loopLo?: number;
  loopHi?: number;
  rest: number;
  /**
   * Non-zero while the stream is playing.
   *
   * Absent for a stream that starts at boot and never stops, on the same terms
   * as the Game Boy player's.
   */
  active?: number;
}

/** Two bytes the walk needs and the three registers cannot hold. */
export interface MosScratch {
  /** Writes left in the run, or the low half of an order entry. */
  count: number;
  /** The run's flags, or the high half of an order entry. */
  flags: number;
}

/** What to emit, and how this stream shares the chip. */
export interface MosStreamOptions {
  /** Label namespace, so one player can be emitted twice. */
  prefix: string;
  /**
   * Where the chip's registers are, as the base a packed register number indexes.
   *
   * {@link APU_BASE} on a NES, {@link PSG_BASE} on a PC Engine. It is a
   * parameter rather than a constant because it is the only thing in this file
   * that is a console's rather than the processor's.
   */
  base: number;
  state: MosStreamState;
  scratch: MosScratch;
  data: DriverData;
  /**
   * Page-zero byte naming the channels another stream has taken.
   *
   * Supplying it makes this stream *preemptible*: a run whose channels appear
   * there is skipped rather than written. Only music needs it.
   */
  steal?: number;
  /**
   * Routine that takes a merge run's value in `a` and folds it into the chip.
   *
   * `$4015` is the whole of it on this console: one byte enables every channel,
   * so a stream that stored it would silence the other stream's notes. It is
   * called with `y` and both scratch bytes live, and must preserve all three.
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
 * supplies whatever drives them, because a cartridge and a game arrive here from
 * different places — on this console, from the picture's own interrupt.
 */
export function emitStream(asm: Asm6502, options: MosStreamOptions): string[] {
  const { prefix: p, base, state, scratch, data } = options;
  const helpers: string[] = [];
  const stoppable = state.active !== undefined;
  const preemptible = options.steal !== undefined && data.runs;

  let serial = 0;
  const local = (what: string): string => `${p}${what}${serial++}`;
  /** Step Y one byte, carrying into the block pointer's high byte. */
  const step = (): void => {
    const over = local("Adv");
    asm.iny();
    asm.bne(over);
    asm.inc(zp(state.dataHi));
    asm.label(over);
  };
  /** Take the byte Y is on into `a`, and step past it. */
  const fetch = (): void => {
    asm.lda(indY(state.dataLo));
    step();
  };
  /**
   * The same, with `a`'s own flags.
   *
   * The step is what leaves the processor's flags set, so a fetch does *not*
   * leave them describing the byte it loaded — `iny` and the carry's `inc` both
   * write Z and N. The Game Boy player has the opposite problem and solves it
   * the same way: `ld a, [hl+]` sets no flags at all, so it says `or a`. Reading
   * the opcode dispatch without this is how a driver comes to interpret a run
   * header as a register number, which sounds like the track turning to noise.
   */
  const fetchTested = (): void => {
    fetch();
    asm.cmp(imm(0));
  };
  /** Branch of any length: invert and jump, because a player spans a page. */
  const far = (cond: Cond, target: string): void => {
    const over = local("Br");
    BRANCH[INVERSE[cond]](asm, over);
    asm.jmp(target);
    asm.label(over);
  };

  asm.label(`${p}Tick`);
  if (stoppable) {
    const live = local("Live");
    asm.lda(zp(state.active as number));
    asm.bne(live);
    asm.rts();
    asm.label(live);
    helpers.push("stoppable");
  }

  if (data.hasRests) {
    // The common case first: most ticks of most tracks write nothing at all.
    asm.lda(zp(state.rest));
    asm.beq(`${p}TickPlay`);
    asm.dec(zp(state.rest));
    asm.rts();
    helpers.push("rests");
  }

  asm.label(`${p}TickPlay`);
  asm.ldy(imm(0));

  asm.label(`${p}TickFetch`);
  fetchTested();
  far("eq", `${p}TickBlock`);
  if (data.hasRests) far("mi", `${p}TickRest`);
  asm.sta(zp(scratch.count));

  if (data.runs) {
    emitRuns(asm, options, { preemptible, fetch, step, far });
    helpers.push(preemptible ? "preemptible-runs" : "runs");
  } else {
    asm.label(`${p}TickWrite`);
    fetch();
    asm.tax(); // the register, as an index off the chip's base
    fetch();
    asm.sta(absX(base));
    asm.dec(zp(scratch.count));
    asm.bne(`${p}TickWrite`);
    asm.jmp(`${p}TickSave`);
  }

  if (data.hasRests) {
    asm.label(`${p}TickRest`);
    asm.and(imm(0x7f));
    asm.sta(zp(state.rest));
  }

  // The tick's whole advance, folded in once: `y` counted the bytes it read, and
  // the high byte already carried each time `y` wrapped.
  asm.label(`${p}TickSave`);
  const saved = local("Saved");
  asm.tya();
  asm.clc();
  asm.adc(zp(state.dataLo));
  asm.sta(zp(state.dataLo));
  asm.bcc(saved);
  asm.inc(zp(state.dataHi));
  asm.label(saved);
  asm.rts();

  // Reaching the end of a block consumes no tick, so the fetch resumes in the
  // next one — which is why a block always covers at least one tick and the walk
  // cannot spin. Nothing is saved first: `NextBlock` replaces the pointer whole.
  asm.label(`${p}TickBlock`);
  asm.jsr(`${p}NextBlock`);
  if (stoppable) {
    const playing = local("Playing");
    asm.bcc(playing);
    asm.rts();
    asm.label(playing);
  }
  asm.ldy(imm(0));
  asm.jmp(`${p}TickFetch`);

  emitNextBlock(asm, options);
  helpers.push(data.hasOrder ? "order-walk" : "single-block");
  if (data.oneShot) helpers.push("one-shot-stop");
  if (data.hasMerges) helpers.push("enable-merge");
  return helpers;
}

/** What the run walk borrows from its caller. */
interface Walk {
  preemptible: boolean;
  fetch(): void;
  step(): void;
  far(cond: Cond, target: string): void;
}

/**
 * The run walk: writes grouped by who they belong to.
 *
 * `count` counts the run and `flags` carries its flags across it, both in page
 * zero, because X holds a register number and Y is the data offset — this CPU
 * has nothing left over. A skipped run is stepped past two bytes at a time,
 * which is all the data says about its length.
 */
function emitRuns(asm: Asm6502, options: MosStreamOptions, walk: Walk): void {
  const { prefix: p, base, scratch, data } = options;
  const { fetch, step, far } = walk;

  asm.label(`${p}TickRun`);
  fetch();
  asm.sta(zp(scratch.flags));
  if (walk.preemptible) {
    asm.and(imm(RUN.channels));
    asm.beq(`${p}TickOwn`); // a run that names no channel is never preempted
    asm.and(zp(options.steal as number));
    far("ne", `${p}TickSkip`);
  }
  asm.label(`${p}TickOwn`);
  if (data.hasMerges) {
    asm.lda(zp(scratch.flags));
    asm.and(imm(RUN.merge));
    far("ne", `${p}TickMerge`);
  }

  asm.label(`${p}TickWrite`);
  fetch();
  asm.tax();
  fetch();
  asm.sta(absX(base));
  asm.dec(zp(scratch.count));
  asm.bne(`${p}TickWrite`);
  asm.jmp(`${p}TickNext`);

  if (data.hasMerges) {
    asm.label(`${p}TickMerge`);
    step(); // the register is implied by the merge routine
    fetch();
    asm.jsr(options.merge as string);
    asm.dec(zp(scratch.count));
    asm.bne(`${p}TickMerge`);
    asm.jmp(`${p}TickNext`);
  }

  if (walk.preemptible) {
    asm.label(`${p}TickSkip`);
    step();
    step();
    asm.dec(zp(scratch.count));
    asm.bne(`${p}TickSkip`);
  }

  asm.label(`${p}TickNext`);
  asm.lda(zp(scratch.flags));
  far("pl", `${p}TickSave`);
  fetch();
  asm.sta(zp(scratch.count));
  asm.jmp(`${p}TickRun`);
}

/**
 * Take the next order entry into the data pointer.
 *
 * The terminator is `$0000` rather than a length, so the order list is walked
 * with a pointer and nothing counts. A looping stream reloads from its stored
 * loop entry; a stoppable one ends, returning with carry set so the caller stops
 * asking. The scratch pair carries the entry, because the 6502 cannot hold two
 * bytes and an index at once.
 */
function emitNextBlock(asm: Asm6502, options: MosStreamOptions): void {
  const { prefix: p, state, scratch } = options;
  asm.label(`${p}NextBlock`);
  emitReadOrder(asm, options);
  asm.bne(`${p}NextBlockGot`);

  if (state.active !== undefined && options.onEnd !== undefined) {
    asm.jsr(options.onEnd);
    asm.lda(imm(0));
    asm.sta(zp(state.active));
    asm.sec();
    asm.rts();
  } else {
    // The loop entry is an address *inside* the order list, so pointing at it
    // and reading resumes the walk as if the list had never ended.
    asm.lda(zp(state.loopLo as number));
    asm.sta(zp(state.orderLo));
    asm.lda(zp(state.loopHi as number));
    asm.sta(zp(state.orderHi));
    emitReadOrder(asm, options);
  }

  asm.label(`${p}NextBlockGot`);
  asm.clc();
  asm.lda(zp(state.orderLo));
  asm.adc(imm(2));
  asm.sta(zp(state.orderLo));
  const over = `${p}OrderCarry`;
  asm.bcc(over);
  asm.inc(zp(state.orderHi));
  asm.label(over);
  asm.lda(zp(scratch.count));
  asm.sta(zp(state.dataLo));
  asm.lda(zp(scratch.flags));
  asm.sta(zp(state.dataHi));
  asm.clc(); // carry clear: the stream is still playing
  asm.rts();
}

/**
 * Read the entry the order pointer is on into the scratch pair.
 *
 * Leaves the two halves ored together in `a`, so the caller's branch tests the
 * `$0000` terminator without a second load — the same reason the Game Boy player
 * ends its read with `or e`.
 */
function emitReadOrder(asm: Asm6502, options: MosStreamOptions): void {
  const { state, scratch } = options;
  asm.ldy(imm(1));
  asm.lda(indY(state.orderLo));
  asm.sta(zp(scratch.flags));
  asm.dey();
  asm.lda(indY(state.orderLo));
  asm.sta(zp(scratch.count));
  asm.ora(zp(scratch.flags));
}

/**
 * Emit a stream's packed data, and return the label its order list starts at.
 *
 * The order list comes first so a caller can point at it without knowing how
 * many blocks follow, and the loop entry is an offset into it.
 */
export function emitStreamData(
  asm: Asm6502,
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

/** A branch condition, named as the 6502 names its branches. */
type Cond = "eq" | "ne" | "mi" | "pl";

const INVERSE: Readonly<Record<Cond, Cond>> = { eq: "ne", ne: "eq", mi: "pl", pl: "mi" };

const BRANCH: Readonly<Record<Cond, (asm: Asm6502, target: string) => void>> = {
  eq: (asm, target) => void asm.beq(target),
  ne: (asm, target) => void asm.bne(target),
  mi: (asm, target) => void asm.bmi(target),
  pl: (asm, target) => void asm.bpl(target),
};
