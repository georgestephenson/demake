/**
 * The SN76489 audio driver a *game* embeds, on a Mega Drive (doc 16 §Two
 * streams, one clock).
 *
 * The fourth of these and the second for this chip, which is exactly why it is
 * the shortest: everything the SN76489 decides — the latched channel tag, the
 * latch discipline the packer's preemption rests on, what silencing a channel
 * means — is `psg.ts`'s and is shared with the Sega 8-bits' driver verbatim.
 * What is left is the console's, and there are three answers worth reading:
 *
 *   - **Nothing here is shared between the two streams.** A Game Boy has `NR51`,
 *     an NES has `$4015` and a Game Gear has its stereo latch; a Mega Drive's PSG
 *     is the mono part of a Master System's, so there is no byte two streams both
 *     write and no merge routine is emitted at all. The FM half is where this
 *     console's panning lives and `demake build` emits none of it.
 *   - **The clock is the frame, and it is the *picture's* frame.** The 68000 has
 *     no timer of its own and this VDP's line interrupt is a raster effect rather
 *     than a tempo, exactly as on the Sega 8-bits (`rom/index.ts` §`GAME_CLOCKS`).
 *     So the handler counts frames and the main loop performs what it owes, which
 *     is how the blanking interval stays the tilemap upload's.
 *   - **Room is not the constraint.** Half a megabyte of cartridge against
 *     thirty-two kilobytes on the other three, so a table entry is padded to a
 *     power of two and indexed with a shift rather than packed and indexed with a
 *     multiply — and the packed data's register byte, which this console has no
 *     use for, is stepped over rather than being reason to fork the format.
 *
 * Sources:
 * - Plutiedev — the PSG at $C00011: https://plutiedev.com/psg-chip
 * - SMS Power! — SN76489: https://www.smspower.org/Development/SN76489
 */

import { Asm68k, eaAbs, eaD, eaDisp, eaImm, eaInd, eaPost, label } from "@demake/core";

import type { ChipScript, Rational } from "../chipscript.js";
import { bindingFor } from "../binding/registry.js";

import type { DriverData } from "./data.js";
import { AudioRomError } from "./gb.js";
import type { GameEffect } from "./gb-game.js";
import { emitStream, emitStreamData, PSG_ADDRESS, type MdStreamState } from "./md-driver.js";
import { checkLatchDiscipline, psgAttenuationOff, psgChannelTag, PSG_CHANNELS } from "./psg.js";
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
export const MD_AUDIO_BYTES = layout(0).end;

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
  for (const script of scripts) checkLatchDiscipline(script);

  const clock = resolveMdClock(first);
  const boot = bindingFor(first.console).init();

  // Preemption machinery exists only when there is something to preempt: a game
  // with music and no effects packs the flat format, exactly as a cartridge that
  // owns the chip does.
  const shared = input.tracks.length > 0 && input.effects.length > 0;
  const packOptions = shared ? { channelOf: psgChannelTag } : {};

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

  const helpers: string[] = [];
  let code = 0;
  let data = 0;

  const emitCode = (asm: Asm68k): void => {
    const start = asm.pc;
    emitInit(asm, state, boot);
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
        }).map((name) => `music-${name}`),
      );
    }
    if (input.effects.length > 0) {
      emitSfxStart(asm, state, input);
      emitRelease(asm, state, stealable);
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
        asm.db(1 << (input.effects[index] as GameEffect).channel);
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
function layout(base: number): Layout {
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
  return { music, sfx, steal, priority, musicReq, sfxReq, pending, end: at };
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
): void {
  asm.label("AudioInit");
  asm.movea("l", eaImm(PSG_ADDRESS), 1);
  for (const write of boot) asm.move("b", eaImm(write.value), eaInd(1));
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
function emitRelease(asm: Asm68k, state: Layout, stealable: number): void {
  asm.label("AudioSfxRelease");
  asm.move("b", eaAbs(state.steal), eaD(1));
  asm.bcc("eq", "AudioReleaseDone");
  asm.movea("l", eaImm(PSG_ADDRESS), 1);
  for (let channel = 0; channel < PSG_CHANNELS; channel += 1) {
    if ((stealable & (1 << channel)) === 0) continue;
    const skip = `AudioRelease${channel}`;
    asm.btst(channel, eaD(1));
    asm.bcc("eq", skip);
    asm.move("b", eaImm(psgAttenuationOff(channel)), eaInd(1));
    asm.label(skip);
  }
  asm.clr("b", eaAbs(state.steal));
  asm.clr("b", eaAbs(state.sfx.active as number));
  asm.label("AudioReleaseDone");
  asm.rts();
}

/** Turn every channel off — what stopping the music means. */
function emitSilence(asm: Asm68k): void {
  asm.label("AudioSilence");
  asm.movea("l", eaImm(PSG_ADDRESS), 1);
  for (let channel = 0; channel < PSG_CHANNELS; channel += 1) {
    asm.move("b", eaImm(psgAttenuationOff(channel)), eaInd(1));
  }
  asm.rts();
}
