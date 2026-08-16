/**
 * The T6W28 audio driver a *game* embeds (doc 16 §Two streams, one clock).
 *
 * `sms-game.ts` for the chip's cousin and `wsc-game.ts` for the previous
 * handheld, answering the same three questions — who owns a channel right now,
 * what a shared register does, and where the tick comes from. Two of the answers
 * are this console's rather than a restatement:
 *
 *   - **There is no shared register, and this is the fourth console in the set
 *     with none.** A Game Boy's `NR51`, an NES's `$4015` and a Game Gear's
 *     stereo latch are all one byte two streams both write, so all three drivers
 *     fold rather than store. Here the panning is *inside* each channel's own
 *     attenuator — two of them, one a side — so there is nothing to fold and no
 *     merge routine is emitted at all. A Master System reaches the same answer
 *     because its hardware pans less; this one reaches it because its hardware
 *     pans *more*.
 *   - **Silencing a channel takes two writes, not one.** Two attenuators means
 *     two `%1cc1 1111` latches, one to each port — and giving a borrowed channel
 *     back means replaying up to six bytes rather than three, because a voice's
 *     period, the data byte that continues it and *both* of its levels are all
 *     things the music stated and the effect overwrote.
 *
 * The third answer is the Sega's and the NES's restated: there is **one
 * interrupt and one rate**, and here it is the picture's. This console's
 * processor has timers and a *standalone* driver would ride one
 * (`binding/t6w28.ts` §fitRate), but a game's two streams share one clock with
 * the picture, and the vertical blank is what a demade cartridge already takes.
 * The game counts frames in the handler and performs the ticks it owes from the
 * main loop, which is how the blanking interval stays the picture's.
 *
 * And one thing is the *machine's* rather than the chip's, and no other driver
 * in the set has it: **the sound chip has to be asked for**. On the board its
 * own bus belongs to the Z80 sound processor, so a program on the main CPU
 * writes `$55` and `$AA` to two bytes of its own I/O page before anything it
 * sends the chip is listened to. `AudioInit` does it first, and a cartridge that
 * skipped it would be perfect and silent.
 *
 * Sources: MAME `src/mame/snk/ngp.cpp` (the two ports and the pair that unlocks
 * them) and `src/devices/sound/t6w28.cpp` (the register split).
 */

import {
  Asm900,
  label,
  NGP_DISABLE_VALUE,
  NGP_ENABLE_VALUE,
  NGP_SOUND_ENABLE,
  NGP_Z80_ENABLE,
  t9Abs as abs,
  t9At as at,
  type Ref,
} from "@demake/core";

import { bindingFor } from "../binding/registry.js";
import type { ChipScript, Rational } from "../chipscript.js";

import type { DriverData } from "./data.js";
import { AudioRomError } from "./gb.js";
import type { GameEffect } from "./gb-game.js";
import { emitStream, emitStreamData, ngpPortByte, type NgpStreamState } from "./ngp-driver.js";
import { clampByte, MAX_PENDING, pack, rateHz, restrict, shapeOf, stripBoot } from "./shared.js";
import {
  checkLatchDiscipline,
  t6w28AttenuationOff,
  t6w28ChannelTag,
  t6w28ShadowInit,
  t6w28ShadowPlan,
  T6W28_CHANNELS,
  T6W28_LEFT,
  T6W28_RIGHT,
  T6W28_SHADOW_BYTES,
} from "./t6w28.js";

/** The value that stops the music, rather than starting a track. */
export const STOP = 0xff;

/**
 * The two bytes that hand the chip to the main CPU, and what to write there.
 *
 * Power the chip up, then stop the Z80 that owns its bus — two jobs rather than
 * halves of one unlock, which is why the values differ.
 *
 * **Imported rather than spelled out**, and it was spelled out once: `$38`/`$39`
 * against `@demake/core`'s own `$B8`/`$B9`, on the grounds that a driver
 * importing them "would be one more reader". That is the machine-description
 * rule exactly backwards — one home, many readers — and it is how a wrong
 * address survived in two files at once, agreeing with itself.
 */
const UNLOCK: readonly [number, number][] = [
  [NGP_SOUND_ENABLE, NGP_ENABLE_VALUE],
  [NGP_Z80_ENABLE, NGP_DISABLE_VALUE],
];

/**
 * Bytes one entry of either table takes, as the shift that indexes it.
 *
 * Eight, so an index is a shift rather than a multiply — which costs an effect's
 * entry two spare bytes it has no use for and is still cheaper than the
 * instruction it saves on a table nobody walks.
 */
const ENTRY_SHIFT = 3;

/** What the game hands the driver builder. */
export interface NgpGameAudioInput {
  /** One schedule per track, in the order the game refers to them. */
  tracks: readonly ChipScript[];
  /** One per effect, likewise. */
  effects: readonly GameEffect[];
  /** First work-RAM byte the driver may use; it needs {@link NGP_AUDIO_BYTES}. */
  state: number;
}

/**
 * Worst case for the borrowed-channel copies: every channel, six bytes each.
 *
 * Reserved rather than fitted, because the memory plan is settled before the
 * game's effects are demade and it is the plan that says how much work RAM the
 * driver has. Six rather than the Sega's three, because a level is two
 * attenuators and the noise generator has a divisor of its own.
 */
const SHADOW_MAX = T6W28_CHANNELS * T6W28_SHADOW_BYTES;

export const NGP_AUDIO_BYTES = layout(0, SHADOW_MAX).end;

/** Sizes and reductions, reported rather than assumed. */
export interface NgpGameAudioStats {
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
export interface NgpGameAudio {
  /**
   * How the game must drive it.
   *
   * The Sega's shape, for the Sega's reason: there is no reload to program and
   * no vector to claim, only a number of times to call `AudioTick` for every
   * frame that has passed.
   */
  clock: { ticksPerFrame: number; rate: Rational };
  /**
   * The two routines the game's own code has to call.
   *
   * `frame` goes in the vertical-blank handler and does nothing but count it;
   * `service` goes in the main loop and performs whatever ticks have been
   * counted. The split is the console's clock discipline: the interrupt is what
   * keeps the tempo honest, and doing the work outside it is what keeps the
   * blanking interval for the picture.
   *
   * `frame` clobbers `A` and the flags and nothing else. `service` clobbers
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
  emitCode(asm: Asm900): void;
  /** Emit the tables and the packed streams. */
  emitData(asm: Asm900): void;
  /**
   * The schedules as the ROM will really perform them.
   *
   * Not the same objects that went in: the chip's initialisation is performed
   * once at boot rather than at the head of every stream, and an effect is
   * restricted to its own channel. Both are stated here so the conformance
   * harness diffs against what the driver actually promises (doc 16 §The proof).
   */
  performed: { tracks: readonly ChipScript[]; effects: readonly ChipScript[] };
  stats: NgpGameAudioStats;
}

/** Build the driver a game embeds. */
export function buildNgpGameAudio(input: NgpGameAudioInput): NgpGameAudio {
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

  const clock = resolveNgpClock(first);
  const binding = bindingFor(first.console);
  const boot = binding.init();

  // Preemption machinery exists only when there is something to preempt: a game
  // with music and no effects packs the flat format, exactly as a cartridge that
  // owns the chip does.
  const shared = input.tracks.length > 0 && input.effects.length > 0;
  const packOptions = shared
    ? { channelOf: t6w28ChannelTag, port: ngpPortByte }
    : { port: ngpPortByte };

  let restricted = 0;
  const tracks = input.tracks.map((script) => stripBoot(script, boot));
  const effects = input.effects.map((effect) => {
    const owned = 1 << effect.channel;
    const result = restrict(stripBoot(effect.script, boot), owned, t6w28ChannelTag());
    restricted += result.dropped;
    return result.script;
  });

  const musicData = tracks.map((script) => pack(script, packOptions));
  const effectData = effects.map((script) =>
    pack(script, { ...packOptions, end: "stop" as const }),
  );

  const stealable = input.effects.reduce((bits, effect) => bits | (1 << effect.channel), 0);
  // What the music has to remember so a borrowed channel comes back holding the
  // music's own note rather than the effect's last one. This chip's copy is keyed
  // by what a byte *is* and which port it went to (`t6w28.ts`).
  const copies = shared ? t6w28ShadowPlan(tracks, stealable) : [];
  const state = layout(input.state, copies.length * T6W28_SHADOW_BYTES);
  /** Where one borrowable channel's copies begin. */
  const shadowAt = (index: number): number => state.shadow + index * T6W28_SHADOW_BYTES;

  const helpers: string[] = [];
  let code = 0;
  let data = 0;

  const emitCode = (asm: Asm900): void => {
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
            ? {
                shadow: {
                  channels: copies.map((copy, index) => ({
                    bit: copy.channel,
                    at: shadowAt(index),
                    slots: copy.slots,
                  })),
                },
              }
            : {}),
        }).map((name) => `music-${name}`),
      );
    }
    if (input.effects.length > 0) {
      emitSfxStart(asm, state, input);
      emitRelease(asm, state, stealable, copies, shadowAt);
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

  const emitData = (asm: Asm900): void => {
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
        const effect = input.effects[index] as GameEffect;
        asm.dd(label(`AudioSfxOrder${index}`) as Ref);
        asm.db(1 << effect.channel);
        asm.db(clampByte(effect.priority));
        // Two spare, so an entry is eight bytes and an index is a shift rather
        // than a multiply. Cheaper than the multiply on a table nobody walks.
        asm.db(0);
        asm.db(0);
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
    get stats(): NgpGameAudioStats {
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
 * The Sega's `resolveSmsClock` with a different error message, and it is short
 * for the same reason: a game's two streams share one clock with the picture, so
 * `gameDriverRate` asks the binding for exactly the console's frame rate and
 * `t6w28Binding.fitRate` hands it back unchanged. A rate that is not a whole
 * multiple is a bug in the fit rather than something to round.
 */
export function resolveNgpClock(script: ChipScript): NgpGameAudio["clock"] {
  const { rate, source } = script.driver;
  if (source !== "vblank") {
    throw new AudioRomError(
      "E_DRIVER_CLOCK",
      `the ngp driver has no '${source}' clock`,
      "a game's music and effects share one interrupt with the picture, so the driver runs on the frame; re-arrange with `vblank`.",
    );
  }
  const frame = bindingFor(script.console).spec.driver.frameRate;
  const ticks = (rate.num * frame.den) / (rate.den * frame.num);
  if (!Number.isInteger(ticks) || ticks < 1 || ticks > 8) {
    throw new AudioRomError(
      "E_DRIVER_CLOCK",
      `${rateHz(rate)} Hz is not a whole number of ticks per frame on this console`,
      "the frame is the only clock a game's driver has; this is a bug in the timing fit, not in the track.",
    );
  }
  return { ticksPerFrame: ticks, rate };
}

// --- state -------------------------------------------------------------------

/** Where the driver keeps everything, laid out from the game's first free byte. */
interface Layout {
  music: NgpStreamState;
  sfx: NgpStreamState;
  /**
   * First byte of the music's copy of the borrowable channels.
   *
   * Six bytes a channel rather than one per register, because this chip has no
   * register numbers and two ports: a period latch, the data byte that continues
   * it, an attenuation *a side*, and the noise generator's own control and
   * divisor (`t6w28.ts` §`T6W28_SHADOW`).
   */
  shadow: number;
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

function layout(base: number, shadowBytes: number): Layout {
  let at_ = base;
  const take = (bytes = 1): number => {
    // Longwords are aligned, because this processor pays for a misaligned one
    // and the allocator that hands out the base does not know what is coming.
    if (bytes === 4) at_ = (at_ + 3) & ~3;
    const address = at_;
    at_ += bytes;
    return address;
  };
  const music: NgpStreamState = {
    data: take(4),
    order: take(4),
    loop: take(4),
    rest: take(),
    active: take(),
  };
  // A sound effect stops rather than looping, so it needs no loop entry.
  const sfx: NgpStreamState = {
    data: take(4),
    order: take(4),
    rest: take(),
    active: take(),
  };
  const steal = take();
  const priority = take();
  const musicReq = take();
  const sfxReq = take();
  const pending = take();
  const shadow = take(shadowBytes);
  return { music, sfx, shadow, steal, priority, musicReq, sfxReq, pending, end: at_ };
}

// --- code --------------------------------------------------------------------

/** One byte straight to one of the chip's ports. */
function emitPortWrite(asm: Asm900, reg: number, value: number): void {
  asm.stmi(abs(ngpPortByte(reg)), "b", value);
}

/**
 * Take the chip, put it in a known state, and clear the driver's own.
 *
 * The unlock comes first and nothing else here would work without it: until both
 * bytes are written the chip is the Z80's and every port write below is ignored.
 * Nothing programs a clock, because there is none to program — the game's
 * vertical-blank handler is already running for the picture's sake and the
 * driver rides it.
 */
function emitInit(
  asm: Asm900,
  state: Layout,
  boot: readonly { reg: number; value: number }[],
  copies: readonly { channel: number; slots: readonly number[] }[],
): void {
  asm.label("AudioInit");
  for (const [address, value] of UNLOCK) asm.stmi(abs(address), "b", value);
  for (const write of boot) emitPortWrite(asm, write.reg, write.value);

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
    asm.stmi(abs(byte), "b", 0);
  }
  // Each borrowable channel's copy starts at what the boot writes left in its
  // latches. Zero would be full volume on this chip, so a replay before the
  // music had stated anything would come back at maximum rather than silent —
  // and here it would do it on both sides at once.
  const seeded = t6w28ShadowInit(boot, copies);
  for (let index = 0; index < copies.length; index += 1) {
    const copy = copies[index] as { slots: readonly number[] };
    for (let slot = 0; slot < copy.slots.length; slot += 1) {
      const value = (seeded[index] as number[])[slot] as number;
      asm.stmi(
        abs(state.shadow + index * T6W28_SHADOW_BYTES + (copy.slots[slot] as number)),
        "b",
        value,
      );
    }
  }
  asm.ret();
}

/**
 * The clock, as the two routines the game calls.
 *
 * `AudioFrame` counts a frame and stops counting at {@link MAX_PENDING}: a game
 * that has been stopped — a breakpoint, a scene change that took half a second —
 * would otherwise come back owing hundreds of ticks and perform them all in one
 * burst.
 *
 * `AudioService` performs them, `ticksPerFrame` at a time, from the main loop
 * rather than from the handler for one reason: the blanking interval belongs to
 * the picture.
 */
function emitClock(asm: Asm900, state: Layout, ticksPerFrame: number): void {
  asm.label("AudioFrame");
  asm.aluMemImm("cp", abs(state.pending), "b", MAX_PENDING);
  asm.retc("uge");
  asm.incMem(1, abs(state.pending), "b");
  asm.ret();

  asm.label("AudioService");
  asm.aluMemImm("cp", abs(state.pending), "b", 0);
  asm.retc("z");
  asm.decMem(1, abs(state.pending), "b");
  for (let tick = 0; tick < ticksPerFrame; tick += 1) asm.calr(label("AudioTick"));
  asm.jp(label("AudioService"));
}

/**
 * One driver tick: take what the game asked for, then step each stream.
 *
 * Requests are single bytes rather than pointers because a rule writes them from
 * the game's own loop. One byte is written atomically; a pointer and a length are
 * not, and the tick that arrived between them would play half of one effect and
 * half of another.
 */
function emitTick(asm: Asm900, state: Layout, input: NgpGameAudioInput): void {
  asm.label("AudioTick");
  if (input.tracks.length > 0) {
    asm.ldm("a", abs(state.musicReq));
    asm.aluImm("cp", "a", 0); // a load sets no flags on this CPU
    asm.callc("nz", label("AudioMusicStart"));
  }
  if (input.effects.length > 0) {
    asm.ldm("a", abs(state.sfxReq));
    asm.aluImm("cp", "a", 0);
    asm.callc("nz", label("AudioSfxStart"));
  }
  if (input.tracks.length > 0) asm.calr(label("AudioMusTick"));
  // Effects step after the music, so on a tick where both write the same channel
  // the effect is the one the chip is left holding.
  if (input.effects.length > 0) asm.jp(label("AudioSfxTick"));
  else asm.ret();
}

/** `XIY` = the entry for the one-based index in `B`, in the named table. */
function emitEntry(asm: Asm900, table: string): void {
  asm.ldn("xwa", 0);
  asm.ld("a", "b");
  asm.dec(1, "a");
  asm.ld("xiy", "xwa");
  asm.shift("sla", ENTRY_SHIFT, "xiy");
  asm.ldn("xwa", label(table));
  asm.alu("add", "xiy", "xwa");
}

/** Start the requested track, or stop the music. */
function emitMusicStart(asm: Asm900, state: Layout, input: NgpGameAudioInput): void {
  asm.label("AudioMusicStart");
  asm.ld("b", "a"); // the request, until the table lookup
  asm.stmi(abs(state.musicReq), "b", 0);

  // A scene change stops whatever was playing, effect included: the sound of the
  // old scene carrying into the new one is a bug in every game that has it.
  // Nothing playing means nothing to stop, and skipping the silencing there is
  // what makes the first track's first tick exactly the schedule's first tick.
  asm.ldm("a", abs(state.music.active as number));
  // An `or` sets the flags a load did not; with no effects there is nothing to
  // fold in, so the comparison has to be stated.
  if (input.effects.length > 0) asm.aluMem("or", "a", abs(state.sfx.active as number));
  else asm.aluImm("cp", "a", 0);
  asm.jrl("z", "AudioMusicFresh");
  asm.stmi(abs(state.music.active as number), "b", 0);
  if (input.effects.length > 0) asm.calr(label("AudioSfxRelease"));
  asm.calr(label("AudioSilence"));

  asm.label("AudioMusicFresh");
  asm.aluImm("cp", "b", STOP);
  asm.retc("z");

  emitEntry(asm, "AudioTracks");
  asm.ldm("xiz", at("xiy"));
  asm.stm(abs(state.music.order), "xiz");
  asm.ldm("xiz", at("xiy", 4));
  asm.stm(abs(state.music.loop as number), "xiz");
  asm.stmi(abs(state.music.rest), "b", 0);
  asm.calr(label("AudioMusNextBlock"));
  asm.stmi(abs(state.music.active as number), "b", 1);
  asm.ret();
}

/**
 * Fire the requested effect, unless the one playing outranks it.
 *
 * `XIY` walks the entry and is *pushed* across `AudioSfxRelease`, because that
 * routine replays a channel's copies and helps itself to the pointer registers
 * to do it. Cheaper to save one here than to constrain a routine two callers
 * reach from different places.
 */
function emitSfxStart(asm: Asm900, state: Layout, input: NgpGameAudioInput): void {
  asm.label("AudioSfxStart");
  asm.ld("b", "a");
  asm.stmi(abs(state.sfxReq), "b", 0);
  emitEntry(asm, "AudioEffects");

  if (input.effects.length > 1) {
    // Priority only means anything when two effects can collide.
    asm.aluMemImm("cp", abs(state.sfx.active as number), "b", 0);
    asm.jrl("z", "AudioSfxTake");
    asm.ldm("a", at("xiy", 5));
    asm.ld("c", "a");
    asm.ldm("a", abs(state.priority));
    asm.alu("cp", "a", "c");
    asm.retc("uge"); // what is playing ranks at least as high; the new one is dropped
  }

  asm.label("AudioSfxTake");
  asm.stmi(abs(state.sfx.active as number), "b", 0);
  asm.push("xiy");
  asm.calr(label("AudioSfxRelease"));
  asm.pop("xiy");
  asm.ldm("xiz", at("xiy"));
  asm.stm(abs(state.sfx.order), "xiz");
  asm.ldm("a", at("xiy", 4));
  asm.stm(abs(state.steal), "a");
  asm.ldm("a", at("xiy", 5));
  asm.stm(abs(state.priority), "a");
  asm.stmi(abs(state.sfx.rest), "b", 0);
  asm.calr(label("AudioSfxNextBlock"));
  asm.stmi(abs(state.sfx.active as number), "b", 1);
  asm.ret();
}

/**
 * Give back the channels an effect borrowed, holding the music's own registers.
 *
 * A replay from the copy the run walk keeps, not a note-off: the packed music is
 * a delta stream, so a register the music's own value did not change is one it
 * never states again — and after an effect has borrowed the channel the chip is
 * holding the effect's value for it (doc 16 §Handing a borrowed channel back).
 *
 * Six bytes at most rather than the Sega's three, and each carries its own
 * channel select *and* names its own port, so there is nothing to say in front of
 * them and no order to get wrong beyond the ascending one the plan already fixed.
 */
function emitRelease(
  asm: Asm900,
  state: Layout,
  stealable: number,
  copies: readonly { channel: number; slots: readonly number[] }[],
  shadowAt: (index: number) => number,
): void {
  asm.label("AudioSfxRelease");
  asm.ldm("a", abs(state.steal));
  asm.aluImm("cp", "a", 0);
  asm.retc("z");
  asm.ld("c", "a");
  for (let channel = 0; channel < T6W28_CHANNELS; channel += 1) {
    if ((stealable & (1 << channel)) === 0) continue;
    const skip = `AudioRelease${channel}`;
    asm.bit(channel, "c");
    asm.jrl("z", skip);
    const index = copies.findIndex((copy) => copy.channel === 1 << channel);
    if (index >= 0) {
      for (const slot of (copies[index] as { slots: readonly number[] }).slots) {
        asm.ldm("a", abs(shadowAt(index) + slot));
        asm.stm(abs(ngpPortByte(portOfSlot(slot))), "a");
      }
    } else {
      // Nothing to restore, so both attenuators go to full cut — two writes,
      // because there are two of them.
      for (const port of [T6W28_RIGHT, T6W28_LEFT]) {
        emitPortWrite(asm, port, t6w28AttenuationOff(channel));
      }
    }
    asm.label(skip);
  }
  asm.stmi(abs(state.steal), "b", 0);
  asm.stmi(abs(state.sfx.active as number), "b", 0);
  asm.ret();
}

/**
 * Which port one of a channel's copies has to be replayed to.
 *
 * The slot says it, because that is what the slot *is*: the three left-hand ones
 * are the period, its data byte and the left attenuation, and the three
 * right-hand ones are the right attenuation and the noise generator's pair. A
 * replay to the wrong port would write a period into an attenuator.
 *
 * The answer is the *binding's* port number and not an address — every caller
 * puts it through {@link ngpPortByte}, which is the one place either becomes the
 * other. Storing this directly writes to `$0000`/`$0001`, which are two bytes of
 * the processor's own register page: a release that reached nothing at all, and
 * a cartridge whose every other register write is perfect.
 */
function portOfSlot(slot: number): number {
  return slot <= 2 ? T6W28_LEFT : T6W28_RIGHT;
}

/** Turn every channel off on both sides — what stopping the music means. */
function emitSilence(asm: Asm900): void {
  asm.label("AudioSilence");
  for (let channel = 0; channel < T6W28_CHANNELS; channel += 1) {
    for (const port of [T6W28_RIGHT, T6W28_LEFT]) {
      emitPortWrite(asm, port, t6w28AttenuationOff(channel));
    }
  }
  asm.ret();
}
