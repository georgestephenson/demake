/**
 * The Game Boy driver's stream player — one implementation, two callers.
 *
 * A cartridge that plays one schedule (`gb.ts`) and a game that plays music
 * under sound effects (`gb-game.ts`) are the same machine: a pointer walking
 * packed data, a rest counter, and an order list that says which block comes
 * next. Writing it twice is how the two would come to disagree about the one
 * thing doc 16 makes a contract — *on tick N the driver performs exactly the
 * writes `ChipScript.ticks[N]` lists, in order* — so it is written here once and
 * specialised by what the caller passes.
 *
 * Specialised, not configured: every branch below is decided at emit time from
 * the packed data, so a schedule with no rests emits no rest handling and a
 * stream nothing can preempt emits no preemption test. That is the same
 * "helpers are pulled, never pushed" discipline the rest of the ROM path runs
 * under, applied inside a routine rather than between routines.
 *
 * **Which is why a branch over the run walk is `jp` and not `jr`.** The walk's
 * length is the schedule's: a body per borrowable channel, a merge loop, a
 * preemption test, each present or absent. A relative branch reaches ±128 bytes
 * and the assembler refuses rather than wrapping, so anything jumping *across*
 * that walk is a long branch by nature — `jr` there is a cartridge that
 * assembles for six of the example games and not for the seventh. `jr` is kept
 * for what it is for: a loop back to a label a few instructions up, and a skip
 * over one.
 *
 * Sources:
 * - Pan Docs — Audio Registers: https://gbdev.io/pandocs/Audio_Registers.html
 */

import { Asm, label } from "@demake/core";

import { RUN, type DriverData } from "./data.js";

/** Where a stream keeps its position, one byte per field, in high RAM. */
export interface StreamState {
  dataLo: number;
  dataHi: number;
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
   * Absent for a cartridge whose only job is one schedule: it starts at boot and
   * never stops, so a flag would be a byte and a test that could only ever say
   * yes.
   */
  active?: number;
}

/** What to emit, and how this stream shares the chip. */
export interface StreamOptions {
  /**
   * Label namespace. Empty for the solo cartridge, so its symbols keep the
   * names the conformance harness looks up.
   */
  prefix: string;
  state: StreamState;
  data: DriverData;
  /**
   * High-RAM byte naming the channels another stream has taken.
   *
   * Supplying it makes this stream *preemptible*: a run whose channels appear
   * there is skipped rather than written. Only music needs it.
   */
  steal?: number;
  /**
   * Routine that takes a merge run's value in `a` and folds it into the chip.
   *
   * `NR51` is the whole of it: one byte carries every channel's panning, so a
   * stream that stored it would erase the other stream's channels.
   */
  merge?: string;
  /**
   * Where this stream keeps a copy of the channels another stream can borrow.
   *
   * A run naming one of `channels` is recorded as well as written, and a run
   * that is *skipped* is recorded instead of written — so the copy is the
   * music's own state whether or not the chip currently holds it, and the
   * release routine has something true to replay (`shared.ts` §`shadowPlan`).
   * Absent when nothing borrowable is ever written, and then neither the
   * recording loop nor the shadow exists.
   */
  shadow?: {
    /**
     * One per borrowable channel: its bit, and what a packed register byte is
     * offset by to reach that channel's copy of it.
     *
     * A channel has a window of its own rather than sharing one, so the offset
     * is per channel and a run is routed to its own loop.
     */
    channels: readonly { bit: number; delta: number }[];
  };
  /** Routine called when a stoppable stream's order list runs out. */
  onEnd?: string;
}

/**
 * Emit `<prefix>Tick` and `<prefix>NextBlock`.
 *
 * `Tick` performs one driver tick and returns; `NextBlock` takes the next order
 * entry, and returns with carry set when a stoppable stream has ended. The
 * caller supplies the interrupt that drives them, because a cartridge and a
 * game arrive here from different places.
 */
export function emitStream(asm: Asm, options: StreamOptions): string[] {
  const { prefix: p, state, data } = options;
  const helpers: string[] = [];
  const stoppable = state.active !== undefined;
  const preemptible = options.steal !== undefined && data.runs;

  asm.label(`${p}Tick`);
  if (stoppable) {
    asm.ldha(state.active as number);
    asm.alu("or", "a");
    asm.ret("z");
    helpers.push("stoppable");
  }

  if (data.hasRests) {
    // A rest costs five instructions and reaches the common case first: most
    // ticks of most tracks write nothing at all.
    asm.ldha(state.rest);
    asm.alu("or", "a");
    asm.jr(`${p}TickPlay`, "z");
    asm.dec("a");
    asm.stha(state.rest);
    asm.ret();
    helpers.push("rests");
  }

  asm.label(`${p}TickPlay`);
  asm.ldha(state.dataLo).ld("l", "a");
  asm.ldha(state.dataHi).ld("h", "a");

  asm.label(`${p}TickFetch`);
  asm.ldaHLI();
  asm.alu("or", "a");
  asm.jp(`${p}TickBlock`, "z");
  if (data.hasRests) {
    asm.bit(7, "a");
    asm.jp(`${p}TickRest`, "nz");
  }
  asm.ld("b", "a");

  if (data.runs) {
    emitRuns(asm, options, preemptible);
    helpers.push(preemptible ? "preemptible-runs" : "runs");
    if (preemptible && options.shadow) helpers.push("borrowed-channel-shadow");
  } else {
    asm.label(`${p}TickWrite`);
    asm.ldaHLI().ld("c", "a"); // register
    asm.ldaHLI().staC(); // value → $FF00 + c
    asm.dec("b");
    asm.jr(`${p}TickWrite`, "nz");
    asm.jr(`${p}TickSave`);
  }

  if (data.hasRests) {
    asm.label(`${p}TickRest`);
    asm.aluN("and", 0x7f);
    asm.stha(state.rest);
  }

  asm.label(`${p}TickSave`);
  asm.ld("a", "l").stha(state.dataLo);
  asm.ld("a", "h").stha(state.dataHi);
  asm.ret();

  // Reaching the end of a block consumes no tick, so the fetch resumes in the
  // next one — which is why a block always covers at least one tick and the
  // walk cannot spin.
  asm.label(`${p}TickBlock`);
  asm.call(`${p}NextBlock`);
  if (stoppable) asm.ret("c");
  asm.ldha(state.dataLo).ld("l", "a");
  asm.ldha(state.dataHi).ld("h", "a");
  asm.jp(`${p}TickFetch`);

  emitNextBlock(asm, options);
  helpers.push(data.hasOrder ? "order-walk" : "single-block");
  if (data.oneShot) helpers.push("one-shot-stop");
  if (data.hasMerges) helpers.push("panning-merge");
  return helpers;
}

/**
 * The run walk: writes grouped by who they belong to.
 *
 * `b` counts the run, `d` carries its flags across the whole run, `c` carries a
 * register for `ld [$FF00+c], a`, and `hl` walks the data. Nothing here touches
 * `e` unless the preemption test needs it, and the merge routine is called with
 * `b`, `d` and `hl` live — which is stated because it is a rule the caller has
 * to keep, not something the assembler can check.
 */
function emitRuns(asm: Asm, options: StreamOptions, preemptible: boolean): void {
  const { prefix: p, data } = options;

  const shadow = preemptible ? options.shadow : undefined;

  asm.label(`${p}TickRun`);
  asm.ldaHLI().ld("d", "a"); // flags
  if (preemptible) {
    asm.aluN("and", RUN.channels);
    asm.jr(`${p}TickOwn`, "z"); // a run that names no channel is never preempted
    asm.ld("e", "a");
    asm.ldha(options.steal as number);
    asm.alu("and", "e");
    asm.jp(`${p}TickSkip`, "nz");
    if (shadow) {
      // Ours right now, but borrowable: the chip and the copy both take it, so
      // the copy is still true the next time an effect hands the channel back.
      asm.ld("a", "e");
      asm.aluN("and", maskOf(shadow.channels));
      asm.jr(`${p}TickRecord`, "nz");
    }
  }
  asm.label(`${p}TickOwn`);
  if (data.hasMerges) {
    asm.bit(6, "d");
    asm.jr(`${p}TickMerge`, "nz");
  }

  asm.label(`${p}TickWrite`);
  asm.ldaHLI().ld("c", "a"); // register
  asm.ldaHLI().staC(); // value → $FF00 + c
  asm.dec("b");
  asm.jr(`${p}TickWrite`, "nz");
  asm.jp(`${p}TickNext`);

  if (data.hasMerges) {
    asm.label(`${p}TickMerge`);
    asm.inc16("hl"); // the register is implied by the merge routine
    asm.ldaHLI();
    asm.call(options.merge as string);
    asm.dec("b");
    asm.jr(`${p}TickMerge`, "nz");
    asm.jp(`${p}TickNext`);
  }

  if (shadow) {
    // Written *and* recorded, one loop per borrowable channel because each has a
    // window of its own. `e` carries the run's channel bits in and then the
    // value across the two stores, since `a` is the only register either of them
    // can go through.
    asm.label(`${p}TickRecord`);
    perChannel(asm, shadow.channels, `${p}TickRecordOn`, (label, delta) => {
      asm.label(label);
      asm.ldaHLI().ld("c", "a"); // register
      asm.ldaHLI().ld("e", "a"); // value
      asm.staC(); // value → $FF00 + c
      asm.ld("a", "c");
      asm.aluN("add", delta & 0xff);
      asm.ld("c", "a");
      asm.ld("a", "e");
      asm.staC(); // value → the copy
      asm.dec("b");
      asm.jr(label, "nz");
      asm.jp(`${p}TickNext`);
    });
  }

  if (preemptible) {
    // A skipped run is recorded and not written: the chip belongs to the effect
    // until it lets go, but the music's own idea of the channel has to keep
    // moving or the replay would restore a note that ended while it played.
    asm.label(`${p}TickSkip`);
    if (shadow) {
      perChannel(asm, shadow.channels, `${p}TickSkipOn`, (label, delta) => {
        asm.label(label);
        asm.ldaHLI();
        asm.aluN("add", delta & 0xff);
        asm.ld("c", "a"); // register → its copy
        asm.ldaHLI().staC();
        asm.dec("b");
        asm.jr(label, "nz");
        asm.jp(`${p}TickNext`);
      });
    } else {
      // Nothing borrowable is ever written, so a skipped run is only stepped
      // over — two bytes per write is the only thing the data says about it.
      asm.inc16("hl").inc16("hl");
      asm.dec("b");
      asm.jr(`${p}TickSkip`, "nz");
    }
  }

  asm.label(`${p}TickNext`);
  asm.bit(7, "d");
  asm.jr(`${p}TickSave`, "z");
  asm.ldaHLI().ld("b", "a");
  asm.jp(`${p}TickRun`);
}

/** Every channel a run may be recorded for, as one mask. */
function maskOf(channels: readonly { bit: number }[]): number {
  return channels.reduce((bits, one) => bits | one.bit, 0);
}

/**
 * Emit one body per borrowable channel, routed on the run's channel bits in `e`.
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
  asm: Asm,
  channels: readonly { bit: number; delta: number }[],
  prefix: string,
  body: (label: string, delta: number) => void,
): void {
  for (let index = 1; index < channels.length; index += 1) {
    asm.ld("a", "e");
    asm.aluN("and", (channels[index] as { bit: number }).bit);
    asm.jp(`${prefix}${index}`, "nz");
  }
  for (let index = 0; index < channels.length; index += 1) {
    const { delta } = channels[index] as { delta: number };
    body(`${prefix}${index}`, delta);
  }
}

/**
 * Take the next order entry into the data pointer.
 *
 * The terminator is `$0000` rather than a length, so the order list is walked
 * with a pointer and nothing counts. Where a looping stream reloads from its
 * stored loop entry, a stoppable one ends: it returns with carry set, and the
 * caller stops asking.
 */
function emitNextBlock(asm: Asm, options: StreamOptions): void {
  const { prefix: p, state } = options;
  asm.label(`${p}NextBlock`);
  asm.ldha(state.orderLo).ld("l", "a");
  asm.ldha(state.orderHi).ld("h", "a");
  asm.ldaHLI().ld("e", "a");
  asm.ldaHLI().ld("d", "a");
  asm.alu("or", "e"); // a still holds the high byte
  asm.jr(`${p}NextBlockGot`, "nz");

  if (state.active !== undefined && options.onEnd !== undefined) {
    asm.call(options.onEnd);
    asm.alu("xor", "a");
    asm.stha(state.active);
    asm.scf();
    asm.ret();
  } else {
    // `Loop` is an address *inside* the order list, so the reload leaves the
    // pointer two bytes past it and the walk resumes as if it had never ended.
    asm.ldha(state.loopLo as number).ld("l", "a");
    asm.ldha(state.loopHi as number).ld("h", "a");
    asm.ldaHLI().ld("e", "a");
    asm.ldaHLI().ld("d", "a");
  }

  asm.label(`${p}NextBlockGot`);
  asm.ld("a", "l").stha(state.orderLo);
  asm.ld("a", "h").stha(state.orderHi);
  asm.ld("a", "e").stha(state.dataLo);
  asm.ld("a", "d").stha(state.dataHi);
  asm.alu("or", "a"); // carry clear: the stream is still playing
  asm.ret();
}

/**
 * Emit a stream's packed data, and return the label its order list starts at.
 *
 * The order list comes first so a caller can point at it without knowing how
 * many blocks follow, and the loop entry is an offset into it.
 */
export function emitStreamData(asm: Asm, prefix: string, index: number, data: DriverData): string {
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
