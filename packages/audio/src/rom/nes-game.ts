/**
 * The 2A03 audio driver a *game* embeds (doc 16 §Two streams, one clock).
 *
 * `gb-game.ts`'s counterpart, one console over, and it answers the same three
 * questions — who owns a channel right now, what a shared register does, and
 * where the tick comes from. Two of the answers are the Game Boy's restated for
 * different hardware; the third is genuinely this machine's.
 *
 *   - **One interrupt, one rate — and here it is the picture's.** The NES has no
 *     general-purpose timer a driver can have without burning the DMC channel,
 *     so the honest clock is the frame: `binding/nes.ts` fits every schedule to
 *     the console's own frame rate and the game steps the driver once per NMI.
 *     That is what the machine's own games did, and it is why an effect's attack
 *     resolves to a frame here where it resolves to half of one on a Game Boy.
 *   - **Preemption is by run, not by write** — `data.ts`'s run format,
 *     unchanged, because it is a property of the schedule rather than of the CPU.
 *   - **`$4015` is merged, never stored.** One byte enables every channel, so a
 *     stream that stored it would silence the other stream's notes. Each stream
 *     keeps a shadow and the driver folds them under the steal mask, which means
 *     that with nothing preempting, the byte the chip receives is exactly the
 *     one the schedule asked for. The Game Boy's `NR51` is the same problem and
 *     this is the same answer — with one nicety: the enable mask's bits *are*
 *     the channel mask's bits, so there is no nibble to swap.
 *
 * Silencing is where the two chips stop looking alike. A Game Boy channel is
 * turned off by powering its DAC down, one register each; a 2A03 channel is
 * turned off by clearing its bit in `$4015`, which the merge already computes.
 * So a released channel and a stopped track are both a shadow set to zero and
 * one recomputed byte — cheaper than the Game Boy's four writes, and it is the
 * hardware being simpler rather than the driver being cleverer.
 *
 * Sources:
 * - NESdev Wiki — APU: https://www.nesdev.org/wiki/APU
 * - NESdev Wiki — APU Frame Counter: https://www.nesdev.org/wiki/APU_Frame_Counter
 */

import { abs, Asm6502, absX, acc, imm, label, zp } from "@demake/core";

import type { ChipScript, Rational } from "../chipscript.js";
import { bindingFor } from "../binding/registry.js";

import type { DriverData } from "./data.js";
import { AudioRomError } from "./gb.js";
import type { GameEffect } from "./gb-game.js";
import {
  APU_BASE,
  emitStream,
  emitStreamData,
  type NesScratch,
  type NesStreamState,
} from "./nes-driver.js";
import { clampByte, MAX_PENDING, pack, rateHz, restrict, shapeOf, stripBoot } from "./shared.js";

/** The value that stops the music, rather than starting a track. */
export const STOP = 0xff;

/**
 * The channel enable mask: the one register two streams both have to write.
 *
 * Addressed absolutely (`sta $4015`) everywhere below, never through the stream
 * player's `$4000,x` form. It is shorter — three bytes against five — and, less
 * obviously, it is what lets the merge be called with `x` live: `AudioSfxStart`
 * carries a table offset in it across `AudioSfxRelease`, which tails into the
 * merge, and an `ldx` in there would silently read the wrong effect's entry.
 */
const SND_CHN = 0x4015;

/**
 * Channel bits by register: which voice a 2A03 register belongs to.
 *
 * Four registers each, in channel order, which is why this is arithmetic rather
 * than a table. `$4010`–`$4013` are the DMC's and `$4015`/`$4017` belong to no
 * single channel — the first because nothing arranges for it, the second two
 * because they are the chip's, which is exactly what makes them a merge and a
 * boot write rather than a stream's own.
 */
export function nesChannelOf(reg: number): number {
  if (reg < 0x00 || reg > 0x0f) return 0;
  return 1 << (reg >> 2);
}

/** What the game hands the driver builder. */
export interface NesGameAudioInput {
  /** One schedule per track, in the order the game refers to them. */
  tracks: readonly ChipScript[];
  /** One per effect, likewise. */
  effects: readonly GameEffect[];
  /** First page-zero byte the driver may use; it needs {@link NES_AUDIO_BYTES}. */
  state: number;
}

/**
 * Page-zero bytes the driver's state occupies.
 *
 * Page zero and not work RAM, and it is not an optimisation: the two stream
 * pointers are *dereferenced*, and `($nn),y` is the only indirection this CPU
 * has. Everything else is here because it is next to them, and because a byte
 * the driver reads on every tick is a byte worth a cycle.
 *
 * Counted from the allocator rather than written down, so the two cannot drift.
 */
export const NES_AUDIO_BYTES = layout(0).end;

/** Sizes and reductions, reported rather than assumed. */
export interface NesGameAudioStats {
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
   * for a cartridge that owns the chip and wrong for one borrowing a channel
   * from the music. Counted rather than quietly discarded, on the "never lose a
   * part silently" rule.
   */
  writesRestricted: number;
}

/** A built game driver: what to emit, where, and what it will really play. */
export interface NesGameAudio {
  /**
   * How the game must drive it.
   *
   * `ticksPerFrame` is the whole of the clock on this console: there is no
   * reload to program and no vector to claim, only a number of times to call
   * `AudioTick` for every frame that has passed. One, for every schedule the
   * arranger fits to the frame rate — which is all of them today, and the field
   * exists so a finer one is a number rather than a rewrite.
   */
  clock: { ticksPerFrame: number; rate: Rational };
  /**
   * The two routines the game's own code has to call.
   *
   * `frame` goes in the NMI and does nothing but count the frame; `service`
   * goes in the main loop and performs whatever ticks have been counted. The
   * split is the whole of the console's clock discipline: the picture's
   * interrupt is what keeps the tempo honest, and doing the work outside it is
   * what keeps the vertical blank for the picture. A frame the game overran is
   * caught up rather than lost, which is why the counter exists at all.
   *
   * `frame` clobbers `a` and nothing else. `service` clobbers everything.
   */
  routines: { frame: string; service: string };
  /** Page-zero bytes the game writes to ask for something. */
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
  /**
   * The schedules as the ROM will really perform them.
   *
   * Not the same objects that went in: the chip's initialisation is performed
   * once at boot rather than at the head of every stream, and an effect is
   * restricted to its own channel. Both are stated here so the conformance
   * harness diffs against what the driver actually promises (doc 16 §The proof).
   */
  performed: { tracks: readonly ChipScript[]; effects: readonly ChipScript[] };
  stats: NesGameAudioStats;
}

/** Build the driver a game embeds. */
export function buildNesGameAudio(input: NesGameAudioInput): NesGameAudio {
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
  const clock = resolveNesClock(first);
  const boot = bindingFor(first.console).init();

  // Preemption machinery exists only when there is something to preempt: a game
  // with music and no effects packs the flat format and stores `$4015` outright,
  // exactly as a cartridge that owns the chip does.
  const shared = input.tracks.length > 0 && input.effects.length > 0;
  const packOptions = shared
    ? { channelOf: () => nesChannelOf, mergeRegs: new Set([SND_CHN - APU_BASE]) }
    : {};

  let restricted = 0;
  const tracks = input.tracks.map((script) => stripBoot(script, boot));
  const effects = input.effects.map((effect) => {
    const owned = 1 << effect.channel;
    const result = restrict(stripBoot(effect.script, boot), owned, nesChannelOf);
    restricted += result.dropped;
    return result.script;
  });

  const musicData = tracks.map((script) => pack(script, packOptions));
  const effectData = effects.map((script) =>
    pack(script, { ...packOptions, end: "stop" as const }),
  );

  const state = layout(input.state);
  const bootEnable = boot.find((write) => write.reg === SND_CHN - APU_BASE)?.value ?? 0;

  const helpers: string[] = [];
  let code = 0;
  let data = 0;

  const emitCode = (asm: Asm6502): void => {
    const start = asm.pc;
    emitInit(asm, state, boot, bootEnable);
    emitClock(asm, state, clock.ticksPerFrame);
    emitTick(asm, state, input);
    if (input.tracks.length > 0) {
      emitMusicStart(asm, state, input);
      helpers.push(
        ...emitStream(asm, {
          prefix: "AudioMus",
          state: state.music,
          scratch: state.scratch,
          data: shapeOf(musicData),
          ...(shared ? { steal: state.steal, merge: "AudioMusEnable" } : {}),
        }).map((name) => `music-${name}`),
      );
    }
    if (input.effects.length > 0) {
      emitSfxStart(asm, state, input);
      emitRelease(asm, state, shared);
      helpers.push(
        ...emitStream(asm, {
          prefix: "AudioSfx",
          state: state.sfx,
          scratch: state.scratch,
          data: shapeOf(effectData),
          onEnd: "AudioSfxRelease",
          ...(shared ? { merge: "AudioSfxEnable" } : {}),
        }).map((name) => `sfx-${name}`),
      );
    }
    if (input.tracks.length > 0) emitSilence(asm, state, shared);
    if (shared) {
      emitMerge(asm, state);
      helpers.push("enable-merge");
    }
    code = asm.pc - start;
  };

  const emitData = (asm: Asm6502): void => {
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
    get stats(): NesGameAudioStats {
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
 * The NES's answer to `resolveClock`, and it is shorter for a reason worth
 * stating: there is no register to recover here, because there is no timer. The
 * binding fits every rate to a whole multiple of the console's frame rate
 * (`binding/nes.ts` §fitRate), so the only thing to resolve is *which* multiple —
 * and a rate that is not one is a bug in the fit rather than something to round.
 */
export function resolveNesClock(script: ChipScript): NesGameAudio["clock"] {
  const { rate, source } = script.driver;
  if (source !== "vblank") {
    throw new AudioRomError(
      "E_DRIVER_CLOCK",
      `the nes driver has no '${source}' clock`,
      "the NES's driver runs on the frame; re-arrange with `vblank`.",
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
  music: NesStreamState;
  sfx: NesStreamState;
  scratch: NesScratch;
  /** Channels an effect has taken. */
  steal: number;
  /** Each stream's intended `$4015`, which the merge folds together. */
  enableMusic: number;
  enableSfx: number;
  /** The merge's own byte, because the run walk's scratch is live when it runs. */
  merged: number;
  /** Priority of the effect playing, for the one that wants to interrupt it. */
  priority: number;
  musicReq: number;
  sfxReq: number;
  /** Frames counted by the NMI that the main loop has not performed yet. */
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
  const music: NesStreamState = {
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
  const sfx: NesStreamState = {
    dataLo: take(),
    dataHi: take(),
    orderLo: take(),
    orderHi: take(),
    rest: take(),
    active: take(),
  };
  const scratch: NesScratch = { count: take(), flags: take() };
  const steal = take();
  const enableMusic = take();
  const enableSfx = take();
  const merged = take();
  const priority = take();
  const musicReq = take();
  const sfxReq = take();
  const pending = take();
  return {
    music,
    sfx,
    scratch,
    steal,
    enableMusic,
    enableSfx,
    merged,
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
 * NMI is already running for the picture's sake and the driver rides it.
 */
function emitInit(
  asm: Asm6502,
  state: Layout,
  boot: readonly { reg: number; value: number }[],
  bootEnable: number,
): void {
  asm.label("AudioInit");
  let held: number | undefined;
  for (const write of boot) {
    if (held !== write.value) {
      asm.lda(imm(write.value));
      held = write.value;
    }
    // Absolute, because the register is a constant here: three bytes against the
    // five an index would cost, and the boot list is the longest run of them.
    asm.sta(abs(APU_BASE + write.reg));
  }

  asm.lda(imm(0));
  for (const byte of [
    state.music.active as number,
    state.sfx.active as number,
    state.music.rest,
    state.sfx.rest,
    state.steal,
    state.enableSfx,
    state.priority,
    state.musicReq,
    state.sfxReq,
    state.pending,
  ]) {
    asm.sta(zp(byte));
  }
  // The music's shadow starts at what the boot writes left in `$4015`, so the
  // first merge folds against the truth rather than against a guess.
  if (bootEnable !== 0) asm.lda(imm(bootEnable));
  asm.sta(zp(state.enableMusic));
  asm.rts();
}

/**
 * The clock, as the two routines the game calls.
 *
 * `AudioFrame` counts a frame and stops counting at {@link MAX_PENDING}: a game
 * that has been stopped — a tab in the background, a breakpoint, a scene change
 * that took half a second — would otherwise come back owing hundreds of ticks
 * and perform them all in one burst. Four is enough to ride out any frame a game
 * really overruns and short enough that the burst is inaudible.
 *
 * `AudioService` performs them, `ticksPerFrame` at a time, and it is called from
 * the main loop rather than from the interrupt for one reason: the vertical
 * blank belongs to the picture. A driver tick in there is a driver tick the
 * tilemap upload is waiting behind.
 */
function emitClock(asm: Asm6502, state: Layout, ticksPerFrame: number): void {
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
  for (let tick = 0; tick < ticksPerFrame; tick += 1) asm.jsr("AudioTick");
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
function emitTick(asm: Asm6502, state: Layout, input: NesGameAudioInput): void {
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
function emitMusicStart(asm: Asm6502, state: Layout, input: NesGameAudioInput): void {
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
 * allowed because that routine and the merge it tails into touch `a` and their
 * own byte and nothing else. It is stated here because it is a rule the callee
 * has to keep, not something the assembler can check.
 */
function emitSfxStart(asm: Asm6502, state: Layout, input: NesGameAudioInput): void {
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
 * On this chip that is one byte: the channels are silenced by clearing their
 * bits in `$4015`, which is what the merge computes anyway once the effect's
 * shadow is empty. The music picks them up again at its next note rather than
 * being restored — keeping a shadow of every register on every channel to hide a
 * gap of a few ticks is the Game Boy driver's rejected trade, and it is rejected
 * here for the same reason.
 */
function emitRelease(asm: Asm6502, state: Layout, shared: boolean): void {
  asm.label("AudioSfxRelease");
  asm.lda(zp(state.steal));
  asm.bne("AudioSfxReleaseDo");
  asm.rts();
  asm.label("AudioSfxReleaseDo");
  asm.lda(imm(0));
  asm.sta(zp(state.steal));
  asm.sta(zp(state.sfx.active as number));
  if (shared) {
    asm.sta(zp(state.enableSfx));
    asm.jmp("AudioEnable");
  } else {
    // With no music there is nothing to preserve, so the effect's channels go
    // off by the shortest route the chip offers.
    asm.sta(zp(state.enableSfx));
    asm.sta(abs(SND_CHN));
    asm.rts();
  }
}

/**
 * Stop everything the music is playing — what stopping the music means.
 *
 * The enable mask alone, because on this chip a channel whose bit is clear is
 * silent whatever its own registers still hold.
 */
function emitSilence(asm: Asm6502, state: Layout, shared: boolean): void {
  asm.label("AudioSilence");
  asm.lda(imm(0));
  asm.sta(zp(state.enableMusic));
  if (shared) {
    asm.jmp("AudioEnable");
  } else {
    asm.sta(abs(SND_CHN));
    asm.rts();
  }
}

/**
 * Fold the two enable shadows under the steal mask and write `$4015`.
 *
 * The channel mask and the register's own bits are the same four bits, so the
 * fold is two `and`s and an `ora` — where the Game Boy's panning byte needs a
 * nibble swapped first because its two bits per channel are four apart.
 *
 * **Clobbers `a` and its own byte, and nothing else.** `x` is live in
 * `AudioSfxStart`, and `y` and both scratch bytes are live in the run walk that
 * calls this per merge write; all three have to survive, which is why the write
 * is absolute rather than indexed.
 */
function emitMerge(asm: Asm6502, state: Layout): void {
  asm.label("AudioSfxEnable");
  asm.sta(zp(state.enableSfx));
  asm.jmp("AudioEnable");

  asm.label("AudioMusEnable");
  asm.sta(zp(state.enableMusic));

  asm.label("AudioEnable");
  asm.lda(zp(state.steal));
  asm.and(zp(state.enableSfx));
  asm.sta(zp(state.merged));
  asm.lda(zp(state.steal));
  asm.eor(imm(0xff));
  asm.and(zp(state.enableMusic));
  asm.ora(zp(state.merged));
  asm.sta(abs(SND_CHN));
  asm.rts();
}
