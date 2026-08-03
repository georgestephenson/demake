/**
 * The HuC6280 PSG's driver a *game* embeds (doc 16 §Two streams, one clock).
 *
 * `nes-game.ts`'s counterpart on the second machine that runs the same
 * instructions — the stream player is `mos-player.ts`, shared verbatim, because
 * a HuC6280 is a 6502 with a memory mapper on it. What is left here is the three
 * questions every game driver answers, and this console answers all three
 * differently from the one next door:
 *
 *   - **The clock is the CPU's own timer.** A NES has none a driver can have
 *     without burning the DMC channel; this processor has one nothing else in a
 *     demade cartridge uses, so a game's audio runs at 120 Hz rather than at the
 *     frame rate. It is still counted rather than ridden: the handler increments
 *     a byte and the main loop performs what it says, because the vertical blank
 *     belongs to the picture and a tick inside it is a tick the tilemap upload
 *     is waiting behind. The counter is also what makes a frame the game overran
 *     cost it no tempo.
 *   - **There is no shared register, so there is no merge.** Not an `NR51`, not
 *     a `$4015`, not a key-on pulse: the global level is written once at boot and
 *     everything else a stream touches belongs to one channel. A Master System
 *     and a Mega Drive are the other two that emit no merge routine, and all
 *     three say it by having *less* shared hardware rather than more.
 *   - **Every run opens with a channel select, and preemption depends on it.**
 *     The channel is a register here rather than an address or a data bit, so a
 *     skipped run takes its own selection with it and the next one selects again
 *     before writing anything. `binding/pce.ts`'s tag carries that latch and
 *     {@link checkSelectDiscipline} refuses a schedule where the property does
 *     not hold, on the SN76489's precedent.
 *
 * Silencing is where this chip is at its simplest: a channel goes off by clearing
 * the enable bit in the same byte its volume lives in, so a released channel and
 * a stopped track are a select and a zero each.
 *
 * Sources:
 * - Archaic Pixels — PSG: https://archaicpixels.com/PSG
 * - Archaic Pixels — Timer: https://archaicpixels.com/Timer
 */

import { abs, absX, acc, Asm6502, imm, immHigh, immLow, indY, label, zp } from "@demake/core";
import { HUC6280_PSG_REG as PSG } from "@demake/chip";

import { bindingFor } from "../binding/registry.js";
import { pceChannelTag, pcePackTag } from "../binding/pce.js";
import type { ChipScript, Rational } from "../chipscript.js";

import type { DriverData } from "./data.js";
import { AudioRomError } from "./gb.js";
import type { GameEffect } from "./gb-game.js";
import {
  emitStream,
  emitStreamData,
  PSG_BASE,
  type MosScratch,
  type MosStreamState,
} from "./mos-player.js";
import { clampByte, MAX_PENDING, pack, rateHz, restrict, shapeOf, stripBoot } from "./shared.js";

/** The value that stops the music, rather than starting a track. */
export const STOP = 0xff;

/** The chip's registers, as absolute addresses in the mapped hardware page. */
const SELECT = PSG_BASE + PSG.SELECT;
const CONTROL = PSG_BASE + PSG.CONTROL;

/**
 * The CPU's timer, which is the only peripheral in this file that is not a chip
 * register.
 *
 * Seven bits of reload at `$0C00` and a run bit at `$0C01`. Starting a stopped
 * timer reloads it, so the two writes in that order are the whole of programming
 * it — and the interrupt it raises is acknowledged by *writing* `$1403`, which
 * the game's own handler does before it calls in here.
 */
const TIMER_RELOAD = 0x0c00;
const TIMER_CONTROL = 0x0c01;

/** Reloads the timer register holds; the binding never fits outside it. */
const MAX_TIMER_RELOAD = 0x7f;

/**
 * Channels a game's effects may be spread over.
 *
 * The packed run format's channel nibble, and the same four the Mega Drive and
 * the Nintendo DS get. The sound demaker places one pitched gesture and one noise
 * gesture, so this has never been close — it is refused by name rather than
 * truncated, because a truncation would be an effect that silently could not
 * preempt.
 */
const MAX_STEAL_CHANNELS = 4;

/** What the game hands the driver builder. */
export interface PceGameAudioInput {
  /** One schedule per track, in the order the game refers to them. */
  tracks: readonly ChipScript[];
  /** One per effect, likewise. */
  effects: readonly GameEffect[];
  /**
   * First cheap-page *operand* the driver may use; it needs {@link PCE_AUDIO_BYTES}.
   *
   * An operand and not an address, because this CPU's zero page is at `$2000`
   * and `zp $7E` means `$207E` (`codegen/mos/zp.ts`). The caller reduces once,
   * here as everywhere else that hands this processor a page-zero byte.
   */
  state: number;
}

/**
 * Cheap-page bytes the driver's state occupies.
 *
 * Page zero and not work RAM, and it is not an optimisation: the two stream
 * pointers are *dereferenced*, and `($nn),y` is the only indirection this CPU
 * has. Counted from the allocator rather than written down, so the two cannot
 * drift.
 */
export const PCE_AUDIO_BYTES = layout(0).end;

/** Sizes and reductions, reported rather than assumed. */
export interface PceGameAudioStats {
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
  /** Writes dropped because an effect may only touch the channel it takes. */
  writesRestricted: number;
}

/** A built game driver: what to emit, where, and what it will really play. */
export interface PceGameAudio {
  /**
   * How the game must drive it.
   *
   * `reload` is what `AudioInit` programmes into the timer, reported so a caller
   * can say what rate its cartridge really runs at without re-deriving one from
   * a rational. The game's own reset has to leave the timer interrupt *unmasked*
   * — that register is the console's interrupt policy rather than the driver's,
   * so it belongs to the backend that owns the vectors.
   */
  clock: { rate: Rational; reload: number };
  /**
   * The two routines the game's own code has to call.
   *
   * `frame` goes in the timer handler and does nothing but count the tick;
   * `service` goes in the main loop and performs whatever has been counted. The
   * split is the NES driver's and it is here for the same reason — a tick inside
   * an interrupt is a tick the picture is waiting behind — with the difference
   * that what counts here is a timer rather than the frame, so the audio rate is
   * not the game's.
   *
   * `frame` clobbers `a` and nothing else. `service` clobbers everything.
   */
  routines: { frame: string; service: string };
  /** Cheap-page bytes the game writes to ask for something. */
  request: {
    /** `1..n` starts a track; {@link STOP} stops the music. */
    music: number;
    /** `1..n` fires an effect. */
    sfx: number;
  };
  /** Emit `AudioInit`, `AudioTick` and everything they pull in. */
  emitCode(asm: Asm6502): void;
  /** Emit the tables and the packed streams. */
  emitData(asm: Asm6502): void;
  /** The schedules as the ROM will really perform them (doc 16 §The proof). */
  performed: { tracks: readonly ChipScript[]; effects: readonly ChipScript[] };
  stats: PceGameAudioStats;
}

/** Build the driver a game embeds. */
export function buildPceGameAudio(input: PceGameAudioInput): PceGameAudio {
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
    checkSelectDiscipline(script);
  }
  const clock = resolvePceClock(first);
  const binding = bindingFor(first.console);
  const boot = binding.init();
  const channels = binding.spec.channels.length;

  // Preemption machinery exists only when there is something to preempt: a game
  // with music and no effects packs the flat format, exactly as a schedule that
  // owns the chip would.
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
  // No `mergeRegs`: nothing on this chip is written by both streams.
  const packOptions = shared ? { channelOf: pcePackTag(stealable) } : {};

  let restricted = 0;
  const tracks = input.tracks.map((script) => stripBoot(script, boot));
  const effects = input.effects.map((effect) => {
    // The *binding's* tag rather than the packed one, because restriction is a
    // question about the hardware channel and not about the run field's index.
    const result = restrict(stripBoot(effect.script, boot), 1 << effect.channel, pceChannelTag());
    restricted += result.dropped;
    return result.script;
  });

  const musicData = tracks.map((script) => pack(script, packOptions));
  const effectData = effects.map((script) =>
    pack(script, { ...packOptions, end: "stop" as const }),
  );

  const state = layout(input.state);
  const helpers: string[] = [];
  let code = 0;
  let data = 0;

  const emitCode = (asm: Asm6502): void => {
    const start = asm.pc;
    emitInit(asm, state, clock.reload);
    emitClock(asm, state);
    emitTick(asm, state, input);
    if (input.tracks.length > 0) {
      emitMusicStart(asm, state, input);
      helpers.push(
        ...emitStream(asm, {
          prefix: "AudioMus",
          base: PSG_BASE,
          state: state.music,
          scratch: state.scratch,
          data: shapeOf(musicData),
          ...(shared ? { steal: state.steal } : {}),
        }).map((name) => `music-${name}`),
      );
    }
    if (input.effects.length > 0) {
      emitSfxStart(asm, state, input);
      emitRelease(asm, state, stealable);
      helpers.push(
        ...emitStream(asm, {
          prefix: "AudioSfx",
          base: PSG_BASE,
          state: state.sfx,
          scratch: state.scratch,
          data: shapeOf(effectData),
          onEnd: "AudioSfxRelease",
        }).map((name) => `sfx-${name}`),
      );
    }
    if (input.tracks.length > 0) emitSilence(asm, channels);
    code = asm.pc - start;
  };

  const emitData = (asm: Asm6502): void => {
    const start = asm.pc;
    // The chip's initialisation as a table rather than as instructions: nearly
    // two hundred writes, most of them a waveform, so a run of literal stores
    // would be a kilobyte of code to say what four hundred bytes of data say.
    asm.label("AudioBoot");
    for (const write of boot) asm.db(write.reg & 0xff, write.value & 0xff);
    asm.db(0xff); // no register is $FF, so one byte ends the walk
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
        const effect = input.effects[index] as GameEffect;
        asm.dw(label(`AudioSfxOrder${index}`));
        // The *packed* index, which is what the run headers carry; the hardware
        // channel is `stealable[index]` and only the release needs it.
        asm.db(1 << stealable.indexOf(effect.channel));
        asm.db(clampByte(effect.priority));
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
    get stats(): PceGameAudioStats {
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
 * Resolve a schedule's driver clock to the register that produces it.
 *
 * The reload is carried rather than re-derived, for the reason doc 16 gives: a
 * ROM programmes a register, and computing one back out of a rational would be a
 * second timing fit that could disagree with the first.
 */
export function resolvePceClock(script: ChipScript): PceGameAudio["clock"] {
  const { rate, source, divisor } = script.driver;
  if (source !== "timer") {
    throw new AudioRomError(
      "E_DRIVER_CLOCK",
      `the pce driver has no '${source}' clock`,
      "this CPU has a timer nothing else in a demade cartridge uses; re-arrange with `timer`.",
    );
  }
  if (divisor === undefined || divisor < 0 || divisor > MAX_TIMER_RELOAD) {
    throw new AudioRomError(
      "E_DRIVER_CLOCK",
      `${rateHz(rate)} Hz needs a timer reload of ${String(divisor)}, and the register holds 0–${MAX_TIMER_RELOAD}`,
      "this is a bug in the timing fit, not in the track.",
    );
  }
  return { rate, reload: divisor };
}

/**
 * Check that no tick leaves a channel register without the select that gives it
 * meaning.
 *
 * The whole of preemption on this chip rests on it, exactly as it does on an
 * SN76489 (`psg.ts` §`checkLatchDiscipline`): a run is a maximal group of writes
 * that agree about which channel they belong to, so a bare channel register can
 * only ever *start* a run if it is the first write of a tick — and a skipped run
 * whose select was in the tick before it would leave the next stream writing to
 * the wrong voice. The binding never emits one, which is exactly why this is
 * checked rather than worked around.
 */
export function checkSelectDiscipline(script: ChipScript): void {
  const global = new Set<number>([PSG.GLOBAL, PSG.LFO_FREQ, PSG.LFO_CONTROL]);
  for (let tick = 0; tick < script.ticks.length; tick += 1) {
    let selected = false;
    for (const write of script.ticks[tick]?.writes ?? []) {
      if (global.has(write.reg)) continue;
      if (write.reg === PSG.SELECT) {
        selected = true;
        continue;
      }
      if (!selected) {
        throw new AudioRomError(
          "E_PSG_SELECT",
          `tick ${tick} of an audio schedule writes a channel register with no select in front of it`,
          "this chip carries the channel in a register of its own, so a driver could not tell which voice the write belongs to; this is a bug in the binding, not in the track.",
        );
      }
    }
  }
}

// --- state -------------------------------------------------------------------

/** Where the driver keeps everything, laid out from the game's first free byte. */
interface Layout {
  music: MosStreamState;
  sfx: MosStreamState;
  scratch: MosScratch;
  /** Channels an effect has taken, in the packed run field's numbering. */
  steal: number;
  /** Priority of the effect playing, for the one that wants to interrupt it. */
  priority: number;
  musicReq: number;
  sfxReq: number;
  /** Timer ticks the handler counted that the main loop has not performed yet. */
  pending: number;
  /** One past the last byte used. */
  end: number;
}

function layout(base: number): Layout {
  let at = base;
  const take = (): number => at++;
  // The pointer pairs come first and adjacent, because they are dereferenced
  // where they lie: `lda (dataLo),y` reads the byte after `dataLo` as the high
  // half whether or not anyone meant it to.
  const music: MosStreamState = {
    dataLo: take(),
    dataHi: take(),
    orderLo: take(),
    orderHi: take(),
    loopLo: take(),
    loopHi: take(),
    rest: take(),
    active: take(),
  };
  // A sound effect stops rather than looping, so it needs no loop entry.
  const sfx: MosStreamState = {
    dataLo: take(),
    dataHi: take(),
    orderLo: take(),
    orderHi: take(),
    rest: take(),
    active: take(),
  };
  const scratch: MosScratch = { count: take(), flags: take() };
  const steal = take();
  const priority = take();
  const musicReq = take();
  const sfxReq = take();
  const pending = take();
  return { music, sfx, scratch, steal, priority, musicReq, sfxReq, pending, end: at };
}

// --- code --------------------------------------------------------------------

/**
 * Put the chip in a known state, clear the driver's own, and start the clock.
 *
 * The chip half is a walk over {@link buildPceGameAudio}'s boot table, because a
 * waveform is thirty-two writes and there are five of them: `binding/pce.ts`
 * uploads the shapes through the register port, so the initialisation this
 * console performs at boot is an order of magnitude longer than anything else in
 * the set. The walk borrows the run scratch as its pointer — the two bytes are
 * adjacent for the stream player's sake and nothing else is running yet.
 */
function emitInit(asm: Asm6502, state: Layout, reload: number): void {
  const { count, flags } = state.scratch;
  asm.label("AudioInit");
  asm.lda(immLow(label("AudioBoot")));
  asm.sta(zp(count));
  asm.lda(immHigh(label("AudioBoot")));
  asm.sta(zp(flags));
  asm.ldy(imm(0));

  asm.label("AudioInitNext");
  asm.lda(indY(count));
  asm.bmi("AudioInitDone"); // $FF ends it; no register on this chip is above $09
  asm.tax();
  emitStepPointer(asm, flags, "AudioInitLow");
  asm.lda(indY(count));
  asm.sta(absX(PSG_BASE));
  emitStepPointer(asm, flags, "AudioInitValue");
  asm.jmp("AudioInitNext");

  asm.label("AudioInitDone");
  asm.lda(imm(0));
  for (const byte of [
    state.music.active as number,
    state.sfx.active as number,
    state.music.rest,
    state.sfx.rest,
    state.steal,
    state.priority,
    state.musicReq,
    state.sfxReq,
    state.pending,
  ]) {
    asm.sta(zp(byte));
  }

  // The clock, last, so nothing can count a tick before there is a driver to
  // perform it. Starting a stopped timer reloads it, which is what makes these
  // two writes the whole of programming it.
  asm.lda(imm(reload & MAX_TIMER_RELOAD));
  asm.sta(abs(TIMER_RELOAD));
  asm.lda(imm(1));
  asm.sta(abs(TIMER_CONTROL));
  asm.rts();
}

/** Step Y one byte, carrying into the boot pointer's high half. */
function emitStepPointer(asm: Asm6502, high: number, name: string): void {
  asm.iny();
  asm.bne(name);
  asm.inc(zp(high));
  asm.label(name);
}

/**
 * The clock, as the two routines the game calls.
 *
 * `AudioFrame` counts a tick and stops counting at {@link MAX_PENDING}: a game
 * that has been stopped — a breakpoint, a scene change that took half a second —
 * would otherwise come back owing hundreds of ticks and perform them all in one
 * burst.
 *
 * `AudioService` performs them, one at a time, and is called from the main loop
 * rather than from the interrupt for the NES driver's reason: the vertical blank
 * belongs to the picture. What differs is that the counter here is a *timer*
 * rather than the frame, so a game running at sixty frames a second performs two
 * ticks a pass and a frame it overran costs it no tempo at all.
 */
function emitClock(asm: Asm6502, state: Layout): void {
  asm.label("AudioFrame");
  asm.lda(zp(state.pending));
  asm.cmp(imm(MAX_PENDING));
  asm.bcc("AudioFrameCount");
  asm.rts();
  asm.label("AudioFrameCount");
  asm.inc(zp(state.pending));
  asm.rts();

  asm.label("AudioService");
  asm.lda(zp(state.pending));
  asm.bne("AudioServiceGo");
  asm.rts();
  asm.label("AudioServiceGo");
  asm.dec(zp(state.pending));
  asm.jsr("AudioTick");
  asm.jmp("AudioService");
}

/**
 * One driver tick: take what the game asked for, then step each stream.
 *
 * Requests are single bytes rather than pointers because a rule writes them from
 * the game's own loop. One byte is written atomically; a pointer and a length
 * are not, and the tick that arrived between them would play half of one effect
 * and half of another.
 */
function emitTick(asm: Asm6502, state: Layout, input: PceGameAudioInput): void {
  asm.label("AudioTick");
  if (input.tracks.length > 0) {
    asm.lda(zp(state.musicReq));
    asm.beq("AudioTickNoMusic");
    asm.jsr("AudioMusicStart");
    asm.label("AudioTickNoMusic");
  }
  if (input.effects.length > 0) {
    asm.lda(zp(state.sfxReq));
    asm.beq("AudioTickNoSfx");
    asm.jsr("AudioSfxStart");
    asm.label("AudioTickNoSfx");
  }
  if (input.tracks.length > 0) asm.jsr("AudioMusTick");
  // Effects step after the music, so on a tick where both write the same
  // register the effect is the one the chip is left holding.
  if (input.effects.length > 0) asm.jmp("AudioSfxTick");
  else asm.rts();
}

/** Start the requested track, or stop the music. */
function emitMusicStart(asm: Asm6502, state: Layout, input: PceGameAudioInput): void {
  asm.label("AudioMusicStart");
  asm.sta(zp(state.scratch.count)); // the request, until the table lookup
  asm.lda(imm(0));
  asm.sta(zp(state.musicReq));

  // A scene change stops whatever was playing, effect included: the sound of the
  // old scene carrying into the new one is a bug in every game that has it.
  // Nothing playing means nothing to stop, and skipping the silencing there is
  // what makes the first track's first tick exactly the schedule's first tick.
  asm.lda(zp(state.music.active as number));
  if (input.effects.length > 0) asm.ora(zp(state.sfx.active as number));
  asm.beq("AudioMusicFresh");
  asm.lda(imm(0));
  asm.sta(zp(state.music.active as number));
  if (input.effects.length > 0) asm.jsr("AudioSfxRelease");
  asm.jsr("AudioSilence");

  asm.label("AudioMusicFresh");
  asm.lda(zp(state.scratch.count));
  asm.cmp(imm(STOP));
  asm.bne("AudioMusicTake");
  asm.rts();

  asm.label("AudioMusicTake");
  asm.sec();
  asm.sbc(imm(1));
  asm.asl(acc);
  asm.asl(acc); // four bytes per entry: order, then loop entry
  asm.tax();
  asm.lda(absX("AudioTracks"));
  asm.sta(zp(state.music.orderLo));
  asm.lda(absX(label("AudioTracks", 1)));
  asm.sta(zp(state.music.orderHi));
  asm.lda(absX(label("AudioTracks", 2)));
  asm.sta(zp(state.music.loopLo as number));
  asm.lda(absX(label("AudioTracks", 3)));
  asm.sta(zp(state.music.loopHi as number));
  asm.lda(imm(0));
  asm.sta(zp(state.music.rest));
  asm.jsr("AudioMusNextBlock");
  asm.lda(imm(1));
  asm.sta(zp(state.music.active as number));
  asm.rts();
}

/**
 * Fire the requested effect, unless the one playing outranks it.
 *
 * `x` carries the table offset across the call to `AudioSfxRelease`, which is
 * allowed because that routine touches `a` and its own bytes and nothing else —
 * and unlike the NES's, it has no merge to tail into, so the constraint costs
 * nothing to keep.
 */
function emitSfxStart(asm: Asm6502, state: Layout, input: PceGameAudioInput): void {
  asm.label("AudioSfxStart");
  asm.sta(zp(state.scratch.count));
  asm.lda(imm(0));
  asm.sta(zp(state.sfxReq));

  asm.lda(zp(state.scratch.count));
  asm.sec();
  asm.sbc(imm(1));
  asm.asl(acc);
  asm.asl(acc); // four bytes per entry: order, channel, priority
  asm.tax();

  if (input.effects.length > 1) {
    // Priority only means anything when two effects can collide.
    asm.lda(zp(state.sfx.active as number));
    asm.beq("AudioSfxTake");
    asm.lda(zp(state.priority));
    asm.cmp(absX(label("AudioEffects", 3)));
    asm.bcc("AudioSfxTake");
    asm.rts(); // what is playing ranks at least as high; the new one is dropped
  }

  asm.label("AudioSfxTake");
  asm.lda(imm(0));
  asm.sta(zp(state.sfx.active as number));
  asm.jsr("AudioSfxRelease");
  asm.lda(absX("AudioEffects"));
  asm.sta(zp(state.sfx.orderLo));
  asm.lda(absX(label("AudioEffects", 1)));
  asm.sta(zp(state.sfx.orderHi));
  asm.lda(absX(label("AudioEffects", 2)));
  asm.sta(zp(state.steal));
  asm.lda(absX(label("AudioEffects", 3)));
  asm.sta(zp(state.priority));
  asm.lda(imm(0));
  asm.sta(zp(state.sfx.rest));
  asm.jsr("AudioSfxNextBlock");
  asm.lda(imm(1));
  asm.sta(zp(state.sfx.active as number));
  asm.rts();
}

/**
 * Give back the channels an effect borrowed.
 *
 * A select and a zero each: the enable bit and the volume are the same byte, so
 * there is nothing else to clear and no shared register to recompute. The music
 * picks the channel up again at its next note rather than being restored —
 * keeping a shadow of every register on every channel to hide a gap of a few
 * ticks is the Game Boy driver's rejected trade, rejected here for the same
 * reason.
 *
 * **Clobbers `a` only**, because `x` is live in the caller.
 */
function emitRelease(asm: Asm6502, state: Layout, stealable: readonly number[]): void {
  asm.label("AudioSfxRelease");
  asm.lda(zp(state.steal));
  asm.bne("AudioSfxReleaseDo");
  asm.rts();
  asm.label("AudioSfxReleaseDo");
  for (let index = 0; index < stealable.length; index += 1) {
    const skip = `AudioRelease${index}`;
    if (stealable.length > 1) {
      asm.lda(zp(state.steal));
      asm.and(imm(1 << index));
      asm.beq(skip);
    }
    asm.lda(imm(stealable[index] as number));
    asm.sta(abs(SELECT));
    asm.lda(imm(0));
    asm.sta(abs(CONTROL));
    if (stealable.length > 1) asm.label(skip);
  }
  asm.lda(imm(0));
  asm.sta(zp(state.steal));
  asm.sta(zp(state.sfx.active as number));
  asm.rts();
}

/**
 * Turn every channel off — what stopping the music means.
 *
 * A loop rather than a run of stores, because `stx` reaches an absolute address
 * on this CPU and the channel number is the only thing that changes. It clobbers
 * `x`, which is why the caller does its table lookup afterwards.
 */
function emitSilence(asm: Asm6502, channels: number): void {
  asm.label("AudioSilence");
  asm.lda(imm(0));
  asm.ldx(imm(channels - 1));
  asm.label("AudioSilenceNext");
  asm.stx(abs(SELECT));
  asm.sta(abs(CONTROL));
  asm.dex();
  asm.bpl("AudioSilenceNext");
  asm.rts();
}
