/**
 * The Nintendo DS audio driver a *game* embeds (doc 16 §Two streams, one clock).
 *
 * The seventh of these and the second whose driver does not run on the game's
 * processor. A Super Nintendo's sound program is uploaded into a chip's private
 * RAM through four mailbox bytes; this one is simply **the cartridge's other
 * binary**. A `.nds` names two programs and the loader copies both into main RAM
 * before either starts, so the driver needs no handshake, no upload and no boot
 * protocol at all — it is running before the game's first frame, and what it
 * costs the cartridge is bytes rather than bytes *and* a transfer.
 *
 * Four answers are this console's rather than a restatement:
 *
 *   - **The game does not call the driver, and does not have to reach it
 *     either.** Both processors see the same four megabytes, so the two request
 *     bytes are ordinary main RAM the ARM9 stores to and the ARM7 polls. That is
 *     the Super Nintendo's arrangement without the mailbox: a frame the game
 *     overran costs the music no tempo, and asking for a sound is one `strb`.
 *   - **The clock is a hardware tally.** Timer 0 reloads at the driver rate and
 *     timer 1 counts its overflows, so the number of ticks that have happened is
 *     a register rather than a flag somebody has to catch — a tick cannot be
 *     missed by a driver that was busy, and nothing accumulates. No interrupt is
 *     involved anywhere in this cartridge's sound.
 *   - **Nothing is shared, so nothing is merged.** No `NR51`, no `$4015`, no
 *     stereo latch, and no key-on pulse: every register belongs to one channel.
 *     Preemption is therefore only "which channels did the effect take", and the
 *     other fourteen play straight through it.
 *   - **Sixteen channels against a four-bit field.** They do not have to fit, for
 *     the Mega Drive's reason: what the field holds is not "which channel is
 *     this" but "may an effect be using it" (`binding/nds.ts` §ndsPackTag).
 *
 * Sources: GBATEK — *DS Sound Channels*, *DS Timers*, *DS Memory Maps*
 * (https://problemkaputt.de/gbatek.htm).
 */

import { NDS_ARM7_RAM } from "@demake/core";
import { AsmArm, armAt, armAtPost, armImm, armLsl, armReg, label, type Ref } from "@demake/core";

import { bindingFor } from "../binding/registry.js";
import { ndsChannelTag, ndsPackTag } from "../binding/nds.js";
import { NDS_CH, NDS_CHANNEL_STRIDE, NDS_SPU_CHANNELS } from "@demake/chip";
import type { ChipScript, Rational } from "../chipscript.js";

import { emitStream, emitStreamData, type ArmStreamState } from "./arm-player.js";
import type { DriverData } from "./data.js";
import { AudioRomError } from "./gb.js";
import type { GameEffect } from "./gb-game.js";
import {
  emitBankCopy,
  emitBankData,
  emitClockStart,
  emitMainLoop,
  emitSoundWrite,
  emitWrite,
  ndsPort,
  NDS_SPU_BASE,
  NDS_STACK_TOP,
  NDS_STATE_BASE,
} from "./nds-driver.js";
import {
  clampByte,
  MAX_PENDING,
  NO_SHADOW,
  pack,
  rateHz,
  restrict,
  shadowBias,
  shadowPlan,
  shapeOf,
  stripBoot,
  type ShadowPlan,
} from "./shared.js";

/** The value that stops the music, rather than starting a track. */
export const NDS_STOP = 0xff;

/** Bytes one table entry occupies, in both tables; a power of two, so a shift. */
const ENTRY_SHIFT = 3;

/**
 * Channels a game's effects may be spread over.
 *
 * The packed run format's channel nibble, and the same four the Mega Drive gets.
 * The sound demaker places one pitched gesture and one noise gesture, so this has
 * never been close — it is refused by name rather than truncated, because a
 * truncation would be an effect that silently could not preempt.
 */
const MAX_STEAL_CHANNELS = 4;

/** Main-RAM bytes the game sets aside for the two request bytes. */
export const NDS_AUDIO_BYTES = 4;

/** What the game hands the driver builder. */
export interface NdsGameAudioInput {
  /** One schedule per track, in the order the game refers to them. */
  tracks: readonly ChipScript[];
  /** One per effect, likewise. */
  effects: readonly GameEffect[];
  /**
   * First main-RAM byte the ARM9 set aside for the request block.
   *
   * The one thing the two processors share, and it is deliberately the smallest
   * thing they could: {@link NDS_AUDIO_BYTES} bytes, written by one and read by
   * the other. Everything else the driver owns lives in the ARM7's private work
   * RAM, where the game cannot reach it.
   */
  state: number;
}

/** Sizes and reductions, reported rather than assumed. */
export interface NdsGameAudioStats {
  /** Driver code bytes. */
  code: number;
  /** Packed schedule bytes, tables and the waveform bank included. */
  data: number;
  /** The whole second binary, which is what it costs the cartridge. */
  image: number;
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
  /** Writes dropped because an effect may only touch the channel it took. */
  writesRestricted: number;
}

/** A built game driver: the second binary, and what it will really play. */
export interface NdsGameAudio {
  /** The ARM7's whole program — driver, tables, bank and packed schedules. */
  image: Uint8Array;
  /** Where the cartridge loads it, and where it starts executing. */
  address: number;
  /** Main-RAM bytes the game writes to ask for something. */
  request: {
    /** `1..n` starts a track; {@link NDS_STOP} stops the music. */
    music: number;
    /** `1..n` fires an effect. */
    sfx: number;
  };
  /** The tick rate the sound processor really runs at, and its timer divisor. */
  clock: { rate: Rational; divisor: number };
  /** Every label, so a harness can watch a routine by program counter. */
  symbols: ReadonlyMap<string, number>;
  /**
   * The schedules as the ARM7 will really perform them.
   *
   * Not the same objects that went in: the chip's initialisation happens once at
   * boot rather than at the head of every stream, and an effect is restricted to
   * the channel it borrowed (doc 16 §The proof).
   */
  performed: { tracks: readonly ChipScript[]; effects: readonly ChipScript[] };
  stats: NdsGameAudioStats;
}

/** Build the sound processor's whole program, for a game. */
export function buildNdsGameAudio(input: NdsGameAudioInput): NdsGameAudio {
  const scripts = [...input.tracks, ...input.effects.map((effect) => effect.script)];
  if (scripts.length === 0) {
    throw new AudioRomError("E_NO_AUDIO", "this game has no audio to build");
  }

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
  const clock = resolveNdsClock(first);

  const binding = bindingFor(first.console);
  const boot = binding.init();

  // Preemption machinery exists only when there is something to preempt: a game
  // with music and no effects packs the flat format, exactly as a standalone
  // schedule that owns the chip would.
  const shared = input.tracks.length > 0 && input.effects.length > 0;
  const stealable = [...new Set(input.effects.map((effect) => effect.channel))].sort(
    (a, b) => a - b,
  );
  if (stealable.length > MAX_STEAL_CHANNELS) {
    throw new AudioRomError(
      "E_TOO_MANY_EFFECT_CHANNELS",
      `this game's effects are spread over ${stealable.length} channels and the packed run format numbers ${MAX_STEAL_CHANNELS}`,
      "the sound demaker places an effect on one pitched channel and one noise channel; this is a bug in the build, not in the effects.",
    );
  }
  const channelOf = ndsPackTag(stealable);
  const packOptions = shared ? { channelOf, port: ndsPort } : { port: ndsPort };

  let restricted = 0;
  const tracks = input.tracks.map((script) => stripBoot(script, boot));
  const effects = input.effects.map((effect) => {
    // The *binding's* tag rather than the packed one, because restriction is a
    // question about the whole chip: an effect's opening tick states every
    // channel it is not using as well, and those writes would stop the music's
    // bass each time the effect fired.
    const result = restrict(stripBoot(effect.script, boot), 1 << effect.channel, ndsChannelTag());
    restricted += result.dropped;
    return result.script;
  });

  const musicData = tracks.map((script) => pack(script, packOptions));
  const effectData = effects.map((script) =>
    pack(script, { ...packOptions, end: "stop" as const }),
  );

  // What the music has to remember so a borrowed channel comes back holding the
  // music's own note rather than the effect's last one (`shared.ts`). The tag and
  // the port are the packer's, because the run walk tests the bits the packed
  // data carries and indexes the copy by the byte it holds.
  const shadow = shared
    ? shadowPlan(tracks, (1 << stealable.length) - 1, channelOf, boot, (reg) => ndsPort(reg))
    : NO_SHADOW;
  const state = layout(input.state, shadow.bytes);
  const helpers: string[] = [];

  const asm = new AsmArm(NDS_ARM7_RAM);
  const codeStart = asm.pc;
  emitBoot(asm, state, boot, clock, input);
  emitMainLoop(asm, { tally: state.tally, base: state.base }, MAX_PENDING);
  emitTick(asm, state, input);
  if (input.tracks.length > 0) {
    emitMusicStart(asm, state, input);
    helpers.push(
      ...emitStream(asm, {
        prefix: "AudioMus",
        state: state.music,
        data: shapeOf(musicData),
        base: state.base,
        ...(shadow.bytes > 0
          ? {
              shadow: {
                channels: shadow.channels.map((channel) => ({
                  bit: channel.channel,
                  base: state.shadow + shadowBias(channel),
                })),
              },
            }
          : {}),
        ...(shared ? { steal: state.steal } : {}),
      }).map((name) => `music-${name}`),
    );
  }
  if (input.effects.length > 0) {
    emitSfxStart(asm, state, input);
    emitRelease(asm, state, stealable, shadow);
    helpers.push(
      ...emitStream(asm, {
        prefix: "AudioSfx",
        state: state.sfx,
        data: shapeOf(effectData),
        base: state.base,
        onEnd: "AudioSfxRelease",
      }).map((name) => `sfx-${name}`),
    );
  }
  if (input.tracks.length > 0) emitSilence(asm);
  emitWrite(asm);
  helpers.push("hardware-tally");
  const code = asm.pc - codeStart;

  const dataStart = asm.pc;
  emitTables(asm, input, stealable, musicData, effectData);
  emitBankData(asm, "AudioBankBytes");
  for (let index = 0; index < musicData.length; index += 1) {
    emitStreamData(asm, "AudioMus", index, musicData[index] as DriverData);
  }
  for (let index = 0; index < effectData.length; index += 1) {
    emitStreamData(asm, "AudioSfx", index, effectData[index] as DriverData);
  }
  const data = asm.pc - dataStart;
  const image = asm.assemble();

  const all = [...musicData, ...effectData];
  return {
    image,
    address: NDS_ARM7_RAM,
    request: { music: state.musicReq, sfx: state.sfxReq },
    clock,
    symbols: asm.symbols(),
    performed: { tracks, effects },
    stats: {
      code,
      data,
      image: image.length,
      tracks: tracks.length,
      effects: effects.length,
      blocks: all.reduce((sum, one) => sum + one.blocks.length, 0),
      blocksSaved: all.reduce((sum, one) => sum + one.blocksSaved, 0),
      helpers,
      rate: clock.rate,
      writesRestricted: restricted,
    },
  };
}

/**
 * Check a schedule's clock is one this driver can keep, and take its divisor.
 *
 * The rate came from `ndsBinding.fitRate`, which enumerates the ARM7's own
 * prescaler and reload — so what is checked here is that nothing downstream
 * replaced it with a frame rate, which would be a driver programming a timer from
 * a number that never described one.
 */
export function resolveNdsClock(script: ChipScript): { rate: Rational; divisor: number } {
  const { rate, source, divisor } = script.driver;
  if (source !== "timer" || divisor === undefined) {
    throw new AudioRomError(
      "E_DRIVER_CLOCK",
      `this schedule is clocked by '${source}' and this driver programmes a timer`,
      "the ARM7 has four timers and nothing else to spend them on; this is a bug in the timing fit, not in the track.",
    );
  }
  return { rate, divisor };
}

// --- state -------------------------------------------------------------------

/** Where the driver keeps everything, and which memory each part is in. */
interface Layout {
  /** The ARM7's private work RAM, which every field but the requests is in. */
  base: number;
  music: ArmStreamState;
  sfx: ArmStreamState;
  /** First byte of the music's copy of the borrowable channels. */
  shadow: number;
  /** Channels an effect has taken. */
  steal: number;
  /** Priority of the effect playing, for the one that wants to interrupt it. */
  priority: number;
  /** Ticks the driver has performed, against the hardware's own tally. */
  tally: number;
  /** One past the last byte of work RAM used. */
  end: number;
  /** The game's two request bytes, which are in main RAM. */
  musicReq: number;
  sfxReq: number;
}

/**
 * The words first, then the halfword, then the bytes.
 *
 * Not a style choice: an unaligned `ldr` *rotates* on this core rather than
 * faulting, so a stream pointer read from an odd address is a wrong pointer and
 * not a crash.
 */
function layout(requests: number, shadowBytes: number): Layout {
  let at = NDS_STATE_BASE;
  const word = (): number => {
    const address = at;
    at += 4;
    return address;
  };
  const half = (): number => {
    const address = at;
    at += 2;
    return address;
  };
  const byte = (): number => {
    const address = at;
    at += 1;
    return address;
  };
  const musicData = word();
  const musicOrder = word();
  const musicLoop = word();
  // A sound effect stops rather than looping, so it needs no loop entry.
  const sfxData = word();
  const sfxOrder = word();
  const tally = half();
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
  const priority = byte();
  const shadow = at;
  at += shadowBytes;
  return {
    base: NDS_STATE_BASE,
    music,
    sfx,
    shadow,
    steal,
    priority,
    tally,
    end: at,
    musicReq: requests,
    sfxReq: requests + 1,
  };
}

/** A field of the driver's own state, as an offset from a base register. */
function off(state: Layout, address: number): number {
  return address - state.base;
}

// --- code --------------------------------------------------------------------

/**
 * Everything that happens once: the stack, the bank, the driver's state, the
 * chip, and the clock.
 *
 * The order matters twice. The chip is initialised *before* the timers start, so
 * the first tick finds a chip in the state every schedule was packed against; and
 * the bank is copied before the chip is told where it is, though nothing would
 * notice the other way round since no channel is started until a note arrives.
 */
function emitBoot(
  asm: AsmArm,
  state: Layout,
  boot: readonly { reg: number; value: number }[],
  clock: { divisor: number },
  input: NdsGameAudioInput,
): void {
  asm.label("Reset");
  asm.ldrConst(13, NDS_STACK_TOP);
  emitBankCopy(asm, "AudioBankBytes");

  // The driver's own state, in the memory only this processor can see. The
  // request bytes are **not** cleared here, and that is the one ordering fact in
  // this whole hand-off: they are the game's own heap, the game's boot zeroes it,
  // and the game's boot zeroes it *before* it posts the entry scene's track. A
  // driver that helpfully cleared them too would be racing the other processor
  // for the right to erase a request it had already made — which is a game that
  // sometimes opens in silence, on a machine fast enough that it never does so
  // while anybody is looking.
  asm.ldrConst(REG_A0, state.base);
  asm.mov(REG_A1, armImm(0));
  asm.mov(REG_A2, armImm((state.end - state.base + 3) >> 2));
  asm.label("AudioClearState");
  asm.str(REG_A1, armAtPost(REG_A0, 4));
  asm.subs(REG_A2, REG_A2, armImm(1));
  asm.b("AudioClearState", "ne");

  for (const write of boot) emitSoundWrite(asm, write.reg, write.value);
  void input;
  emitClockStart(asm, clock.divisor);
  asm.b("AudioMain");
  asm.ltorg();
}

/** Scratch registers, named locally so the boot reads like the rest. */
const REG_A0 = 0;
const REG_A1 = 1;
const REG_A2 = 2;

/**
 * One driver tick: take what the game asked for, then step each stream.
 *
 * Requests are single bytes rather than pointers because the *other processor*
 * writes them, with no lock and no acknowledgement. One byte is written
 * atomically; a pointer and a length are not, and the tick that arrived between
 * them would play half of one effect and half of another.
 */
function emitTick(asm: AsmArm, state: Layout, input: NdsGameAudioInput): void {
  asm.label("AudioTick");
  asm.push([14]);
  if (input.tracks.length > 0) {
    asm.ldrConst(12, state.musicReq);
    asm.ldrb(0, armAt(12, 0));
    asm.cmp(0, armImm(0));
    asm.bl("AudioMusicStart", "ne");
  }
  if (input.effects.length > 0) {
    asm.ldrConst(12, state.sfxReq);
    asm.ldrb(0, armAt(12, 0));
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

/** Point `r2` at table entry `r0 − 1`. */
function emitEntry(asm: AsmArm, table: string): void {
  asm.sub(0, 0, armImm(1));
  asm.ldrConst(2, label(table) as Ref);
  asm.add(2, 2, armLsl(0, ENTRY_SHIFT));
}

/** Start the requested track, or stop the music. */
function emitMusicStart(asm: AsmArm, state: Layout, input: NdsGameAudioInput): void {
  asm.label("AudioMusicStart");
  asm.push([4, 5, 14]);
  asm.mov(4, armReg(0)); // the request, until the table lookup
  asm.ldrConst(5, state.musicReq);
  asm.mov(0, armImm(0));
  asm.strb(0, armAt(5, 0));
  asm.ldrConst(5, state.base);

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
  asm.cmp(4, armImm(NDS_STOP));
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
function emitSfxStart(asm: AsmArm, state: Layout, input: NdsGameAudioInput): void {
  asm.label("AudioSfxStart");
  asm.push([4, 5, 14]);
  asm.ldrConst(5, state.sfxReq);
  asm.mov(1, armImm(0));
  asm.strb(1, armAt(5, 0));
  emitEntry(asm, "AudioEffects");
  asm.mov(4, armReg(2)); // the entry, across the release
  asm.ldrConst(5, state.base);

  if (input.effects.length > 1) {
    // Priority only means anything when two effects can collide.
    asm.ldrb(0, armAt(5, off(state, state.sfx.active as number)));
    asm.cmp(0, armImm(0));
    asm.b("AudioSfxTake", "eq");
    // The entry is `order` (a word), then the channel mask, then the priority.
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
 * The channel is stopped rather than left holding the effect's last note, and the
 * music picks it up again at its own next one. Restoring what the music *would*
 * have been playing would mean shadowing every register of every channel to hide
 * a gap of at most a few ticks — the trade every driver here rejects.
 *
 * Clobbers `r0`–`r3` and `r12` only: `AudioMusicStart` holds the track it was
 * asked for in `r4` across this call and `AudioSfxStart` holds a table pointer
 * there.
 */
function emitRelease(
  asm: AsmArm,
  state: Layout,
  stealable: readonly number[],
  plan: ShadowPlan,
): void {
  asm.label("AudioSfxRelease");
  asm.ldrConst(3, state.base);
  asm.ldrb(1, armAt(3, off(state, state.steal)));
  asm.cmp(1, armImm(0));
  asm.bx(14, "eq");
  for (let index = 0; index < stealable.length; index += 1) {
    const skip = `AudioRelease${index}`;
    asm.tst(1, armImm(1 << index));
    asm.b(skip, "eq");
    const copy = plan.channels.find((one) => one.channel === 1 << index);
    if (copy) {
      // Ascending register order, so the byte carrying the start bit — which is
      // the whole of a note's existence here — is written last. `r1` is the steal
      // mask and `r3` the state base, both live across it.
      for (const write of copy.writes) {
        asm.ldrConst(2, state.shadow);
        asm.ldrb(0, armAt(2, write.slot));
        asm.ldrConst(12, NDS_SPU_BASE + write.port);
        asm.strb(0, armAt(12, 0));
      }
    } else {
      emitSoundWrite(asm, (stealable[index] as number) * NDS_CHANNEL_STRIDE + NDS_CH.control, 0);
    }
    asm.label(skip);
  }
  asm.ldrConst(3, state.base);
  asm.mov(0, armImm(0));
  asm.strb(0, armAt(3, off(state, state.steal)));
  asm.strb(0, armAt(3, off(state, state.sfx.active as number)));
  asm.bx(14);
  asm.ltorg();
}

/**
 * Stop every channel — what stopping the music means.
 *
 * One byte a channel, because the start bit is the whole of a note's existence
 * here: a stopped channel is not advancing through a waveform, so nothing is left
 * to come back at a random phase when the next scene keys it.
 */
function emitSilence(asm: AsmArm): void {
  asm.label("AudioSilence");
  asm.ldrConst(12, NDS_SPU_BASE + NDS_CH.control);
  asm.mov(0, armImm(0));
  asm.mov(2, armImm(NDS_SPU_CHANNELS));
  asm.label("AudioSilenceChannel");
  asm.strb(0, armAt(12, 0));
  asm.add(12, 12, armImm(NDS_CHANNEL_STRIDE));
  asm.subs(2, 2, armImm(1));
  asm.b("AudioSilenceChannel", "ne");
  asm.bx(14);
  asm.ltorg();
}

/** The two tables a request is looked up in. */
function emitTables(
  asm: AsmArm,
  input: NdsGameAudioInput,
  stealable: readonly number[],
  musicData: readonly DriverData[],
  effectData: readonly DriverData[],
): void {
  asm.align();
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
      const effect = input.effects[index] as GameEffect;
      asm.dw(label(`AudioSfxOrder${index}`) as Ref);
      // The *packed* channel bit rather than the console's channel number: what
      // the driver skips a run for is a bit of the run header, and the header
      // numbers the stealable channels (`binding/nds.ts` §ndsPackTag).
      asm.db(1 << stealable.indexOf(effect.channel));
      asm.db(clampByte(effect.priority));
      asm.dh(0); // padding to one shifted entry
    }
  }
}
