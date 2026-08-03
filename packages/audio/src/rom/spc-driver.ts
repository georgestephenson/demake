/**
 * The SPC700 stream player (doc 16 §The driver contract).
 *
 * `gb-driver.ts`, `mos-player.ts` and `sms-driver.ts` a fourth CPU over, and the
 * first one that does not run on the console's main processor. On a Super
 * Nintendo the sound hardware is a second computer, so this code is *uploaded* to
 * it at boot and then runs on its own: it takes its tempo from the sound
 * processor's own timer, reads its schedule out of the sound processor's RAM, and
 * hears from the game only through four mailbox bytes. Nothing about a frame, a
 * scanline or a vertical blank reaches it.
 *
 * Two things follow, and they are why this player is shorter than the other
 * three rather than longer:
 *
 *   - **The read cursor is the stream's own pointer.** `mov a,[$nn]+y` with `Y`
 *     held at zero and `incw $nn` after it is the whole of "read the next byte",
 *     so there is no separate cursor to keep in step and no register that has to
 *     stay live across a call.
 *   - **Preemption is one byte per stream.** `own` is the voices this stream may
 *     touch: a run is skipped when it names a voice outside it, and a *merge*
 *     write — `KON`, the only register two streams could both want — is masked
 *     down to it. Music's `own` is the complement of what an effect took and an
 *     effect's is what it took, so there are no shadows to fold and no shared
 *     register to recompute.
 *
 * The packed format is `data.ts`'s, in its **wide** shape where two streams share
 * the chip: eight voices do not fit in a run header's low nibble, so the channel
 * mask is a byte of its own. A game with music and no effects packs flat and gets
 * the shorter player, exactly as a cartridge that owns the chip does.
 */

import { Asm700, A, X, Y, spcDp, spcIdxIndY, spcImm } from "@demake/core";

import { RUN, type DriverData } from "./data.js";

/** Where one stream keeps everything, as direct-page offsets. */
export interface SpcStreamState {
  /** Non-zero while the stream is playing. */
  active: number;
  /** Ticks still to skip before the next opcode. */
  rest: number;
  /** Voices this stream may write; the rest belong to the other one. */
  own: number;
  /** Cursor into the current block. */
  ptr: number;
  /** Cursor into the order list. */
  order: number;
  /** Where the order cursor goes when the list runs out. */
  loop: number;
}

/** Direct-page bytes one stream's state occupies. */
export const SPC_STREAM_BYTES = 9;

/** Lay a stream's state out from `at`. */
export function streamState(at: number): SpcStreamState {
  return { active: at, rest: at + 1, own: at + 2, ptr: at + 3, order: at + 5, loop: at + 7 };
}

/** Scratch the player uses inside one tick, shared because ticks do not nest. */
export interface SpcScratch {
  count: number;
  flags: number;
  mask: number;
}

/** What one stream's player needs to know. */
export interface SpcStreamOptions {
  /** Label prefix, so two streams can share one emitter. */
  prefix: string;
  state: SpcStreamState;
  scratch: SpcScratch;
  /** The union of what this stream's schedules ask for. */
  data: DriverData;
  /** Routine to jump to when a one-shot's order list runs out. */
  onEnd?: string;
}

/**
 * Emit one stream's player, and report the routines it pulled in.
 *
 * Helpers are pulled, never pushed, on the rule the whole project runs under: a
 * stream with no rests in it emits no rest path, and one that never shares the
 * chip emits neither the skip nor the merge.
 */
export function emitStream(asm: Asm700, options: SpcStreamOptions): string[] {
  const { prefix, state: s, scratch, data } = options;
  const helpers: string[] = ["order-walk"];
  const at = (name: string): string => `${prefix}${name}`;

  // --- one tick ---------------------------------------------------------------
  asm.label(at("Tick"));
  asm.mov(A, spcDp(s.active));
  asm.beq(at("Return"));
  if (data.hasRests) {
    asm.mov(A, spcDp(s.rest));
    asm.beq(at("Ready"));
    asm.dec(A);
    asm.mov(spcDp(s.rest), A);
    asm.ret();
    asm.label(at("Ready"));
    helpers.push("rest");
  }
  // Y stays at zero for the whole tick: it is the index half of `[$nn]+y`, and
  // the pointer it indexes is what actually advances.
  asm.mov(Y, spcImm(0x00));

  asm.label(at("Next"));
  readByte(asm, s.ptr);
  asm.cmp(A, spcImm(0x00));
  asm.beq(at("Block"));
  asm.cmp(A, spcImm(0x80));
  asm.bcc(at("Run"));
  if (data.hasRests) {
    asm.and(A, spcImm(0x7f));
    asm.mov(spcDp(s.rest), A);
  }
  asm.label(at("Return"));
  asm.ret();

  // --- a run of writes --------------------------------------------------------
  asm.label(at("Run"));
  asm.mov(spcDp(scratch.count), A);
  if (data.runs) {
    readByte(asm, s.ptr);
    asm.mov(spcDp(scratch.flags), A);
    readByte(asm, s.ptr);
    asm.mov(spcDp(scratch.mask), A);
    if (data.hasMerges) {
      asm.mov(A, spcDp(scratch.flags));
      asm.and(A, spcImm(RUN.merge));
      asm.bne(at("Merge"));
      helpers.push("merge");
    }
    // A run belongs to this stream only if every voice it names is one this
    // stream still owns. One `eor`, one `and`: no per-write decision anywhere.
    asm.mov(A, spcDp(s.own));
    asm.eor(A, spcImm(0xff));
    asm.and(A, spcDp(scratch.mask));
    asm.bne(at("Skip"));
    helpers.push("preemptible-skip");
  }

  asm.label(at("Write"));
  readByte(asm, s.ptr);
  asm.mov(spcDp(0xf2), A);
  readByte(asm, s.ptr);
  asm.mov(spcDp(0xf3), A);
  asm.dbnzDp(scratch.count, at("Write"));
  if (!data.runs) asm.ret();
  else asm.bra(at("After"));

  if (data.runs && data.hasMerges) {
    asm.label(at("Merge"));
    readByte(asm, s.ptr);
    asm.mov(spcDp(0xf2), A);
    readByte(asm, s.ptr);
    asm.and(A, spcDp(s.own));
    asm.mov(spcDp(0xf3), A);
    asm.dbnzDp(scratch.count, at("Merge"));
    asm.bra(at("After"));
  }

  if (data.runs) {
    asm.label(at("Skip"));
    asm.mov(A, spcDp(scratch.count));
    asm.asl();
    asm.clrc();
    asm.adc(A, spcDp(s.ptr));
    asm.mov(spcDp(s.ptr), A);
    asm.bcc(at("After"));
    asm.inc(spcDp(s.ptr + 1));

    asm.label(at("After"));
    asm.mov(A, spcDp(scratch.flags));
    asm.and(A, spcImm(RUN.more));
    asm.beq(at("Stop"));
    asm.jmp(at("Next"));
    asm.label(at("Stop"));
    asm.ret();
  }

  // --- the order list ---------------------------------------------------------
  //
  // Reached both from the end of a block and from a start, which is why `Load` is
  // a label of its own: starting a stream is "point the order cursor at the list
  // and load an entry".
  asm.label(at("Block"));
  asm.call(at("Load"));
  if (options.onEnd !== undefined) {
    asm.mov(A, spcDp(s.active));
    asm.beq(at("Ended"));
  }
  asm.mov(Y, spcImm(0x00));
  asm.jmp(at("Next"));
  if (options.onEnd !== undefined) {
    asm.label(at("Ended"));
    asm.ret();
  }

  // `Load` is a subroutine rather than a fall-through, because starting a stream
  // is "point the order cursor at the list and load an entry" and must *not*
  // perform a tick: the first tick belongs to the timer, not to the request that
  // started the track.
  asm.label(at("Load"));
  asm.mov(Y, spcImm(0x01));
  asm.mov(A, spcIdxIndY(s.order));
  asm.mov(spcDp(s.ptr + 1), A);
  asm.mov(Y, spcImm(0x00));
  asm.mov(A, spcIdxIndY(s.order));
  asm.mov(spcDp(s.ptr), A);
  asm.incw(spcDp(s.order));
  asm.incw(spcDp(s.order));
  asm.or(A, spcDp(s.ptr + 1));
  asm.bne(at("Entry"));
  if (options.onEnd !== undefined) {
    // A one-shot stops: the order list's terminator is the whole of "this effect
    // is over", and the release routine gives the voice back.
    asm.mov(spcDp(s.active), spcImm(0x00));
    asm.call(options.onEnd);
    helpers.push("one-shot-stop");
  } else {
    asm.mov(A, spcDp(s.loop));
    asm.mov(spcDp(s.order), A);
    asm.mov(A, spcDp(s.loop + 1));
    asm.mov(spcDp(s.order + 1), A);
    asm.bra(at("Load"));
    helpers.push("loop");
  }
  asm.label(at("Entry"));
  asm.ret();

  return helpers;
}

/** `a = *ptr++`, which is two instructions and the whole of the read path. */
function readByte(asm: Asm700, ptr: number): void {
  asm.mov(A, spcIdxIndY(ptr));
  asm.incw(spcDp(ptr));
}

/**
 * Emit one stream's order lists and block bodies.
 *
 * Order entries are absolute addresses rather than block indices, because on this
 * machine a pointer is what the player wants and an index would cost a multiply
 * every block. The list ends with a zero word, which is a valid terminator here
 * for the reason it is a valid one anywhere: nothing is ever assembled at address
 * zero on the sound side — that is the direct page.
 */
export function emitStreamData(asm: Asm700, prefix: string, index: number, data: DriverData): void {
  asm.label(`${prefix}Order${index}`);
  for (const block of data.order) asm.dw(`${prefix}Block${index}_${block}`);
  asm.dw(0x0000);
  for (let block = 0; block < data.blocks.length; block += 1) {
    asm.label(`${prefix}Block${index}_${block}`);
    asm.bytes(data.blocks[block] as Uint8Array);
  }
}

/** Silence every voice, one `GAIN` at a time. Pulled only when music can stop. */
export function emitSilence(asm: Asm700, name: string): void {
  asm.label(name);
  asm.mov(Y, spcImm(0x07));
  asm.mov(X, spcImm(0x08));
  asm.label(`${name}Loop`);
  asm.mov(spcDp(0xf2), Y);
  asm.mov(spcDp(0xf3), spcImm(0x00));
  asm.mov(A, Y);
  asm.clrc();
  asm.adc(A, spcImm(0x10));
  asm.mov(Y, A);
  asm.dec(X);
  asm.bne(`${name}Loop`);
  asm.ret();
}
