/**
 * The Game Boy Advance audio driver a *game* embeds (doc 16 §Two streams, one
 * clock).
 *
 * The sixth of these, and the first whose console's second device is not a chip
 * at all. Four voices are a Game Boy's APU and reach it as ordinary stores; the
 * other six are a **software mixer**, which means this driver does not only
 * perform a schedule, it *computes an output* — and the contract survives
 * restated one level up (doc 16 §The proof, for a mixer console): what has to be
 * reproduced on that half is the samples themselves, byte for byte, against what
 * `@demake/chip`'s `GbaPcm` renders.
 *
 * Four answers are this console's rather than a restatement:
 *
 *   - **The clock is the transfer, not a timer.** A block of 256 samples is
 *     sixteen FIFO refills, so the sixteenth refill's interrupt *is* a block
 *     boundary — the driver counts transfers and owes itself a tick. That is
 *     exact where a timer at the same rate would not be: a timer runs a fixed
 *     number of bytes out of phase with a transfer that reads ahead, and the
 *     phase depends on how deep the hardware's queue is. It also makes the rate
 *     128 Hz exactly, because 32768 ÷ 256 has no remainder — the Super
 *     Nintendo's argument for 125 Hz, reached by different hardware.
 *   - **The tick is the main loop's, and the mixing with it.** The interrupt
 *     counts and re-points the two transfers and does nothing else; a mix inside
 *     it would be twenty thousand cycles with interrupts masked, which is two
 *     refills the handler would never see. So the frame-clocked consoles'
 *     `AudioService` shape returns here for a reason of this console's own.
 *   - **An effect only ever borrows a Game Boy channel**, because that is where
 *     the sound demaker places one: a pitched gesture on the first pulse and a
 *     noise gesture on the noise channel, both of them this chip's. So the
 *     preemption machinery is the Game Boy's unchanged — four channel bits, a
 *     steal mask, `NR51` merged and never stored — and the mixer's six voices
 *     tag no channel at all and play *through* an effect. That is refused rather
 *     than assumed: an effect placed on a mixer voice is a build error naming
 *     itself.
 *   - **`NR51` is the only shared byte on the whole board.** The mixer's levels
 *     are per voice and its `KON` is a pulse, so there is one merge here and not
 *     two.
 *
 * Sources: GBATEK — *GBA Sound Controller*, *Sound Channel A and B (DMA Sound)*
 * (https://problemkaputt.de/gbatek.htm); Pan Docs — *Audio Registers*.
 */

import { GBA_PCM_RATE_HZ, GBA_PCM_KOF, GBA_PCM_VOICES } from "@demake/chip";
import {
  AsmArm,
  armAt,
  armAtPost,
  armImm,
  armLsl,
  armReg,
  gbaSoundAddress,
  label,
  type Ref,
} from "@demake/core";

import { bindingFor } from "../binding/registry.js";
import { bankBytes, sampleBank } from "../binding/gba-bank.js";
import { gbaChannelTag, GBA_APU_CHANNELS } from "../binding/gba.js";
import type { ChipScript, Rational } from "../chipscript.js";

import type { DriverData } from "./data.js";
import { AudioRomError } from "./gb.js";
import { gbChannelOf, type GameEffect } from "./gb-game.js";
import { emitStream, emitStreamData, type ArmStreamState } from "./arm-player.js";
import {
  emitIrq,
  emitMix,
  emitMixCopy,
  emitMixWrite,
  emitSoundInit,
  emitSoundWrite,
  emitWrite,
  gbaPort,
  GBA_AUDIO_IRQ,
  GBA_BLOCK_SAMPLES,
  GBA_MIX_CODE_BYTES,
  GBA_RING_BLOCKS,
  VOICE,
  VOICE_STRIDE,
} from "./gba-driver.js";
import { clampByte, pack, rateHz, restrict, shapeOf, stripBoot } from "./shared.js";

/** The value that stops the music, rather than starting a track. */
export const STOP = 0xff;

/** Bytes one table entry occupies, in both tables; a power of two, so a shift. */
const ENTRY_SHIFT = 3;

/** `NR51`, as the offset a packed port byte carries. */
const NR51 = 0x25;
const NR51_PORT = gbaSoundAddress(NR51) - (0x04000000 + 0x060);

/** Note-off for one Game Boy channel: the register that powers its DAC down. */
const CHANNEL_OFF = [0x12, 0x17, 0x1a, 0x21] as const;

/** What the game hands the driver builder. */
export interface GbaGameAudioInput {
  /** One schedule per track, in the order the game refers to them. */
  tracks: readonly ChipScript[];
  /** One per effect, likewise. */
  effects: readonly GameEffect[];
  /** First work-RAM byte the driver may use; it needs {@link GBA_AUDIO_BYTES}. */
  state: number;
}

/**
 * Work-RAM bytes the driver's state occupies.
 *
 * Counted from the allocator rather than written down, so the two cannot drift.
 * Most of it is the **mixing accumulator** — a 32-bit word per side per sample of
 * a block — and it is in internal RAM rather than beside the ring in external
 * RAM because the mix loop touches it four times a sample: one cycle an access
 * here against six over a sixteen-bit bus with two wait states, which is the
 * difference between the mixer costing a tenth of the processor and costing a
 * third of it.
 */
export const GBA_AUDIO_BYTES = layout(0).end;

/** Sizes and reductions, reported rather than assumed. */
export interface GbaGameAudioStats {
  /** Driver code bytes. */
  code: number;
  /** Packed schedule bytes, tables and the waveform bank included. */
  data: number;
  tracks: number;
  effects: number;
  /** Distinct blocks across every stream, after dedup. */
  blocks: number;
  /** Blocks the dedup collapsed. */
  blocksSaved: number;
  /** Driver routines this game actually pulled in. */
  helpers: readonly string[];
  /** The tick rate the ROM really runs at. */
  rate: Rational;
  /** Writes dropped because an effect may only touch the channel it takes. */
  writesRestricted: number;
}

/** A built game driver: what to emit, where, and what it will really play. */
export interface GbaGameAudio {
  /**
   * How the game must drive it.
   *
   * No `ticksPerFrame` and no reload to programme: this driver's clock is the
   * sample transfer's own completion count, which the hardware produces whether
   * the game's frame arrived on time or not. What the game owes it is the
   * interrupt and a call from the main loop.
   */
  clock: { rate: Rational; interrupt: number };
  /**
   * The two routines the game's own code has to call.
   *
   * `irq` goes in the interrupt dispatcher, under the transfer's own bit, and
   * does nothing but count and re-point; `service` goes in the main loop and
   * performs whatever blocks have been counted. The split is the whole of this
   * console's clock discipline — see the file header.
   *
   * `irq` clobbers `r0`–`r3` and `r12` only, which is exactly what the BIOS
   * dispatcher has already saved. `service` clobbers everything the ABI allows.
   */
  routines: { irq: string; service: string };
  /** Work-RAM bytes the game writes to ask for something. */
  request: {
    /** `1..n` starts a track; {@link STOP} stops the music. */
    music: number;
    /** `1..n` fires an effect. */
    sfx: number;
  };
  /** Emit `AudioInit`, `AudioTick` and everything they pull in. */
  emitCode(asm: AsmArm): void;
  /** Emit the tables, the waveform bank and the packed streams. */
  emitData(asm: AsmArm): void;
  /**
   * The schedules as the ROM will really perform them.
   *
   * Not the same objects that went in: the hardware's initialisation is
   * performed once at boot rather than at the head of every stream, and an
   * effect is restricted to the channel it borrowed.
   */
  performed: { tracks: readonly ChipScript[]; effects: readonly ChipScript[] };
  stats: GbaGameAudioStats;
}

/** Build the driver a game embeds. */
export function buildGbaGameAudio(input: GbaGameAudioInput): GbaGameAudio {
  const scripts = [...input.tracks, ...input.effects.map((effect) => effect.script)];
  if (scripts.length === 0)
    throw new AudioRomError("E_NO_AUDIO", "this game has no audio to build");

  // One clock produces one rate, so a game whose streams disagree about it
  // cannot be built — and that is a builder bug, not something to average out.
  const first = scripts[0] as ChipScript;
  for (const script of scripts) {
    if (
      script.driver.rate.num * first.driver.rate.den !==
      first.driver.rate.num * script.driver.rate.den
    ) {
      throw new AudioRomError(
        "E_DRIVER_RATE",
        `this game's audio streams ask for ${rateHz(first.driver.rate)} Hz and ${rateHz(script.driver.rate)} Hz`,
        "music and effects share one clock, so they must be fitted to one rate; this is a bug in the build, not in the source.",
      );
    }
  }
  const clock = resolveGbaClock(first);

  // An effect on a mixer voice would need the preemption machinery to reach a
  // device that has no shared register and no channel numbering in the packed
  // run format. The sound demaker never places one there — a gesture is pitched
  // or it is noise, and both of those are Game Boy channels on this console — so
  // this is a gap named rather than a case half-written (AGENTS.md §Iron rules).
  for (const effect of input.effects) {
    if (effect.channel >= GBA_APU_CHANNELS) {
      throw new AudioRomError(
        "E_TOO_MANY_EFFECT_CHANNELS",
        `this game places an effect on mixer voice ${effect.channel - GBA_APU_CHANNELS + 1} and the driver only lends the four Game Boy channels`,
        "the sound demaker places an effect on the first pulse or on the noise channel; this is a bug in the build, not in the effects.",
      );
    }
  }

  const binding = bindingFor(first.console);
  const boot = binding.init();
  const address = (reg: number): number => gbaSoundAddress(reg);
  const port = (reg: number, chip: number): number => gbaPort(reg, chip, address);

  // Preemption machinery exists only when there is something to preempt: a game
  // with music and no effects packs the flat format and stores `NR51` outright,
  // exactly as a cartridge that owns the hardware does.
  const shared = input.tracks.length > 0 && input.effects.length > 0;
  // The four Game Boy channels number themselves and the mixer's six tag zero,
  // which the run format reads as "belongs to no channel" and therefore never
  // preempts. That is the right answer rather than a truncation: what preemption
  // asks is whether an *effect* may be using a voice, and no effect ever is.
  const channelOf = (): ((reg: number, value: number, chip: number) => number) => {
    return (reg, _value, chip) => (chip === 0 ? gbChannelOf(reg) : 0);
  };
  // `mergeChip` and not only `mergeRegs`, because a register number does not
  // identify a register on this board: `$25` is the Game Boy channels' panning
  // byte and the mixer's fifth voice's right level, and folding the second into
  // the first is the music's stereo image replaced by a volume.
  const packOptions = shared
    ? { channelOf, mergeRegs: new Set([NR51]), mergeChip: 0, port }
    : { port };

  let restricted = 0;
  const tracks = input.tracks.map((script) => stripBoot(script, boot));
  const effects = input.effects.map((effect) => {
    const owned = 1 << effect.channel;
    // The *binding's* tag rather than the packer's, because restriction is about
    // the whole console: a write to a mixer voice belongs to that voice, and an
    // effect that kept it would silence the music's bass while it played.
    const result = restrict(stripBoot(effect.script, boot), owned, gbaChannelTag());
    restricted += result.dropped;
    return result.script;
  });

  const musicData = tracks.map((script) => pack(script, packOptions));
  const effectData = effects.map((script) =>
    pack(script, { ...packOptions, end: "stop" as const }),
  );

  const state = layout(input.state);
  const stealable = input.effects.reduce((bits, effect) => bits | (1 << effect.channel), 0);
  // `KOF` is a second way to say what a level of zero already says, and the
  // binding never emits it — so the driver only grows the path if a schedule
  // really carries one.
  const keyOff = [...tracks, ...effects].some((script) =>
    script.ticks.some((tick) =>
      tick.writes.some((write) => (write.chip ?? 0) === 1 && write.reg === GBA_PCM_KOF),
    ),
  );

  const helpers: string[] = [];
  let code = 0;
  let data = 0;

  const emitCode = (asm: AsmArm): void => {
    const start = asm.pc;
    emitInit(asm, state, boot, port);
    emitService(asm, state);
    emitTick(asm, state, input);
    if (input.tracks.length > 0) {
      emitMusicStart(asm, state, input);
      helpers.push(
        ...emitStream(asm, {
          prefix: "AudioMus",
          state: state.music,
          data: shapeOf(musicData),
          base: state.base,
          ...(shared ? { steal: state.steal, merge: "AudioMusPan" } : {}),
        }).map((name) => `music-${name}`),
      );
    }
    if (input.effects.length > 0) {
      emitSfxStart(asm, state, input);
      emitRelease(asm, state, stealable, shared);
      helpers.push(
        ...emitStream(asm, {
          prefix: "AudioSfx",
          state: state.sfx,
          data: shapeOf(effectData),
          base: state.base,
          onEnd: "AudioSfxRelease",
          ...(shared ? { merge: "AudioSfxPan" } : {}),
        }).map((name) => `sfx-${name}`),
      );
    }
    if (input.tracks.length > 0) emitSilence(asm, state);
    if (shared) {
      emitPan(asm, state);
      helpers.push("panning-merge");
    }
    emitWrite(asm);
    emitMixWrite(asm, state.voices, "AudioBank", keyOff);
    if (keyOff) helpers.push("mixer-key-off");
    emitMix(asm, { acc: state.acc, voices: state.voices, writeBlock: state.writeBlock });
    // After the routine, because it measures what it is copying.
    emitMixCopy(asm, state.mixCode);
    emitIrq(asm, {
      base: state.base,
      refill: state.refill,
      readBlock: state.readBlock,
      pending: state.pending,
    });
    helpers.push("mixer", "mixer-in-work-ram", "transfer-clock");
    code = asm.pc - start;
  };

  const emitData = (asm: AsmArm): void => {
    asm.align();
    const start = asm.pc;
    if (input.tracks.length > 0) {
      asm.label("AudioTracks");
      for (let index = 0; index < musicData.length; index += 1) {
        const track = musicData[index] as DriverData;
        asm.dw(label(`AudioMusOrder${index}`) as Ref);
        asm.dw(label(`AudioMusOrder${index}`, track.loopOrderIndex * 4) as Ref);
      }
    }
    if (input.effects.length > 0) {
      asm.label("AudioEffects");
      for (let index = 0; index < effectData.length; index += 1) {
        asm.dw(label(`AudioSfxOrder${index}`) as Ref);
        asm.db(1 << (input.effects[index] as GameEffect).channel);
        asm.db(clampByte((input.effects[index] as GameEffect).priority));
        asm.dh(0); // padding to one shifted entry
      }
    }
    emitBank(asm);
    for (let index = 0; index < musicData.length; index += 1) {
      emitStreamData(asm, "AudioMus", index, musicData[index] as DriverData);
    }
    for (let index = 0; index < effectData.length; index += 1) {
      emitStreamData(asm, "AudioSfx", index, effectData[index] as DriverData);
    }
    data = asm.pc - start;
  };

  const all = [...musicData, ...effectData];
  return {
    clock: { rate: clock.rate, interrupt: clock.interrupt },
    routines: { irq: "AudioIrq", service: "AudioService" },
    request: { music: state.musicReq, sfx: state.sfxReq },
    emitCode,
    emitData,
    performed: { tracks, effects },
    get stats(): GbaGameAudioStats {
      return {
        code,
        data,
        tracks: tracks.length,
        effects: effects.length,
        blocks: all.reduce((sum, one) => sum + one.blocks.length, 0),
        blocksSaved: all.reduce((sum, one) => sum + one.blocksSaved, 0),
        helpers,
        rate: clock.rate,
        writesRestricted: restricted,
      };
    },
  };
}

/**
 * Resolve a schedule's driver clock to the block the mixer produces per tick.
 *
 * The rate is not negotiable on this console and that is the point: a driver
 * tick *is* a block of samples, so the rate is the sample rate divided by the
 * block, and a fit that landed anywhere else would be a schedule the mixer could
 * not deliver in whole blocks. 32768 ÷ 256 is 128 exactly, which is why
 * `gameDriverRate` names it rather than taking the general answer.
 */
export function resolveGbaClock(script: ChipScript): { rate: Rational; interrupt: number } {
  const { rate } = script.driver;
  const samples = (GBA_PCM_RATE_HZ * rate.den) / rate.num;
  if (samples !== GBA_BLOCK_SAMPLES) {
    throw new AudioRomError(
      "E_DRIVER_CLOCK",
      `${rateHz(rate)} Hz is ${samples} mixer samples a tick and this driver's block is ${GBA_BLOCK_SAMPLES}`,
      "a tick on this console is one block of samples; this is a bug in the timing fit, not in the track.",
    );
  }
  // Channel one's transfer interrupt: the driver's whole clock, and the bit the
  // game has to route to `AudioIrq`.
  return { rate, interrupt: GBA_AUDIO_IRQ };
}

// --- state -------------------------------------------------------------------

/** Where the driver keeps everything, laid out from the game's first free byte. */
interface Layout {
  base: number;
  music: ArmStreamState;
  sfx: ArmStreamState;
  /** Channels an effect has taken. */
  steal: number;
  /** Each stream's intended `NR51`, which the merge folds together. */
  panMusic: number;
  panSfx: number;
  /** Priority of the effect playing, for the one that wants to interrupt it. */
  priority: number;
  musicReq: number;
  sfxReq: number;
  /** Refills counted since the last block boundary. */
  refill: number;
  /** Which ring block the converters are reading. */
  readBlock: number;
  /** Which one the processor fills next. */
  writeBlock: number;
  /** Blocks counted by the interrupt that the main loop has not mixed yet. */
  pending: number;
  /** The mixer's six voice records. */
  voices: number;
  /** The 32-bit stereo accumulator one block is summed in. */
  acc: number;
  /** Where the mix routine is copied to, so it runs out of internal RAM. */
  mixCode: number;
  /** One past the last byte used. */
  end: number;
}

/**
 * The words first, then the bytes, then the two aligned blocks.
 *
 * Not a style choice: an unaligned `ldr` *rotates* on this core rather than
 * faulting, so a stream pointer read from an odd address is a wrong pointer and
 * not a crash. The allocator aligns the base to four; everything wider than a
 * byte is placed before anything narrower, and the two blocks are re-aligned
 * after the byte fields.
 */
function layout(base: number): Layout {
  let at = base;
  const word = (): number => {
    const address = at;
    at += 4;
    return address;
  };
  const byte = (): number => {
    const address = at;
    at += 1;
    return address;
  };
  const align = (): void => {
    at = (at + 3) & ~3;
  };
  const musicData = word();
  const musicOrder = word();
  const musicLoop = word();
  // A sound effect stops rather than looping, so it needs no loop entry.
  const sfxData = word();
  const sfxOrder = word();
  const music: ArmStreamState = {
    data: musicData,
    order: musicOrder,
    loop: musicLoop,
    rest: byte(),
    active: byte(),
  };
  const sfx: ArmStreamState = {
    data: sfxData,
    order: sfxOrder,
    rest: byte(),
    active: byte(),
  };
  const steal = byte();
  const panMusic = byte();
  const panSfx = byte();
  const priority = byte();
  const musicReq = byte();
  const sfxReq = byte();
  const refill = byte();
  const readBlock = byte();
  const writeBlock = byte();
  const pending = byte();
  align();
  const voices = at;
  at += GBA_PCM_VOICES * VOICE_STRIDE;
  const acc = at;
  at += GBA_BLOCK_SAMPLES * 2 * 4;
  // The mix routine itself, because on this console an instruction fetched from
  // the cartridge costs four cycles and one fetched from here costs none
  // (`gba-driver.ts` §GBA_MIX_CODE_BYTES).
  const mixCode = at;
  at += GBA_MIX_CODE_BYTES;
  return {
    base,
    music,
    sfx,
    steal,
    panMusic,
    panSfx,
    priority,
    musicReq,
    sfxReq,
    refill,
    readBlock,
    writeBlock,
    pending,
    voices,
    acc,
    mixCode,
    end: at,
  };
}

/** A field of the driver's state, as an offset from a base register. */
function off(state: Layout, address: number): number {
  return address - state.base;
}

// --- code --------------------------------------------------------------------

/**
 * Put the hardware in a known state, clear the driver's own, and start the
 * converters.
 *
 * The mixer's own initialisation goes through `AudioWrite` rather than being
 * open-coded: what a silent voice *is* is the binding's answer (a source, and a
 * level of zero on each side), and a second statement of it here would be the
 * one that quietly grew a wrong entry.
 */
function emitInit(
  asm: AsmArm,
  state: Layout,
  boot: readonly { reg: number; value: number; chip?: number }[],
  port: (reg: number, chip: number) => number,
): void {
  asm.label("AudioInit");
  asm.push([4, 5, 14]);

  asm.ldrConst(12, state.voices);
  asm.mov(0, armImm(0));
  for (const reg of [1, 2, 3]) asm.mov(reg, armImm(0));
  asm.mov(5, armImm((GBA_PCM_VOICES * VOICE_STRIDE) / 16));
  asm.label("AudioInitVoices");
  asm.stm(12, [0, 1, 2, 3], "ia", true);
  asm.subs(5, 5, armImm(1));
  asm.b("AudioInitVoices", "ne");

  asm.ldrConst(4, state.base);
  asm.mov(0, armImm(0));
  for (const byte of [
    state.music.active as number,
    state.sfx.active as number,
    state.music.rest,
    state.sfx.rest,
    state.steal,
    state.panSfx,
    state.priority,
    state.musicReq,
    state.sfxReq,
  ]) {
    asm.strb(0, armAt(4, off(state, byte)));
  }
  // The music's shadow starts at what the boot writes left in `NR51`, so the
  // first merge folds against the truth rather than against zero.
  const panning = boot.find((write) => write.reg === NR51 && (write.chip ?? 0) === 0);
  asm.mov(0, armImm(panning?.value ?? 0xff));
  asm.strb(0, armAt(4, off(state, state.panMusic)));

  for (const write of boot) {
    if ((write.chip ?? 0) === 0) {
      emitSoundWrite(asm, port(write.reg, 0) & 0x3f, write.value);
      continue;
    }
    asm.mov(0, armImm(port(write.reg, 1)));
    asm.mov(1, armImm(write.value));
    asm.bl("AudioWrite");
  }

  // The mixer into internal work RAM before anything can call it, which is
  // before the transfers start below.
  asm.bl("AudioMixInstall");
  emitSoundInit(asm, {
    base: state.base,
    refill: state.refill,
    readBlock: state.readBlock,
    writeBlock: state.writeBlock,
    pending: state.pending,
  });
  asm.pop([4, 5, 15]);
  asm.ltorg();
}

/**
 * Perform the blocks the transfer has counted: a schedule tick and a mix each.
 *
 * From the main loop rather than from the interrupt, for the reason the file
 * header gives — mixing with interrupts masked would cost the handler the very
 * refills it counts. A block the game was too slow to reach is a block of stale
 * ring, which is why the interrupt caps what it will count at the ring's own
 * length: falling further behind than the ring holds would mean writing the
 * block being read.
 */
function emitService(asm: AsmArm, state: Layout): void {
  asm.label("AudioService");
  asm.push([14]);
  asm.label("AudioServiceLoop");
  asm.ldrConst(12, state.base);
  asm.ldrb(0, armAt(12, off(state, state.pending)));
  asm.cmp(0, armImm(0));
  asm.b("AudioServiceDone", "eq");
  asm.sub(0, 0, armImm(1));
  asm.strb(0, armAt(12, off(state, state.pending)));
  asm.bl("AudioTick");
  // Into the copy in internal work RAM rather than the one in the cartridge:
  // same instructions, a fifth of the fetch cost. `mov lr, pc` lands the return
  // on the instruction after the `bx`, which is why the two are adjacent.
  asm.ldrConst(12, state.mixCode);
  asm.mov(14, armReg(15));
  asm.bx(12);
  asm.ldrConst(12, state.base);
  asm.ldrb(0, armAt(12, off(state, state.writeBlock)));
  asm.add(0, 0, armImm(1));
  asm.cmp(0, armImm(GBA_RING_BLOCKS));
  asm.mov(0, armImm(0), "eq");
  asm.strb(0, armAt(12, off(state, state.writeBlock)));
  asm.b("AudioServiceLoop");
  asm.label("AudioServiceDone");
  asm.pop([15]);
  asm.ltorg();
}

/**
 * One driver tick: take what the game asked for, then step each stream.
 *
 * Requests are single bytes rather than pointers because a rule writes them from
 * the game's own loop. One byte is written atomically; a pointer and a length are
 * not, and the tick that arrived between them would play half of one effect and
 * half of another.
 */
function emitTick(asm: AsmArm, state: Layout, input: GbaGameAudioInput): void {
  asm.label("AudioTick");
  asm.push([14]);
  if (input.tracks.length > 0) {
    asm.ldrConst(12, state.base);
    asm.ldrb(0, armAt(12, off(state, state.musicReq)));
    asm.cmp(0, armImm(0));
    asm.bl("AudioMusicStart", "ne");
  }
  if (input.effects.length > 0) {
    asm.ldrConst(12, state.base);
    asm.ldrb(0, armAt(12, off(state, state.sfxReq)));
    asm.cmp(0, armImm(0));
    asm.bl("AudioSfxStart", "ne");
  }
  if (input.tracks.length > 0) asm.bl("AudioMusTick");
  // Effects step after the music, so on a tick where both write the same register
  // the effect is the one the hardware is left holding.
  if (input.effects.length > 0) asm.bl("AudioSfxTick");
  asm.pop([15]);
  asm.ltorg();
}

/**
 * Point `r2` at table entry `r0 − 1`, and leave the request cleared.
 *
 * The index is widened by nothing and shifted by three, which is why both tables
 * pad to eight bytes an entry: a multiply on this architecture is a real
 * instruction and a shifted operand is free.
 */
function emitEntry(asm: AsmArm, table: string): void {
  asm.sub(0, 0, armImm(1));
  asm.ldrConst(2, label(table) as Ref);
  asm.add(2, 2, armLsl(0, ENTRY_SHIFT));
}

/** Start the requested track, or stop the music. */
function emitMusicStart(asm: AsmArm, state: Layout, input: GbaGameAudioInput): void {
  asm.label("AudioMusicStart");
  asm.push([4, 5, 14]);
  asm.ldrConst(5, state.base);
  asm.mov(4, armReg(0)); // the request, until the table lookup
  asm.mov(0, armImm(0));
  asm.strb(0, armAt(5, off(state, state.musicReq)));

  // A scene change stops whatever was playing, effect included: the sound of the
  // old scene carrying into the new one is a bug in every game that has it.
  // Nothing playing means nothing to stop, and skipping the silencing there is
  // what makes the first track's first tick exactly the schedule's first tick.
  asm.ldrb(0, armAt(5, off(state, state.music.active as number)));
  if (input.effects.length > 0) {
    asm.ldrb(1, armAt(5, off(state, state.sfx.active as number)));
    asm.orr(0, 0, armReg(1));
  }
  asm.cmp(0, armImm(0));
  asm.b("AudioMusicFresh", "eq");
  asm.mov(0, armImm(0));
  asm.strb(0, armAt(5, off(state, state.music.active as number)));
  if (input.effects.length > 0) asm.bl("AudioSfxRelease");
  asm.bl("AudioSilence");

  asm.label("AudioMusicFresh");
  asm.cmp(4, armImm(STOP));
  asm.b("AudioMusicDone", "eq");

  asm.mov(0, armReg(4));
  emitEntry(asm, "AudioTracks");
  asm.ldrConst(5, state.base);
  asm.ldr(0, armAtPost(2, 4));
  asm.str(0, armAt(5, off(state, state.music.order)));
  asm.ldr(0, armAtPost(2, 4));
  asm.str(0, armAt(5, off(state, state.music.loop as number)));
  asm.mov(0, armImm(0));
  asm.strb(0, armAt(5, off(state, state.music.rest)));
  asm.bl("AudioMusNextBlock");
  asm.ldrConst(5, state.base);
  asm.mov(0, armImm(1));
  asm.strb(0, armAt(5, off(state, state.music.active as number)));
  asm.label("AudioMusicDone");
  asm.pop([4, 5, 15]);
  asm.ltorg();
}

/** Fire the requested effect, unless the one playing outranks it. */
function emitSfxStart(asm: AsmArm, state: Layout, input: GbaGameAudioInput): void {
  asm.label("AudioSfxStart");
  asm.push([4, 5, 14]);
  asm.ldrConst(5, state.base);
  asm.mov(1, armImm(0));
  asm.strb(1, armAt(5, off(state, state.sfxReq)));
  emitEntry(asm, "AudioEffects");
  asm.mov(4, armReg(2)); // the entry, across the release

  if (input.effects.length > 1) {
    // Priority only means anything when two effects can collide.
    asm.ldrb(0, armAt(5, off(state, state.sfx.active as number)));
    asm.cmp(0, armImm(0));
    asm.b("AudioSfxTake", "eq");
    // The entry is `order` (a word), then the channel, then the priority.
    asm.ldrb(0, armAt(4, 5));
    asm.ldrb(1, armAt(5, off(state, state.priority)));
    asm.cmp(1, armReg(0));
    // What is playing ranks at least as high: the new one is dropped.
    asm.b("AudioSfxDone", "cs");
    asm.label("AudioSfxTake");
  }

  asm.mov(0, armImm(0));
  asm.strb(0, armAt(5, off(state, state.sfx.active as number)));
  asm.bl("AudioSfxRelease");
  asm.ldrConst(5, state.base);
  asm.ldr(0, armAt(4, 0));
  asm.str(0, armAt(5, off(state, state.sfx.order)));
  asm.ldrb(0, armAt(4, 4));
  asm.strb(0, armAt(5, off(state, state.steal)));
  asm.ldrb(0, armAt(4, 5));
  asm.strb(0, armAt(5, off(state, state.priority)));
  asm.mov(0, armImm(0));
  asm.strb(0, armAt(5, off(state, state.sfx.rest)));
  asm.bl("AudioSfxNextBlock");
  asm.ldrConst(5, state.base);
  asm.mov(0, armImm(1));
  asm.strb(0, armAt(5, off(state, state.sfx.active as number)));
  asm.label("AudioSfxDone");
  asm.pop([4, 5, 15]);
  asm.ltorg();
}

/**
 * Give back the channels an effect borrowed.
 *
 * The channel is silenced rather than left holding the effect's last register
 * values, and the music picks it up again at its next note. Restoring what the
 * music *would* have been playing would mean keeping a shadow of every register
 * on every channel, to hide a gap of at most a few ticks — the trade every
 * driver here rejects.
 *
 * Clobbers `r0`–`r3` and `r12` only: `AudioMusicStart` holds the track it was
 * asked for in `r4` across this call and `AudioSfxStart` holds a table pointer
 * there, and a scene change that happened while an effect was playing would
 * otherwise start whichever track a scratch register happened to name.
 */
function emitRelease(asm: AsmArm, state: Layout, stealable: number, shared: boolean): void {
  asm.label("AudioSfxRelease");
  asm.ldrConst(3, state.base);
  asm.ldrb(1, armAt(3, off(state, state.steal)));
  asm.cmp(1, armImm(0));
  asm.bx(14, "eq");
  for (let channel = 0; channel < CHANNEL_OFF.length; channel += 1) {
    if ((stealable & (1 << channel)) === 0) continue;
    const skip = `AudioRelease${channel}`;
    asm.tst(1, armImm(1 << channel));
    asm.b(skip, "eq");
    emitSoundWrite(asm, gbaSoundAddress(CHANNEL_OFF[channel] as number) - 0x04000060, 0);
    asm.label(skip);
  }
  asm.ldrConst(3, state.base);
  asm.mov(0, armImm(0));
  asm.strb(0, armAt(3, off(state, state.steal)));
  asm.strb(0, armAt(3, off(state, state.sfx.active as number)));
  if (shared) {
    asm.strb(0, armAt(3, off(state, state.panSfx)));
    asm.b("AudioPan");
  } else {
    asm.bx(14);
  }
  asm.ltorg();
}

/**
 * Turn every voice off — what stopping the music means.
 *
 * Both devices, because both are playing: the Game Boy channels lose their DACs
 * and the mixer's voices lose their levels *and* their playback, which is the
 * one thing a level of zero does not say. A voice left running under a silent
 * level would come back at whatever phase it had reached the moment the next
 * scene keyed it.
 */
function emitSilence(asm: AsmArm, state: Layout): void {
  asm.label("AudioSilence");
  for (const reg of CHANNEL_OFF) {
    emitSoundWrite(asm, gbaSoundAddress(reg) - 0x04000060, 0);
  }
  asm.ldrConst(12, state.voices);
  asm.mov(0, armImm(0));
  asm.mov(2, armImm(GBA_PCM_VOICES));
  asm.label("AudioSilenceVoice");
  asm.strb(0, armAt(12, VOICE.left));
  asm.strb(0, armAt(12, VOICE.right));
  asm.strb(0, armAt(12, VOICE.playing));
  asm.add(12, 12, armImm(VOICE_STRIDE));
  asm.subs(2, 2, armImm(1));
  asm.b("AudioSilenceVoice", "ne");
  asm.bx(14);
  asm.ltorg();
}

/**
 * Fold the two panning shadows under the steal mask and write `NR51`.
 *
 * One byte carries every Game Boy channel's panning twice — left and right, four
 * bits apart — which is why the steal mask is one nibble and the fold shifts it
 * into both halves. With nothing preempting, the byte the chip receives is
 * exactly the one the schedule asked for, and that is what the whole proof rests
 * on.
 *
 * Clobbers `r0`–`r2` and `r12` only: the run walk that calls it holds a tick's
 * whole state in `r4`–`r7`.
 */
function emitPan(asm: AsmArm, state: Layout): void {
  asm.label("AudioMusPan");
  asm.ldrConst(12, state.base);
  asm.strb(1, armAt(12, off(state, state.panMusic)));
  asm.b("AudioPan");

  asm.label("AudioSfxPan");
  asm.ldrConst(12, state.base);
  asm.strb(1, armAt(12, off(state, state.panSfx)));

  asm.label("AudioPan");
  asm.ldrConst(12, state.base);
  asm.ldrb(0, armAt(12, off(state, state.steal)));
  asm.orr(0, 0, armLsl(0, 4));
  asm.and(0, 0, armImm(0xff)); // the stolen channels, in NR51's layout
  asm.ldrb(1, armAt(12, off(state, state.panSfx)));
  asm.and(1, 1, armReg(0));
  asm.ldrb(2, armAt(12, off(state, state.panMusic)));
  asm.bic(2, 2, armReg(0));
  asm.orr(1, 1, armReg(2));
  emitSoundWriteReg(asm, NR51_PORT, 1);
  asm.bx(14);
  asm.ltorg();
}

/** Store a register that is already in `rd` to a Game Boy sound register. */
function emitSoundWriteReg(asm: AsmArm, offset: number, rd: number): void {
  asm.ldrConst(12, 0x04000060 + offset);
  asm.strb(rd, armAt(12, 0));
}

/**
 * The waveform bank: the table the mixer resolves a source through, and the
 * bytes it plays.
 *
 * One definition with two readers, exactly as the Super Nintendo's is
 * (`binding/sdsp-bank.ts`): `binding/gba-bank.ts` decides what is in it and how
 * long each waveform is, the binding puts an index in a voice's `SRCN`, and this
 * lays the same bytes in the cartridge. A second copy of either number is a game
 * whose bass plays the snare.
 *
 * Each entry is the pointer, `length << 16` and `(length − loop) << 16` — the
 * two forms the mix loop actually compares against, computed here so the inner
 * loop is a comparison and a subtraction rather than two shifts.
 */
function emitBank(asm: AsmArm): void {
  const bank = sampleBank();
  const { bytes, offsets } = bankBytes();
  for (const sample of bank) {
    if (sample.loop !== null) continue;
    {
      // Every built-in waveform loops (`gba-bank.ts` §the bank), so the mix loop
      // has no one-shot path at all. A bank that grew one would need it, and this
      // is where that would be found rather than in a wrong note.
      throw new AudioRomError(
        "E_INTERNAL",
        "the mixer's waveform bank has a one-shot sample and the driver's mix loop only loops",
        "this is a bug in the ROM builder, not in the track.",
      );
    }
  }
  asm.align();
  asm.label("AudioBank");
  for (const [index, sample] of bank.entries()) {
    asm.dw(label("AudioBankBytes", offsets[index] as number) as Ref);
    asm.dw(sample.data.length << 16);
    asm.dw((sample.data.length - (sample.loop ?? 0)) << 16);
    asm.dw(0); // padding to a shifted entry, so the lookup is one instruction
  }
  asm.label("AudioBankBytes");
  asm.bytes(bytes);
  asm.align();
}
