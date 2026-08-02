/**
 * The Nintendo DS driver's hardware half.
 *
 * The stream player is `arm-player.ts` — the walk over packed data belongs to the
 * *processor* and this console shares one with the Game Boy Advance — so what is
 * here is everything the machine adds to it, and on this console that is
 * remarkably little:
 *
 *   - **A packed byte is a register.** Sixteen channels of sixteen bytes fills
 *     the byte exactly, so `AudioWrite` is one indexed store and there is no
 *     dispatch at all. That is the Game Boy's `ld [$FF00+c], a` argument reached
 *     by a chip whose whole map happens to be 256 bytes wide.
 *   - **The clock is a *count*, not a flag.** Timer 0 reloads at the driver rate
 *     and timer 1 is chained to it in count-up mode, so the hardware maintains a
 *     sixteen-bit tally of ticks that have happened whether the driver was
 *     looking or not. The main loop subtracts what it has performed from what the
 *     counter says. Nothing can be missed by a tick that overran, nothing drifts,
 *     and — unlike every other console here — no interrupt is involved at all,
 *     which is affordable because this processor has nothing else to do.
 *   - **There is no merge routine**, because there is no register two streams
 *     share. Not panning (a byte per channel), not enabling (the start bit is a
 *     channel's own), not keying (there is no key-on pulse). The Master System
 *     and the Mega Drive are the only other machines here that can say it, and
 *     they say it by having less hardware rather than more.
 *
 * Sources: GBATEK — *DS Sound Channels*, *DS Timers*
 * (https://problemkaputt.de/gbatek.htm).
 */

import { AsmArm, armAt, armAtIdx, armAtPost, armImm, armReg, label, type Ref } from "@demake/core";

import { NDS_BANK_BASE, ndsBank } from "../binding/nds-bank.js";

import { REG } from "./arm-player.js";
import { AudioRomError } from "./gb.js";

/** Where the sound channels answer; a packed port byte is an offset from it. */
export const NDS_SPU_BASE = 0x04000400;

/** The ARM7's timer block, and the two timers the driver takes. */
const TIMER_BASE = 0x04000100;
const TM0_RELOAD = 0x00;
const TM0_CONTROL = 0x02;
const TM1_COUNT = 0x04;
const TM1_CONTROL = 0x06;

/** `TMxCNT_H`: running. The prescaler rides in the low two bits beside it. */
const TIMER_START = 0x0080;
/** And the bit that makes a timer count *its predecessor's overflows*. */
const TIMER_CASCADE = 0x0004;

/**
 * Where the driver keeps its own state: the ARM7's private 64 KiB.
 *
 * Not main RAM, which is where its binary and the waveform bank are. This memory
 * is on the sound processor's own bus and no other processor can see it at all,
 * so the driver's cursors cost no arbitration and a game that ran wild in its
 * heap cannot move a stream pointer. The request bytes are the deliberate
 * exception, and they are the game's own allocation (`nds-game.ts` §requests).
 */
export const NDS_STATE_BASE = 0x03801000;

/** Where the ARM7 leaves its stack: the top of that memory, below the vectors. */
export const NDS_STACK_TOP = 0x0380ff00;

/**
 * How a schedule's register number reaches the packed data.
 *
 * The identity, for the channels. Sixteen channels of sixteen bytes is exactly
 * the byte the packed format holds, which is why the write loop has no
 * translation and no dispatch in it — and why the master volume, which lives
 * above that, can only ever be written by the boot code. A schedule carrying one
 * is a builder bug and says so rather than wrapping round onto channel zero.
 */
export function ndsPort(reg: number): number {
  if (reg > 0xff) {
    throw new AudioRomError(
      "E_INTERNAL",
      `register $${reg.toString(16)} is above the channels and cannot be packed`,
      "the master volume is written once at boot; this is a bug in the ROM builder, not in the track.",
    );
  }
  return reg;
}

/**
 * One packed write: a channel register and the byte to put in it.
 *
 * `r0` is the register and `r1` the value. Clobbers `r0`, `r1` and `r12` only —
 * never `r4`–`r7`, which the stream player holds a tick's whole state in.
 */
export function emitWrite(asm: AsmArm): void {
  asm.label("AudioWrite");
  asm.ldrConst(REG.addr, NDS_SPU_BASE);
  asm.strb(REG.a1, armAtIdx(REG.addr, REG.a0));
  asm.bx(REG.lr);
  asm.ltorg();
}

/** One immediate write to a sound register, for boot and release code. */
export function emitSoundWrite(asm: AsmArm, reg: number, value: number): void {
  asm.ldrConst(REG.addr, NDS_SPU_BASE + reg);
  asm.mov(REG.a0, armImm(value & 0xff));
  asm.strb(REG.a0, armAt(REG.addr, 0));
}

/**
 * Copy the waveform bank out of the driver's image and into the page the
 * channels read it from.
 *
 * A `SAD` is an address, so the bank has to *be* at the address the binding put
 * in one — and the binding decided that at build time from `nds-bank.ts`, which
 * is the same file this reads its bytes out of. One definition, two readers
 * (doc 16 §The sample bank).
 */
export function emitBankCopy(asm: AsmArm, bytes: string): void {
  asm.ldrConst(REG.a0, label(bytes) as Ref);
  asm.ldrConst(REG.a1, NDS_BANK_BASE);
  asm.mov(REG.a2, armImm(ndsBank().length / 4));
  asm.label("AudioBankCopy");
  asm.ldr(REG.a3, armAtPost(REG.a0, 4));
  asm.str(REG.a3, armAtPost(REG.a1, 4));
  asm.subs(REG.a2, REG.a2, armImm(1));
  asm.b("AudioBankCopy", "ne");
}

/** The bank's bytes, at a label the copy above reads from. */
export function emitBankData(asm: AsmArm, bytes: string): void {
  asm.align();
  asm.label(bytes);
  asm.bytes(ndsBank());
  asm.align();
}

/**
 * Start the pair of timers the driver's clock is.
 *
 * The order is the whole of it: timer 1 is armed *before* timer 0, so the first
 * overflow is already being counted when it happens. Arming them the other way
 * round would lose the first tick of every cartridge — one tick of one schedule,
 * which is exactly the kind of thing that is invisible in a listen and a
 * one-tick offset in a register diff for the rest of the track.
 *
 * `divisor` is what `fitRate` packed: the sixteen-bit reload, with the prescaler
 * index above it.
 */
export function emitClockStart(asm: AsmArm, divisor: number): void {
  const reload = divisor & 0xffff;
  const prescaler = (divisor >> 16) & 3;
  asm.ldrConst(REG.addr, TIMER_BASE);
  // Count-up, running, and never reloaded: sixteen bits of tick tally that wrap
  // and are read as a difference, so wrapping costs nothing.
  asm.movImm32(REG.a0, TIMER_START | TIMER_CASCADE);
  asm.strh(REG.a0, armAt(REG.addr, TM1_CONTROL));
  asm.movImm32(REG.a0, reload);
  asm.strh(REG.a0, armAt(REG.addr, TM0_RELOAD));
  asm.movImm32(REG.a0, TIMER_START | prescaler);
  asm.strh(REG.a0, armAt(REG.addr, TM0_CONTROL));
}

/**
 * The main loop: perform whatever the hardware has counted, and go round.
 *
 * `AudioTick` is the caller's; this is the machine that decides when to call it.
 * The tally is a hardware counter and the driver's own copy is what it has
 * performed, so the difference is what it owes — and the cap is why a driver that
 * was stopped (a breakpoint, a host that descheduled the emulator) does not come
 * back and play a hundred ticks at once.
 *
 * There is no `wfi` and no halt: the processor has one job and burning the gap
 * between ticks is what it is for. A halt would need an interrupt to leave it,
 * which is the machinery this clock exists to avoid.
 */
export function emitMainLoop(asm: AsmArm, state: { tally: number; base: number }, cap: number) {
  const off = (address: number): number => address - state.base;
  asm.label("AudioMain");
  asm.ldrConst(REG.state, state.base);
  asm.ldrConst(REG.addr, TIMER_BASE);
  asm.ldrh(REG.a0, armAt(REG.addr, TM1_COUNT));
  asm.ldrh(REG.a1, armAt(REG.state, off(state.tally)));
  asm.sub(REG.a2, REG.a0, armReg(REG.a1));
  // Sixteen bits, so a counter that wrapped past the driver's copy still gives
  // the right difference once the borrow above the halfword is masked away.
  asm.movImm32(REG.addr, 0xffff);
  asm.ands(REG.a2, REG.a2, armReg(REG.addr));
  asm.b("AudioMain", "eq");
  asm.cmp(REG.a2, armImm(cap));
  asm.mov(REG.a2, armImm(cap), "hi");
  // What is *not* performed is still counted as done, which is what makes a lost
  // tick a lost tick rather than a permanent debt.
  asm.strh(REG.a0, armAt(REG.state, off(state.tally)));

  asm.label("AudioMainTick");
  asm.push([REG.a2]);
  asm.bl("AudioTick");
  asm.pop([REG.a2]);
  asm.subs(REG.a2, REG.a2, armImm(1));
  asm.b("AudioMainTick", "ne");
  asm.b("AudioMain");
  asm.ltorg();
}
