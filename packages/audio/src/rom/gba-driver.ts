/**
 * The Game Boy Advance driver: its hardware, and its software mixer.
 *
 * The stream player itself is not here — it is `arm-player.ts`, because two
 * consoles in the set run this architecture and the walk over packed data is the
 * *processor's* rather than either machine's. What is here is everything this
 * console adds to it: where a packed byte goes, how the converters are started
 * and clocked, and the mixer.
 *
 * That mixer is the **second half of the console's sound**, and it is the
 * first thing in this project that "a timed register-write schedule" does not
 * describe. Four of this machine's ten voices are a Game Boy's APU and reach it
 * as ordinary stores; the other six are `@demake/chip`'s `GbaPcm`, which is a
 * *mixer* — a register file of demake's own, and an output the processor has to
 * compute. So this file emits two things that no predecessor needed:
 *
 *   - **{@link emitMixWrite}**, which performs a write to that register file.
 *     It is the exact counterpart of `GbaPcm.write`, and it is where the model's
 *     semantics are restated in ARM: `KON` is a *pulse*, a source number is
 *     resolved against the waveform bank the moment it is written, and a step is
 *     three bytes of one word.
 *   - **{@link emitMix}**, which is `GbaPcm.mix` unrolled over a block of
 *     samples. The contract for this half is not a register diff but *the
 *     samples themselves*, byte for byte, so this routine is written to match
 *     that method operation for operation rather than to be clever: the
 *     accumulator is 32-bit, the voices are summed in index order, and the shift
 *     and the clamp are the model's.
 *
 * Four things are this instruction set's rather than this console's:
 *
 *   - **Two accumulator words are one transfer.** `ldmia`/`stmia` of a register
 *     pair moves both sides of a stereo accumulator in two instructions where
 *     four would be needed, which is a third of the inner loop.
 *   - **A short conditional is predicated.** The clamp is four instructions and
 *     no branch, and the three cases of a step byte are three predicated pairs.
 *   - **Every conditional branch reaches**, so nothing here needs the 6502
 *     player's invert-and-jump dance — but a branch is ±32 MB and a *pooled
 *     constant* is only ±4 KB, so `ltorg` goes after every routine.
 *   - **`lr` is a register once it has been saved.** The inner mix loop uses it
 *     as the second accumulator word, which is only sound because the routine
 *     pushed it and does not call anything.
 *
 * Sources: GBATEK — *GBA Sound Controller*, *Sound Channel A and B (DMA Sound)*
 * (https://problemkaputt.de/gbatek.htm).
 */

import { GBA_PCM_KOF, GBA_PCM_KON, GBA_PCM_VOICES } from "@demake/chip";
import {
  AsmArm,
  armAsr,
  armAt,
  armAtIdx,
  armAtPost,
  armImm,
  armLsl,
  armLsr,
  armReg,
  label,
  type Ref,
} from "@demake/core";

import { WAVEFORMS } from "../binding/gba-bank.js";

import { REG } from "./arm-player.js";
import { AudioRomError } from "./gb.js";

/** Samples the mixer produces per driver tick, per side. */
export const GBA_BLOCK_SAMPLES = 256;

/**
 * Blocks the sample ring holds.
 *
 * The processor fills a block whenever one has been played, so it runs
 * `RING_BLOCKS − 1` blocks ahead of the converters — and that lead is the whole
 * of what stops a frame the game overran from being heard. Five blocks is 39
 * milliseconds, which covers two frames with room to spare; the cost is the same
 * 39 milliseconds of latency on this half of the sound, which is what every
 * driver on this console pays for mixing in software.
 */
export const GBA_RING_BLOCKS = 6;

/** Bytes one FIFO refill moves: the four words the hardware transfers. */
export const GBA_REFILL_BYTES = 16;

/** Refills that carry one block, which is what the interrupt counts. */
export const GBA_REFILLS_PER_BLOCK = GBA_BLOCK_SAMPLES / GBA_REFILL_BYTES;

/** Bytes one side of the ring occupies. */
export const GBA_RING_BYTES = GBA_BLOCK_SAMPLES * GBA_RING_BLOCKS;

/**
 * Where the sample ring lives: the first bytes of external work RAM.
 *
 * Not the heap, and not because there is no room in it — because the ring is
 * *read by DMA and never by an instruction*, so the only thing it wants is an
 * address the transfer can reach, and this console's 256 KiB of external RAM is
 * otherwise untouched by a build. The accumulator the mixer actually works in
 * stays in internal RAM, where it costs one cycle an access instead of six.
 */
export const GBA_RING_LEFT = 0x02000000;
export const GBA_RING_RIGHT = GBA_RING_LEFT + GBA_RING_BYTES;

/** The I/O page, and the bases the driver holds pieces of it in. */
const IO = 0x04000000;
/** Where the four Game Boy channels answer; a packed port byte is an offset. */
const SOUND_BASE = IO + 0x060;
/** `SOUNDCNT_H` — the sample channels' volumes, timers, enables and resets. */
const SOUNDCNT_H = IO + 0x082;
/** The two direct-sound queues. */
const FIFO_A = IO + 0x0a0;
const FIFO_B = IO + 0x0a4;
/** The DMA block, held as one base so every field is inside a halfword's reach. */
const DMA_BASE = IO + 0x0b0;
const DMA1_SAD = 0x0c;
const DMA1_DAD = 0x10;
const DMA1_CNT_L = 0x14;
const DMA1_CNT_H = 0x16;
const DMA2_SAD = 0x18;
const DMA2_DAD = 0x1c;
const DMA2_CNT_L = 0x20;
const DMA2_CNT_H = 0x22;
/** Timer zero, which clocks both converters. */
const TIMER_BASE = IO + 0x100;
const TM0_RELOAD = 0x00;
const TM0_CONTROL = 0x02;
/** The interrupt enable, and the bit the refill raises. */
const IE_ADDRESS = IO + 0x200;
/** DMA channel one's interrupt, which is the driver's clock. */
export const GBA_AUDIO_IRQ = 0x0200;

/**
 * `SOUNDCNT_H` as the driver leaves it.
 *
 * Channel A is the left output and channel B is the right, both at full volume
 * and both clocked by timer zero — which is what makes the mixer's two sides two
 * converters rather than one signal split. The Game Boy channels sit beside them
 * at their own full ratio; how loud the two halves are *against each other* is a
 * fact about the board and lives in `binding/gba.ts` and `@demake/gba`, not in a
 * register.
 *
 * The two reset bits empty the queues, and they are one-shot rather than state —
 * written once here, and never again.
 */
const SOUND_CONTROL = 0x0002 | 0x000c | 0x0200 | 0x2000 | 0x8800;

/**
 * The reload that makes timer zero the mixer's clock.
 *
 * 16777216 ÷ 512 is 32768 exactly, so the rate has no remainder and the sample
 * clock, the pitch lattice in `binding/gba.ts` and `GbaPcm.clockHz` are three
 * statements of one number rather than three approximations of it.
 */
const TIMER_RELOAD = 0x10000 - 512;

/** `TM0CNT_H`: running, no prescaler, and no interrupt of its own. */
const TIMER_CONTROL = 0x0080;

/**
 * `DMAxCNT_H` for a converter: enabled, repeating, thirty-two bits at a time,
 * into a destination that does not move, on the special timing the FIFOs use.
 */
const DMA_CONTROL = 0x8000 | 0x3000 | 0x0400 | 0x0200 | 0x0040;
/** The same, plus the interrupt that is the driver's whole clock. */
const DMA_CONTROL_IRQ = DMA_CONTROL | 0x4000;

/**
 * Internal work RAM set aside for a copy of the mix routine.
 *
 * **The mixer runs from internal RAM, not from the cartridge**, and on this
 * console that is not a micro-optimisation — it is the difference between a
 * mixer that fits in a frame and one that does not. Every instruction fetched
 * from the cartridge bus costs the wait states `WAITCNT` names (four cycles a
 * word at the setting the boot writes) and every instruction fetched from
 * internal RAM costs none, so an eleven-instruction inner loop run six times per
 * sample is five times more expensive out there. Every real mixer on this
 * machine copies its loop into internal RAM for exactly this reason; measured
 * here, it took a game tick from 1.85 frames to inside one.
 *
 * A fixed reservation rather than the routine's own size, because the memory
 * plan is a constant and the routine is not assembled until long after it: the
 * emitter checks the routine fits and says so by name if it ever stops fitting.
 */
export const GBA_MIX_CODE_BYTES = 640;

/** How far to shift a voice index to reach its record: thirty-two bytes. */
const VOICE_SHIFT = 5;

/** Bytes one voice's mixer state occupies; a power of two, so a lookup shifts. */
export const VOICE_STRIDE = 1 << VOICE_SHIFT;

/** What is in one, as offsets — read here and by the driver's silencing. */
export const VOICE = {
  /** Playback position, 16.16, in samples of the source. */
  position: 0,
  /** How far it advances per output sample, 16.16. */
  step: 4,
  /** Where the waveform's bytes are, resolved when `SRCN` is written. */
  data: 8,
  /** `length << 16`, so the end test is a comparison against the position. */
  limit: 12,
  /** `(length − loop) << 16`, which is what running off the end subtracts. */
  loop: 16,
  left: 20,
  right: 21,
  playing: 22,
  source: 23,
} as const;

/** The same, for this file's own use. */
const V = VOICE;

/** Bytes one waveform's bank entry occupies; a power of two for the same reason. */
export const BANK_ENTRY = 16;

/** Registers inside the mixer's file, per voice — `GbaPcm`'s own numbering. */
const MIX_STRIDE = 8;
const MIX_SRCN = 0;
const MIX_STEP0 = 2;
const MIX_VOLL = 5;
const MIX_VOLR = 6;

/**
 * How a schedule's register number reaches the packed data.
 *
 * One byte, as on every other console, and here it says *which of two devices*
 * as well as which register. The Game Boy channels take the low half — their
 * offset from {@link SOUND_BASE}, which runs to `$3F` — and the mixer takes the
 * high half with bit 6 set, which its thirty-two registers fit inside. So the
 * write loop's dispatch is one `tst` and the common case is an indexed store,
 * which is the Mega Drive's arrangement reached by a console with a different
 * kind of second chip.
 */
export function gbaPort(reg: number, chip: number, address: (reg: number) => number): number {
  if (chip === 0) return (address(reg) - SOUND_BASE) & 0x3f;
  if (reg >= 0x40) {
    throw new AudioRomError(
      "E_INTERNAL",
      `the mixer's register $${reg.toString(16)} does not fit the packed port byte`,
      "this is a bug in the ROM builder, not in the track.",
    );
  }
  return 0x40 | reg;
}

/**
 * One packed write: the device, then the byte out to it.
 *
 * `r0` is the packed port byte and `r1` the value. Bit 6 says which of the two
 * devices it addresses; the Game Boy channels are the fall-through because they
 * are the more common by a wide margin — a tone is four registers a note and a
 * mixer voice is five bytes.
 *
 * Clobbers `r0`, `r1` and `r12` on the Game Boy path, and whatever
 * {@link emitMixWrite} clobbers on the other — never `r4`–`r7`, which the stream
 * player holds a tick's whole state in.
 */
export function emitWrite(asm: AsmArm): void {
  asm.label("AudioWrite");
  asm.tst(REG.a0, armImm(0x40));
  asm.b("AudioMixWrite", "ne");
  asm.ldrConst(REG.addr, SOUND_BASE);
  asm.strb(REG.a1, armAtIdx(REG.addr, REG.a0));
  asm.bx(REG.lr);
  asm.ltorg();
}

/**
 * `GbaPcm.write`, in ARM: `r0` a mixer register, `r1` its value.
 *
 * The model's method is the specification and this is written against it line by
 * line, because the two have to agree about state that is never observable as a
 * register read — a position, a resolved sample pointer, whether a voice is
 * playing at all. Three of its decisions are restated here rather than
 * paraphrased:
 *
 *   - **`KON` is a pulse.** It starts the voices whose bits are set and does
 *     nothing at all to the rest, which is what makes preemption on this half a
 *     mask rather than two shadows folded together — the S-DSP's arrangement,
 *     reached by a mixer this project wrote.
 *   - **A source is resolved when it is written**, not when it is read. That is
 *     equivalent because every write in a schedule happens at a tick boundary
 *     and the block is mixed after them, so no sample is ever produced between a
 *     `SRCN` write and the next read of it — and it turns a bank lookup per
 *     sample into one per note.
 *   - **A source the bank does not have silences the voice.** `sampleOf`
 *     returns nothing for it and `mix` clears `playing` at the next sample; a
 *     `limit` of zero here says the same thing one step earlier.
 */
export function emitMixWrite(asm: AsmArm, voices: number, bank: string, keyOff: boolean): void {
  asm.label("AudioMixWrite");
  asm.bic(REG.a0, REG.a0, armImm(0x40));
  asm.cmp(REG.a0, armImm(GBA_PCM_KON));
  asm.b("AudioKeyOn", "eq");
  if (keyOff) {
    asm.cmp(REG.a0, armImm(GBA_PCM_KOF));
    asm.b("AudioKeyOff", "eq");
  }
  asm.cmp(REG.a0, armImm(GBA_PCM_VOICES * MIX_STRIDE));
  asm.bx(REG.lr, "cs");

  // The voice index is the register's high bits and the field its low three, so
  // the record's address is one shift of the first and a mask of the second. A
  // thirty-two-byte record is what makes that shift a free operand rather than a
  // multiply, which on this core is a real instruction.
  asm.ldrConst(REG.addr, voices);
  asm.mov(REG.a3, armLsr(REG.a0, 3));
  asm.add(REG.addr, REG.addr, armLsl(REG.a3, VOICE_SHIFT));
  asm.and(REG.a2, REG.a0, armImm(MIX_STRIDE - 1));

  asm.cmp(REG.a2, armImm(MIX_SRCN));
  asm.b("AudioMixSource", "eq");
  asm.cmp(REG.a2, armImm(MIX_VOLL));
  asm.strb(REG.a1, armAt(REG.addr, V.left), "eq");
  asm.bx(REG.lr, "eq");
  asm.cmp(REG.a2, armImm(MIX_VOLR));
  asm.strb(REG.a1, armAt(REG.addr, V.right), "eq");
  asm.bx(REG.lr, "eq");

  // The three bytes of the 16.16 step, low first. Predicated rather than
  // dispatched: this architecture has no register-by-register shift in an
  // operand, so three fixed masks cost less than building one.
  asm.sub(REG.a2, REG.a2, armImm(MIX_STEP0));
  asm.cmp(REG.a2, armImm(3));
  asm.bx(REG.lr, "cs");
  asm.ldr(REG.a3, armAt(REG.addr, V.step));
  asm.cmp(REG.a2, armImm(0));
  asm.bic(REG.a3, REG.a3, armImm(0x000000ff), "eq");
  asm.orr(REG.a3, REG.a3, armReg(REG.a1), "eq");
  asm.cmp(REG.a2, armImm(1));
  asm.bic(REG.a3, REG.a3, armImm(0x0000ff00), "eq");
  asm.orr(REG.a3, REG.a3, armLsl(REG.a1, 8), "eq");
  asm.cmp(REG.a2, armImm(2));
  asm.bic(REG.a3, REG.a3, armImm(0x00ff0000), "eq");
  asm.orr(REG.a3, REG.a3, armLsl(REG.a1, 16), "eq");
  asm.str(REG.a3, armAt(REG.addr, V.step));
  asm.bx(REG.lr);

  asm.label("AudioMixSource");
  asm.strb(REG.a1, armAt(REG.addr, V.source));
  asm.cmp(REG.a1, armImm(WAVEFORMS.length));
  asm.mov(REG.a3, armImm(0), "cs");
  asm.str(REG.a3, armAt(REG.addr, V.data), "cs");
  asm.str(REG.a3, armAt(REG.addr, V.limit), "cs");
  asm.str(REG.a3, armAt(REG.addr, V.loop), "cs");
  asm.strb(REG.a3, armAt(REG.addr, V.playing), "cs");
  asm.bx(REG.lr, "cs");
  asm.ldrConst(REG.a0, label(bank));
  asm.add(REG.a0, REG.a0, armLsl(REG.a1, 4));
  asm.ldm(REG.a0, [REG.a1, REG.a2, REG.a3]);
  asm.str(REG.a1, armAt(REG.addr, V.data));
  asm.str(REG.a2, armAt(REG.addr, V.limit));
  asm.str(REG.a3, armAt(REG.addr, V.loop));
  asm.bx(REG.lr);
  asm.ltorg();

  asm.label("AudioKeyOn");
  asm.ldrConst(REG.addr, voices);
  asm.mov(REG.a2, armImm(GBA_PCM_VOICES));
  const konLoop = `AudioKeyOnLoop`;
  asm.label(konLoop);
  asm.tst(REG.a1, armImm(1));
  asm.b("AudioKeyOnNext", "eq");
  asm.mov(REG.a3, armImm(0));
  asm.str(REG.a3, armAt(REG.addr, V.position));
  // A voice whose source the bank does not have is not started at all, which is
  // `sampleOf(voice.source) !== undefined` in the model and a `limit` of zero
  // here.
  asm.ldr(REG.a3, armAt(REG.addr, V.limit));
  asm.cmp(REG.a3, armImm(0));
  asm.mov(REG.a3, armImm(1), "ne");
  asm.strb(REG.a3, armAt(REG.addr, V.playing));
  asm.label("AudioKeyOnNext");
  asm.mov(REG.a1, armLsr(REG.a1, 1));
  asm.add(REG.addr, REG.addr, armImm(VOICE_STRIDE));
  asm.subs(REG.a2, REG.a2, armImm(1));
  asm.b(konLoop, "ne");
  asm.bx(REG.lr);
  asm.ltorg();

  if (keyOff) {
    asm.label("AudioKeyOff");
    asm.ldrConst(REG.addr, voices);
    asm.mov(REG.a2, armImm(GBA_PCM_VOICES));
    const kofLoop = `AudioKeyOffLoop`;
    asm.label(kofLoop);
    asm.tst(REG.a1, armImm(1));
    asm.mov(REG.a3, armImm(0), "ne");
    asm.strb(REG.a3, armAt(REG.addr, V.playing), "ne");
    asm.mov(REG.a1, armLsr(REG.a1, 1));
    asm.add(REG.addr, REG.addr, armImm(VOICE_STRIDE));
    asm.subs(REG.a2, REG.a2, armImm(1));
    asm.b(kofLoop, "ne");
    asm.bx(REG.lr);
    asm.ltorg();
  }
}

/**
 * `GbaPcm.mix`, over a whole block: the sample half's entire contract.
 *
 * What a driver on this console has to reproduce is not a register stream but
 * *the samples themselves*, byte for byte, against what the model renders from
 * the same voice state (doc 16 §The proof, for a mixer console). That is a
 * sharper claim than a register diff, not a weaker one — the comparison is
 * against the audio rather than against an instruction to make it — and it is
 * exact because the mixing is integer throughout:
 *
 *     out = clamp((Σ sample[v] × volume[v]) >> 8, −128, 127)
 *
 * per side, per output sample, with voices accumulated **in index order**. Every
 * line below is one of those operations and nothing below is an approximation of
 * one; the accumulator is a 32-bit word per side per sample precisely so that
 * the sum, the shift and the clamp happen where the model puts them rather than
 * one voice early.
 *
 * The one thing here that is an optimisation rather than a transcription is the
 * **silent voice**: a voice whose two levels are zero contributes `value × 0` to
 * both sides, so its samples need not be read at all — but its position still
 * advances, because where a voice *is* when its level comes back is audible.
 */
export function emitMix(asm: AsmArm, state: { acc: number; voices: number; writeBlock: number }) {
  const words = GBA_BLOCK_SAMPLES * 2;
  asm.label("AudioMix");
  asm.push([4, 5, 6, 7, 8, 9, 10, 11, REG.lr]);

  // --- the accumulator starts empty, eight words at a time.
  asm.ldrConst(REG.addr, state.acc);
  for (const reg of [0, 1, 2, 3, 4, 5, 6, 7]) asm.mov(reg, armImm(0));
  asm.mov(8, armImm(words / 8));
  asm.label("AudioMixClear");
  asm.stm(REG.addr, [0, 1, 2, 3, 4, 5, 6, 7], "ia", true);
  asm.subs(8, 8, armImm(1));
  asm.b("AudioMixClear", "ne");

  // --- every voice that is playing, in index order.
  asm.ldrConst(10, state.voices);
  asm.mov(11, armImm(GBA_PCM_VOICES));
  asm.label("AudioMixVoice");
  asm.ldrb(0, armAt(10, V.playing));
  asm.cmp(0, armImm(0));
  asm.b("AudioMixNext", "eq");
  asm.ldm(10, [0, 1]); // position, step — the two words a silent voice needs
  asm.mov(3, armReg(0));
  asm.mov(4, armReg(1));
  asm.ldr(1, armAt(10, V.limit));
  asm.ldr(2, armAt(10, V.loop));
  asm.ldrb(5, armAt(10, V.left));
  asm.ldrb(6, armAt(10, V.right));
  asm.ldr(0, armAt(10, V.data));
  asm.mov(8, armImm(GBA_BLOCK_SAMPLES));
  asm.orrs(9, 5, armReg(6));
  asm.b("AudioMixQuiet", "eq");
  asm.ldrConst(7, state.acc);

  asm.label("AudioMixSample");
  asm.mov(REG.addr, armLsr(3, 16));
  asm.ldrsb(9, armAtIdx(0, REG.addr));
  asm.ldm(7, [REG.addr, REG.lr]);
  asm.mla(REG.addr, 9, 5, REG.addr);
  asm.mla(REG.lr, 9, 6, REG.lr);
  asm.stm(7, [REG.addr, REG.lr], "ia", true);
  asm.add(3, 3, armReg(4));
  asm.cmp(3, armReg(1));
  asm.sub(3, 3, armReg(2), "cs");
  asm.subs(8, 8, armImm(1));
  asm.b("AudioMixSample", "ne");
  asm.b("AudioMixStore");

  // A voice at zero on both sides adds nothing to either accumulator, so only
  // its position moves — which it must, or a note that comes back after a rest
  // comes back in the wrong place.
  asm.label("AudioMixQuiet");
  asm.add(3, 3, armReg(4));
  asm.cmp(3, armReg(1));
  asm.sub(3, 3, armReg(2), "cs");
  asm.subs(8, 8, armImm(1));
  asm.b("AudioMixQuiet", "ne");

  asm.label("AudioMixStore");
  asm.str(3, armAt(10, V.position));
  asm.label("AudioMixNext");
  asm.add(10, 10, armImm(VOICE_STRIDE));
  asm.subs(11, 11, armImm(1));
  asm.b("AudioMixVoice", "ne");
  // No flush here, deliberately: a pool goes past a return or over a branch, and
  // what follows this one is a *fall-through*. The whole routine is a few hundred
  // bytes, so every pooled load in it reaches the pool at the end.

  // --- the shift, the clamp, and out to the block the converters will read.
  asm.ldrConst(8, state.writeBlock);
  asm.ldrb(0, armAt(8, 0));
  asm.mov(0, armLsl(0, 8));
  asm.ldrConst(10, GBA_RING_LEFT);
  asm.add(10, 10, armReg(0));
  asm.ldrConst(11, GBA_RING_RIGHT);
  asm.add(11, 11, armReg(0));
  asm.ldrConst(7, state.acc);
  asm.mov(8, armImm(GBA_BLOCK_SAMPLES));
  asm.label("AudioMixPack");
  for (const [reg, dest] of [
    [0, 10],
    [1, 11],
  ] as const) {
    asm.ldr(reg, armAtPost(7, 4));
    asm.mov(reg, armAsr(reg, 8));
    asm.cmp(reg, armImm(127));
    asm.mov(reg, armImm(127), "gt");
    asm.cmn(reg, armImm(128));
    asm.mvn(reg, armImm(127), "lt");
    asm.strb(reg, armAtPost(dest, 1));
  }
  asm.subs(8, 8, armImm(1));
  asm.b("AudioMixPack", "ne");
  asm.pop([4, 5, 6, 7, 8, 9, 10, 11, REG.pc]);
  // The pool goes *inside* the copied range, which is what makes the copy legal:
  // every constant this routine loads is PC-relative and every branch it takes is
  // its own, so moving the code and its pool together as one block leaves both
  // correct. A `bl` out of here would not survive the move, and there is none.
  asm.ltorg();
  asm.label("AudioMixEnd");
}

/**
 * Copy the mix routine into internal work RAM, and check it fits.
 *
 * Called once at boot. The size is a build-time fact, so a routine that outgrew
 * its reservation is a build error naming itself rather than a cartridge that
 * copies half a loop and jumps into it.
 */
export function emitMixCopy(asm: AsmArm, dest: number): void {
  // Emitted *after* the routine it copies, so both ends of the range are known
  // here; the boot reaches it as an ordinary forward call.
  const from = asm.addressOf("AudioMix");
  const to = asm.addressOf("AudioMixEnd");
  const bytes = to - from;
  if (bytes > GBA_MIX_CODE_BYTES) {
    throw new AudioRomError(
      "E_INTERNAL",
      `the mix routine is ${bytes} bytes and internal RAM reserves ${GBA_MIX_CODE_BYTES}`,
      "raise `GBA_MIX_CODE_BYTES`; this is a bug in the ROM builder, not in the track.",
    );
  }
  asm.label("AudioMixInstall");
  asm.ldrConst(REG.a0, label("AudioMix") as Ref);
  asm.ldrConst(REG.a1, dest);
  asm.mov(REG.a2, armImm((bytes + 3) >> 2));
  asm.label("AudioMixCopy");
  asm.ldr(REG.a3, armAtPost(REG.a0, 4));
  asm.str(REG.a3, armAtPost(REG.a1, 4));
  asm.subs(REG.a2, REG.a2, armImm(1));
  asm.b("AudioMixCopy", "ne");
  asm.bx(REG.lr);
  asm.ltorg();
}

/**
 * The interrupt the driver's whole clock is: one FIFO refill has completed.
 *
 * Sixteen of them carry one block, so the sixteenth is a block boundary — and
 * counting *transfers* rather than riding a timer is what makes the hand-off
 * exact. At that moment the transfer has read exactly `BLOCK_SAMPLES` bytes and
 * no more, so pointing it at the next block cannot repeat a byte or skip one,
 * whatever the queue happens to be holding and whenever the driver was started.
 * A timer at the same rate would be a fixed number of bytes out of phase with
 * the transfer — deterministic, and impossible to state without knowing how deep
 * the hardware reads ahead.
 *
 * The handler is reached from the game's own interrupt dispatcher, which has
 * been through the BIOS: `r0`–`r3`, `r12` and `lr` are already saved and
 * everything else is somebody's. So this uses exactly those and returns with
 * `bx lr`.
 */
export function emitIrq(
  asm: AsmArm,
  state: { base: number; refill: number; readBlock: number; pending: number },
): void {
  const off = (address: number): number => address - state.base;
  asm.label("AudioIrq");
  asm.ldrConst(REG.a3, state.base);
  asm.ldrb(REG.a0, armAt(REG.a3, off(state.refill)));
  asm.add(REG.a0, REG.a0, armImm(1));
  asm.cmp(REG.a0, armImm(GBA_REFILLS_PER_BLOCK));
  asm.strb(REG.a0, armAt(REG.a3, off(state.refill)), "ne");
  asm.bx(REG.lr, "ne");

  asm.mov(REG.a0, armImm(0));
  asm.strb(REG.a0, armAt(REG.a3, off(state.refill)));
  asm.ldrb(REG.a0, armAt(REG.a3, off(state.readBlock)));
  asm.add(REG.a0, REG.a0, armImm(1));
  asm.cmp(REG.a0, armImm(GBA_RING_BLOCKS));
  asm.mov(REG.a0, armImm(0), "eq");
  asm.strb(REG.a0, armAt(REG.a3, off(state.readBlock)));

  // A block the processor has not refilled yet is a block it owes, and the main
  // loop performs what it owes. The cap is the ring itself: falling further
  // behind than it holds would mean overwriting the block being read, which is
  // worse than losing a tick.
  asm.ldrb(REG.a1, armAt(REG.a3, off(state.pending)));
  asm.cmp(REG.a1, armImm(GBA_RING_BLOCKS - 1));
  asm.add(REG.a1, REG.a1, armImm(1), "cc");
  asm.strb(REG.a1, armAt(REG.a3, off(state.pending)), "cc");

  // Both transfers are re-pointed at the new block, and **both are stopped before
  // either is** — which is the whole of why this is written as three passes
  // rather than two channels in turn.
  //
  // The two are refilled in lockstep, one timer and one threshold apart, which is
  // what lets one channel's interrupts count for both. A timer overflow landing
  // while one of them is disabled and the other is not breaks that: the enabled
  // one refills, the disabled one does not, and at the next block boundary the
  // second has read a refill less than the first — so re-pointing it drops
  // sixteen samples of that side. Stopping both first makes such an overflow miss
  // *both*, and both catch up on the next one, which is a queue sixteen bytes
  // shallower for a moment and not a sample lost. The window is a few dozen
  // cycles of a hundred and thirty thousand, which is exactly the kind of odds
  // that makes a wrong version pass a test and fail a listener.
  asm.mov(REG.a1, armLsl(REG.a0, 8));
  asm.ldrConst(REG.addr, DMA_BASE);
  asm.mov(REG.a0, armImm(0));
  asm.strh(REG.a0, armAt(REG.addr, DMA1_CNT_H));
  asm.strh(REG.a0, armAt(REG.addr, DMA2_CNT_H));

  asm.ldrConst(REG.a2, GBA_RING_LEFT);
  asm.add(REG.a2, REG.a2, armReg(REG.a1));
  asm.str(REG.a2, armAt(REG.addr, DMA1_SAD));
  asm.ldrConst(REG.a2, GBA_RING_RIGHT);
  asm.add(REG.a2, REG.a2, armReg(REG.a1));
  asm.str(REG.a2, armAt(REG.addr, DMA2_SAD));

  emitHalf(asm, REG.a0, DMA_CONTROL_IRQ);
  asm.strh(REG.a0, armAt(REG.addr, DMA1_CNT_H));
  emitHalf(asm, REG.a0, DMA_CONTROL);
  asm.strh(REG.a0, armAt(REG.addr, DMA2_CNT_H));
  asm.bx(REG.lr);
  asm.ltorg();
}

/**
 * Put the sound hardware into the state the driver assumes, and start it.
 *
 * The order is the whole of it: the queues are emptied and routed, the transfers
 * are armed at block zero, and only then does the timer start — so the first
 * overflow finds an empty queue and a live transfer, and the first bytes the
 * converters see are the first bytes of the ring. Starting the timer first would
 * make the first refill land wherever the transfer had got to.
 */
export function emitSoundInit(
  asm: AsmArm,
  state: { base: number; refill: number; readBlock: number; writeBlock: number; pending: number },
): void {
  const off = (address: number): number => address - state.base;

  // The ring is silence to begin with, which is also what gives the processor
  // its lead: every block is already valid, so the first one it fills is the one
  // furthest from being played.
  asm.ldrConst(REG.addr, GBA_RING_LEFT);
  asm.mov(0, armImm(0));
  for (const reg of [1, 2, 3]) asm.mov(reg, armImm(0));
  asm.mov(REG.count, armImm((GBA_RING_BYTES * 2) / 16));
  asm.label("AudioRingClear");
  asm.stm(REG.addr, [0, 1, 2, 3], "ia", true);
  asm.subs(REG.count, REG.count, armImm(1));
  asm.b("AudioRingClear", "ne");

  asm.ldrConst(REG.a3, state.base);
  asm.mov(REG.a0, armImm(0));
  asm.strb(REG.a0, armAt(REG.a3, off(state.refill)));
  asm.strb(REG.a0, armAt(REG.a3, off(state.readBlock)));
  asm.strb(REG.a0, armAt(REG.a3, off(state.pending)));
  asm.mov(REG.a0, armImm(GBA_RING_BLOCKS - 1));
  asm.strb(REG.a0, armAt(REG.a3, off(state.writeBlock)));

  asm.ldrConst(REG.addr, SOUNDCNT_H);
  emitHalf(asm, REG.a0, SOUND_CONTROL);
  asm.strh(REG.a0, armAt(REG.addr, 0));

  asm.ldrConst(REG.addr, DMA_BASE);
  asm.ldrConst(REG.a0, GBA_RING_LEFT);
  asm.str(REG.a0, armAt(REG.addr, DMA1_SAD));
  asm.ldrConst(REG.a0, FIFO_A);
  asm.str(REG.a0, armAt(REG.addr, DMA1_DAD));
  asm.ldrConst(REG.a0, GBA_RING_RIGHT);
  asm.str(REG.a0, armAt(REG.addr, DMA2_SAD));
  asm.ldrConst(REG.a0, FIFO_B);
  asm.str(REG.a0, armAt(REG.addr, DMA2_DAD));
  // The count is four words on this timing, which the hardware forces and the
  // register records; it is written so a reader of the register file sees the
  // same thing the transfer does.
  asm.mov(REG.a0, armImm(4));
  asm.strh(REG.a0, armAt(REG.addr, DMA1_CNT_L));
  asm.strh(REG.a0, armAt(REG.addr, DMA2_CNT_L));
  emitHalf(asm, REG.a0, DMA_CONTROL_IRQ);
  asm.strh(REG.a0, armAt(REG.addr, DMA1_CNT_H));
  emitHalf(asm, REG.a0, DMA_CONTROL);
  asm.strh(REG.a0, armAt(REG.addr, DMA2_CNT_H));

  asm.ldrConst(REG.addr, IE_ADDRESS);
  asm.ldrh(REG.a0, armAt(REG.addr, 0));
  asm.orr(REG.a0, REG.a0, armImm(GBA_AUDIO_IRQ));
  asm.strh(REG.a0, armAt(REG.addr, 0));

  asm.ldrConst(REG.addr, TIMER_BASE);
  emitHalf(asm, REG.a0, TIMER_RELOAD);
  asm.strh(REG.a0, armAt(REG.addr, TM0_RELOAD));
  emitHalf(asm, REG.a0, TIMER_CONTROL);
  asm.strh(REG.a0, armAt(REG.addr, TM0_CONTROL));
}

/** A sixteen-bit constant, in whichever of the two ways the encoding allows. */
function emitHalf(asm: AsmArm, rd: number, value: number): void {
  asm.movImm32(rd, value & 0xffff);
}

/** One immediate write to a Game Boy sound register, for boot and release code. */
export function emitSoundWrite(asm: AsmArm, offset: number, value: number): void {
  asm.ldrConst(REG.addr, SOUND_BASE + offset);
  asm.mov(REG.a0, armImm(value));
  asm.strb(REG.a0, armAt(REG.addr, 0));
}
