/**
 * The driver a WonderSwan game embeds.
 *
 * The eighth machine to get one, and the fourth whose clock is the picture — so
 * most of it is `sms-game.ts` and `nes-game.ts` with a V30MZ under it. Four
 * things are this console's, and each one is a consequence of hardware rather
 * than a choice:
 *
 *   - **The clock is a tally, not an interrupt.** This machine has two timers
 *     that could raise one and the cartridge takes neither: its interrupt
 *     controller vectors through the processor's own table in the first kilobyte
 *     of RAM, and a main loop that already waits for the beam gains nothing by
 *     it. What the hardware gives instead is a vertical-blank timer whose
 *     **counter is readable** — so `AudioFrame` asks how many frames have passed
 *     since it last looked, rather than being told once each time one does. A
 *     frame the game overran is therefore owed and paid rather than lost, which
 *     is what every other frame-clocked console needs a handler to achieve
 *     (doc 16 §A frame-clocked console counts frames). The Nintendo DS's
 *     argument, reached by different hardware.
 *   - **The shared register is an enable mask.** `$90` carries all four channel
 *     enables *and* the bit that puts channel four on its shift register, so two
 *     streams both write it and the driver merges rather than stores. The mask
 *     it folds under has to reach that mode bit too, which is one shift: the
 *     noise select is bit 7 and its channel is bit 3.
 *   - **Silence is two writes a channel, not one.** Clearing a channel's enable
 *     bit stops it, but the volume byte is the channel's own and survives — so a
 *     release that only touched `$90` would hand a channel back at the effect's
 *     level the moment the music enabled it again.
 *   - **The waveforms are copied, not uploaded.** Sixty-four bytes go from the
 *     cartridge into RAM at boot and port `$8F` says where; there is no wave
 *     port to write and nothing to sequence (`binding/wsc-bank.ts`).
 *
 * Source: WSdev wiki — Sound (https://ws.nesdev.org/wiki/Sound).
 */

import { Asm30, label, x86Abs as abs, x86RomAt as romAt } from "@demake/core";
import { WS_SOUND_CHANNELS, WS_SOUND_REG } from "@demake/chip";

import type { ChipScript, Rational } from "../chipscript.js";
import { bindingFor } from "../binding/registry.js";
import { WS_BANK_BYTES, WS_WAVE_BASE, wsWaveBank } from "../binding/wsc-bank.js";
import { wsWaveforms, WSC_SHARED_REG, wscChannelTag } from "../binding/wsc.js";

import { type DriverData } from "./data.js";
import { AudioRomError } from "./gb.js";
import type { GameEffect } from "./gb-game.js";
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
import { emitStream, emitStreamData, type WscStreamState } from "./wsc-driver.js";

/** The request value that stops the music rather than starting a track. */
export const STOP = 0xff;

/**
 * The vertical-blank timer, which is this driver's whole clock.
 *
 * Its counter decrements at the start of line 144 and reloads when it reaches
 * one, so with a reload of `$0100` the low byte is a plain modulo-256 frame
 * counter: `(last - now) & $FF` is how many frames have passed, however many
 * that is, and nothing has to have been listening.
 */
const TIMER = {
  control: 0xa2,
  reload: 0xa6,
  counter: 0xaa,
  /** Repeat, and count. The horizontal timer is left alone. */
  enable: 0x0c,
  /** A whole low byte of frames between reloads, so the subtraction is exact. */
  period: 0x0100,
} as const;

/** What a game hands the builder. */
export interface WscGameAudioInput {
  /** One schedule per track, in the order the game refers to them. */
  tracks: readonly ChipScript[];
  /** One per effect, likewise. */
  effects: readonly GameEffect[];
  /** First RAM byte the driver may use; it needs {@link WSC_AUDIO_BYTES}. */
  state: number;
  /**
   * The segment `DS` and `ES` hold, where that is not the console's own memory.
   *
   * Absent on every build but one. A mono WonderSwan game too big for the
   * console's sixteen kilobytes puts its whole heap — this driver's state
   * included — in the cartridge's save RAM at segment `$1`, and points both data
   * segment registers there (`demotic/src/codegen/layout.ts` §WS_SAVE_MEMORY).
   *
   * Everything the driver does with {@link WscGameAudioInput.state} is then
   * right without knowing it, because an unprefixed operand still means the
   * heap. The one thing that is not is the waveform copy: `rep movsb` writes
   * `ES:DI`, and its destination is {@link WS_WAVE_BASE} — a page of the
   * *console's* memory that the sound hardware reads, and the one address in
   * this driver that is not the game's to choose.
   */
  heapSegment?: number;
}

/**
 * Worst case for the borrowed-channel copies: every channel, its own registers.
 *
 * Reserved rather than fitted, because the memory plan is settled before the
 * game's effects are demade and it is the plan that says how much RAM the driver
 * has. A channel is written through three bytes — the two halves of its divider
 * and its volume — and the noise voice adds the shift register's own, so four
 * apiece is the ceiling.
 */
const SHADOW_MAX = WS_SOUND_CHANNELS * 4;

/** RAM bytes the driver's state occupies, counted from the allocator. */
export const WSC_AUDIO_BYTES = layout(0, SHADOW_MAX).end;

/** Sizes and reductions, reported rather than assumed. */
export interface WscGameAudioStats {
  code: number;
  data: number;
  tracks: number;
  effects: number;
  blocks: number;
  blocksSaved: number;
  helpers: readonly string[];
  rate: Rational;
  /** Writes dropped because an effect may only touch the channel it takes. */
  writesRestricted: number;
}

/** A built game driver: what to emit, where, and what it will really play. */
export interface WscGameAudio {
  /** How the game must drive it: how many ticks each frame owes. */
  clock: { ticksPerFrame: number; rate: Rational };
  /**
   * The two routines the game's own code has to call.
   *
   * `frame` goes where the main loop notices a frame and does nothing but read
   * the tally; `service` performs whatever it counted. The split is the other
   * frame-clocked consoles' and it survives the absence of an interrupt: what
   * keeps the tempo honest is that the count comes from hardware, and what keeps
   * the blanking interval for the tilemap upload is doing the work outside it.
   *
   * `frame` clobbers `ax` and the flags. `service` clobbers everything but `bp`,
   * which it uses and restores because the driver's own shadow store needs it.
   */
  routines: { frame: string; service: string };
  /** RAM bytes the game writes to ask for something. */
  request: { music: number; sfx: number };
  /** Emit `AudioInit`, `AudioTick` and everything they pull in. */
  emitCode(asm: Asm30): void;
  /** Emit the tables, the waveform page and the packed streams. */
  emitData(asm: Asm30): void;
  /** The schedules as the ROM will really perform them. */
  performed: { tracks: readonly ChipScript[]; effects: readonly ChipScript[] };
  stats: WscGameAudioStats;
}

/** Build the driver a game embeds. */
export function buildWscGameAudio(input: WscGameAudioInput): WscGameAudio {
  const scripts = [...input.tracks, ...input.effects.map((effect) => effect.script)];
  if (scripts.length === 0)
    throw new AudioRomError("E_NO_AUDIO", "this game has no audio to build");

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

  const clock = resolveWscClock(first);
  const binding = bindingFor(first.console);
  const boot = binding.init();
  const shapes = wsWaveforms(binding.spec);

  // Preemption machinery exists only when there is something to preempt: a game
  // with music and no effects packs the flat format and stores `$90` outright,
  // exactly as a cartridge that owned the chip would.
  const shared = input.tracks.length > 0 && input.effects.length > 0;
  const merged = new Set([WSC_SHARED_REG]);
  const packOptions = shared
    ? { channelOf: wscChannelTag, port: portOf, mergeRegs: merged }
    : { port: portOf };

  let restricted = 0;
  const tracks = input.tracks.map((script) => stripBoot(script, boot));
  const effects = input.effects.map((effect) => {
    const owned = 1 << effect.channel;
    const result = restrict(stripBoot(effect.script, boot), owned, wscChannelTag());
    restricted += result.dropped;
    return result.script;
  });

  const musicData = tracks.map((script) => pack(script, packOptions));
  const effectData = effects.map((script) =>
    pack(script, { ...packOptions, end: "stop" as const }),
  );

  const stealable = input.effects.reduce((bits, effect) => bits | (1 << effect.channel), 0);
  // What the music has to remember so a borrowed channel comes back holding the
  // music's own note rather than the effect's last one. Register-numbered, so a
  // window is indexed by the packed port byte and recording is one store.
  const shadow: ShadowPlan = shared
    ? shadowPlan(tracks, stealable, wscChannelTag, boot, portOf, merged)
    : NO_SHADOW;
  const state = layout(input.state, shadow.bytes);
  const bootControl = boot.find((write) => write.reg === WSC_SHARED_REG)?.value ?? 0;

  const helpers: string[] = [];
  let code = 0;
  let data = 0;

  const emitCode = (asm: Asm30): void => {
    const start = asm.pc;
    emitInit(asm, state, boot, bootControl, shadow, input.heapSegment ?? 0);
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
          ...(shadow.channels.length > 0
            ? {
                shadow: {
                  channels: shadow.channels.map((channel) => ({
                    bit: channel.channel,
                    base: state.shadow + shadowBias(channel),
                  })),
                },
              }
            : {}),
          ...(shared ? { merge: "AudioMusControl" } : {}),
        }).map((name) => `music-${name}`),
      );
    }
    if (input.effects.length > 0) {
      emitSfxStart(asm, state, input);
      emitRelease(asm, state, stealable, shared, shadow);
      helpers.push(
        ...emitStream(asm, {
          prefix: "AudioSfx",
          state: state.sfx,
          data: shapeOf(effectData),
          onEnd: "AudioSfxRelease",
          ...(shared ? { merge: "AudioSfxControl" } : {}),
        }).map((name) => `sfx-${name}`),
      );
    }
    if (input.tracks.length > 0) emitSilence(asm);
    if (shared) {
      emitControlMerge(asm, state);
      helpers.push("shared-register-merge");
    }
    code = asm.pc - start;
  };

  const emitData = (asm: Asm30): void => {
    const start = asm.pc;
    // The waveforms, which are the one thing in a demade cartridge that is
    // copied into RAM rather than written to a port.
    asm.label("AudioWaves");
    asm.bytes(wsWaveBank(shapes));
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
    get stats(): WscGameAudioStats {
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
 * The packed byte a register is written through, which here *is* the port.
 *
 * The chip's registers are I/O ports `$80`–`$94`, and a port on this
 * architecture is a byte — so unlike the Game Boy's high-RAM offsets and the
 * NES's `$4000` bias there is nothing to subtract.
 */
export function portOf(reg: number): number {
  return reg & 0xff;
}

/**
 * Resolve a schedule's driver clock to the number of ticks a frame owes it.
 *
 * The Sega's `resolveSmsClock` with a different message, and it is short for the
 * same reason: `wscBinding.fitRate` hands back exactly the console's frame rate,
 * so the only thing to resolve is which multiple — and a rate that is not a
 * whole one is a bug in the fit rather than something to round.
 */
export function resolveWscClock(script: ChipScript): WscGameAudio["clock"] {
  const { rate, source } = script.driver;
  if (source !== "vblank") {
    throw new AudioRomError(
      "E_DRIVER_CLOCK",
      `the wsc driver has no '${source}' clock`,
      "this cartridge takes no interrupts at all, so a game's driver counts frames off the vertical-blank timer; re-arrange with `vblank`.",
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

// --- state -------------------------------------------------------------------

/** Where the driver keeps everything, laid out from the game's first free byte. */
interface Layout {
  music: WscStreamState;
  sfx: WscStreamState;
  /** First byte of the music's copy of the borrowable channels. */
  shadow: number;
  /** Channels an effect has taken. */
  steal: number;
  /** Each stream's intended `$90`, which the merge folds together. */
  controlMusic: number;
  controlSfx: number;
  /** Priority of the effect playing, for the one that wants to interrupt it. */
  priority: number;
  musicReq: number;
  sfxReq: number;
  /** Frames the tally has counted that the main loop has not performed yet. */
  pending: number;
  /** The timer's low byte when `AudioFrame` last looked. */
  lastFrame: number;
  /** One past the last byte used. */
  end: number;
}

function layout(base: number, shadowBytes: number): Layout {
  let at = base;
  const take = (bytes = 1): number => {
    const address = at;
    at += bytes;
    return address;
  };
  const music: WscStreamState = {
    data: take(2),
    order: take(2),
    loop: take(2),
    rest: take(),
    active: take(),
  };
  // A sound effect stops rather than looping, so it needs no loop entry.
  const sfx: WscStreamState = { data: take(2), order: take(2), rest: take(), active: take() };
  const steal = take();
  const controlMusic = take();
  const controlSfx = take();
  const priority = take();
  const musicReq = take();
  const sfxReq = take();
  const pending = take();
  const lastFrame = take();
  const shadow = take(shadowBytes);
  return {
    music,
    sfx,
    shadow,
    steal,
    controlMusic,
    controlSfx,
    priority,
    musicReq,
    sfxReq,
    pending,
    lastFrame,
    end: at,
  };
}

// --- code --------------------------------------------------------------------

/**
 * Put the chip in a known state, copy the waveforms in, and start the tally.
 *
 * The copy is what makes this console's boot different from every other
 * wavetable machine's: a PC Engine writes a hundred and sixty register bytes and
 * this writes one port and moves sixty-four bytes with `rep movsb`.
 */
function emitInit(
  asm: Asm30,
  state: Layout,
  boot: readonly { reg: number; value: number }[],
  bootControl: number,
  shadow: ShadowPlan,
  heapSegment = 0,
): void {
  asm.label("AudioInit");
  // The waveforms first, because a channel enabled before its table is in place
  // would play whatever the game had at that address.
  asm.movi("si", label("AudioWaves"));
  asm.movi("di", WS_WAVE_BASE);
  asm.movi("cx", WS_BANK_BYTES);
  asm.pushSeg("ds");
  asm.movi("ax", 0xf000);
  asm.movsr("ds", "ax");
  // `ES` is the heap, and the waveform page is not in it on a game whose heap is
  // in the cartridge (§WscGameAudioInput.heapSegment). Saved and restored rather
  // than reloaded, so the driver never has to know what it was.
  if (heapSegment !== 0) {
    asm.pushSeg("es");
    asm.movi("ax", 0);
    asm.movsr("es", "ax");
  }
  asm.rep().movsb();
  if (heapSegment !== 0) asm.popSeg("es");
  asm.popSeg("ds");

  for (const write of boot) {
    asm.movi8("al", write.value);
    asm.out8(portOf(write.reg));
  }

  asm.movi8("al", 0);
  for (const byte of [
    state.music.active as number,
    state.sfx.active as number,
    state.music.rest,
    state.sfx.rest,
    state.steal,
    state.controlSfx,
    state.priority,
    state.musicReq,
    state.sfxReq,
    state.pending,
  ]) {
    asm.movmr8(abs(byte), "al");
  }
  // The music's shadow of `$90` starts at what the boot writes left there, so
  // the first merge folds against the truth rather than against zero.
  asm.movi8("al", bootControl);
  asm.movmr8(abs(state.controlMusic), "al");

  // Each borrowable channel's copy starts at what the boot writes left in its
  // registers, for the same reason (`shared.ts` §`shadowPlan`).
  for (let slot = 0; slot < shadow.init.length; slot += 1) {
    asm.movi8("al", shadow.init[slot] as number);
    asm.movmr8(abs(state.shadow + slot), "al");
  }

  // The tally: a repeating vertical-blank timer with a whole low byte between
  // reloads. Writing the reload initialises the counter with it, so the first
  // reading is the one this records rather than whatever the timer held.
  asm.movi("ax", TIMER.period);
  asm.out16(TIMER.reload);
  asm.movi8("al", TIMER.enable);
  asm.out8(TIMER.control);
  asm.in8(TIMER.counter);
  asm.movmr8(abs(state.lastFrame), "al");
  asm.ret();
}

/**
 * The clock, as the two routines the game calls.
 *
 * `AudioFrame` asks the hardware how many frames have gone by since it last
 * looked and adds them to what is owed, capped at {@link MAX_PENDING}: a game
 * that has been stopped would otherwise come back owing hundreds of ticks and
 * perform them all in one burst. Reading a counter rather than counting an
 * interrupt is what makes a frame the game overran owed rather than lost.
 *
 * `AudioService` performs them, `ticksPerFrame` at a time, from the main loop
 * rather than from the blanking interval — which belongs to the picture, as it
 * does on every other console here.
 */
function emitClock(asm: Asm30, state: Layout, ticksPerFrame: number): void {
  asm.label("AudioFrame");
  asm.in8(TIMER.counter);
  asm.mov8("ah", "al"); // what the timer says now, kept across the subtraction
  asm.aluM8("sub", "al", abs(state.lastFrame));
  asm.unary8("neg", "al"); // the counter runs *down*, so elapsed is last minus now
  asm.movmr8(abs(state.lastFrame), "ah");
  asm.aluI8("cmp", "al", 0);
  asm.jcc("nz", "AudioFrameOwed");
  asm.ret();

  asm.label("AudioFrameOwed");
  asm.aluM8("add", "al", abs(state.pending));
  asm.aluI8("cmp", "al", MAX_PENDING);
  asm.jcc("b", "AudioFrameKeep");
  asm.movi8("al", MAX_PENDING);
  asm.label("AudioFrameKeep");
  asm.movmr8(abs(state.pending), "al");
  asm.ret();

  asm.label("AudioService");
  asm.aluMI8("cmp", abs(state.pending), 0);
  asm.jcc("nz", "AudioServiceGo");
  asm.ret();
  asm.label("AudioServiceGo");
  asm.decM8(abs(state.pending));
  for (let tick = 0; tick < ticksPerFrame; tick += 1) asm.call("AudioTick");
  asm.jmp("AudioService");
}

/**
 * One driver tick: take what the game asked for, then step each stream.
 *
 * Requests are single bytes rather than pointers because a rule writes them from
 * the game's own loop. One byte is written atomically; a pointer and a length
 * are not.
 */
function emitTick(asm: Asm30, state: Layout, input: WscGameAudioInput): void {
  asm.label("AudioTick");
  if (input.tracks.length > 0) {
    asm.movm8("al", abs(state.musicReq));
    asm.alu8("or", "al", "al");
    asm.jcc("z", "AudioTickNoMusic");
    asm.call("AudioMusicStart");
    asm.label("AudioTickNoMusic");
  }
  if (input.effects.length > 0) {
    asm.movm8("al", abs(state.sfxReq));
    asm.alu8("or", "al", "al");
    asm.jcc("z", "AudioTickNoSfx");
    asm.call("AudioSfxStart");
    asm.label("AudioTickNoSfx");
  }
  if (input.tracks.length > 0) asm.call("AudioMusTick");
  // Effects step after the music, so on a tick where both write the same channel
  // the effect is the one the chip is left holding.
  if (input.effects.length > 0) asm.jmp("AudioSfxTick");
  else asm.ret();
}

/** Start the requested track, or stop the music. */
function emitMusicStart(asm: Asm30, state: Layout, input: WscGameAudioInput): void {
  asm.label("AudioMusicStart");
  asm.mov8("bl", "al"); // the request, until the table lookup
  asm.movi8("al", 0);
  asm.movmr8(abs(state.musicReq), "al");

  // A scene change stops whatever was playing, effect included. Nothing playing
  // means nothing to stop, and skipping the silencing there is what makes the
  // first track's first tick exactly the schedule's first tick.
  asm.movm8("al", abs(state.music.active as number));
  if (input.effects.length > 0) asm.aluM8("or", "al", abs(state.sfx.active as number));
  asm.alu8("or", "al", "al");
  asm.jcc("z", "AudioMusicFresh");
  asm.movi8("al", 0);
  asm.movmr8(abs(state.music.active as number), "al");
  if (input.effects.length > 0) asm.call("AudioSfxRelease");
  asm.call("AudioSilence");

  asm.label("AudioMusicFresh");
  asm.aluI8("cmp", "bl", STOP);
  asm.jcc("nz", "AudioMusicPlay");
  asm.ret();

  asm.label("AudioMusicPlay");
  asm.movi8("bh", 0);
  asm.dec("bx");
  asm.shift("shl", "bx", 2); // four bytes per entry: order, then loop entry
  asm.movm("ax", romAt("bx", label("AudioTracks")));
  asm.movmr(abs(state.music.order), "ax");
  asm.movm("ax", romAt("bx", label("AudioTracks", 2)));
  asm.movmr(abs(state.music.loop as number), "ax");
  asm.movi8("al", 0);
  asm.movmr8(abs(state.music.rest), "al");
  asm.call("AudioMusNextBlock");
  asm.movi8("al", 1);
  asm.movmr8(abs(state.music.active as number), "al");
  asm.ret();
}

/** Fire the requested effect, unless the one playing outranks it. */
function emitSfxStart(asm: Asm30, state: Layout, input: WscGameAudioInput): void {
  asm.label("AudioSfxStart");
  asm.movi8("ah", 0);
  asm.dec("ax");
  asm.mov("bx", "ax");
  asm.shift("shl", "bx", 2); // four bytes per entry: order, channel, priority
  asm.movi8("al", 0);
  asm.movmr8(abs(state.sfxReq), "al");

  if (input.effects.length > 1) {
    // Priority only means anything when two effects can collide.
    asm.aluMI8("cmp", abs(state.sfx.active as number), 0);
    asm.jcc("z", "AudioSfxTake");
    asm.movm8("al", romAt("bx", label("AudioEffects", 3)));
    asm.aluM8("cmp", "al", abs(state.priority));
    asm.jcc("nb", "AudioSfxTake");
    asm.ret(); // what is playing ranks higher; the new one is dropped
  }

  asm.label("AudioSfxTake");
  asm.movi8("al", 0);
  asm.movmr8(abs(state.sfx.active as number), "al");
  asm.push("bx");
  asm.call("AudioSfxRelease");
  asm.pop("bx");
  asm.movm("ax", romAt("bx", label("AudioEffects")));
  asm.movmr(abs(state.sfx.order), "ax");
  asm.movm8("al", romAt("bx", label("AudioEffects", 2)));
  asm.movmr8(abs(state.steal), "al");
  asm.movm8("al", romAt("bx", label("AudioEffects", 3)));
  asm.movmr8(abs(state.priority), "al");
  asm.movi8("al", 0);
  asm.movmr8(abs(state.sfx.rest), "al");
  asm.call("AudioSfxNextBlock");
  asm.movi8("al", 1);
  asm.movmr8(abs(state.sfx.active as number), "al");
  asm.ret();
}

/**
 * Give back the channels an effect borrowed.
 *
 * The music's own registers go back on the chip, so a held note comes back in
 * tune rather than at whatever the effect last set (doc 16 §Give a borrowed
 * channel back). A channel with no copy — one the music never wrote — is
 * silenced instead, which is its volume byte cleared and not just its enable
 * bit, because the volume is the channel's own register and survives `$90`.
 */
function emitRelease(
  asm: Asm30,
  state: Layout,
  stealable: number,
  merging: boolean,
  shadow: ShadowPlan,
): void {
  asm.label("AudioSfxRelease");
  asm.movm8("al", abs(state.steal));
  asm.alu8("or", "al", "al");
  asm.jcc("nz", "AudioReleaseGo");
  asm.ret();
  asm.label("AudioReleaseGo");
  asm.mov8("bl", "al");
  for (let channel = 0; channel < WS_SOUND_CHANNELS; channel += 1) {
    if ((stealable & (1 << channel)) === 0) continue;
    const skip = `AudioRelease${channel}`;
    asm.testI8("bl", 1 << channel);
    asm.jcc("z", skip);
    const copy = shadow.channels.find((one) => one.channel === 1 << channel);
    if (copy) {
      // Ascending, so the divider is stated before the volume turns the voice
      // back up — the order `shadowPlan` documents and every chip here shares.
      for (const write of copy.writes) {
        asm.movm8("al", abs(state.shadow + write.slot));
        asm.out8(write.port);
      }
    } else {
      asm.movi8("al", 0);
      asm.out8(WS_SOUND_REG.CH1_VOLUME + channel);
    }
    asm.label(skip);
  }
  asm.movi8("al", 0);
  asm.movmr8(abs(state.steal), "al");
  asm.movmr8(abs(state.sfx.active as number), "al");
  if (merging) {
    asm.movmr8(abs(state.controlSfx), "al");
    asm.jmp("AudioControl");
  } else {
    asm.ret();
  }
}

/** Turn every channel off — what stopping the music means. */
function emitSilence(asm: Asm30): void {
  asm.label("AudioSilence");
  asm.movi8("al", 0);
  asm.out8(WS_SOUND_REG.CONTROL);
  for (let channel = 0; channel < WS_SOUND_CHANNELS; channel += 1) {
    asm.out8(WS_SOUND_REG.CH1_VOLUME + channel);
  }
  asm.ret();
}

/**
 * Fold the two copies of `$90` under the steal mask and write it.
 *
 * The Game Boy's `emitPan` on a byte with a different shape: the channel bits
 * are the low nibble, so the mask is the steal byte itself — and then bit 7,
 * which puts channel four on its shift register and therefore belongs to
 * whichever stream owns channel four. One shift moves bit 3 to bit 7, which is
 * the whole of what this register needs beyond the obvious.
 *
 * **Clobbers `ax` and `dx` only** — `bx`, `cx` and `si` are live in the run walk
 * that calls this per merge write.
 */
function emitControlMerge(asm: Asm30, state: Layout): void {
  asm.label("AudioMusControl");
  asm.movmr8(abs(state.controlMusic), "al");
  asm.jmp("AudioControl");

  asm.label("AudioSfxControl");
  asm.movmr8(abs(state.controlSfx), "al");

  asm.label("AudioControl");
  asm.movm8("al", abs(state.steal));
  asm.mov8("dl", "al");
  asm.aluI8("and", "al", 0x08);
  for (let shift = 0; shift < 4; shift += 1) asm.shift8("shl", "al");
  asm.alu8("or", "al", "dl"); // the stolen channels, plus their mode bit
  asm.mov8("dl", "al");
  asm.movm8("al", abs(state.controlSfx));
  asm.alu8("and", "al", "dl");
  asm.mov8("dh", "al");
  asm.mov8("al", "dl");
  asm.unary8("not", "al");
  asm.mov8("dl", "al");
  asm.movm8("al", abs(state.controlMusic));
  asm.alu8("and", "al", "dl");
  asm.alu8("or", "al", "dh");
  asm.out8(WS_SOUND_REG.CONTROL);
  asm.ret();
}
