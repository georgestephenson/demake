/**
 * The ARM stream player: what two consoles' drivers share, and nothing else.
 *
 * `shared.ts` holds what no *processor* owns and `psg.ts` holds what a *chip*
 * owns; this is the third of that kind and it is the **CPU's**. A Game Boy
 * Advance and a Nintendo DS both run this architecture — the DS's sound
 * processor is an ARM7TDMI and the Game Boy Advance *is* one — so the walk over
 * packed data is one walk, emitted once, and neither console owns it. The rule is
 * AGENTS.md §How to add a console's: if you find yourself copying an emitter, you
 * are writing the wrong one of the two.
 *
 * What is here is the machine every driver in this directory is a copy of — a
 * pointer walking packed data, a rest counter and an order list saying which
 * block comes next — specialised at emit time from the packed data, so a schedule
 * with no rests emits no rest handling and a stream nothing can preempt emits no
 * preemption test.
 *
 * What is *not* here is the one routine it calls: `AudioWrite` takes a packed
 * port byte in `r0` and a value in `r1`, and what that byte means is the
 * console's — two devices behind one bit on a Game Boy Advance, a channel and a
 * field on a Nintendo DS. Each driver defines it, and each defines it once.
 *
 * Four things about the code below are this instruction set's rather than either
 * console's:
 *
 *   - **Every conditional branch reaches**, so nothing here needs the 6502
 *     player's invert-and-jump dance — but a *pooled constant* is only ±4 KB, so
 *     `ltorg` goes after every routine.
 *   - **`ltorg` does not branch over what it emits**, so a flush belongs past a
 *     return and nowhere else.
 *   - **A block pointer is a word**, so the packed data can be anywhere in the
 *     address space and the order list is words rather than offsets.
 *   - **`r4`–`r7` hold a tick's whole state**, which is why `AudioWrite` and the
 *     merge routine are documented as clobbering `r0`–`r3` and `r12` only.
 */

import { AsmArm, armAt, armAtIdx, armAtPost, armImm, armReg, label, type Ref } from "@demake/core";

import { RUN, type DriverData } from "./data.js";

/** Registers, named so the allocation is readable in one place. */
export const REG = {
  /** Scratch, and where a helper takes its first argument. */
  a0: 0,
  a1: 1,
  a2: 2,
  a3: 3,
  /** The packed data pointer, walking a block. */
  data: 4,
  /** Writes left in the run. */
  count: 5,
  /** The run's flags, live across it. */
  flags: 6,
  /** The driver's state base, live across a whole tick. */
  state: 7,
  /** The address scratch, which nothing may hold anything in across a call. */
  addr: 12,
  lr: 14,
  pc: 15,
} as const;

/** Where a stream keeps its position, in the driver's work RAM. */
export interface ArmStreamState {
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
export interface ArmStreamOptions {
  /** Label namespace, so one player can be emitted twice. */
  prefix: string;
  state: ArmStreamState;
  data: DriverData;
  /** The driver's state base, which every field above is an offset from. */
  base: number;
  /**
   * Byte naming the channels another stream has taken.
   *
   * Supplying it makes this stream *preemptible*: a run whose channels appear
   * there is skipped rather than written. Only music needs it.
   */
  steal?: number;
  /**
   * Routine that takes a merge run's value in `r1` and folds it into the chip.
   *
   * Only a console with a register two streams both write needs one — a Game Boy
   * Advance's `NR51` is the whole of it, and a Nintendo DS has none at all.
   */
  merge?: string;
  /**
   * Where this stream keeps a copy of the channels another stream can borrow.
   *
   * A run naming one of `channels` is recorded as well as written, and a run
   * that is *skipped* is recorded instead of written, so the copy is the music's
   * own state whether or not the chip currently holds it (`shared.ts`
   * §`shadowPlan`). `base` is an absolute address rather than an offset from the
   * state register, because `strb` with a register index wants a base of its own
   * and `r7` is carrying the stream's fields.
   */
  shadow?: {
    /** One per borrowable channel: its bit, and the address it indexes. */
    channels: readonly { bit: number; base: number }[];
  };
  /** Routine called when a stoppable stream's order list runs out. */
  onEnd?: string;
}

/** A byte field of the driver's state, as an offset from the base register. */
function at(base: number, address: number): number {
  return address - base;
}

/**
 * Emit `<prefix>Tick` and `<prefix>NextBlock`, and report what they pulled in.
 *
 * `Tick` performs one driver tick and returns; `NextBlock` takes the next order
 * entry, clearing a stoppable stream's `active` byte when the list runs out —
 * the Mega Drive's arrangement, because this architecture has no carry flag a
 * routine can set as a return value either.
 */
export function emitStream(asm: AsmArm, options: ArmStreamOptions): string[] {
  const { prefix: p, state, data, base } = options;
  const helpers: string[] = [];
  const stoppable = state.active !== undefined;
  const preemptible = options.steal !== undefined && data.runs;

  asm.label(`${p}Tick`);
  asm.push([REG.data, REG.count, REG.flags, REG.state, REG.lr]);
  asm.ldrConst(REG.state, base);
  if (stoppable) {
    asm.ldrb(REG.a0, armAt(REG.state, at(base, state.active as number)));
    asm.cmp(REG.a0, armImm(0));
    asm.b(`${p}TickDone`, "eq");
    helpers.push("stoppable");
  }

  if (data.hasRests) {
    // The common case first: most ticks of most tracks write nothing at all.
    asm.ldrb(REG.a0, armAt(REG.state, at(base, state.rest)));
    asm.cmp(REG.a0, armImm(0));
    asm.b(`${p}TickPlay`, "eq");
    asm.sub(REG.a0, REG.a0, armImm(1));
    asm.strb(REG.a0, armAt(REG.state, at(base, state.rest)));
    asm.b(`${p}TickDone`);
    helpers.push("rests");
  }

  asm.label(`${p}TickPlay`);
  asm.ldr(REG.data, armAt(REG.state, at(base, state.data)));

  asm.label(`${p}TickFetch`);
  asm.ldrb(REG.a0, armAtPost(REG.data, 1));
  asm.cmp(REG.a0, armImm(0));
  asm.b(`${p}TickBlock`, "eq");
  if (data.hasRests) {
    asm.tst(REG.a0, armImm(0x80));
    asm.b(`${p}TickRest`, "ne");
  }
  asm.mov(REG.count, armReg(REG.a0));

  if (data.runs) {
    emitRuns(asm, options, preemptible);
    helpers.push(preemptible ? "preemptible-runs" : "runs");
  } else {
    asm.label(`${p}TickWrite`);
    asm.ldrb(REG.a0, armAtPost(REG.data, 1));
    asm.ldrb(REG.a1, armAtPost(REG.data, 1));
    asm.bl("AudioWrite");
    asm.subs(REG.count, REG.count, armImm(1));
    asm.b(`${p}TickWrite`, "ne");
    asm.b(`${p}TickSave`);
  }

  if (data.hasRests) {
    asm.label(`${p}TickRest`);
    asm.and(REG.a0, REG.a0, armImm(0x7f));
    asm.strb(REG.a0, armAt(REG.state, at(base, state.rest)));
  }

  asm.label(`${p}TickSave`);
  asm.str(REG.data, armAt(REG.state, at(base, state.data)));
  asm.label(`${p}TickDone`);
  asm.pop([REG.data, REG.count, REG.flags, REG.state, REG.pc]);

  // Reaching the end of a block consumes no tick, so the fetch resumes in the
  // next one — which is why a block always covers at least one tick and the walk
  // cannot spin. Nothing is saved first: `NextBlock` replaces the pointer whole.
  asm.label(`${p}TickBlock`);
  asm.bl(`${p}NextBlock`);
  if (stoppable) {
    asm.ldrb(REG.a0, armAt(REG.state, at(base, state.active as number)));
    asm.cmp(REG.a0, armImm(0));
    asm.b(`${p}TickDone`, "eq");
  }
  asm.ldr(REG.data, armAt(REG.state, at(base, state.data)));
  asm.b(`${p}TickFetch`);
  asm.ltorg();

  emitNextBlock(asm, options);
  helpers.push(data.hasOrder ? "order-walk" : "single-block");
  if (data.oneShot) helpers.push("one-shot-stop");
  if (data.hasMerges) helpers.push("panning-merge");
  return helpers;
}

/**
 * The run walk: writes grouped by who they belong to.
 *
 * `r5` counts the run, `r6` carries its flags across it, `r4` walks the data and
 * `r7` holds the driver's state. That is the other players' allocation with
 * different names on the registers, which is not a coincidence — the walk is the
 * same walk.
 */
function emitRuns(asm: AsmArm, options: ArmStreamOptions, preemptible: boolean): void {
  const { prefix: p, data, base } = options;

  asm.label(`${p}TickRun`);
  asm.ldrb(REG.flags, armAtPost(REG.data, 1));
  if (preemptible) {
    asm.and(REG.a0, REG.flags, armImm(RUN.channels));
    asm.cmp(REG.a0, armImm(0));
    // A run that names no channel is never preempted — which is most of a track
    // on a console whose effects only ever borrow one or two of its channels.
    asm.b(`${p}TickOwn`, "eq");
    asm.ldrb(REG.a1, armAt(REG.state, at(base, options.steal as number)));
    asm.tst(REG.a0, armReg(REG.a1));
    asm.b(`${p}TickSkip`, "ne");
    if (options.shadow) {
      // Ours right now, but borrowable: the chip and the copy both take it, so
      // the copy is still true the next time an effect hands the channel back.
      asm.tst(REG.a0, armImm(options.shadow.channels.reduce((bits, one) => bits | one.bit, 0)));
      asm.b(`${p}TickRecord`, "ne");
    }
  }
  asm.label(`${p}TickOwn`);
  if (data.hasMerges) {
    asm.tst(REG.flags, armImm(RUN.merge));
    asm.b(`${p}TickMerge`, "ne");
  }

  asm.label(`${p}TickWrite`);
  asm.ldrb(REG.a0, armAtPost(REG.data, 1));
  asm.ldrb(REG.a1, armAtPost(REG.data, 1));
  asm.bl("AudioWrite");
  asm.subs(REG.count, REG.count, armImm(1));
  asm.b(`${p}TickWrite`, "ne");
  asm.b(`${p}TickNext`);

  if (data.hasMerges) {
    asm.label(`${p}TickMerge`);
    // The register is implied by the merge routine, so only the value is read.
    asm.add(REG.data, REG.data, armImm(1));
    asm.ldrb(REG.a1, armAtPost(REG.data, 1));
    asm.bl(options.merge as string);
    asm.subs(REG.count, REG.count, armImm(1));
    asm.b(`${p}TickMerge`, "ne");
    asm.b(`${p}TickNext`);
  }

  if (preemptible && options.shadow) {
    // Written *and* recorded, one loop per borrowable channel because each has a
    // window of its own. `r2` carries the copy's base, which is why the plan
    // hands over an address rather than an offset.
    asm.label(`${p}TickRecord`);
    armPerChannel(asm, options, `${p}TickRecordOn`, (name, address) => {
      asm.label(name);
      asm.ldrb(REG.a0, armAtPost(REG.data, 1));
      asm.ldrb(REG.a1, armAtPost(REG.data, 1));
      // The copy first: `AudioWrite` clobbers `r0`-`r3`, so the register and the
      // value it takes are gone by the time it returns.
      asm.ldrConst(REG.a2, address);
      asm.strb(REG.a1, armAtIdx(REG.a2, REG.a0));
      asm.bl("AudioWrite");
      asm.subs(REG.count, REG.count, armImm(1));
      asm.b(name, "ne");
      asm.b(`${p}TickNext`);
    });
  }

  if (preemptible) {
    // A skipped run is recorded and not written: the chip belongs to the effect
    // until it lets go, but the music's own idea of the channel has to keep
    // moving or the replay would restore a note that ended while it played.
    asm.label(`${p}TickSkip`);
    if (options.shadow) {
      armPerChannel(asm, options, `${p}TickSkipOn`, (name, address) => {
        asm.label(name);
        asm.ldrb(REG.a0, armAtPost(REG.data, 1));
        asm.ldrb(REG.a1, armAtPost(REG.data, 1));
        asm.ldrConst(REG.a2, address);
        asm.strb(REG.a1, armAtIdx(REG.a2, REG.a0));
        asm.subs(REG.count, REG.count, armImm(1));
        asm.b(name, "ne");
        asm.b(`${p}TickNext`);
      });
    } else {
      // Two bytes per write is the only thing the data says about its length.
      asm.add(REG.data, REG.data, armImm(2));
      asm.subs(REG.count, REG.count, armImm(1));
      asm.b(`${p}TickSkip`, "ne");
    }
  }

  asm.label(`${p}TickNext`);
  asm.tst(REG.flags, armImm(RUN.more));
  asm.b(`${p}TickSave`, "eq");
  asm.ldrb(REG.count, armAtPost(REG.data, 1));
  asm.b(`${p}TickRun`);
}

/**
 * Emit one body per borrowable channel, routed on the run's channel bits in `r0`.
 *
 * The **first** channel falls through rather than being tested, because a run only
 * reaches here when it named one of them — so with a single borrowable channel,
 * which is what a game with one pitched effect has, there is no test at all. It
 * has to be the first and not the last, because the bodies are emitted in index
 * order directly below: testing every one but the *last* would send a run that
 * named it into the *first* channel's body, which no schedule in the example
 * library reaches and which nothing but a two-channel effect set can see.
 */
function armPerChannel(
  asm: AsmArm,
  options: ArmStreamOptions,
  prefix: string,
  body: (name: string, address: number) => void,
): void {
  const channels = (options.shadow as { channels: readonly { bit: number; base: number }[] })
    .channels;
  for (let index = 1; index < channels.length; index += 1) {
    asm.tst(REG.a0, armImm((channels[index] as { bit: number }).bit));
    asm.b(`${prefix}${index}`, "ne");
  }
  for (let index = 0; index < channels.length; index += 1) {
    body(`${prefix}${index}`, (channels[index] as { base: number }).base);
  }
}

/**
 * Take the next order entry into the data pointer.
 *
 * The terminator is a zero word rather than a length, so the order list is
 * walked with a pointer and nothing counts. A looping stream reloads from its
 * stored loop entry; a stoppable one ends, clearing `active` so the caller — and
 * the next tick — stop asking.
 */
function emitNextBlock(asm: AsmArm, options: ArmStreamOptions): void {
  const { prefix: p, state, base } = options;
  asm.label(`${p}NextBlock`);
  // Its own base, and saved: this is called from the tick — which holds one
  // already — *and* from the routine that starts a stream, which does not.
  asm.push([REG.state, REG.lr]);
  asm.ldrConst(REG.state, base);
  asm.ldr(REG.a2, armAt(REG.state, at(base, state.order)));
  asm.ldr(REG.a0, armAtPost(REG.a2, 4));
  asm.cmp(REG.a0, armImm(0));
  asm.b(`${p}NextBlockGot`, "ne");

  if (state.active !== undefined && options.onEnd !== undefined) {
    asm.bl(options.onEnd);
    asm.mov(REG.a0, armImm(0));
    asm.strb(REG.a0, armAt(REG.state, at(base, state.active)));
    asm.pop([REG.state, REG.pc]);
  } else {
    // The loop entry is an address *inside* the order list, so pointing at it
    // and reading resumes the walk as if the list had never ended.
    asm.ldr(REG.a2, armAt(REG.state, at(base, state.loop as number)));
    asm.ldr(REG.a0, armAtPost(REG.a2, 4));
  }

  asm.label(`${p}NextBlockGot`);
  asm.str(REG.a2, armAt(REG.state, at(base, state.order)));
  asm.str(REG.a0, armAt(REG.state, at(base, state.data)));
  asm.pop([REG.state, REG.pc]);
  asm.ltorg();
}

/**
 * Emit a stream's packed data, and return the label its order list starts at.
 *
 * The order list comes first so a caller can point at it without knowing how many
 * blocks follow, and the loop entry is an offset into it. Aligned first, because
 * the entries are words and the block bodies before them are a run of bytes — an
 * unaligned `ldr` *rotates* on this core rather than faulting, which is a wrong
 * pointer rather than a crash and therefore worse.
 */
export function emitStreamData(
  asm: AsmArm,
  prefix: string,
  index: number,
  data: DriverData,
): string {
  const orderLabel = `${prefix}Order${index}`;
  const blockLabel = (block: number): string => `${prefix}Block${index}_${block}`;
  asm.align();
  asm.label(orderLabel);
  for (const block of data.order) asm.dw(label(blockLabel(block)) as Ref);
  asm.dw(0);
  for (let block = 0; block < data.blocks.length; block += 1) {
    asm.label(blockLabel(block));
    asm.bytes(data.blocks[block] as Uint8Array);
  }
  asm.align();
  return orderLabel;
}
