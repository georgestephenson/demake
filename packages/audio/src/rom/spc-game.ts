/**
 * The S-DSP audio driver a *game* embeds (doc 16 §Two streams, one clock).
 *
 * `gb-game.ts`, `nes-game.ts` and `sms-game.ts` a fourth console over, answering
 * the same three questions — who owns a voice right now, what a shared register
 * does, and where the tick comes from. On this machine all three answers are new,
 * and all three are the same fact restated: **the driver is not on the console's
 * processor at all.**
 *
 *   - **The clock is the sound processor's own timer.** Not the picture's
 *     interrupt, which is what the NES and the Sega 8-bits are stuck with, and
 *     not a timer the game has to share with anything: an 8 kHz prescaler and an
 *     eight-bit divisor, so 125 Hz is exact and the game never counts a frame.
 *   - **The shared register is a *pulse*.** `KON` starts the voices whose bits
 *     are set and does nothing to the rest, so two streams do not have to fold
 *     shadows the way `NR51` and `$4015` force — the driver masks the value down
 *     to the voices the stream still owns, which is one `and`. Every other
 *     register on this chip belongs to exactly one voice.
 *   - **The game does not call the driver.** It posts two request bytes and a
 *     sequence byte through the mailbox and carries on; the driver notices,
 *     acknowledges, and performs the schedule on its own clock. A frame the game
 *     overruns costs it nothing, which is the one thing this console's sound
 *     hardware gives away for free.
 *
 * What it costs is a **boot upload**: the driver, its tables and its schedules
 * all live in the sound processor's RAM, so they are cartridge bytes *and* they
 * have to be handed over four at a time before the game starts. `image` is that
 * block, and the 65816 side of the handshake is the game backend's.
 */

import { Asm700, A, X, Y, label, spcAbsX, spcDp, spcImm } from "@demake/core";

import { bindingFor } from "../binding/registry.js";
import { ARAM_DIR, waveformBank } from "../binding/sdsp-bank.js";
import { NOISE_VOICE, SDSP_MERGE_REGS, sdspChannelTag } from "../binding/sdsp.js";
import type { ChipScript, Rational } from "../chipscript.js";

import { packScript, PackError, type DriverData } from "./data.js";
import { AudioRomError } from "./gb.js";
import type { GameEffect } from "./gb-game.js";
import {
  emitSilence,
  emitStream,
  emitStreamData,
  streamState,
  type SpcScratch,
  type SpcStreamState,
} from "./spc-driver.js";

/** The value that stops the music, rather than starting a track. */
export const STOP = 0xff;

/** Where the uploaded block starts: the sample directory is its first byte. */
export const SPC_IMAGE_BASE = ARAM_DIR;

/** Where the driver's code is assembled, above the waveform bank. */
export const SPC_CODE_BASE = 0x0300;

/** Which mailbox port carries what, in both directions. */
export const SPC_PORT = {
  /** The game bumps it to say "there is a request"; the driver echoes it back. */
  sequence: 0,
  /** `1..n` starts a track; {@link STOP} stops the music; `0` means nothing. */
  music: 1,
  /** `1..n` fires an effect; `0` means nothing. */
  sfx: 2,
} as const;

/** The sound side sees the mailbox at `$F4`–`$F7`. */
const MAILBOX = 0xf4;

/** Direct-page addresses. Page zero is the only page an SPC700 addresses cheaply. */
const DP = {
  seq: 0x02,
  steal: 0x03,
  sfxGain: 0x04,
  sfxPrio: 0x05,
  owed: 0x06,
  count: 0x07,
  flags: 0x08,
  mask: 0x09,
  music: 0x10,
  sfx: 0x19,
} as const;

const SCRATCH: SpcScratch = { count: DP.count, flags: DP.flags, mask: DP.mask };
const MUSIC: SpcStreamState = streamState(DP.music);
const SFX: SpcStreamState = streamState(DP.sfx);

/** What the game hands the driver builder. */
export interface SpcGameAudioInput {
  /** One schedule per track, in the order the game refers to them. */
  tracks: readonly ChipScript[];
  /** One per effect, likewise. */
  effects: readonly GameEffect[];
  /**
   * Start this track (1-based) as soon as the driver boots.
   *
   * A game posts a request when a scene opens, so it does not need this. A
   * standalone `.spc` has no game to post one, and the file is the driver's
   * whole world — so the boot code ends by asking for the track itself.
   */
  autoStart?: number;
}

/** Sizes and reductions, reported rather than assumed. */
export interface SpcGameAudioStats {
  /** Driver code bytes, in the sound processor's RAM. */
  code: number;
  /** Packed schedule bytes, tables and the waveform bank included. */
  data: number;
  /** The whole uploaded block, which is what it costs the cartridge. */
  image: number;
  tracks: number;
  effects: number;
  blocks: number;
  blocksSaved: number;
  helpers: readonly string[];
  rate: Rational;
  /** Writes dropped because an effect may only touch the voice it takes. */
  writesRestricted: number;
}

/** A built game driver: the block to upload, and what it will really play. */
export interface SpcGameAudio {
  /** The bytes the cartridge hands to the sound processor at boot. */
  image: Uint8Array;
  /** Where they go in its 64 KiB. */
  address: number;
  /** Where it starts executing once they are all there. */
  entry: number;
  /** Which mailbox port carries which request. */
  ports: typeof SPC_PORT;
  /** The tick rate the sound processor really runs at, and its timer divisor. */
  clock: { rate: Rational; divisor: number };
  /** Every label, so a harness can watch a routine by program counter. */
  symbols: ReadonlyMap<string, number>;
  /**
   * The schedules as the sound processor will really perform them.
   *
   * Not the same objects that went in: the chip's initialisation happens once at
   * boot rather than at the head of every stream, and an effect is restricted to
   * the voice it borrowed. Both are stated here so the conformance harness diffs
   * against what the driver actually promises (doc 16 §The proof).
   */
  performed: { tracks: readonly ChipScript[]; effects: readonly ChipScript[] };
  stats: SpcGameAudioStats;
}

/** Build the sound processor's whole program, for a game. */
export function buildSpcGameAudio(input: SpcGameAudioInput): SpcGameAudio {
  const scripts = [...input.tracks, ...input.effects.map((effect) => effect.script)];
  if (scripts.length === 0) {
    throw new AudioRomError("E_NO_AUDIO", "this game has no audio to build");
  }

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

  const clock = resolveSpcClock(first);
  const binding = bindingFor(first.console);
  const boot = binding.init();

  // Preemption machinery exists only when there is something to preempt, exactly
  // as on the other three consoles.
  const shared = input.tracks.length > 0 && input.effects.length > 0;
  const packOptions = shared
    ? {
        channelOf: sdspChannelTag,
        mergeRegs: SDSP_MERGE_REGS,
        // Eight voices, so the run header's channel mask is a byte of its own.
        channels: binding.spec.channels.length,
      }
    : {};

  let restricted = 0;
  const tracks = input.tracks.map((script) => stripBoot(script, boot));
  const effects = input.effects.map((effect) => {
    const result = restrict(stripBoot(effect.script, boot), 1 << effect.channel);
    restricted += result.dropped;
    return result.script;
  });

  const musicData = tracks.map((script) => pack(script, packOptions));
  const effectData = effects.map((script) =>
    pack(script, { ...packOptions, end: "stop" as const }),
  );

  const helpers: string[] = [];
  const asm = new Asm700(SPC_CODE_BASE);
  const codeStart = asm.pc;

  emitBoot(asm, boot.length, clock.divisor, input.tracks.length > 0, input.autoStart);
  emitMain(asm, input);
  if (input.tracks.length > 0) {
    emitMusicCommand(asm);
    helpers.push(
      ...emitStream(asm, {
        prefix: "AudioMus",
        state: MUSIC,
        scratch: SCRATCH,
        data: shapeOf(musicData),
      }).map((name) => `music-${name}`),
    );
    emitSilence(asm, "AudioSilence");
    helpers.push("silence");
  }
  if (input.effects.length > 0) {
    emitSfxStart(asm, input.tracks.length > 0);
    emitRelease(asm, input.tracks.length > 0);
    helpers.push(
      ...emitStream(asm, {
        prefix: "AudioSfx",
        state: SFX,
        scratch: SCRATCH,
        data: shapeOf(effectData),
        onEnd: "AudioSfxRelease",
      }).map((name) => `sfx-${name}`),
    );
    helpers.push("release");
  }
  const code = asm.pc - codeStart;

  // --- tables and packed streams ---------------------------------------------
  asm.label("AudioBoot");
  for (const write of boot) asm.db(write.reg & 0xff, write.value & 0xff);
  if (input.tracks.length > 0) {
    asm.label("AudioTracks");
    for (let index = 0; index < musicData.length; index += 1) {
      asm.dw(`AudioMusOrder${index}`);
      asm.dw(label(`AudioMusOrder${index}`, (musicData[index] as DriverData).loopOrderIndex * 2));
    }
  }
  if (input.effects.length > 0) {
    asm.label("AudioEffects");
    for (let index = 0; index < effectData.length; index += 1) {
      const effect = input.effects[index] as GameEffect;
      asm.dw(`AudioSfxOrder${index}`);
      asm.db(1 << effect.channel);
      // The voice's `GAIN` register, so releasing it is two instructions and no
      // arithmetic: the effect's channel is known here and never at run time.
      asm.db(((effect.channel & 0x07) << 4) | 0x07);
      asm.db(clampByte(effect.priority));
    }
  }
  for (let index = 0; index < musicData.length; index += 1) {
    emitStreamData(asm, "AudioMus", index, musicData[index] as DriverData);
  }
  for (let index = 0; index < effectData.length; index += 1) {
    emitStreamData(asm, "AudioSfx", index, effectData[index] as DriverData);
  }

  const program = asm.assemble();
  const bank = waveformBank();
  const image = new Uint8Array(SPC_CODE_BASE - SPC_IMAGE_BASE + program.length);
  image.set(bank, 0);
  image.set(program, SPC_CODE_BASE - SPC_IMAGE_BASE);

  const all = [...musicData, ...effectData];
  return {
    image,
    address: SPC_IMAGE_BASE,
    entry: SPC_CODE_BASE,
    ports: SPC_PORT,
    clock,
    symbols: asm.symbols(),
    performed: { tracks, effects },
    stats: {
      code,
      data: program.length - code + bank.length,
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
 * Resolve a schedule's driver clock to the timer divisor that produces it.
 *
 * The divisor is carried on the schedule rather than re-derived, on the rule
 * doc 16 states for exactly this: a ROM programs a register, and computing one
 * back from a rational would be a second timing fit that could disagree with the
 * first.
 */
export function resolveSpcClock(script: ChipScript): SpcGameAudio["clock"] {
  const { rate, source, divisor } = script.driver;
  if (source !== "spc-timer" || divisor === undefined) {
    throw new AudioRomError(
      "E_DRIVER_CLOCK",
      `the snes driver has no '${source}' clock`,
      "the sound processor has three timers of its own, so a game's driver runs on one of them; re-arrange with `spc-timer`.",
    );
  }
  return { rate, divisor: divisor & 0xff };
}

// --- the driver's own code ---------------------------------------------------

/**
 * Boot: initialise the chip once, then start the timer.
 *
 * The initialisation is a table walked by a loop rather than a hundred inline
 * writes, because it is forty-odd register pairs and a loop is a sixth of the
 * bytes. It runs *once*: an effect that re-ran it would silence the music every
 * time it fired, which is why `stripBoot` takes it off the head of every stream.
 */
function emitBoot(
  asm: Asm700,
  bootWrites: number,
  divisor: number,
  hasMusic: boolean,
  autoStart: number | undefined,
): void {
  asm.label("AudioBootCode");
  // Timers off and the mailbox left alone. Bit 7 keeps the boot ROM mapped: the
  // window is RAM nothing here uses either way, and leaving it is one less thing
  // changing under a reader.
  asm.mov(spcDp(0xf1), spcImm(0x80));
  asm.mov(X, spcImm(0x00));
  asm.label("AudioBootLoop");
  asm.mov(A, spcAbsX("AudioBoot"));
  asm.mov(spcDp(0xf2), A);
  asm.inc(X);
  asm.mov(A, spcAbsX("AudioBoot"));
  asm.mov(spcDp(0xf3), A);
  asm.inc(X);
  asm.cmp(X, spcImm((bootWrites * 2) & 0xff));
  asm.bne("AudioBootLoop");
  if (hasMusic) asm.mov(spcDp(MUSIC.own), spcImm(0xff));
  asm.mov(spcDp(0xfa), spcImm(divisor));
  asm.mov(spcDp(0xf1), spcImm(0x81));
  if (autoStart !== undefined && hasMusic) {
    asm.mov(A, spcImm(autoStart & 0xff));
    asm.call("AudioMusicCommand");
  }
}

/**
 * The main loop: notice a request, then perform whatever ticks are owed.
 *
 * The timer's counter is four bits and reading it clears it, so "how many ticks
 * have I missed" is one read and cannot be missed — which is the whole reason
 * this console's driver needs no interrupt and no frame counter.
 */
function emitMain(asm: Asm700, input: SpcGameAudioInput): void {
  asm.label("AudioMain");
  asm.mov(A, spcDp(MAILBOX + SPC_PORT.sequence));
  asm.cmp(A, spcDp(DP.seq));
  asm.beq("AudioNoCommand");
  asm.mov(spcDp(DP.seq), A);
  // Echo it, so the game can see that the request landed.
  asm.mov(spcDp(MAILBOX + SPC_PORT.sequence), A);
  if (input.tracks.length > 0) {
    asm.mov(A, spcDp(MAILBOX + SPC_PORT.music));
    asm.beq("AudioNoMusic");
    asm.call("AudioMusicCommand");
    asm.label("AudioNoMusic");
  }
  if (input.effects.length > 0) {
    asm.mov(A, spcDp(MAILBOX + SPC_PORT.sfx));
    asm.beq("AudioNoCommand");
    asm.call("AudioSfxStart");
  }
  asm.label("AudioNoCommand");
  asm.mov(A, spcDp(0xfd));
  asm.beq("AudioMain");
  asm.mov(spcDp(DP.owed), A);
  asm.label("AudioTicks");
  asm.call("AudioTick");
  asm.dbnzDp(DP.owed, "AudioTicks");
  asm.bra("AudioMain");

  // One symbol covering both streams, so a harness watching a program counter
  // sees a tick begin exactly once (doc 16 §The proof).
  asm.label("AudioTick");
  if (input.tracks.length > 0) asm.call("AudioMusTick");
  if (input.effects.length > 0) asm.call("AudioSfxTick");
  asm.ret();
}

/** `1..n` starts a track; `STOP` stops the music and silences every voice. */
function emitMusicCommand(asm: Asm700): void {
  asm.label("AudioMusicCommand");
  asm.cmp(A, spcImm(STOP));
  asm.beq("AudioMusicStop");
  asm.dec(A);
  asm.mov(Y, spcImm(0x04));
  asm.mul();
  asm.mov(X, A);
  asm.mov(A, spcAbsX("AudioTracks"));
  asm.mov(spcDp(MUSIC.order), A);
  asm.mov(A, spcAbsX(label("AudioTracks", 1)));
  asm.mov(spcDp(MUSIC.order + 1), A);
  asm.mov(A, spcAbsX(label("AudioTracks", 2)));
  asm.mov(spcDp(MUSIC.loop), A);
  asm.mov(A, spcAbsX(label("AudioTracks", 3)));
  asm.mov(spcDp(MUSIC.loop + 1), A);
  asm.mov(spcDp(MUSIC.rest), spcImm(0x00));
  asm.mov(spcDp(MUSIC.active), spcImm(0x01));
  // A tail call: the loader returns to whoever asked for the track.
  asm.jmp("AudioMusLoad");
  asm.label("AudioMusicStop");
  asm.mov(spcDp(MUSIC.active), spcImm(0x00));
  asm.jmp("AudioSilence");
}

/** `1..n` fires an effect, unless a louder one is already playing. */
function emitSfxStart(asm: Asm700, hasMusic: boolean): void {
  asm.label("AudioSfxStart");
  asm.dec(A);
  asm.mov(Y, spcImm(0x05));
  asm.mul();
  asm.mov(X, A);
  asm.mov(A, spcDp(SFX.active));
  asm.beq("AudioSfxTake");
  asm.mov(A, spcAbsX(label("AudioEffects", 4)));
  asm.cmp(A, spcDp(DP.sfxPrio));
  asm.bcc("AudioSfxIgnore");
  asm.label("AudioSfxTake");
  asm.mov(A, spcAbsX(label("AudioEffects", 4)));
  asm.mov(spcDp(DP.sfxPrio), A);
  asm.mov(A, spcAbsX("AudioEffects"));
  asm.mov(spcDp(SFX.order), A);
  asm.mov(A, spcAbsX(label("AudioEffects", 1)));
  asm.mov(spcDp(SFX.order + 1), A);
  asm.mov(A, spcAbsX(label("AudioEffects", 2)));
  asm.mov(spcDp(DP.steal), A);
  asm.mov(spcDp(SFX.own), A);
  if (hasMusic) {
    // The music keeps everything the effect did not take, which is the whole of
    // preemption on this chip.
    asm.eor(A, spcImm(0xff));
    asm.mov(spcDp(MUSIC.own), A);
  }
  asm.mov(A, spcAbsX(label("AudioEffects", 3)));
  asm.mov(spcDp(DP.sfxGain), A);
  asm.mov(spcDp(SFX.rest), spcImm(0x00));
  asm.mov(spcDp(SFX.active), spcImm(0x01));
  asm.jmp("AudioSfxLoad");
  asm.label("AudioSfxIgnore");
  asm.ret();
}

/**
 * Give the borrowed voice back.
 *
 * The effect's `GAIN` goes to zero — not a key-off, because a key-off is a bit in
 * a register the music also writes and this driver has no shared byte to fold.
 * The music's next write to that voice brings it back; until then it is silent,
 * which is what every other console's release does too.
 */
function emitRelease(asm: Asm700, hasMusic: boolean): void {
  asm.label("AudioSfxRelease");
  asm.mov(spcDp(0xf2), spcDp(DP.sfxGain));
  asm.mov(spcDp(0xf3), spcImm(0x00));
  asm.mov(spcDp(DP.steal), spcImm(0x00));
  asm.mov(spcDp(SFX.own), spcImm(0x00));
  asm.mov(spcDp(DP.sfxPrio), spcImm(0x00));
  if (hasMusic) asm.mov(spcDp(MUSIC.own), spcImm(0xff));
  asm.ret();
}

// --- the schedules, as the sound processor will perform them ------------------

function stripBoot(
  script: ChipScript,
  boot: readonly { reg: number; value: number }[],
): ChipScript {
  const ticks = script.ticks.map((tick) => ({ ...tick, writes: [...tick.writes] }));
  const head = ticks[0];
  if (head === undefined) return script;
  const matches = boot.every((write, index) => {
    const got = head.writes[index];
    return got !== undefined && got.reg === write.reg && got.value === write.value;
  });
  if (!matches) {
    throw new AudioRomError(
      "E_BOOT_PREFIX",
      "an audio schedule does not open with the chip initialisation the ROM performs at boot",
      "this is a bug in the ROM builder, not in the track.",
    );
  }
  ticks[0] = { ...head, writes: head.writes.slice(boot.length) };
  return { ...script, ticks };
}

/**
 * A schedule cut down to the voices it is allowed to touch.
 *
 * An effect borrows one voice from the music; every write it makes to another
 * one would be a note being silenced. `KON` survives with its bits masked rather
 * than being dropped, because it is a pulse — keying the effect's voice must
 * still happen, and keying anyone else's must not.
 */
function restrict(script: ChipScript, owned: number): { script: ChipScript; dropped: number } {
  const tag = sdspChannelTag();
  let dropped = 0;
  const ticks = script.ticks.map((tick) => {
    const writes = [];
    for (const write of tick.writes) {
      const channels = tag(write.reg, write.value);
      if (SDSP_MERGE_REGS.has(write.reg)) {
        const masked = write.value & owned;
        if (masked === 0) {
          dropped += 1;
          continue;
        }
        writes.push({ ...write, value: masked });
        continue;
      }
      if (channels !== 0 && (channels & owned) === 0) {
        dropped += 1;
        continue;
      }
      writes.push(write);
    }
    return { ...tick, writes };
  });
  return { script: { ...script, ticks }, dropped };
}

/** The shape one player has to cope with, across every stream it plays. */
function shapeOf(streams: readonly DriverData[]): DriverData {
  const base = streams[0] as DriverData;
  return {
    ...base,
    hasRests: streams.some((one) => one.hasRests),
    hasMerges: streams.some((one) => one.hasMerges),
    hasOrder: streams.some((one) => one.hasOrder),
    oneShot: streams.some((one) => one.oneShot),
  };
}

function pack(script: ChipScript, options: Parameters<typeof packScript>[1]): DriverData {
  try {
    return packScript(script, options);
  } catch (error) {
    if (error instanceof PackError) throw new AudioRomError(error.code, error.message, error.hint);
    throw error;
  }
}

function rateHz(rate: Rational): string {
  return (rate.num / rate.den).toFixed(2);
}

function clampByte(value: number): number {
  const rounded = Math.round(value);
  return rounded < 0 ? 0 : rounded > 255 ? 255 : rounded;
}

/** The voice the spec's noise channel is, re-exported for the game backend. */
export { NOISE_VOICE };
