/**
 * The Virtual Boy audio driver a *game* embeds (doc 16 §Two streams, one clock).
 *
 * The eleventh of these, and the one that asks least of its console. Everything
 * below the console — the walk over packed data, the order list, the rests —
 * is `v810-player.ts`'s; everything about the chip is `rom/vb.ts`'s, which built
 * the standalone cartridge first and left the port map and the write routine
 * behind. What is here is the two-stream half: a request protocol, preemption,
 * and the routine that hands a borrowed channel back.
 *
 * Four answers are this console's rather than a restatement.
 *
 *   - **There is no merge routine, and there is no register to merge.** A Game
 *     Boy has `NR51`, an NES has `$4015`, a Game Gear has its stereo latch; on a
 *     VSU panning is two nibbles of a channel's own register, enabling is its own
 *     bit 7, and the one global register is a panic button. So this is the sixth
 *     console in the matrix to emit no merge at all, and the fourth to have none
 *     because its hardware shares *less* rather than more.
 *   - **The clock is the frame, and the game's own loop already is one.** A
 *     demade Virtual Boy cartridge takes no interrupt anywhere: its main loop
 *     builds a frame, waits for the drawing processor's `XPEND` and starts again,
 *     so a tick per pass *is* a tick per frame, at 50.2 Hz. Every other
 *     frame-clocked console here counts frames in a handler and performs what it
 *     owes, because their loops can overrun one; this loop cannot get ahead of
 *     the picture, so there is nothing to count and no handler to count it in.
 *   - **A tick is one call and one register.** `AudioTick` is entered from the
 *     game's loop with `lp` live, so it pushes it and pops it — this processor's
 *     tax, paid once a tick.
 *   - **The waveform tables are the boot's**, which is why `AudioInit` is called
 *     rather than tick 0 performing them: five tables is a hundred and sixty
 *     writes, more than a run's count byte holds.
 *
 * Sources: the Virtual Boy *Sacred Tech Scroll* (`vbtech`, David Tucker) — VSU
 * register map.
 */

import { Asm810, label, VB_VSU, type Ref } from "@demake/core";
import { VSU_CHANNELS, VSU_REG } from "@demake/chip";

import { bindingFor } from "../binding/registry.js";
import { vbChannelTag, vbPackTag } from "../binding/vb.js";
import type { ChipScript, Rational } from "../chipscript.js";

import type { DriverData } from "./data.js";
import { AudioRomError } from "./gb.js";
import type { GameEffect } from "./gb-game.js";
import {
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
import { CHANNEL_BASE, CHANNEL_STRIDE, emitWrite, portOf, VSU_PORTS } from "./vb.js";
import { emitStream, emitStreamData, REG, type V810StreamState } from "./v810-player.js";

/** The value that stops the music, rather than starting a track. */
export const STOP = 0xff;

/** Bytes one table entry occupies, in both tables; a power of two, so a shift. */
const ENTRY_SHIFT = 3;

/**
 * Channels a game's effects may be spread over.
 *
 * The packed run format's channel nibble. The sound demaker places one pitched
 * gesture and one noise gesture, so this has never been close — it is refused by
 * name rather than truncated, because a truncation would be an effect that
 * silently could not preempt.
 */
const MAX_STEAL_CHANNELS = 4;

/**
 * Worst case for the borrowed-channel copies: every channel, its own registers.
 *
 * A channel block is eight registers and {@link portOf} packs them into eight
 * consecutive port bytes, so a window is eight and the reservation is that times
 * the channels an effect could be spread over. Reserved rather than fitted,
 * because the memory plan is settled before the game's effects are demade.
 */
const SHADOW_MAX = MAX_STEAL_CHANNELS * VSU_PORTS;

/** What the game hands the driver builder. */
export interface VbGameAudioInput {
  /** One schedule per track, in the order the game refers to them. */
  tracks: readonly ChipScript[];
  /** One per effect, likewise. */
  effects: readonly GameEffect[];
  /** First work-RAM byte the driver may use; it needs {@link VB_AUDIO_BYTES}. */
  state: number;
}

/** Work-RAM bytes the driver's state occupies, counted from the allocator. */
export const VB_AUDIO_BYTES = layout(0, SHADOW_MAX).end;

/** Sizes and reductions, reported rather than assumed. */
export interface VbGameAudioStats {
  /** Driver code bytes. */
  code: number;
  /** Packed schedule bytes and tables. */
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
  /** Writes dropped because an effect may only touch the channel it took. */
  writesRestricted: number;
}

/** A built game driver: what to emit, where, and what it will really play. */
export interface VbGameAudio {
  /**
   * How the game must drive it.
   *
   * One tick per pass of the main loop, which on this console *is* one tick per
   * frame: the loop already waits for the drawing processor before it starts
   * again, so there is no reload to programme, no vector to claim and no counter
   * to read.
   */
  clock: { ticksPerFrame: number; rate: Rational };
  /** The two routines the game's own code calls. */
  routines: { init: string; tick: string };
  /** Work-RAM bytes the game writes to ask for something. */
  request: {
    /** `1..n` starts a track; {@link STOP} stops the music. */
    music: number;
    /** `1..n` fires an effect. */
    sfx: number;
  };
  /** Emit `AudioInit`, `AudioTick` and everything they pull in. */
  emitCode(asm: Asm810): void;
  /** Emit the tables and the packed streams. */
  emitData(asm: Asm810): void;
  /**
   * The schedules as the ROM will really perform them.
   *
   * Not the same objects that went in: the chip's initialisation is performed
   * once at boot rather than at the head of every stream, and an effect is
   * restricted to the channel it borrowed (doc 16 §The proof).
   */
  performed: { tracks: readonly ChipScript[]; effects: readonly ChipScript[] };
  stats: VbGameAudioStats;
}

/** Build the driver a game embeds. */
export function buildVbGameAudio(input: VbGameAudioInput): VbGameAudio {
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
  const clock = resolveVbClock(first);

  const binding = bindingFor(first.console);
  const boot = binding.init();

  // Preemption machinery exists only when there is something to preempt: a game
  // with music and no effects packs the flat format and needs no steal mask,
  // exactly as the standalone cartridge does.
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
  const channelOf = vbPackTag(stealable);
  const packOptions = shared ? { channelOf, port: portOf } : { port: portOf };

  let restricted = 0;
  const tracks = input.tracks.map((script) => stripBoot(script, boot));
  const effects = input.effects.map((effect) => {
    // The *binding's* tag rather than the packed one, because restriction is a
    // question about the whole chip: an effect's opening tick states every
    // channel it is not using as well, and those writes would silence the
    // music's bass each time the effect fired.
    const result = restrict(stripBoot(effect.script, boot), 1 << effect.channel, vbChannelTag());
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
    ? shadowPlan(tracks, (1 << stealable.length) - 1, channelOf, boot, portOf)
    : NO_SHADOW;
  const state = layout(input.state, shadow.bytes);
  const helpers: string[] = [];
  let code = 0;
  let data = 0;

  const emitCode = (asm: Asm810): void => {
    const start = asm.pc;
    emitInit(asm, state, boot, shadow);
    emitTick(asm, state, input);
    if (input.tracks.length > 0) {
      emitMusicStart(asm, state, input);
      helpers.push(
        ...emitStream(asm, {
          prefix: "AudioMus",
          state: state.music,
          data: shapeOf(musicData),
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
          onEnd: "AudioSfxRelease",
        }).map((name) => `sfx-${name}`),
      );
    }
    if (input.tracks.length > 0) emitSilence(asm);
    emitWrite(asm);
    code = asm.pc - start;
  };

  const emitData = (asm: Asm810): void => {
    asm.align(4);
    const start = asm.pc;
    if (input.tracks.length > 0) {
      asm.label("AudioTracks");
      for (let index = 0; index < musicData.length; index += 1) {
        const track = musicData[index] as DriverData;
        asm.dd(label(`AudioMusOrder${index}`) as Ref);
        asm.dd(label(`AudioMusOrder${index}`, track.loopOrderIndex * 4) as Ref);
      }
    }
    if (input.effects.length > 0) {
      asm.label("AudioEffects");
      for (let index = 0; index < effectData.length; index += 1) {
        asm.dd(label(`AudioSfxOrder${index}`) as Ref);
        asm.db(1 << (input.effects[index] as GameEffect).channel);
        asm.db(clampByte((input.effects[index] as GameEffect).priority));
        asm.db(0, 0); // padding to one shifted entry
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
    routines: { init: "AudioInit", tick: "AudioTick" },
    request: { music: state.musicReq, sfx: state.sfxReq },
    emitCode,
    emitData,
    performed: { tracks, effects },
    get stats(): VbGameAudioStats {
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
 * Resolve a schedule's driver clock.
 *
 * One tick a frame and nothing else. This console's loop waits for the drawing
 * processor once a pass, so a driver called from it ticks at the frame rate by
 * construction — and a schedule fitted to anything else would be performed at
 * whatever the loop happened to run at, which is why it is refused rather than
 * rounded (`binding/vb.ts` §fitRate already returns only the frame).
 */
export function resolveVbClock(script: ChipScript): { ticksPerFrame: number; rate: Rational } {
  const spec = bindingFor(script.console).spec;
  const frame = spec.driver.frameRate;
  if (script.driver.rate.num * frame.den !== frame.num * script.driver.rate.den) {
    throw new AudioRomError(
      "E_DRIVER_CLOCK",
      `this schedule asks for ${rateHz(script.driver.rate)} Hz and this console's driver runs at ${rateHz(frame)} Hz`,
      "a demade Virtual Boy cartridge takes no interrupt: its main loop waits for the drawing processor once a pass, so a driver tick is a frame. This is a bug in the build, not in the track.",
    );
  }
  return { ticksPerFrame: 1, rate: frame };
}

/** A byte the packer would clamp anyway, stated once. */
function clampByte(value: number): number {
  const rounded = Math.round(value);
  return rounded < 0 ? 0 : rounded > 255 ? 255 : rounded;
}

// --- the memory plan ---------------------------------------------------------

interface Layout {
  base: number;
  music: V810StreamState;
  sfx: V810StreamState;
  /** First byte of the music's copy of the borrowable channels. */
  shadow: number;
  /** Channels an effect has taken. */
  steal: number;
  /** Priority of the effect playing, for the one that wants to interrupt it. */
  priority: number;
  /** One past the last byte used. */
  end: number;
  musicReq: number;
  sfxReq: number;
}

/**
 * The words first, then the bytes.
 *
 * Not a style choice: an unaligned `ld.w` on this processor is **masked rather
 * than faulted** — it clears the low bits of the address and reads the word
 * below — so a stream pointer at an odd address is a wrong pointer that reports
 * nothing (AGENTS.md §The V810 half).
 */
function layout(base: number, shadowBytes: number): Layout {
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
  const musicData = word();
  const musicOrder = word();
  const musicLoop = word();
  // A sound effect stops rather than looping, so it needs no loop entry.
  const sfxData = word();
  const sfxOrder = word();
  const music: V810StreamState = {
    data: musicData,
    order: musicOrder,
    loop: musicLoop,
    rest: byte(),
    active: byte(),
  };
  const sfx: V810StreamState = {
    data: sfxData,
    order: sfxOrder,
    rest: byte(),
    active: byte(),
  };
  const steal = byte();
  const priority = byte();
  const musicReq = byte();
  const sfxReq = byte();
  const shadow = at;
  at += shadowBytes;
  at = (at + 3) & ~3;
  return { base, music, sfx, shadow, steal, priority, end: at, musicReq, sfxReq };
}

/** A field of the driver's state, as an offset from the stream's own base. */
function off(state: Layout, address: number): number {
  return address - state.music.data;
}

// --- code --------------------------------------------------------------------

/** Push the return address, which this processor's call does not. */
function enter(asm: Asm810): void {
  asm.addImm5(-4, REG.sp);
  asm.stw(REG.lp, 0, REG.sp);
}

/** Restore it and return. */
function leave(asm: Asm810): void {
  asm.ldw(0, REG.sp, REG.lp);
  asm.addImm5(4, REG.sp);
  asm.jmp(REG.lp);
}

/**
 * Keep a register across a call, and take it back.
 *
 * This processor has no callee-saved convention and no push list, so a routine
 * here saves its return address and nothing else — which makes register
 * liveness the *caller's* question at every `jal`. `AudioSfxRelease` reads the
 * steal mask into {@link REG.flags}, and both of the routines that call it are
 * holding something in that register at the time: the request byte in one and
 * the effect's table entry in the other. Without these two the entry is read
 * back as a steal mask, and the effect is started from a pointer into whatever
 * the release happened to leave — which is a game whose sound never fires and
 * whose music is otherwise perfect.
 *
 * The pair must straddle a *whole* branch arm rather than one side of it, or
 * the stack is one word out on the path that skipped it.
 */
function keep(asm: Asm810, reg: number): void {
  asm.addImm5(-4, REG.sp);
  asm.stw(reg, 0, REG.sp);
}

/**
 * A conditional branch whose distance is *data*, not something visible here.
 *
 * `bcond` reaches ±256 bytes and `jr` reaches the whole cartridge, so anything
 * skipping a body whose length is a schedule's business takes this: a channel's
 * replay is one window of the shadow plan, and a release skipping *every*
 * channel skips as many of them as the game's effects were spread over. The
 * assembler refuses an out-of-range branch rather than wrapping it, so getting
 * this wrong is a build that fails on the first game big enough — the game
 * backend's own rule (AGENTS.md §Working on the console backend), which a driver
 * is not exempt from.
 */
function far(asm: Asm810, cond: "e" | "ne", target: string): void {
  const over = `${target}$over${asm.pc.toString(16)}`;
  asm.bcond(cond === "e" ? "ne" : "e", over);
  asm.jr(target);
  asm.label(over);
}

function unkeep(asm: Asm810, reg: number): void {
  asm.ldw(0, REG.sp, reg);
  asm.addImm5(4, REG.sp);
}

/**
 * Everything that happens once: the driver's state, and the chip.
 *
 * The waveform tables are in here rather than at the head of a stream, which on
 * this console is what makes a schedule packable at all — five tables is a
 * hundred and sixty writes and a run's count is seven bits.
 */
function emitInit(
  asm: Asm810,
  state: Layout,
  boot: readonly { reg: number; value: number }[],
  shadow: ShadowPlan,
): void {
  asm.label("AudioInit");
  enter(asm);

  asm.movImm32(state.music.data, REG.state);
  for (let index = 0; index < state.end - state.base; index += 1) {
    asm.stb(0, state.base + index - state.music.data, REG.state);
  }
  // Each borrowable channel's copy starts at what the boot writes left in its
  // registers, so a replay before the music has stated anything restores the
  // chip's power-up condition rather than a guess.
  for (let index = 0; index < shadow.init.length; index += 1) {
    const value = shadow.init[index] as number;
    if (value === 0) continue;
    asm.movImm32(value, REG.a0);
    asm.stb(REG.a0, state.shadow + index - state.music.data, REG.state);
  }

  // The chip's own initialisation, written *directly* rather than through the
  // packed-write routine. A port byte is six bits of channel and register and
  // the waveform tables are neither — they are six hundred and forty bytes of a
  // separate address space, which is exactly why they are stripped out of the
  // stream in the first place. So the boot addresses the chip the way a boot
  // can and `portOf` is left for what a *run* carries.
  asm.movImm32(VB_VSU, REG.addr);
  for (const write of boot) {
    asm.movImm32(write.value, REG.a0);
    asm.stb(REG.a0, write.reg, REG.addr);
  }
  leave(asm);
}

/**
 * One driver tick: take what the game asked for, then step each stream.
 *
 * Requests are single bytes rather than pointers because a rule writes them from
 * the game's own loop. One byte is written atomically; a pointer and a length are
 * not, and the tick that arrived between them would play half of one effect and
 * half of another.
 */
function emitTick(asm: Asm810, state: Layout, input: VbGameAudioInput): void {
  asm.label("AudioTick");
  enter(asm);
  asm.movImm32(state.music.data, REG.state);
  if (input.tracks.length > 0) {
    asm.ldb(off(state, state.musicReq), REG.state, REG.a0);
    asm.cmpImm5(0, REG.a0);
    asm.bcond("e", "AudioTickNoMusic");
    asm.jal("AudioMusicStart");
    asm.label("AudioTickNoMusic");
  }
  if (input.effects.length > 0) {
    asm.movImm32(state.music.data, REG.state);
    asm.ldb(off(state, state.sfxReq), REG.state, REG.a0);
    asm.cmpImm5(0, REG.a0);
    asm.bcond("e", "AudioTickNoSfx");
    asm.jal("AudioSfxStart");
    asm.label("AudioTickNoSfx");
  }
  if (input.tracks.length > 0) asm.jal("AudioMusTick");
  // Effects step after the music, so on a tick where both write the same register
  // the effect is the one the hardware is left holding.
  if (input.effects.length > 0) asm.jal("AudioSfxTick");
  leave(asm);
}

/** Point `a2` at table entry `a0 − 1`. */
function emitEntry(asm: Asm810, table: string): void {
  asm.addImm5(-1, REG.a0);
  asm.shlImm5(ENTRY_SHIFT, REG.a0);
  asm.movImm32(label(table), REG.a2);
  asm.add(REG.a0, REG.a2);
}

/** Start the requested track, or stop the music. */
function emitMusicStart(asm: Asm810, state: Layout, input: VbGameAudioInput): void {
  asm.label("AudioMusicStart");
  enter(asm);
  asm.movImm32(state.music.data, REG.state);
  asm.ldb(off(state, state.musicReq), REG.state, REG.flags); // the request, kept
  asm.stb(0, off(state, state.musicReq), REG.state);

  // A scene change stops whatever was playing, effect included: the sound of the
  // old scene carrying into the new one is a bug in every game that has it.
  // Nothing playing means nothing to stop, and skipping the silencing there is
  // what makes the first track's first tick exactly the schedule's first tick.
  asm.ldb(off(state, state.music.active as number), REG.state, REG.a0);
  if (input.effects.length > 0) {
    asm.ldb(off(state, state.sfx.active as number), REG.state, REG.a1);
    asm.or(REG.a1, REG.a0);
  }
  asm.cmpImm5(0, REG.a0);
  asm.bcond("e", "AudioMusicFresh");
  asm.stb(0, off(state, state.music.active as number), REG.state);
  if (input.effects.length > 0) {
    keep(asm, REG.flags);
    asm.jal("AudioSfxRelease");
    unkeep(asm, REG.flags);
  }
  asm.jal("AudioSilence");

  asm.label("AudioMusicFresh");
  asm.movImm32(STOP, REG.a0);
  asm.cmp(REG.a0, REG.flags);
  asm.bcond("e", "AudioMusicDone");

  asm.movReg(REG.flags, REG.a0);
  emitEntry(asm, "AudioTracks");
  asm.movImm32(state.music.data, REG.state);
  asm.ldw(0, REG.a2, REG.a0);
  asm.stw(REG.a0, off(state, state.music.order), REG.state);
  asm.ldw(4, REG.a2, REG.a0);
  asm.stw(REG.a0, off(state, state.music.loop as number), REG.state);
  asm.stb(0, off(state, state.music.rest), REG.state);
  asm.jal("AudioMusNextBlock");
  asm.movImm32(state.music.data, REG.state);
  asm.movImm32(1, REG.a0);
  asm.stb(REG.a0, off(state, state.music.active as number), REG.state);
  asm.label("AudioMusicDone");
  leave(asm);
}

/** Fire the requested effect, unless the one playing outranks it. */
function emitSfxStart(asm: Asm810, state: Layout, input: VbGameAudioInput): void {
  asm.label("AudioSfxStart");
  enter(asm);
  asm.movImm32(state.music.data, REG.state);
  asm.ldb(off(state, state.sfxReq), REG.state, REG.a0);
  asm.stb(0, off(state, state.sfxReq), REG.state);
  emitEntry(asm, "AudioEffects");
  asm.movReg(REG.a2, REG.flags); // the entry, across the release

  if (input.effects.length > 1) {
    // Priority only means anything when two effects can collide.
    asm.ldb(off(state, state.sfx.active as number), REG.state, REG.a0);
    asm.cmpImm5(0, REG.a0);
    asm.bcond("e", "AudioSfxTake");
    // The entry is `order` (a word), then the channel mask, then the priority.
    asm.ldb(5, REG.flags, REG.a0);
    asm.ldb(off(state, state.priority), REG.state, REG.a1);
    asm.cmp(REG.a0, REG.a1);
    // What is playing ranks at least as high: the new one is dropped.
    asm.bcond("nl", "AudioSfxDone");
    asm.label("AudioSfxTake");
  }

  asm.stb(0, off(state, state.sfx.active as number), REG.state);
  keep(asm, REG.flags);
  asm.jal("AudioSfxRelease");
  unkeep(asm, REG.flags);
  asm.movImm32(state.music.data, REG.state);
  asm.ldw(0, REG.flags, REG.a0);
  asm.stw(REG.a0, off(state, state.sfx.order), REG.state);
  asm.ldb(4, REG.flags, REG.a0);
  asm.stb(REG.a0, off(state, state.steal), REG.state);
  asm.ldb(5, REG.flags, REG.a0);
  asm.stb(REG.a0, off(state, state.priority), REG.state);
  asm.stb(0, off(state, state.sfx.rest), REG.state);
  asm.jal("AudioSfxNextBlock");
  asm.movImm32(state.music.data, REG.state);
  asm.movImm32(1, REG.a0);
  asm.stb(REG.a0, off(state, state.sfx.active as number), REG.state);
  asm.label("AudioSfxDone");
  leave(asm);
}

/**
 * Give the channels an effect borrowed back to the music.
 *
 * A **replay** rather than a note-off, which every driver here does and this one
 * has to: the packed music is a delta stream, so a register the music's own value
 * did not change is one it never states again — and the chip is holding the
 * effect's value for it. The copy the run walk kept is written back in ascending
 * port order, so the byte carrying the channel's enable bit lands last.
 */
function emitRelease(
  asm: Asm810,
  state: Layout,
  stealable: readonly number[],
  plan: ShadowPlan,
): void {
  asm.label("AudioSfxRelease");
  enter(asm);
  asm.movImm32(state.music.data, REG.state);
  asm.ldb(off(state, state.steal), REG.state, REG.flags);
  asm.cmpImm5(0, REG.flags);
  far(asm, "e", "AudioReleaseDone");
  for (let index = 0; index < stealable.length; index += 1) {
    const skip = `AudioRelease${index}`;
    asm.movImm32(1 << index, REG.a0);
    asm.and(REG.flags, REG.a0);
    asm.cmpImm5(0, REG.a0);
    far(asm, "e", skip);
    const copy = plan.channels.find((one) => one.channel === 1 << index);
    if (copy) {
      for (const write of copy.writes) {
        asm.ldb(state.shadow + write.slot - state.music.data, REG.state, REG.a1);
        asm.movImm32(write.port, REG.a0);
        asm.jal("AudioWrite");
        asm.movImm32(state.music.data, REG.state);
      }
    } else {
      asm.movImm32(portOf(CHANNEL_BASE + (stealable[index] as number) * CHANNEL_STRIDE), REG.a0);
      asm.movImm32(0, REG.a1);
      asm.jal("AudioWrite");
      asm.movImm32(state.music.data, REG.state);
    }
    asm.label(skip);
  }
  asm.stb(0, off(state, state.steal), REG.state);
  asm.stb(0, off(state, state.sfx.active as number), REG.state);
  asm.label("AudioReleaseDone");
  leave(asm);
}

/**
 * Stop every channel — what stopping the music means.
 *
 * The channel's own `INT` register, whose bit 7 is the whole of a note's
 * existence here. There is no global silence to write instead: `SSTOP` is a panic
 * button that also stops the chip's own clocks, and a scene change is not a
 * panic.
 */
function emitSilence(asm: Asm810): void {
  asm.label("AudioSilence");
  enter(asm);
  for (let channel = 0; channel < VSU_CHANNELS; channel += 1) {
    asm.movImm32(portOf(CHANNEL_BASE + channel * CHANNEL_STRIDE + VSU_REG.INT), REG.a0);
    asm.movImm32(0, REG.a1);
    asm.jal("AudioWrite");
  }
  leave(asm);
}
