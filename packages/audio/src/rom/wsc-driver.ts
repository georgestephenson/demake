/**
 * The WonderSwan driver's stream player — the V30MZ half.
 *
 * The sixth processor to get one, and the same machine again: a pointer walking
 * packed data, a rest counter, and an order list saying which block comes next.
 * It is written once and specialised at emit time from the packed data — a
 * schedule with no rests emits no rest handling, a stream nothing can preempt
 * emits no preemption test — because the one thing doc 16 makes a contract is
 * the register stream, and six hand-written copies of a walk are six chances to
 * disagree about it.
 *
 * What is genuinely this machine's is small, and almost all of it is about
 * *where a byte is*:
 *
 *   - **The packed data is in a different segment from the state.** A stream's
 *     blocks are cartridge and its position is RAM, so every fetch carries a
 *     `cs:` override and every store does not. That is the game backend's rule
 *     one layer down (`codegen/wsc/val.ts` §`source`), and forgetting it here
 *     reads a game's own variables as though they were music.
 *   - **A chip is a port, and the port is a byte in the data.** Like the Z80,
 *     this architecture has a separate I/O space; unlike it, the register-
 *     indirect form takes `dx` rather than `c`. So the packed data carries the
 *     port (`data.ts`'s `port` option) and the write loop is `mov dl,` then
 *     `out dx, al` — and `dh` is held at zero across the whole walk, because
 *     this console decodes a byte port and `out dx, al` puts all sixteen bits on
 *     the bus.
 *   - **A load *does* set the flags.** `mov` does not, but the ALU forms do, and
 *     `or al, al` costs two bytes — so the dispatch reads exactly like the Z80
 *     player's. What this CPU adds is `test`, which does the same thing for a
 *     single bit without destroying anything.
 *   - **A conditional jump reaches ±128 bytes**, because a near conditional jump
 *     is an 80386 instruction. Anything that leaves a routine goes through
 *     {@link far}, exactly as the 6502 player's does; a jump a few instructions
 *     along stays short.
 *
 * Source: WSdev wiki — Sound (https://ws.nesdev.org/wiki/Sound).
 */

import {
  Asm30,
  label,
  x86Abs as abs,
  x86At as at,
  x86Invert as invert,
  x86RomAt as romAt,
  type X86CC,
} from "@demake/core";

import { RUN, type DriverData } from "./data.js";

/**
 * Where a stream keeps its position, in the console's RAM.
 *
 * Words rather than byte pairs, because this CPU loads and stores sixteen bits
 * in one instruction and has no cheap page to be economical in — a V30MZ pays
 * the same two address bytes wherever a variable lives, which is the Z80's
 * bargain and why `SmsStreamState` has the same shape.
 */
export interface WscStreamState {
  /** The block pointer, as an offset in the cartridge's mapped bank. */
  data: number;
  /** The order-list pointer, likewise. */
  order: number;
  /** Order entry playback returns to when the list runs out; absent if it stops. */
  loop?: number;
  rest: number;
  /** Non-zero while the stream is playing; absent for one that never stops. */
  active?: number;
}

/** What to emit, and how this stream shares the chip. */
export interface WscStreamOptions {
  /** Label namespace, so one player can be emitted twice. */
  prefix: string;
  state: WscStreamState;
  data: DriverData;
  /**
   * Byte naming the channels another stream has taken.
   *
   * Supplying it makes this stream *preemptible*: a run whose channels appear
   * there is skipped rather than written. Only music needs it.
   */
  steal?: number;
  /**
   * Routine that takes a merge run's value in `al` and folds it into the chip.
   *
   * `$90` is the whole of it here: one byte carries all four channel enables, so
   * a stream that stored it would silence the other stream's notes. Called with
   * `cx`, `bx`, `si` and `dx` live.
   */
  merge?: string;
  /**
   * Where this stream keeps a copy of the channels another stream can borrow.
   *
   * A run naming one of `channels` is recorded as well as written, and a run
   * that is *skipped* is recorded instead of written, so the copy is the music's
   * own state whether or not the chip currently holds it (`shared.ts`
   * §`shadowPlan`). This chip has real register numbers, so a copy is indexed by
   * the packed port byte and recording is one store rather than the SN76489's
   * tree of bit tests.
   */
  shadow?: {
    /** One per borrowable channel: its bit, and the address its window sits at. */
    channels: readonly { bit: number; base: number }[];
  };
  /** Routine called when a stoppable stream's order list runs out. */
  onEnd?: string;
}

/** A conditional jump that reaches anywhere: invert it and jump over a `jmp`. */
function far(asm: Asm30, cond: X86CC, target: string): void {
  const over = `${target}_far${asm.pc}`;
  asm.jcc(invert(cond), over);
  asm.jmp(target);
  asm.label(over);
}

/**
 * Emit `<prefix>Tick` and `<prefix>NextBlock`, and report what they pulled in.
 *
 * `Tick` performs one driver tick and returns; `NextBlock` takes the next order
 * entry and returns with the carry set when a stoppable stream has ended. The
 * caller supplies whatever drives them — on this console, the frame the main
 * loop already waits for.
 */
export function emitStream(asm: Asm30, options: WscStreamOptions): string[] {
  const { prefix: p, state, data } = options;
  const helpers: string[] = [];
  const stoppable = state.active !== undefined;
  const preemptible = options.steal !== undefined && data.runs;

  asm.label(`${p}Tick`);
  if (stoppable) {
    asm.aluMI8("cmp", abs(state.active as number), 0);
    asm.jcc("nz", `${p}TickOn`);
    asm.ret();
    asm.label(`${p}TickOn`);
    helpers.push("stoppable");
  }

  if (data.hasRests) {
    // The common case first: most ticks of most tracks write nothing at all.
    asm.aluMI8("cmp", abs(state.rest), 0);
    asm.jcc("z", `${p}TickPlay`);
    asm.decM8(abs(state.rest));
    asm.ret();
    helpers.push("rests");
  }

  asm.label(`${p}TickPlay`);
  asm.movm("si", abs(state.data));
  // `dh` is zero for the whole walk: `out dx, al` puts sixteen bits on the bus
  // and this console decodes eight, so the high half has to be something rather
  // than whatever the game left there.
  asm.movi8("dh", 0);

  asm.label(`${p}TickFetch`);
  fetch(asm);
  asm.alu8("or", "al", "al");
  far(asm, "z", `${p}TickBlock`);
  if (data.hasRests) {
    asm.testI8("al", 0x80);
    far(asm, "nz", `${p}TickRest`);
  }
  asm.mov8("cl", "al");
  asm.movi8("ch", 0);

  if (data.runs) {
    emitRuns(asm, options, preemptible);
    helpers.push(preemptible ? "preemptible-runs" : "runs");
    if (preemptible && options.shadow) helpers.push("borrowed-channel-shadow");
  } else {
    asm.label(`${p}TickWrite`);
    emitWrite(asm);
    asm.loop(`${p}TickWrite`);
    asm.jmp(`${p}TickSave`);
  }

  if (data.hasRests) {
    asm.label(`${p}TickRest`);
    asm.aluI8("and", "al", 0x7f);
    asm.movmr8(abs(state.rest), "al");
  }

  asm.label(`${p}TickSave`);
  asm.movmr(abs(state.data), "si");
  asm.ret();

  // Reaching the end of a block consumes no tick, so the fetch resumes in the
  // next one — which is why a block always covers at least one tick and the walk
  // cannot spin. Nothing is saved first: `NextBlock` replaces the pointer whole.
  asm.label(`${p}TickBlock`);
  asm.call(`${p}NextBlock`);
  if (stoppable) {
    asm.jcc("nb", `${p}TickBlockGo`);
    asm.ret();
    asm.label(`${p}TickBlockGo`);
  }
  asm.movm("si", abs(state.data));
  asm.movi8("dh", 0);
  asm.jmp(`${p}TickFetch`);

  emitNextBlock(asm, options);
  helpers.push(data.hasOrder ? "order-walk" : "single-block");
  if (data.oneShot) helpers.push("one-shot-stop");
  if (data.hasMerges) helpers.push("shared-register-merge");
  return helpers;
}

/** Take the byte `si` is on into `al`, and step past it — out of the cartridge. */
function fetch(asm: Asm30): void {
  asm.movm8("al", romAt("si"));
  asm.inc("si");
}

/** One packed write: the port, then the value, straight out to the chip. */
function emitWrite(asm: Asm30): void {
  fetch(asm);
  asm.mov8("dl", "al");
  fetch(asm);
  asm.outDx8();
}

/**
 * The run walk: writes grouped by who they belong to.
 *
 * `cx` counts the run, `bl` carries its flags across it, `dx` carries the port,
 * `si` walks the data, and `bh` is borrowed only by the preemption test. That is
 * the Z80 player's allocation with the pairs renamed, which is not a coincidence
 * — the same registers exist for the same reasons.
 */
function emitRuns(asm: Asm30, options: WscStreamOptions, preemptible: boolean): void {
  const { prefix: p, data } = options;
  const shadow = preemptible ? options.shadow : undefined;

  asm.label(`${p}TickRun`);
  fetch(asm);
  asm.mov8("bl", "al"); // flags

  if (preemptible) {
    asm.aluI8("and", "al", RUN.channels);
    far(asm, "z", `${p}TickOwn`); // a run naming no channel is never preempted
    asm.mov8("bh", "al");
    asm.movm8("al", abs(options.steal as number));
    asm.alu8("and", "al", "bh");
    far(asm, "nz", `${p}TickSkip`);
    if (shadow) {
      // Ours right now, but borrowable: the chip and the copy both take it, so
      // the copy is still true the next time an effect hands the channel back.
      asm.mov8("al", "bh");
      asm.aluI8(
        "and",
        "al",
        shadow.channels.reduce((bits, one) => bits | one.bit, 0),
      );
      far(asm, "nz", `${p}TickRecord`);
    }
  }

  asm.label(`${p}TickOwn`);
  if (data.hasMerges) {
    asm.testI8("bl", RUN.merge);
    far(asm, "nz", `${p}TickMerge`);
  }

  asm.label(`${p}TickWrite`);
  emitWrite(asm);
  asm.loop(`${p}TickWrite`);
  asm.jmp(`${p}TickNext`);

  if (data.hasMerges) {
    asm.label(`${p}TickMerge`);
    asm.inc("si"); // the port is the merge routine's business
    fetch(asm);
    asm.call(options.merge as string);
    asm.loop(`${p}TickMerge`);
    asm.jmp(`${p}TickNext`);
  }

  if (shadow) {
    // Written *and* recorded, one loop per borrowable channel. The copy is
    // indexed by the packed port byte, so recording is a second store to a
    // window whose base the plan chose — no classification and no branch.
    asm.label(`${p}TickRecord`);
    perChannel(asm, shadow.channels, `${p}TickRecordOn`, (name, entry) => {
      asm.label(name);
      fetch(asm);
      asm.mov8("dl", "al");
      // `bp` and not `bx`, because `bl` is carrying the run's flags across the
      // whole loop and this CPU has only four registers a displacement can be
      // added to. `[bp+disp]` addresses the *stack* segment by default, which is
      // the same segment: a demade cartridge sets `SS = DS = ES = 0` at reset
      // (`codegen/wsc/emit.ts` §`emitReset`), so the two reach the same RAM.
      asm.mov("bp", "dx");
      fetch(asm);
      asm.outDx8();
      asm.movmr8(at("bp", entry.base), "al");
      asm.loop(name);
      asm.jmp(`${p}TickNext`);
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
        fetch(asm);
        asm.movi8("dh", 0);
        asm.mov8("dl", "al");
        asm.mov("bp", "dx");
        fetch(asm);
        asm.movmr8(at("bp", entry.base), "al");
        asm.loop(name);
        asm.jmp(`${p}TickNext`);
      });
    } else {
      // Two bytes per write is the only thing the data says about its length.
      asm.label(`${p}TickSkipStep`);
      asm.aluI("add", "si", 2);
      asm.loop(`${p}TickSkipStep`);
    }
  }

  asm.label(`${p}TickNext`);
  asm.testI8("bl", RUN.more);
  far(asm, "z", `${p}TickSave`);
  fetch(asm);
  asm.mov8("cl", "al");
  asm.movi8("ch", 0);
  asm.jmp(`${p}TickRun`);
}

/**
 * Emit one body per borrowable channel, routed on the run's channel bits in `bh`.
 *
 * The **first** channel falls through rather than being tested, because a run only
 * reaches here when it named one of them — so with a single borrowable channel,
 * which is what a game with one pitched effect has, there is no test at all. It
 * has to be the first and not the last, because the bodies are emitted in index
 * order directly below: testing every one but the *last* would send a run that
 * named it into the *first* channel's body, which no schedule in the example
 * library reaches and which nothing but a two-channel effect set can see.
 */
function perChannel(
  asm: Asm30,
  channels: readonly { bit: number; base: number }[],
  prefix: string,
  body: (name: string, entry: { base: number }) => void,
): void {
  for (let index = 1; index < channels.length; index += 1) {
    asm.mov8("al", "bh");
    asm.aluI8("and", "al", (channels[index] as { bit: number }).bit);
    far(asm, "nz", `${prefix}${index}`);
  }
  for (let index = 0; index < channels.length; index += 1) {
    body(`${prefix}${index}`, channels[index] as { base: number });
  }
}

/**
 * Take the next order entry into the data pointer.
 *
 * The terminator is `$0000` rather than a length, so the order list is walked
 * with a pointer and nothing counts. A looping stream reloads from its stored
 * loop entry; a stoppable one ends, returning with the carry set so the caller
 * stops asking.
 */
function emitNextBlock(asm: Asm30, options: WscStreamOptions): void {
  const { prefix: p, state } = options;
  asm.label(`${p}NextBlock`);
  asm.movm("bx", abs(state.order));
  emitReadEntry(asm);
  asm.jcc("nz", `${p}NextBlockGot`);

  if (state.active !== undefined && options.onEnd !== undefined) {
    asm.call(options.onEnd);
    asm.movmi8(abs(state.active), 0);
    asm.stc();
    asm.ret();
  } else {
    // The loop entry is an address *inside* the order list, so pointing at it
    // and reading resumes the walk as if the list had never ended.
    asm.movm("bx", abs(state.loop as number));
    emitReadEntry(asm);
  }

  asm.label(`${p}NextBlockGot`);
  asm.movmr(abs(state.order), "bx");
  asm.movmr(abs(state.data), "ax");
  asm.clc(); // the stream is still playing
  asm.ret();
}

/**
 * Read the entry `bx` is on into `ax`, stepping past it.
 *
 * The read leaves the flags set from the value itself, so the caller's branch
 * tests the `$0000` terminator without a second instruction — which on this CPU
 * needs one explicit `or` because `mov` sets nothing.
 */
function emitReadEntry(asm: Asm30): void {
  asm.movm("ax", romAt("bx"));
  asm.aluI("add", "bx", 2);
  asm.alu("or", "ax", "ax");
}

/**
 * Emit a stream's packed data, and return the label its order list starts at.
 *
 * The order list comes first so a caller can point at it without knowing how
 * many blocks follow, and the loop entry is an offset into it.
 */
export function emitStreamData(
  asm: Asm30,
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
