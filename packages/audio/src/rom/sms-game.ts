/**
 * The SN76489 audio driver a *game* embeds (doc 16 §Two streams, one clock).
 *
 * `gb-game.ts` and `nes-game.ts` a third console over, answering the same three
 * questions — who owns a channel right now, what a shared register does, and
 * where the tick comes from. Two of the answers are new, and both of them are
 * this chip's rather than this CPU's:
 *
 *   - **The channel is in the data, and it is latched.** A Game Boy register
 *     belongs to a channel by its address and an NES register by its address
 *     divided by four; an SN76489 has one write port and puts the channel in the
 *     top bits of the byte — and only in *some* bytes, because a byte with bit 7
 *     clear continues whatever the byte before it selected. So the packer is
 *     handed a tag that carries a latch, and preemption
 *     skips whole runs rather than writes: every run opens with a latch byte, so
 *     a skipped run takes its own selection with it and the next one that is
 *     written selects again before writing anything. That property is checked
 *     rather than assumed. Both are `psg.ts`'s, because both are the chip's
 *     rather than this processor's.
 *   - **The shared register exists only on one of the two machines.** A Master
 *     System has nothing two streams both have to write, so it emits no merge
 *     path at all. A Game Gear has the stereo port: one byte carrying every
 *     channel's left and right enables, in the same two-nibble layout as the Game
 *     Boy's `NR51` and merged for the same reason — by the same fold, spelt out
 *     in four `rlca` because this CPU has no `swap`.
 *
 * The third answer is the NES's restated. There is **one interrupt and one
 * rate**, and here it is the picture's: this VDP reloads its line counter on
 * every scanline outside the active display, so a line interrupt is not a clock a
 * driver can hold a tempo on (`rom/index.ts` §`GAME_CLOCKS`). The game counts
 * frames in the handler and performs the ticks it owes from the main loop, which
 * is how the blanking interval stays the picture's.
 *
 * Silencing is a third shape again. A Game Boy channel goes off by powering its
 * DAC down and an NES channel by clearing one bit of a shared register; here it
 * is one write per channel to the chip's own attenuation latch, at full cut —
 * `%1cc1 1111`. No shared byte to recompute and no second register to remember,
 * which is the hardware being simpler rather than the driver being cleverer.
 *
 * Sources:
 * - SMS Power! — SN76489: https://www.smspower.org/Development/SN76489
 * - SMS Power! — Game Gear stereo port ($06): https://www.smspower.org/Development/AudioPort
 */

import { AsmZ80, label } from "@demake/core";

import type { ChipScript, Rational } from "../chipscript.js";
import { bindingFor } from "../binding/registry.js";

import type { DriverData } from "./data.js";
import { AudioRomError } from "./gb.js";
import type { GameEffect } from "./gb-game.js";
import { checkLatchDiscipline, psgAttenuationOff, psgChannelTag, PSG_STEREO_REG } from "./psg.js";
import { clampByte, MAX_PENDING, pack, rateHz, restrict, shapeOf, stripBoot } from "./shared.js";
import { emitStream, emitStreamData, type SmsStreamState } from "./sms-driver.js";

/** The value that stops the music, rather than starting a track. */
export const STOP = 0xff;

/**
 * The chip's one write port, and the Game Gear's stereo latch beside it.
 *
 * The sound chip answers on either half of `$40`–`$7F`; `$7F` is what the Sega
 * 8-bit backend's own boot code uses and what every published example uses, so
 * the driver uses it too. The stereo latch is a separate device at `$06` and only
 * exists on the handheld.
 */
const PORT = { psg: 0x7f, stereo: 0x06 } as const;

/**
 * How a schedule's register number reaches the packed data.
 *
 * The port, because a Z80 writes a chip with `out (c), a` and the packed byte is
 * what lands in `c`. One byte either way — the same one the Game Boy spends on a
 * high-RAM offset — and the write loop pays nothing to translate.
 */
function portOf(reg: number): number {
  return reg === PSG_STEREO_REG ? PORT.stereo : PORT.psg;
}

/** What the game hands the driver builder. */
export interface SmsGameAudioInput {
  /** One schedule per track, in the order the game refers to them. */
  tracks: readonly ChipScript[];
  /** One per effect, likewise. */
  effects: readonly GameEffect[];
  /** First work-RAM byte the driver may use; it needs {@link SMS_AUDIO_BYTES}. */
  state: number;
}

/**
 * Work-RAM bytes the driver's state occupies.
 *
 * Plain work RAM, and there is nowhere better: a Z80 pays the same two address
 * bytes wherever a variable lives, so unlike the Game Boy's high RAM and the
 * NES's page zero there is nothing to be economical about. Counted from the
 * allocator rather than written down, so the two cannot drift.
 */
export const SMS_AUDIO_BYTES = layout(0).end;

/** Sizes and reductions, reported rather than assumed. */
export interface SmsGameAudioStats {
  /** Driver code bytes. */
  code: number;
  /** Packed schedule bytes, tables included. */
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
  /**
   * Writes dropped because an effect may only touch the channel it takes.
   *
   * An effect's schedule opens by stating every channel's state, which is right
   * for a cartridge that owns the chip and wrong for one borrowing a channel from
   * the music. Counted rather than quietly discarded, on the "never lose a part
   * silently" rule.
   */
  writesRestricted: number;
}

/** A built game driver: what to emit, where, and what it will really play. */
export interface SmsGameAudio {
  /**
   * How the game must drive it.
   *
   * The NES's shape, for the NES's reason: there is no reload to program and no
   * vector to claim, only a number of times to call `AudioTick` for every frame
   * that has passed.
   */
  clock: { ticksPerFrame: number; rate: Rational };
  /**
   * The two routines the game's own code has to call.
   *
   * `frame` goes in the frame interrupt and does nothing but count it; `service`
   * goes in the main loop and performs whatever ticks have been counted. The
   * split is the console's clock discipline: the interrupt is what keeps the
   * tempo honest, and doing the work outside it is what keeps the blanking
   * interval for the tilemap upload.
   *
   * `frame` clobbers `a` and the flags and nothing else. `service` clobbers
   * everything.
   */
  routines: { frame: string; service: string };
  /** Work-RAM bytes the game writes to ask for something. */
  request: {
    /** `1..n` starts a track; {@link STOP} stops the music. */
    music: number;
    /** `1..n` fires an effect. */
    sfx: number;
  };
  /** Emit `AudioInit`, `AudioTick` and everything they pull in. */
  emitCode(asm: AsmZ80): void;
  /** Emit the tables and the packed streams. */
  emitData(asm: AsmZ80): void;
  /**
   * The schedules as the ROM will really perform them.
   *
   * Not the same objects that went in: the chip's initialisation is performed
   * once at boot rather than at the head of every stream, and an effect is
   * restricted to its own channel. Both are stated here so the conformance
   * harness diffs against what the driver actually promises (doc 16 §The proof).
   */
  performed: { tracks: readonly ChipScript[]; effects: readonly ChipScript[] };
  stats: SmsGameAudioStats;
}

/** Build the driver a game embeds. */
export function buildSmsGameAudio(input: SmsGameAudioInput): SmsGameAudio {
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
  for (const script of scripts) checkLatchDiscipline(script);

  const clock = resolveSmsClock(first);
  const binding = bindingFor(first.console);
  const boot = binding.init();
  // A Game Gear has the stereo latch and a Master System does not, which is the
  // whole of what differs between the two drivers. Asked of the console's own
  // spec rather than of its id, so the SG-1000 needs no entry anywhere.
  const stereo = binding.spec.mixing.channels === 2;

  // Preemption machinery exists only when there is something to preempt: a game
  // with music and no effects packs the flat format and stores the stereo latch
  // outright, exactly as a cartridge that owns the chip does.
  const shared = input.tracks.length > 0 && input.effects.length > 0;
  const packOptions = shared
    ? {
        channelOf: psgChannelTag,
        port: portOf,
        ...(stereo ? { mergeRegs: new Set([PSG_STEREO_REG]) } : {}),
      }
    : { port: portOf };

  let restricted = 0;
  const tracks = input.tracks.map((script) => stripBoot(script, boot));
  const effects = input.effects.map((effect) => {
    const owned = 1 << effect.channel;
    const result = restrict(stripBoot(effect.script, boot), owned, psgChannelTag());
    restricted += result.dropped;
    return result.script;
  });

  const musicData = tracks.map((script) => pack(script, packOptions));
  const effectData = effects.map((script) =>
    pack(script, { ...packOptions, end: "stop" as const }),
  );

  const state = layout(input.state);
  const stealable = input.effects.reduce((bits, effect) => bits | (1 << effect.channel), 0);
  const bootStereo = boot.find((write) => write.reg === PSG_STEREO_REG)?.value ?? 0xff;
  const merging = shared && stereo;

  const helpers: string[] = [];
  let code = 0;
  let data = 0;

  const emitCode = (asm: AsmZ80): void => {
    const start = asm.pc;
    emitInit(asm, state, boot, stereo ? bootStereo : undefined);
    emitClock(asm, state, clock.ticksPerFrame);
    emitTick(asm, state, input);
    if (input.tracks.length > 0) {
      emitMusicStart(asm, state, input);
      helpers.push(
        ...emitStream(asm, {
          prefix: "AudioMus",
          state: state.music,
          data: shapeOf(musicData),
          ...(shared ? { steal: state.steal } : {}),
          ...(merging ? { merge: "AudioMusStereo" } : {}),
        }).map((name) => `music-${name}`),
      );
    }
    if (input.effects.length > 0) {
      emitSfxStart(asm, state, input);
      emitRelease(asm, state, stealable, merging);
      helpers.push(
        ...emitStream(asm, {
          prefix: "AudioSfx",
          state: state.sfx,
          data: shapeOf(effectData),
          onEnd: "AudioSfxRelease",
          ...(merging ? { merge: "AudioSfxStereo" } : {}),
        }).map((name) => `sfx-${name}`),
      );
    }
    if (input.tracks.length > 0) emitSilence(asm);
    if (merging) {
      emitStereoMerge(asm, state);
      helpers.push("stereo-merge");
    }
    code = asm.pc - start;
  };

  const emitData = (asm: AsmZ80): void => {
    const start = asm.pc;
    if (input.tracks.length > 0) {
      asm.label("AudioTracks");
      for (let index = 0; index < musicData.length; index += 1) {
        const track = musicData[index] as DriverData;
        asm.dw(label(`AudioMusOrder${index}`));
        asm.dw(label(`AudioMusOrder${index}`, track.loopOrderIndex * 2));
      }
    }
    if (input.effects.length > 0) {
      asm.label("AudioEffects");
      for (let index = 0; index < effectData.length; index += 1) {
        asm.dw(label(`AudioSfxOrder${index}`));
        asm.db(1 << (input.effects[index] as GameEffect).channel);
        asm.db(clampByte((input.effects[index] as GameEffect).priority));
      }
    }
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
    clock,
    routines: { frame: "AudioFrame", service: "AudioService" },
    request: { music: state.musicReq, sfx: state.sfxReq },
    emitCode,
    emitData,
    performed: { tracks, effects },
    get stats(): SmsGameAudioStats {
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
 * Resolve a schedule's driver clock to the number of ticks a frame owes it.
 *
 * The NES's `resolveNesClock` with a different error message, and it is short for
 * the same reason: there is no register to recover, because there is no timer the
 * driver can hold a tempo on. `gameDriverRate` asks the binding for exactly the
 * console's frame rate and `psgBinding.fitRate` hands it back unchanged, so the
 * only thing to resolve is which multiple — and a rate that is not a whole one is
 * a bug in the fit rather than something to round.
 */
export function resolveSmsClock(script: ChipScript): SmsGameAudio["clock"] {
  const { rate, source } = script.driver;
  if (source !== "vblank") {
    throw new AudioRomError(
      "E_DRIVER_CLOCK",
      `the sms driver has no '${source}' clock`,
      "this VDP reloads its line counter outside the active display, so a game's driver runs on the frame; re-arrange with `vblank`.",
    );
  }
  const frame = bindingFor(script.console).spec.driver.frameRate;
  const ticks = (rate.num * frame.den) / (rate.den * frame.num);
  if (!Number.isInteger(ticks) || ticks < 1 || ticks > 8) {
    throw new AudioRomError(
      "E_DRIVER_CLOCK",
      `${rateHz(rate)} Hz is not a whole number of ticks per frame on this console`,
      "the frame is the only clock the driver has; this is a bug in the timing fit, not in the track.",
    );
  }
  return { ticksPerFrame: ticks, rate };
}

// --- the schedules, as the ROM will perform them -----------------------------

// --- state -------------------------------------------------------------------

/** Where the driver keeps everything, laid out from the game's first free byte. */
interface Layout {
  music: SmsStreamState;
  sfx: SmsStreamState;
  /** Channels an effect has taken. */
  steal: number;
  /** Each stream's intended stereo latch, which the merge folds together. */
  stereoMusic: number;
  stereoSfx: number;
  /** Priority of the effect playing, for the one that wants to interrupt it. */
  priority: number;
  musicReq: number;
  sfxReq: number;
  /** Frames counted by the interrupt that the main loop has not performed yet. */
  pending: number;
  /** One past the last byte used. */
  end: number;
}

function layout(base: number): Layout {
  let at = base;
  const take = (bytes = 1): number => {
    const address = at;
    at += bytes;
    return address;
  };
  const music: SmsStreamState = {
    data: take(2),
    order: take(2),
    loop: take(2),
    rest: take(),
    active: take(),
  };
  // A sound effect stops rather than looping, so it needs no loop entry.
  const sfx: SmsStreamState = {
    data: take(2),
    order: take(2),
    rest: take(),
    active: take(),
  };
  const steal = take();
  const stereoMusic = take();
  const stereoSfx = take();
  const priority = take();
  const musicReq = take();
  const sfxReq = take();
  const pending = take();
  return {
    music,
    sfx,
    steal,
    stereoMusic,
    stereoSfx,
    priority,
    musicReq,
    sfxReq,
    pending,
    end: at,
  };
}

// --- code --------------------------------------------------------------------

/**
 * Put the chip in a known state and clear the driver's own.
 *
 * Nothing programs a clock here, because there is none to program: the game's
 * frame interrupt is already running for the picture's sake and the driver rides
 * it.
 */
function emitInit(
  asm: AsmZ80,
  state: Layout,
  boot: readonly { reg: number; value: number }[],
  bootStereo: number | undefined,
): void {
  asm.label("AudioInit");
  for (const write of boot) {
    asm.ldn("a", write.value);
    asm.outN(portOf(write.reg));
  }

  asm.alu("xor", "a");
  for (const byte of [
    state.music.active as number,
    state.sfx.active as number,
    state.music.rest,
    state.sfx.rest,
    state.steal,
    state.stereoSfx,
    state.priority,
    state.musicReq,
    state.sfxReq,
    state.pending,
  ]) {
    asm.sta(byte);
  }
  // The music's shadow starts at what the boot writes left in the stereo latch,
  // so the first merge folds against the truth rather than against zero.
  if (bootStereo !== undefined) {
    asm.ldn("a", bootStereo);
    asm.sta(state.stereoMusic);
  }
  asm.ret();
}

/**
 * The clock, as the two routines the game calls.
 *
 * `AudioFrame` counts a frame and stops counting at {@link MAX_PENDING}: a game
 * that has been stopped — a tab in the background, a breakpoint, a scene change
 * that took half a second — would otherwise come back owing hundreds of ticks and
 * perform them all in one burst.
 *
 * `AudioService` performs them, `ticksPerFrame` at a time, from the main loop
 * rather than from the interrupt for one reason: the blanking interval belongs to
 * the picture. A driver tick in there is a driver tick the tilemap upload is
 * waiting behind.
 */
function emitClock(asm: AsmZ80, state: Layout, ticksPerFrame: number): void {
  asm.label("AudioFrame");
  asm.lda(state.pending);
  asm.aluN("cp", MAX_PENDING);
  asm.ret("nc");
  asm.inc("a");
  asm.sta(state.pending);
  asm.ret();

  asm.label("AudioService");
  asm.lda(state.pending);
  asm.alu("or", "a");
  asm.ret("z");
  asm.dec("a");
  asm.sta(state.pending);
  for (let tick = 0; tick < ticksPerFrame; tick += 1) asm.call("AudioTick");
  asm.jp("AudioService");
}

/**
 * One driver tick: take what the game asked for, then step each stream.
 *
 * Requests are single bytes rather than pointers because a rule writes them from
 * the game's own loop. One byte is written atomically; a pointer and a length are
 * not, and the tick that arrived between them would play half of one effect and
 * half of another.
 */
function emitTick(asm: AsmZ80, state: Layout, input: SmsGameAudioInput): void {
  asm.label("AudioTick");
  if (input.tracks.length > 0) {
    asm.lda(state.musicReq);
    asm.alu("or", "a");
    asm.call("AudioMusicStart", "nz");
  }
  if (input.effects.length > 0) {
    asm.lda(state.sfxReq);
    asm.alu("or", "a");
    asm.call("AudioSfxStart", "nz");
  }
  if (input.tracks.length > 0) asm.call("AudioMusTick");
  // Effects step after the music, so on a tick where both write the same channel
  // the effect is the one the chip is left holding.
  if (input.effects.length > 0) asm.jp("AudioSfxTick");
  else asm.ret();
}

/** Start the requested track, or stop the music. */
function emitMusicStart(asm: AsmZ80, state: Layout, input: SmsGameAudioInput): void {
  asm.label("AudioMusicStart");
  asm.ld("b", "a"); // the request, until the table lookup
  asm.alu("xor", "a");
  asm.sta(state.musicReq);

  // A scene change stops whatever was playing, effect included: the sound of the
  // old scene carrying into the new one is a bug in every game that has it.
  // Nothing playing means nothing to stop, and skipping the silencing there is
  // what makes the first track's first tick exactly the schedule's first tick.
  asm.lda(state.music.active as number);
  if (input.effects.length > 0) {
    asm.ld("c", "a");
    asm.lda(state.sfx.active as number);
    asm.alu("or", "c");
  }
  asm.alu("or", "a");
  asm.jr("AudioMusicFresh", "z");
  asm.alu("xor", "a");
  asm.sta(state.music.active as number);
  if (input.effects.length > 0) asm.call("AudioSfxRelease");
  asm.call("AudioSilence");

  asm.label("AudioMusicFresh");
  asm.ld("a", "b");
  asm.aluN("cp", STOP);
  asm.ret("z");

  asm.dec("a");
  asm.alu("add", "a");
  asm.alu("add", "a"); // four bytes per entry: order, then loop entry
  asm.ld("l", "a");
  asm.ldn("h", 0);
  asm.ld16("de", label("AudioTracks"));
  asm.addHL("de");
  emitTakeWord(asm, state.music.order);
  emitTakeWord(asm, state.music.loop as number);
  asm.alu("xor", "a");
  asm.sta(state.music.rest);
  asm.call("AudioMusNextBlock");
  asm.ldn("a", 1);
  asm.sta(state.music.active as number);
  asm.ret();
}

/** Copy the word `hl` is on into a driver variable, stepping past it. */
function emitTakeWord(asm: AsmZ80, address: number): void {
  asm.ld("a", "hlp");
  asm.inc16("hl");
  asm.sta(address);
  asm.ld("a", "hlp");
  asm.inc16("hl");
  asm.sta(address + 1);
}

/**
 * Fire the requested effect, unless the one playing outranks it.
 *
 * The table entry is walked with `hl`, which is pushed across `AudioSfxRelease`
 * rather than trusted to survive it — that routine tails into the merge, and the
 * merge is written to preserve what the *run walk* has live, which is a different
 * list. Cheaper to save one pair here than to constrain a routine two callers
 * reach from different places.
 */
function emitSfxStart(asm: AsmZ80, state: Layout, input: SmsGameAudioInput): void {
  asm.label("AudioSfxStart");
  asm.ld("b", "a");
  asm.alu("xor", "a");
  asm.sta(state.sfxReq);

  asm.ld("a", "b");
  asm.dec("a");
  asm.alu("add", "a");
  asm.alu("add", "a"); // four bytes per entry: order, channel, priority
  asm.ld("l", "a");
  asm.ldn("h", 0);
  asm.ld16("de", label("AudioEffects"));
  asm.addHL("de");

  if (input.effects.length > 1) {
    // Priority only means anything when two effects can collide.
    asm.lda(state.sfx.active as number);
    asm.alu("or", "a");
    asm.jr("AudioSfxTake", "z");
    asm.push("hl");
    asm.inc16("hl");
    asm.inc16("hl");
    asm.inc16("hl");
    asm.ld("a", "hlp");
    asm.ld("b", "a");
    asm.lda(state.priority);
    asm.alu("cp", "b");
    asm.pop("hl");
    asm.ret("nc"); // what is playing ranks at least as high; the new one is dropped
  }

  asm.label("AudioSfxTake");
  asm.alu("xor", "a");
  asm.sta(state.sfx.active as number);
  asm.push("hl");
  asm.call("AudioSfxRelease");
  asm.pop("hl");
  emitTakeWord(asm, state.sfx.order);
  asm.ld("a", "hlp");
  asm.inc16("hl");
  asm.sta(state.steal);
  asm.ld("a", "hlp");
  asm.sta(state.priority);
  asm.alu("xor", "a");
  asm.sta(state.sfx.rest);
  asm.call("AudioSfxNextBlock");
  asm.ldn("a", 1);
  asm.sta(state.sfx.active as number);
  asm.ret();
}

/**
 * Give back the channels an effect borrowed.
 *
 * The channel is silenced rather than left holding the effect's last attenuation,
 * and the music picks it up again at its next note. Restoring what the music
 * *would* have been playing would mean keeping a shadow of every register on
 * every channel, to hide a gap of at most a few ticks — the trade the Game Boy
 * driver rejected, rejected here for the same reason.
 *
 * The mask is held in `c` rather than `b` because **`b` is live in the caller**:
 * `AudioMusicStart` holds the track it was asked for there across this call, and
 * a scene change that happened while an effect was playing would otherwise start
 * whichever track the effect's channel mask happened to name.
 */
function emitRelease(asm: AsmZ80, state: Layout, stealable: number, merging: boolean): void {
  asm.label("AudioSfxRelease");
  asm.lda(state.steal);
  asm.alu("or", "a");
  asm.ret("z");
  asm.ld("c", "a");
  for (let channel = 0; channel < 4; channel += 1) {
    if ((stealable & (1 << channel)) === 0) continue;
    const skip = `AudioRelease${channel}`;
    asm.bit(channel, "c");
    asm.jr(skip, "z");
    asm.ldn("a", psgAttenuationOff(channel));
    asm.outN(PORT.psg);
    asm.label(skip);
  }
  asm.alu("xor", "a");
  asm.sta(state.steal);
  asm.sta(state.sfx.active as number);
  if (merging) {
    asm.sta(state.stereoSfx);
    asm.jp("AudioStereo");
  } else {
    asm.ret();
  }
}

/** Turn every channel off — what stopping the music means. */
function emitSilence(asm: AsmZ80): void {
  asm.label("AudioSilence");
  for (let channel = 0; channel < 4; channel += 1) {
    asm.ldn("a", psgAttenuationOff(channel));
    asm.outN(PORT.psg);
  }
  asm.ret();
}

/**
 * Fold the two stereo shadows under the steal mask and write the latch.
 *
 * The Game Boy's `emitPan` with one instruction expanded, because the byte has
 * the same shape: a channel's left bit and right bit are four apart, so the
 * channel mask is one nibble and swapping the two turns it into the register's
 * layout. The SM83 has a `swap` for that and the Z80 — which it is otherwise a
 * subset of — does not, so this is four `rlca`. The other difference is that this
 * device is a port rather than an address.
 *
 * **Clobbers `a`, `c` and `e` only** — `b`, `d` and `hl` are live in the run walk
 * that calls this per merge write.
 */
function emitStereoMerge(asm: AsmZ80, state: Layout): void {
  asm.label("AudioMusStereo");
  asm.sta(state.stereoMusic);
  asm.jr("AudioStereo");

  asm.label("AudioSfxStereo");
  asm.sta(state.stereoSfx);

  asm.label("AudioStereo");
  asm.lda(state.steal);
  asm.ld("c", "a");
  for (let rotate = 0; rotate < 4; rotate += 1) asm.rlca();
  asm.alu("or", "c");
  asm.ld("c", "a"); // the stolen channels, in the latch's layout
  asm.lda(state.stereoSfx);
  asm.alu("and", "c");
  asm.ld("e", "a");
  asm.ld("a", "c");
  asm.cpl();
  asm.ld("c", "a");
  asm.lda(state.stereoMusic);
  asm.alu("and", "c");
  asm.alu("or", "e");
  asm.outN(PORT.stereo);
  asm.ret();
}
