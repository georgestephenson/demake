/**
 * The V810 stream player: the walk over packed data, for the Virtual Boy's
 * processor.
 *
 * The seventh of these and the first for this architecture, on
 * `mos-player.ts`'s and `arm-player.ts`'s precedent: what is here is the
 * *processor's* share of a driver — how a tick fetches, how a run is walked, how
 * an order list is followed — and what a console adds to it is a boot sequence,
 * a clock, a way to send a byte to its chip and a cartridge wrapper.
 *
 * Three things about it are this instruction set's rather than a predecessor's
 * restated.
 *
 *   - **A call returns through a register, so a routine that calls one has to
 *     put its own return address away.** `jal` writes `lp`, so `Tick` — which
 *     calls the write routine once per write — would destroy the address it was
 *     entered with on its first one. Every routine here therefore opens by
 *     pushing `lp` and closes by popping it, which is the game backend's
 *     `ctx.enter`/`ctx.leave` in a file that has no `ctx`. No other player in
 *     the set needs it: every other processor pushes on a call.
 *   - **There is no post-increment addressing**, so walking the packed data is a
 *     load and an add rather than one instruction. That costs the inner loop one
 *     instruction a byte and buys the register allocation back — this machine
 *     has thirty-two registers, so the whole of a tick's state stays in them and
 *     nothing is spilled.
 *   - **A conditional branch reaches ±256 bytes and an unconditional one ±32
 *     MiB**, so a branch across the run walk — whose length *is* the schedule —
 *     is `bcond` over a `jr` rather than a bare `bcond`. That is the Game Boy
 *     driver's long-branch rule (AGENTS.md §Working on audio) on a processor
 *     whose short branch is twice as short.
 *
 * The data format is `data.ts`'s and is not this file's to change: a block is a
 * run of ticks, a tick is a count byte and then that many writes, a rest is a
 * count with bit 7 set, and a zero byte ends the block.
 */

import { Asm810, label, type Ref } from "@demake/core";

import { RUN, type DriverData } from "./data.js";

/**
 * The registers a tick lives in.
 *
 * Chosen from the caller-saved half so a driver called from a game's main loop
 * costs it nothing to preserve, and named for what they hold rather than for
 * their numbers — the same allocation every player in this project uses, which
 * is not a coincidence: the walk is the same walk.
 */
export const REG = {
  /** Scratch, and where a helper takes its first argument. */
  a0: 6,
  a1: 7,
  a2: 8,
  /** The packed data pointer, walking a block. */
  data: 9,
  /** Writes left in the run. */
  count: 10,
  /** The run's flags, live across it. */
  flags: 11,
  /** The driver's state base, live across a whole tick. */
  state: 12,
  /** The address scratch, which nothing may hold anything in across a call. */
  addr: 13,
  /** `r3`, the stack this processor's calls have to make for themselves. */
  sp: 3,
  /** `r31`, where `jal` leaves the return address. */
  lp: 31,
} as const;

/** Where a stream keeps its position, in the console's work RAM. */
export interface V810StreamState {
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
   * as the other players'.
   */
  active?: number;
}

/** What to emit, and how this stream shares the hardware. */
export interface V810StreamOptions {
  /** Label namespace, so one player can be emitted twice. */
  prefix: string;
  state: V810StreamState;
  data: DriverData;
  /** Routine called when a stoppable stream's order list runs out. */
  onEnd?: string;
}

/** Push the return address, which this processor's call does not. */
function enter(asm: Asm810): void {
  asm.addImm5(-4, REG.sp);
  asm.stw(REG.lp, 0, REG.sp);
}

/** Restore it and return. */
function leave(asm: Asm810): void {
  asm.ldw(0, REG.sp, REG.lp);
  asm.addImm5(4, REG.sp);
  asm.jmp(REG.lp);
}

/**
 * A conditional branch to a label that may be a long way off.
 *
 * `bcond` reaches ±256 bytes, which is nothing next to a run walk whose length
 * is the schedule's own shape, so the condition is inverted over a `jr` — the
 * 6502 backend's `far` on a third processor.
 */
function far(asm: Asm810, cond: "e" | "ne", target: string): void {
  const over = `${target}$over${asm.pc.toString(16)}`;
  asm.bcond(cond === "e" ? "ne" : "e", over);
  asm.jr(target);
  asm.label(over);
}

/** Load a byte from the data pointer and step past it. */
function fetch(asm: Asm810, into: number): void {
  asm.ldb(0, REG.data, into);
  asm.addImm5(1, REG.data);
}

/**
 * Emit `<prefix>Tick` and `<prefix>NextBlock`, and report what they pulled in.
 *
 * `Tick` performs one driver tick and returns; `NextBlock` takes the next order
 * entry, clearing a stoppable stream's `active` byte when the list runs out.
 */
export function emitStream(asm: Asm810, options: V810StreamOptions): string[] {
  const { prefix: p, state, data } = options;
  const helpers: string[] = [];
  const stoppable = state.active !== undefined;

  asm.label(`${p}Tick`);
  enter(asm);
  asm.movImm32(state.data, REG.state);
  if (stoppable) {
    asm.ldb((state.active as number) - state.data, REG.state, REG.a0);
    asm.cmpImm5(0, REG.a0);
    far(asm, "e", `${p}TickDone`);
    helpers.push("stoppable");
  }

  if (data.hasRests) {
    // The common case first: most ticks of most tracks write nothing at all.
    asm.ldb(state.rest - state.data, REG.state, REG.a0);
    asm.cmpImm5(0, REG.a0);
    far(asm, "e", `${p}TickPlay`);
    asm.addImm5(-1, REG.a0);
    asm.stb(REG.a0, state.rest - state.data, REG.state);
    // Unconditional: a rest of one decrements to zero and *that* tick is still
    // a rest — the tick after it is the one that plays.
    asm.jr(`${p}TickDone`);
    helpers.push("rests");
  }

  asm.label(`${p}TickPlay`);
  asm.ldw(0, REG.state, REG.data);

  asm.label(`${p}TickFetch`);
  fetch(asm, REG.a0);
  asm.cmpImm5(0, REG.a0);
  far(asm, "e", `${p}TickBlock`);
  if (data.hasRests) {
    asm.movImm32(0x80, REG.a1);
    asm.and(REG.a1, REG.a0);
    asm.cmpImm5(0, REG.a0);
    far(asm, "ne", `${p}TickRest`);
    // The test consumed the byte, so it is fetched again from where it was.
    asm.ldb(-1, REG.data, REG.a0);
  }
  asm.movReg(REG.a0, REG.count);

  if (data.runs) {
    emitRuns(asm, options);
    helpers.push("runs");
  } else {
    asm.label(`${p}TickWrite`);
    fetch(asm, REG.a0);
    fetch(asm, REG.a1);
    asm.jal("AudioWrite");
    asm.addImm5(-1, REG.count);
    asm.cmpImm5(0, REG.count);
    far(asm, "ne", `${p}TickWrite`);
    asm.jr(`${p}TickSave`);
  }

  if (data.hasRests) {
    asm.label(`${p}TickRest`);
    asm.ldb(-1, REG.data, REG.a0);
    asm.andi(0x7f, REG.a0, REG.a0);
    asm.stb(REG.a0, state.rest - state.data, REG.state);
  }

  asm.label(`${p}TickSave`);
  asm.stw(REG.data, 0, REG.state);
  asm.label(`${p}TickDone`);
  leave(asm);

  // Reaching the end of a block consumes no tick, so the fetch resumes in the
  // next one — which is why a block always covers at least one tick and the walk
  // cannot spin. Nothing is saved first: `NextBlock` replaces the pointer whole.
  asm.label(`${p}TickBlock`);
  asm.jal(`${p}NextBlock`);
  if (stoppable) {
    asm.ldb((state.active as number) - state.data, REG.state, REG.a0);
    asm.cmpImm5(0, REG.a0);
    far(asm, "e", `${p}TickDone`);
  }
  asm.ldw(0, REG.state, REG.data);
  asm.jr(`${p}TickFetch`);

  emitNextBlock(asm, options);
  helpers.push(data.hasOrder ? "order-walk" : "single-block");
  if (data.oneShot) helpers.push("one-shot-stop");
  return helpers;
}

/**
 * The run walk: writes grouped by who they belong to.
 *
 * One stream owns this chip today, so a run's channel bits are read and nothing
 * is skipped — there is no steal mask, no shadow and no merge, because nothing
 * on a VSU is shared between channels (`@demake/chip`'s `vsu.ts`). What is here
 * is the shape the format requires: the flags byte, the chaining bit, and the
 * count that follows it.
 */
function emitRuns(asm: Asm810, options: V810StreamOptions): void {
  const { prefix: p } = options;

  asm.label(`${p}TickRun`);
  fetch(asm, REG.flags);

  asm.label(`${p}TickWrite`);
  fetch(asm, REG.a0);
  fetch(asm, REG.a1);
  asm.jal("AudioWrite");
  asm.addImm5(-1, REG.count);
  asm.cmpImm5(0, REG.count);
  far(asm, "ne", `${p}TickWrite`);

  asm.label(`${p}TickNext`);
  asm.movImm32(RUN.more, REG.a0);
  asm.and(REG.flags, REG.a0);
  asm.cmpImm5(0, REG.a0);
  far(asm, "e", `${p}TickSave`);
  fetch(asm, REG.count);
  asm.jr(`${p}TickRun`);
}

/**
 * Take the next order entry into the data pointer.
 *
 * The terminator is a zero word rather than a length, so the order list is
 * walked with a pointer and nothing counts. A looping stream reloads from its
 * stored loop entry; a stoppable one ends, clearing `active` so the caller — and
 * the next tick — stop asking.
 */
function emitNextBlock(asm: Asm810, options: V810StreamOptions): void {
  const { prefix: p, state } = options;
  asm.label(`${p}NextBlock`);
  // Its own base, and saved: this is called from the tick — which holds one
  // already — *and* from the routine that starts a stream, which does not.
  enter(asm);
  asm.movImm32(state.data, REG.state);
  asm.ldw(state.order - state.data, REG.state, REG.a2);
  asm.ldw(0, REG.a2, REG.a0);
  asm.addImm5(4, REG.a2);
  asm.cmpImm5(0, REG.a0);
  far(asm, "ne", `${p}NextBlockGot`);

  if (state.active !== undefined && options.onEnd !== undefined) {
    asm.jal(options.onEnd);
    // Reloaded, because the routine that ends a stream is the console's and
    // this file cannot know which registers it spends.
    asm.movImm32(state.data, REG.state);
    asm.stb(0, (state.active as number) - state.data, REG.state);
    leave(asm);
  } else {
    // The loop entry is an address *inside* the order list, so pointing at it
    // and reading resumes the walk as if the list had never ended.
    asm.ldw((state.loop as number) - state.data, REG.state, REG.a2);
    asm.ldw(0, REG.a2, REG.a0);
    asm.addImm5(4, REG.a2);
  }

  asm.label(`${p}NextBlockGot`);
  asm.stw(REG.a2, state.order - state.data, REG.state);
  asm.stw(REG.a0, 0, REG.state);
  leave(asm);
}

/**
 * Emit a stream's packed data, and return the label its order list starts at.
 *
 * The order list comes first so a caller can point at it without knowing how
 * many blocks follow, and the loop entry is an offset into it. Aligned first,
 * because the entries are words and the block bodies before them are a run of
 * bytes — and on this processor an unaligned load is **masked rather than
 * faulted**, so a misaligned order list reads the word below it and reports
 * nothing (AGENTS.md §The V810 half).
 */
export function emitStreamData(
  asm: Asm810,
  prefix: string,
  index: number,
  data: DriverData,
): string {
  const orderLabel = `${prefix}Order${index}`;
  const blockLabel = (block: number): string => `${prefix}Block${index}_${block}`;
  asm.align(4);
  asm.label(orderLabel);
  for (const block of data.order) asm.dd(label(blockLabel(block)) as Ref);
  asm.dd(0);
  for (let block = 0; block < data.blocks.length; block += 1) {
    asm.label(blockLabel(block));
    asm.bytes(data.blocks[block] as Uint8Array);
  }
  return orderLabel;
}
