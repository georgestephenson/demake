/**
 * The SN76489 audio driver a *game* embeds, on a Mega Drive (doc 16 §Two
 * streams, one clock).
 *
 * The fourth of these and the first to drive **two chips**: six four-operator FM
 * voices and four tone generators, on one board and one driver tick. Everything
 * either chip decides lives in `md-chips.ts` and `psg.ts`; what is left is the
 * console's, and there are three answers worth reading:
 *
 *   - **The packed register byte says which of five places a write goes.** The FM
 *     chip's four bus addresses and the PSG's one. That is the same byte every
 *     other console spends on a register number, carrying more here because this
 *     console has more hardware to reach — and it is why two chips cost the
 *     packed format nothing.
 *   - **Ten voices, and a four-bit channel field.** They do not have to fit: what
 *     preemption asks is whether an effect may be using a voice, so only the
 *     voices effects were placed on are numbered and everything else tags zero.
 *     The FM half of a track therefore plays *through* an effect rather than
 *     ducking for it, which is better than what a four-voice console can manage
 *     and is the hardware's doing rather than the driver's.
 *   - **Nothing is shared between the two streams.** A Game Boy has `NR51`, an
 *     NES has `$4015` and a Game Gear has its stereo latch; here panning is a
 *     per-voice FM register and the PSG has none, so no merge routine is emitted
 *     at all. Silencing is two gestures rather than one — a key-off for an FM
 *     voice, an attenuation latch for a tone one.
 *
 *   The clock is the frame, as on the Sega 8-bits and the NES: the handler counts
 *   frames and the main loop performs what it owes, which is how the blanking
 *   interval stays the tilemap upload's.
 *
 * Sources:
 * - Plutiedev — the PSG at $C00011: https://plutiedev.com/psg-chip
 * - Plutiedev — the YM2612 at $A04000: https://plutiedev.com/ym2612-registers
 * - SMS Power! — SN76489: https://www.smspower.org/Development/SN76489
 */

import { Asm68k, eaAbs, eaD, eaDisp, eaImm, eaPost, label } from "@demake/core";

import type { ChipScript, Rational } from "../chipscript.js";
import { bindingFor } from "../binding/registry.js";

import type { DriverData } from "./data.js";
import { AudioRomError } from "./gb.js";
import type { GameEffect } from "./gb-game.js";
import {
  emitStream,
  emitStreamData,
  PSG_ADDRESS,
  YM_ADDRESS,
  type MdStreamState,
} from "./md-driver.js";
import {
  checkMdLatchDiscipline,
  mdChannelTag,
  mdPort,
  mdShadowBytes,
  mdShadowInit,
  mdShadowPlan,
  mdSilenceWrites,
  MD_FM_CHANNELS,
  PSG_CHIP,
  YM_CHIP,
  checkMdPairDiscipline,
  emitZ80Handover,
  type MdShadowChannel,
} from "./md-chips.js";
import { clampByte, MAX_PENDING, pack, rateHz, restrict, shapeOf, stripBoot } from "./shared.js";

/** The value that stops the music, rather than starting a track. */
export const STOP = 0xff;

/**
 * How far to shift an index to reach one table entry: eight bytes, in both.
 *
 * A power of two so the lookup is a shift rather than a `mulu.w`, which on this
 * CPU is seventy cycles. A track needs eight of them (two longwords) and an
 * effect needs six, so the effect table pads — two bytes an entry, on a cartridge
 * with half a megabyte, to keep both lookups one instruction.
 */
const ENTRY_SHIFT = 3;

/** What the game hands the driver builder. */
export interface MdGameAudioInput {
  /** One schedule per track, in the order the game refers to them. */
  tracks: readonly ChipScript[];
  /** One per effect, likewise. */
  effects: readonly GameEffect[];
  /** First work-RAM byte the driver may use; it needs {@link MD_AUDIO_BYTES}. */
  state: number;
}

/**
 * Work-RAM bytes the driver's state occupies.
 *
 * Counted from the allocator rather than written down, so the two cannot drift.
 * The base has to be **even**, which `MemoryPlan.align` gives it: five of these
 * bytes' worth are longword pointers, and a `move.l` from an odd address is an
 * address error rather than a wrong note.
 */
/**
 * Worst case for the borrowed-voice copies.
 *
 * Every voice the packed run format can number, each with a window as wide as an
 * FM voice's addresses — `$28`, the key register, up to `$B4`. A tone voice takes
 * three bytes and is nowhere near it, so this covers both. Reserved rather than
 * fitted, because the memory plan is settled before the game's effects are
 * demade — and with 64 KiB of work RAM there is nothing to weigh it against.
 */
const SHADOW_MAX = 4 * (0xb4 - 0x28 + 1);

export const MD_AUDIO_BYTES = layout(0, SHADOW_MAX).end;

/** Sizes and reductions, reported rather than assumed. */
export interface MdGameAudioStats {
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
export interface MdGameAudio {
  /**
   * How the game must drive it.
   *
   * The NES's and the Sega 8-bits' shape, for their reason: there is no reload to
   * program and no vector to claim, only a number of times to call `AudioTick`
   * for every frame that has passed.
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
   * `frame` clobbers `d0` and the flags and nothing else, which is why the
   * emitter's `Vint` saves `d0` alone. `service` clobbers everything.
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
  emitCode(asm: Asm68k): void;
  /** Emit the tables and the packed streams. */
  emitData(asm: Asm68k): void;
  /**
   * The schedules as the ROM will really perform them.
   *
   * Not the same objects that went in: the chip's initialisation is performed
   * once at boot rather than at the head of every stream, and an effect is
   * restricted to its own channel. Both are stated here so the conformance
   * harness diffs against what the driver actually promises (doc 16 §The proof).
   */
  performed: { tracks: readonly ChipScript[]; effects: readonly ChipScript[] };
  stats: MdGameAudioStats;
}

/** Build the driver a game embeds. */
export function buildMdGameAudio(input: MdGameAudioInput): MdGameAudio {
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
  for (const script of scripts) {
    checkMdLatchDiscipline(script);
    checkMdPairDiscipline(script);
  }

  const clock = resolveMdClock(first);
  const boot = bindingFor(first.console).init();

  // Preemption machinery exists only when there is something to preempt: a game
  // with music and no effects packs the flat format, exactly as a cartridge that
  // owns the chips does.
  const shared = input.tracks.length > 0 && input.effects.length > 0;
  // Ten voices against a four-bit channel field: what the field has to hold is
  // not "which voice is this" but "may an effect be using it", so only the
  // voices effects were actually placed on are numbered. Everything else — the
  // whole FM half of a track, usually — tags zero and plays straight through an
  // effect instead of ducking for it (`md-chips.ts` §mdChannelTag).
  const stealable = [...new Set(input.effects.map((effect) => effect.channel))].sort(
    (a, b) => a - b,
  );
  if (stealable.length > 4) {
    throw new AudioRomError(
      "E_TOO_MANY_EFFECT_CHANNELS",
      `this game's effects are spread over ${stealable.length} voices and the packed run format numbers four`,
      "the sound demaker places an effect on one pitched voice and one noise voice; this is a bug in the build, not in the effects.",
    );
  }
  const channelOf = mdChannelTag(stealable);
  // Always the run format on this console, even with nothing to preempt: a tick
  // that installs six four-operator patches is four hundred writes, and a run's
  // count is seven bits. The flags byte per run is what buys the chaining.
  const packOptions = { channelOf, port: mdPort };
  void shared;

  let restricted = 0;
  const tracks = input.tracks.map((script) => stripBoot(script, boot));
  const effects = input.effects.map((effect) => {
    const owned = 1 << stealable.indexOf(effect.channel);
    const result = restrict(stripBoot(effect.script, boot), owned, channelOf());
    restricted += result.dropped;
    return result.script;
  });

  const musicData = tracks.map((script) => pack(script, packOptions));
  const effectData = effects.map((script) =>
    pack(script, { ...packOptions, end: "stop" as const }),
  );

  // What the music has to remember so a borrowed voice comes back holding the
  // music's own note rather than the effect's last one. Neither chip on this
  // board has a register number the packed byte carries, so the plan is
  // `md-chips.ts`'s rather than `shared.ts`'s.
  const copies = shared ? mdShadowPlan(tracks, stealable) : [];
  const state = layout(input.state, mdShadowBytes(copies));

  const helpers: string[] = [];
  let code = 0;
  let data = 0;

  const emitCode = (asm: Asm68k): void => {
    const start = asm.pc;
    emitInit(asm, state, boot, copies);
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
          ...(copies.length > 0
            ? { shadow: { at: state.shadow, latch: state.fmLatch, channels: copies } }
            : {}),
        }).map((name) => `music-${name}`),
      );
    }
    if (input.effects.length > 0) {
      emitSfxStart(asm, state, input);
      emitRelease(asm, state, stealable, copies);
      helpers.push(
        ...emitStream(asm, {
          prefix: "AudioSfx",
          state: state.sfx,
          data: shapeOf(effectData),
          onEnd: "AudioSfxRelease",
        }).map((name) => `sfx-${name}`),
      );
    }
    if (input.tracks.length > 0) emitSilence(asm);
    code = asm.pc - start;
  };

  const emitData = (asm: Asm68k): void => {
    asm.align();
    const start = asm.pc;
    if (input.tracks.length > 0) {
      asm.label("AudioTracks");
      for (let index = 0; index < musicData.length; index += 1) {
        const track = musicData[index] as DriverData;
        asm.dl(label(`AudioMusOrder${index}`));
        asm.dl(label(`AudioMusOrder${index}`, track.loopOrderIndex * 4));
      }
    }
    if (input.effects.length > 0) {
      asm.label("AudioEffects");
      for (let index = 0; index < effectData.length; index += 1) {
        asm.dl(label(`AudioSfxOrder${index}`));
        asm.db(1 << stealable.indexOf((input.effects[index] as GameEffect).channel));
        asm.db(clampByte((input.effects[index] as GameEffect).priority));
        asm.dw(0); // padding to ENTRY_BYTES, so the lookup is a shift
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
    get stats(): MdGameAudioStats {
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
 * `resolveSmsClock` with a different error message, and it is short for the same
 * reason: there is no timer the driver can hold a tempo on, so `gameDriverRate`
 * asks the binding for exactly the console's frame rate and `psgBinding.fitRate`
 * hands it back unchanged. A rate that is not a whole multiple of the frame is a
 * bug in the fit rather than something to round.
 */
export function resolveMdClock(script: ChipScript): MdGameAudio["clock"] {
  const { rate, source } = script.driver;
  if (source !== "vblank") {
    throw new AudioRomError(
      "E_DRIVER_CLOCK",
      `the md driver has no '${source}' clock`,
      "the 68000 has no timer of its own and this VDP's line interrupt is a raster effect; re-arrange with `vblank`.",
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
  music: MdStreamState;
  sfx: MdStreamState;
  /** First byte of the music's copy of the borrowable voices. */
  shadow: number;
  /** The FM address the music's stream last latched (`md-driver.ts`). */
  fmLatch: number;
  /** Channels an effect has taken. */
  steal: number;
  /** Priority of the effect playing, for the one that wants to interrupt it. */
  priority: number;
  musicReq: number;
  sfxReq: number;
  /** Frames counted by the interrupt that the main loop has not performed yet. */
  pending: number;
  /** One past the last byte used. */
  end: number;
}

/**
 * The pointers first, then the bytes.
 *
 * Not a style choice: a `move.l` to an odd address is an address error on this
 * CPU, and the block's base is even because the allocator aligns anything wider
 * than a byte. Putting a byte field between two longwords would push the second
 * one odd and fault at the first tick.
 */
function layout(base: number, shadowBytes: number): Layout {
  let at = base;
  const long = (): number => {
    const address = at;
    at += 4;
    return address;
  };
  const byte = (): number => {
    const address = at;
    at += 1;
    return address;
  };
  const musicData = long();
  const musicOrder = long();
  const musicLoop = long();
  // A sound effect stops rather than looping, so it needs no loop entry.
  const sfxData = long();
  const sfxOrder = long();
  const music: MdStreamState = {
    data: musicData,
    order: musicOrder,
    loop: musicLoop,
    rest: byte(),
    active: byte(),
  };
  const sfx: MdStreamState = {
    data: sfxData,
    order: sfxOrder,
    rest: byte(),
    active: byte(),
  };
  const steal = byte();
  const priority = byte();
  const musicReq = byte();
  const sfxReq = byte();
  const pending = byte();
  const fmLatch = byte();
  const shadow = at;
  at += shadowBytes;
  return { music, sfx, shadow, fmLatch, steal, priority, musicReq, sfxReq, pending, end: at };
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
  asm: Asm68k,
  state: Layout,
  boot: readonly { reg: number; value: number }[],
  copies: readonly MdShadowChannel[],
): void {
  asm.label("AudioInit");
  // Before a single register write, because the second of these two stores is
  // the *FM chip's* reset and the writes below are discarded while it is held
  // (`md-chips.ts` §emitZ80Handover). It is here rather than in the game's own
  // boot for the reason every helper in this project is pulled: a game with no
  // audio emits neither store, because it emits no `AudioInit`.
  emitZ80Handover(asm);
  for (const write of boot) emitChipWrite(asm, write);
  // Each borrowable voice's copy starts at what the boot writes left in its
  // registers, so a replay before the music has stated anything restores the
  // chip's power-up condition rather than a guess.
  const seeded = mdShadowInit(boot, copies, mdShadowBytes(copies));
  for (let byte = 0; byte < seeded.length; byte += 1) {
    const value = seeded[byte] as number;
    if (value === 0) asm.clr("b", eaAbs(state.shadow + byte));
    else asm.move("b", eaImm(value), eaAbs(state.shadow + byte));
  }
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
    state.fmLatch,
  ]) {
    asm.clr("b", eaAbs(byte));
  }
  asm.rts();
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
function emitClock(asm: Asm68k, state: Layout, ticksPerFrame: number): void {
  asm.label("AudioFrame");
  asm.move("b", eaAbs(state.pending), eaD(0));
  asm.cmpi("b", MAX_PENDING, eaD(0));
  asm.bcc("cc", "AudioFrameDone");
  asm.addq("b", 1, eaD(0));
  asm.move("b", eaD(0), eaAbs(state.pending));
  asm.label("AudioFrameDone");
  asm.rts();

  asm.label("AudioService");
  asm.move("b", eaAbs(state.pending), eaD(0));
  asm.bcc("eq", "AudioServiceDone");
  asm.subq("b", 1, eaD(0));
  asm.move("b", eaD(0), eaAbs(state.pending));
  for (let tick = 0; tick < ticksPerFrame; tick += 1) asm.bsr("AudioTick");
  asm.bra("AudioService");
  asm.label("AudioServiceDone");
  asm.rts();
}

/**
 * One driver tick: take what the game asked for, then step each stream.
 *
 * Requests are single bytes rather than pointers because a rule writes them from
 * the game's own loop. One byte is written atomically; a pointer and a length are
 * not, and the tick that arrived between them would play half of one effect and
 * half of another.
 */
function emitTick(asm: Asm68k, state: Layout, input: MdGameAudioInput): void {
  asm.label("AudioTick");
  if (input.tracks.length > 0) {
    asm.move("b", eaAbs(state.musicReq), eaD(0));
    asm.bcc("eq", "AudioTickNoMusic");
    asm.bsr("AudioMusicStart");
    asm.label("AudioTickNoMusic");
  }
  if (input.effects.length > 0) {
    asm.move("b", eaAbs(state.sfxReq), eaD(0));
    asm.bcc("eq", "AudioTickNoSfx");
    asm.bsr("AudioSfxStart");
    asm.label("AudioTickNoSfx");
  }
  if (input.tracks.length > 0) asm.bsr("AudioMusTick");
  // Effects step after the music, so on a tick where both write the same channel
  // the effect is the one the chip is left holding.
  if (input.effects.length > 0) asm.bra("AudioSfxTick");
  else asm.rts();
}

/**
 * Start the requested track, or stop the music.
 *
 * The request arrives in `d0` and is kept in `d4` across the silencing, because
 * `AudioSfxRelease` and `AudioSilence` both clobber `d0`. `d4` is the one
 * register neither of them touches, which is the 68000's version of the Sega
 * driver's "the mask is in `c` because `b` is live in the caller".
 */
function emitMusicStart(asm: Asm68k, state: Layout, input: MdGameAudioInput): void {
  asm.label("AudioMusicStart");
  asm.move("b", eaD(0), eaD(4)); // the request, until the table lookup
  asm.clr("b", eaAbs(state.musicReq));

  // A scene change stops whatever was playing, effect included: the sound of the
  // old scene carrying into the new one is a bug in every game that has it.
  // Nothing playing means nothing to stop, and skipping the silencing there is
  // what makes the first track's first tick exactly the schedule's first tick.
  asm.move("b", eaAbs(state.music.active as number), eaD(0));
  if (input.effects.length > 0) asm.or("b", eaAbs(state.sfx.active as number), 0);
  asm.bcc("eq", "AudioMusicFresh");
  asm.clr("b", eaAbs(state.music.active as number));
  if (input.effects.length > 0) asm.bsr("AudioSfxRelease");
  asm.bsr("AudioSilence");

  asm.label("AudioMusicFresh");
  asm.cmpi("b", STOP, eaD(4));
  asm.bcc("eq", "AudioMusicDone");

  emitEntry(asm, 4, "AudioTracks");
  asm.move("l", eaPost(0), eaAbs(state.music.order));
  asm.move("l", eaPost(0), eaAbs(state.music.loop as number));
  asm.clr("b", eaAbs(state.music.rest));
  asm.bsr("AudioMusNextBlock");
  asm.move("b", eaImm(1), eaAbs(state.music.active as number));
  asm.label("AudioMusicDone");
  asm.rts();
}

/**
 * Point `a0` at table entry `dn - 1`.
 *
 * The index is widened before the shift, because `move.b` leaves a register's
 * high three bytes alone and `lsl.l` would then shift whatever was above the
 * byte into the address — a table lookup that is right until the register has
 * been used for something else.
 */
function emitEntry(asm: Asm68k, dn: number, table: string): void {
  asm.moveq(0, 0);
  asm.move("b", eaD(dn), eaD(0));
  asm.subq("b", 1, eaD(0));
  asm.lsl("l", ENTRY_SHIFT, 0);
  asm.lea(eaAbs(label(table)), 0);
  asm.adda("l", eaD(0), 0);
}

/**
 * Fire the requested effect, unless the one playing outranks it.
 *
 * The table pointer survives `AudioSfxRelease` without being saved, which the
 * Z80 driver has to push for: that routine tails into a stereo merge there and
 * here there is no merge to tail into, so it touches `d0`, `d1` and `a1` and
 * nothing else. Stated because it is the kind of invariant that is invisible
 * until something grows a second caller.
 */
function emitSfxStart(asm: Asm68k, state: Layout, input: MdGameAudioInput): void {
  asm.label("AudioSfxStart");
  asm.move("b", eaD(0), eaD(4));
  asm.clr("b", eaAbs(state.sfxReq));
  emitEntry(asm, 4, "AudioEffects");

  if (input.effects.length > 1) {
    // Priority only means anything when two effects can collide.
    asm.tst("b", eaAbs(state.sfx.active as number));
    asm.bcc("eq", "AudioSfxTake");
    // The entry is `order` (a longword), then the channel, then the priority.
    asm.move("b", eaDisp(0, 5), eaD(0));
    asm.move("b", eaAbs(state.priority), eaD(1));
    asm.cmp("b", eaD(0), 1); // playing − new
    asm.bcc("cc", "AudioSfxDone"); // no borrow: what is playing ranks at least as high
    asm.label("AudioSfxTake");
  }

  asm.clr("b", eaAbs(state.sfx.active as number));
  asm.bsr("AudioSfxRelease");
  asm.move("l", eaPost(0), eaAbs(state.sfx.order));
  asm.move("b", eaPost(0), eaAbs(state.steal));
  asm.move("b", eaPost(0), eaAbs(state.priority));
  asm.clr("b", eaAbs(state.sfx.rest));
  asm.bsr("AudioSfxNextBlock");
  asm.move("b", eaImm(1), eaAbs(state.sfx.active as number));
  asm.label("AudioSfxDone");
  asm.rts();
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
 * **Clobbers `d0`, `d1` and `a1` only.** `AudioMusicStart` holds the track it was
 * asked for in `d4` across this call and `AudioSfxStart` holds a table pointer in
 * `a0`; a scene change that happened while an effect was playing would otherwise
 * start whichever track a scratch register happened to name.
 */
function emitRelease(
  asm: Asm68k,
  state: Layout,
  stealable: readonly number[],
  copies: readonly MdShadowChannel[],
): void {
  asm.label("AudioSfxRelease");
  asm.move("b", eaAbs(state.steal), eaD(1));
  asm.bcc("eq", "AudioReleaseDone");
  for (let bit = 0; bit < stealable.length; bit += 1) {
    const voice = stealable[bit] as number;
    const skip = `AudioRelease${bit}`;
    asm.btst(bit, eaD(1));
    asm.bcc("eq", skip);
    const copy = copies.find((one) => one.channel === 1 << bit);
    if (copy) {
      // Ascending, so an FM voice's key register — `$28`, the lowest address any
      // voice writes — is stated first and its frequency last. A tone voice's
      // bytes carry their own channel select and need nothing in front of them.
      for (const write of copy.writes) {
        if (copy.kind === "fm") {
          const port = YM_ADDRESS + (write.half as number) * 2;
          asm.move("b", eaImm(write.key), eaAbs(port));
          asm.move("b", eaAbs(state.shadow + write.slot), eaAbs(port + 1));
        } else {
          asm.move("b", eaAbs(state.shadow + write.slot), eaAbs(PSG_ADDRESS));
        }
      }
    } else {
      for (const write of silenceVoice(voice)) emitChipWrite(asm, write);
    }
    asm.label(skip);
  }
  asm.clr("b", eaAbs(state.steal));
  asm.clr("b", eaAbs(state.sfx.active as number));
  asm.label("AudioReleaseDone");
  asm.rts();
}

/**
 * Silence one voice, on whichever chip it lives on.
 *
 * A key-off for an FM voice and an attenuation latch for a tone one — the same
 * gesture in intent and nothing alike in registers, which is what having two
 * chips on a board actually costs.
 */
function silenceVoice(voice: number): { reg: number; value: number; chip: number }[] {
  if (voice < MD_FM_CHANNELS) {
    const encoded = voice < 3 ? voice : voice + 1;
    return [
      { reg: 0, value: 0x28, chip: YM_CHIP },
      { reg: 1, value: encoded, chip: YM_CHIP },
    ];
  }
  return [{ reg: 0, value: 0x9f | ((voice - MD_FM_CHANNELS) << 5), chip: PSG_CHIP }];
}

/**
 * One immediate write to one of the two chips.
 *
 * Absolute long, because this is boot and release code rather than the write
 * loop: a handful of writes that each happen once, where holding a base in an
 * address register would cost more instructions than it saved.
 */
function emitChipWrite(asm: Asm68k, write: { reg: number; value: number; chip?: number }): void {
  const address = (write.chip ?? 0) === PSG_CHIP ? PSG_ADDRESS : YM_ADDRESS + (write.reg & 3);
  asm.move("b", eaImm(write.value), eaAbs(address));
}

/** Turn every channel off — what stopping the music means. */
function emitSilence(asm: Asm68k): void {
  asm.label("AudioSilence");
  for (const write of mdSilenceWrites()) emitChipWrite(asm, write);
  asm.rts();
}
