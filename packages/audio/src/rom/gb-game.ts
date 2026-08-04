/**
 * The Game Boy audio driver a *game* embeds (doc 16 §Two streams, one clock).
 *
 * A cartridge that only plays music has one schedule, starts it at boot and
 * never stops. A game has neither of those luxuries: it has a track per scene,
 * an effect per event, and the two want the same four channels at the same time.
 * What it does *not* have is a second driver — everything below is the stream
 * player of `gb-driver.ts`, emitted twice, plus the small amount of machinery
 * that decides who owns a channel right now.
 *
 * Three decisions are load-bearing, and each is here rather than in the game
 * backend because each is a fact about this chip:
 *
 *   - **One interrupt, one rate.** The Game Boy has one timer, so music and
 *     effects step on the same tick. The game picks the rate (by arranging its
 *     music above the effect rate) and everything is fitted to it; a driver that
 *     re-derived a second rate could disagree with the first by a fraction that
 *     shows up as drift.
 *   - **Preemption is by run, not by write.** An effect takes a channel while it
 *     plays, and the music stream skips the writes that would fight it. The
 *     packed data groups consecutive writes that agree about which channel they
 *     belong to, so the test is paid once per group rather than once per write
 *     (`data.ts` §the run format).
 *   - **`NR51` is merged, never stored.** One byte carries every channel's
 *     panning, so a stream that wrote it whole would erase the other stream's
 *     channels. Each stream keeps a shadow of what it wants and the driver folds
 *     the two under the steal mask — which means that with nothing preempting,
 *     the byte the chip receives is exactly the one the schedule asked for.
 *
 * Sources:
 * - Pan Docs — Audio Registers: https://gbdev.io/pandocs/Audio_Registers.html
 * - Pan Docs — Timer and Divider Registers: https://gbdev.io/pandocs/Timer_and_Divider_Registers.html
 */

import { Asm, label } from "@demake/core";

import type { ChipScript, Rational } from "../chipscript.js";
import { bindingFor } from "../binding/registry.js";

import type { DriverData } from "./data.js";
import { emitStream, emitStreamData, type StreamState } from "./gb-driver.js";
import { AudioRomError, resolveClock } from "./gb.js";
import {
  clampByte,
  pack,
  rateHz,
  restrict,
  shadowBias,
  shadowPlan,
  shapeOf,
  stripBoot,
  type ShadowPlan,
} from "./shared.js";

/** One effect the game can fire, and what it needs while it plays. */
export interface GameEffect {
  script: ChipScript;
  /** Index into the console's channel list — the channel it takes. */
  channel: number;
  /** Higher preempts lower when two effects collide (doc 18 §Placement). */
  priority: number;
}

/** What the game hands the driver builder. */
export interface GameAudioInput {
  /** One schedule per track, in the order the game refers to them. */
  tracks: readonly ChipScript[];
  /** One per effect, likewise. */
  effects: readonly GameEffect[];
  /** First high-RAM byte the driver may use. */
  hram: number;
  /**
   * Where the chip's registers live on this console, when they have moved.
   *
   * The Game Boy's APU appears at `$FF20`–`$FF46` on a Mega Duck rather than
   * `$FF10`–`$FF26`, with `NR11`/`NR12`, `NR33`/`NR34`, `NR42`/`NR43` and
   * `NR51`/`NR52` each swapped and wave RAM left where it was. That is the whole
   * of the difference, so it is the whole of what this carries: one function
   * applied wherever a register number becomes an address, and nothing above it
   * — not the schedules, not the channel map, not the proof — has to know.
   *
   * Named for `PackOptions.port`, which is the same idea reached from the other
   * end: the Z80's driver stores a port because its chip has no register
   * numbers, and this one stores a different address for the same registers.
   */
  port?: (reg: number) => number;
}

/** Sizes and reductions, reported rather than assumed. */
export interface GameAudioStats {
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
export interface GameAudio {
  /** Interrupt bit and vector the game must wire this into. */
  clock: { interrupt: number; vector: number; rate: Rational };
  /** High-RAM bytes the game writes to ask for something. */
  request: {
    /** `1..n` starts a track; {@link STOP} stops the music. */
    music: number;
    /** `1..n` fires an effect. */
    sfx: number;
  };
  /** Emit `AudioInit`, `AudioTick` and everything they pull in. */
  emitCode(asm: Asm): void;
  /** Emit the tables and the packed streams. */
  emitData(asm: Asm): void;
  /**
   * The schedules as the ROM will really perform them.
   *
   * Not the same objects that went in: the chip's initialisation is performed
   * once at boot rather than at the head of every stream, and an effect is
   * restricted to its own channel. Both are stated here so the conformance
   * harness diffs against what the driver actually promises (doc 16 §The proof).
   */
  performed: { tracks: readonly ChipScript[]; effects: readonly ChipScript[] };
  stats: GameAudioStats;
}

/** The value that stops the music, rather than starting a track. */
export const STOP = 0xff;

/** Registers a stream merges into rather than stores over. */
const NR51 = 0x25;

/** Channel bits by register: which voice a Game Boy audio register belongs to. */
export function gbChannelOf(reg: number): number {
  if (reg >= 0x10 && reg <= 0x14) return 1 << 0;
  if (reg >= 0x15 && reg <= 0x19) return 1 << 1;
  if (reg >= 0x1a && reg <= 0x1e) return 1 << 2;
  if (reg >= 0x1f && reg <= 0x23) return 1 << 3;
  // Wave RAM is the wave channel's, so an effect on another channel does not
  // get to rewrite the instrument the music is playing.
  if (reg >= 0x30 && reg <= 0x3f) return 1 << 2;
  return 0;
}

/** Note-off for one channel: the register that powers its DAC down. */
const CHANNEL_OFF = [0x12, 0x17, 0x1a, 0x21] as const;

/**
 * Each borrowable channel's bit and the offset a packed register byte adds.
 *
 * The copies are laid out so that `register + delta` is the copy's own high-RAM
 * offset, which makes recording a write one `add` rather than a table lookup.
 */
function shadowChannels(state: Layout, plan: ShadowPlan): { bit: number; delta: number }[] {
  return plan.channels.map((channel) => ({
    bit: channel.channel,
    delta: (state.shadow + shadowBias(channel)) & 0xff,
  }));
}

/** Build the driver a game embeds. */
export function buildGameAudio(input: GameAudioInput): GameAudio {
  const scripts = [...input.tracks, ...input.effects.map((effect) => effect.script)];
  if (scripts.length === 0)
    throw new AudioRomError("E_NO_AUDIO", "this game has no audio to build");

  // One timer produces one rate, so a game whose streams disagree about it
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
        "music and effects share one timer, so they must be fitted to one rate; this is a bug in the build, not in the source.",
      );
    }
  }
  const clock = resolveClock(first);
  const boot = bindingFor(first.console).init();

  // Preemption machinery exists only when there is something to preempt: a game
  // with music and no effects packs the flat format and stores `NR51` outright,
  // exactly as a music cartridge does.
  const shared = input.tracks.length > 0 && input.effects.length > 0;
  // The boot writes are taken off the *schedules*, not by the packer, so
  // `performed` is exactly what the conformance harness should expect to see.
  // The tag is a factory because one chip in the set latches its channel in the
  // data byte (`data.ts` §`channelOf`); this one does not, so the factory hands
  // back the same stateless function every time.
  //
  // `port` is the console's wiring rather than the chip's, so it goes on both
  // packing paths, shared or not: a Mega Duck has this exact APU at
  // `$FF20`-`$FF46` instead of `$FF10`-`$FF26`.
  const at = input.port ?? ((reg: number) => reg);
  const packOptions = shared
    ? { channelOf: () => gbChannelOf, mergeRegs: new Set([NR51]), port: at }
    : { port: at };

  let restricted = 0;
  const tracks = input.tracks.map((script) => stripBoot(script, boot));
  const effects = input.effects.map((effect) => {
    const owned = 1 << effect.channel;
    const result = restrict(stripBoot(effect.script, boot), owned, gbChannelOf);
    restricted += result.dropped;
    return result.script;
  });

  const musicData = tracks.map((script) => pack(script, packOptions));
  const effectData = effects.map((script) =>
    pack(script, { ...packOptions, end: "stop" as const }),
  );

  const stealable = input.effects.reduce((bits, effect) => bits | (1 << effect.channel), 0);
  // What the music has to remember so a borrowed channel comes back holding the
  // music's own note rather than the effect's last one (`shared.ts`).
  const shadow = shadowPlan(tracks, stealable, () => gbChannelOf, boot, (reg) => at(reg));
  const state = layout(input.hram, shadow.bytes);

  const helpers: string[] = [];
  let code = 0;
  let data = 0;

  const emitCode = (asm: Asm): void => {
    const start = asm.pc;
    emitInit(asm, state, boot, clock, at, shadow);
    emitTick(asm, state, input);
    if (input.tracks.length > 0) {
      emitMusicStart(asm, state, input);
      helpers.push(
        ...emitStream(asm, {
          prefix: "AudioMus",
          state: state.music,
          data: shapeOf(musicData),
          ...(shared ? { steal: state.steal, merge: "AudioMusPan" } : {}),
          ...(shared && shadow.bytes > 0
            ? { shadow: { channels: shadowChannels(state, shadow) } }
            : {}),
        }).map((name) => `music-${name}`),
      );
    }
    if (input.effects.length > 0) {
      emitSfxStart(asm, state, input);
      emitRelease(asm, state, stealable, shared, at, shadow);
      helpers.push(
        ...emitStream(asm, {
          prefix: "AudioSfx",
          state: state.sfx,
          data: shapeOf(effectData),
          onEnd: "AudioSfxRelease",
          ...(shared ? { merge: "AudioSfxPan" } : {}),
        }).map((name) => `sfx-${name}`),
      );
    }
    if (input.tracks.length > 0) emitSilence(asm, "AudioSilence", at);
    if (shared) {
      emitPan(asm, state, at);
      helpers.push("panning-merge");
    }
    code = asm.pc - start;
  };

  const emitData = (asm: Asm): void => {
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
    clock: { interrupt: clock.interrupt, vector: clock.vector, rate: clock.rate },
    request: { music: state.musicReq, sfx: state.sfxReq },
    emitCode,
    emitData,
    performed: { tracks, effects },
    get stats(): GameAudioStats {
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

// --- the schedules, as the ROM will perform them -----------------------------

// --- state -------------------------------------------------------------------

/** Where the driver keeps everything, laid out from the game's first free byte. */
interface Layout {
  music: StreamState;
  sfx: StreamState;
  /** Channels an effect has taken. */
  steal: number;
  /** Each stream's intended `NR51`, which the merge folds together. */
  panMusic: number;
  panSfx: number;
  /** Priority of the effect playing, for the one that wants to interrupt it. */
  priority: number;
  musicReq: number;
  sfxReq: number;
  /**
   * First byte of the music's copy of the borrowable channels.
   *
   * In high RAM rather than work RAM because both halves of the mechanism reach
   * it through `$FF00 + n`: the run walk records with `ld [c], a` and the replay
   * reads with `ldh a, [n]`, and a copy anywhere else would cost a sixteen-bit
   * pointer in a loop that has no register free for one.
   */
  shadow: number;
  /** One past the last byte used. */
  end: number;
}

function layout(base: number, shadowBytes: number): Layout {
  let at = base;
  const take = (): number => at++;
  const music: StreamState = {
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
  const sfx: StreamState = {
    dataLo: take(),
    dataHi: take(),
    orderLo: take(),
    orderHi: take(),
    rest: take(),
    active: take(),
  };
  const steal = take();
  const panMusic = take();
  const panSfx = take();
  const priority = take();
  const musicReq = take();
  const sfxReq = take();
  const shadow = at;
  at += shadowBytes;
  // `$FFFF` is the interrupt-enable register, so the last byte a driver may take
  // is `$FFFE`.
  if (at > 0xffff) {
    throw new AudioRomError(
      "E_AUDIO_HRAM",
      `this game's audio driver needs ${at - base} bytes of high RAM and there are ${0xffff - base}`,
      "high RAM is 127 bytes and the copy of each borrowable channel is part of what a driver keeps there; this is a bug in the build, not in the track.",
    );
  }
  return { music, sfx, steal, panMusic, panSfx, priority, musicReq, sfxReq, shadow, end: at };
}

// --- code --------------------------------------------------------------------

/** Power the chip up, clear the driver's state, and start the timer. */
function emitInit(
  asm: Asm,
  state: Layout,
  boot: readonly { reg: number; value: number }[],
  clock: ReturnType<typeof resolveClock>,
  at: (reg: number) => number,
  plan: ShadowPlan,
): void {
  asm.label("AudioInit");
  let held: number | undefined;
  for (const write of boot) {
    if (held !== write.value) {
      asm.ldn("a", write.value);
      held = write.value;
    }
    asm.stha(at(write.reg));
  }

  asm.alu("xor", "a");
  for (const byte of [
    state.music.active as number,
    state.sfx.active as number,
    state.steal,
    state.panSfx,
    state.priority,
    state.musicReq,
    state.sfxReq,
  ]) {
    asm.stha(byte);
  }
  // The music's shadow starts at what the boot writes left in `NR51`, so the
  // first merge folds against the truth rather than against zero.
  const panning = boot.find((write) => write.reg === NR51);
  asm.ldn("a", panning?.value ?? 0xff);
  asm.stha(state.panMusic);

  // The copy of each borrowable channel starts at what the boot writes leave
  // those registers holding, so a replay before the music has stated anything
  // restores the chip's power-up condition rather than a guess. Unrolled because
  // it is a handful of bytes and a loop would cost a register the caller has not
  // been told about.
  let last: number | undefined;
  for (let byte = 0; byte < plan.bytes; byte += 1) {
    const value = plan.init[byte] as number;
    if (last !== value) {
      if (value === 0) asm.alu("xor", "a");
      else asm.ldn("a", value);
      last = value;
    }
    asm.stha(state.shadow + byte);
  }

  if (clock.source === "timer") {
    asm.alu("xor", "a").stha(0x07); // TAC off while the reload is set
    asm.ldn("a", clock.tma as number).stha(0x06); // TMA
    asm.ldn("a", clock.tma as number).stha(0x05); // TIMA: a full first period
    asm.ldn("a", clock.tac as number).stha(0x07);
  }
  asm.ret();
}

/**
 * One driver tick: take what the game asked for, then step each stream.
 *
 * Requests are single bytes rather than pointers because the game writes them
 * from its own loop while this runs on an interrupt. One byte is written
 * atomically; a pointer and a length are not, and the tick that arrived between
 * them would play half of one effect and half of another.
 */
function emitTick(asm: Asm, state: Layout, input: GameAudioInput): void {
  asm.label("AudioTick");
  if (input.tracks.length > 0) {
    asm.ldha(state.musicReq);
    asm.alu("or", "a");
    asm.call("AudioMusicStart", "nz");
  }
  if (input.effects.length > 0) {
    asm.ldha(state.sfxReq);
    asm.alu("or", "a");
    asm.call("AudioSfxStart", "nz");
  }
  if (input.tracks.length > 0) asm.call("AudioMusTick");
  // Effects step after the music, so on a tick where both write the same
  // register the effect is the one the chip is left holding.
  if (input.effects.length > 0) asm.jp("AudioSfxTick");
  else asm.ret();
}

/** Start the requested track, or stop the music. */
function emitMusicStart(asm: Asm, state: Layout, input: GameAudioInput): void {
  asm.label("AudioMusicStart");
  asm.ld("b", "a");
  asm.alu("xor", "a");
  asm.stha(state.musicReq);

  // A scene change stops whatever was playing, effect included: the sound of
  // the old scene carrying into the new one is a bug in every game that has it.
  // Nothing playing means nothing to stop, and skipping the silencing there is
  // what makes the first track's first tick exactly the schedule's first tick.
  asm.ldha(state.music.active as number);
  if (input.effects.length > 0) {
    asm.ld("c", "a");
    asm.ldha(state.sfx.active as number);
    asm.alu("or", "c");
  }
  asm.alu("or", "a");
  asm.jr("AudioMusicFresh", "z");
  asm.alu("xor", "a");
  asm.stha(state.music.active as number);
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
  asm.ldaHLI().stha(state.music.orderLo);
  asm.ldaHLI().stha(state.music.orderHi);
  asm.ldaHLI().stha(state.music.loopLo as number);
  asm.ldaHLI().stha(state.music.loopHi as number);
  asm.alu("xor", "a");
  asm.stha(state.music.rest);
  asm.call("AudioMusNextBlock");
  asm.ldn("a", 1);
  asm.stha(state.music.active as number);
  asm.ret();
}

/** Fire the requested effect, unless the one playing outranks it. */
function emitSfxStart(asm: Asm, state: Layout, input: GameAudioInput): void {
  asm.label("AudioSfxStart");
  asm.ld("b", "a");
  asm.alu("xor", "a");
  asm.stha(state.sfxReq);

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
    asm.ldha(state.sfx.active as number);
    asm.alu("or", "a");
    asm.jr("AudioSfxTake", "z");
    asm.push("hl");
    asm.inc16("hl").inc16("hl").inc16("hl");
    asm.ld("a", "hlp");
    asm.ld("b", "a");
    asm.ldha(state.priority);
    asm.alu("cp", "b");
    asm.pop("hl");
    asm.ret("nc"); // what is playing ranks at least as high; the new one is dropped
  }

  asm.label("AudioSfxTake");
  asm.alu("xor", "a");
  asm.stha(state.sfx.active as number);
  asm.push("hl");
  asm.call("AudioSfxRelease");
  asm.pop("hl");
  asm.ldaHLI().stha(state.sfx.orderLo);
  asm.ldaHLI().stha(state.sfx.orderHi);
  asm.ldaHLI().stha(state.steal);
  asm.ld("a", "hlp");
  asm.stha(state.priority);
  asm.alu("xor", "a");
  asm.stha(state.sfx.rest);
  asm.call("AudioSfxNextBlock");
  asm.ldn("a", 1);
  asm.stha(state.sfx.active as number);
  asm.ret();
}

/**
 * Give back the channels an effect borrowed.
 *
 * The music's own registers are replayed from the copy the run walk keeps
 * (`shared.ts` §`shadowPlan`), so the channel comes back sounding the note the
 * music was holding. Silencing it and waiting for the music's next note — which
 * is what this did — is wrong twice over: the packed music is a delta stream, so
 * the *next note* can be a whole bar away for a held chord tone, and the channel
 * does not stay silent that long either. Any later write the music makes to it —
 * a volume step, which the driver-shaped decay makes several times a note —
 * re-triggers it through `NRx4` while `NRx3` still holds the effect's low byte,
 * so a pulse comes back a whole tone sharp and rings until the bar ends. It was
 * heard in pong as a dissonant note on every bounce.
 *
 * A channel the music never writes has no copy and is silenced, because there is
 * nothing truer to say about it.
 *
 * The mask is held in `c` rather than `b` because **`b` is live in the caller**:
 * `AudioMusicStart` holds the track it was asked for there across this call, and
 * a scene change that happened while an effect was playing would otherwise start
 * whichever track the effect's channel mask happened to name — or start one where
 * the scene asked for silence. `c` is free by then and dead again before
 * `AudioPan` reaches for it.
 */
function emitRelease(
  asm: Asm,
  state: Layout,
  stealable: number,
  shared: boolean,
  at: (reg: number) => number,
  plan: ShadowPlan,
): void {
  asm.label("AudioSfxRelease");
  asm.ldha(state.steal);
  asm.alu("or", "a");
  asm.ret("z");
  asm.ld("c", "a");
  for (let channel = 0; channel < CHANNEL_OFF.length; channel += 1) {
    if ((stealable & (1 << channel)) === 0) continue;
    const skip = `AudioRelease${channel}`;
    asm.bit(channel, "c");
    asm.jr(skip, "z");
    const copy = plan.channels.find((one) => one.channel === 1 << channel);
    if (copy) {
      // Ascending register order, so the byte carrying the trigger is written
      // last and strikes a voice the rest of the replay has already stated.
      for (const write of copy.writes) {
        asm.ldha(state.shadow + write.slot);
        asm.stha(write.port);
      }
    } else {
      asm.alu("xor", "a");
      asm.stha(at(CHANNEL_OFF[channel] as number));
    }
    asm.label(skip);
  }
  asm.alu("xor", "a");
  asm.stha(state.steal);
  asm.stha(state.sfx.active as number);
  if (shared) {
    asm.stha(state.panSfx);
    asm.jp("AudioPan");
  } else {
    asm.ret();
  }
}

/** Turn every channel off — what stopping the music means. */
function emitSilence(asm: Asm, name: string, at: (reg: number) => number): void {
  asm.label(name);
  asm.alu("xor", "a");
  for (const reg of CHANNEL_OFF) asm.stha(at(reg));
  asm.ret();
}

/**
 * Fold the two panning shadows under the steal mask and write `NR51`.
 *
 * `swap` turns the channel mask into the register's two-nibble layout, which is
 * why the mask is kept as one nibble: the left and right bits of a channel are
 * four apart, so one byte holds both meanings.
 *
 * Clobbers `a`, `c` and `e` only — `b`, `d` and `hl` are live in the run walk
 * that calls it.
 */
function emitPan(asm: Asm, state: Layout, at: (reg: number) => number): void {
  asm.label("AudioMusPan");
  asm.stha(state.panMusic);
  asm.jr("AudioPan");

  asm.label("AudioSfxPan");
  asm.stha(state.panSfx);

  asm.label("AudioPan");
  asm.ldha(state.steal);
  asm.ld("c", "a");
  asm.shift("swap", "a");
  asm.alu("or", "c");
  asm.ld("c", "a"); // the stolen channels, in NR51's layout
  asm.ldha(state.panSfx);
  asm.alu("and", "c");
  asm.ld("e", "a");
  asm.ld("a", "c");
  asm.cpl();
  asm.ld("c", "a");
  asm.ldha(state.panMusic);
  asm.alu("and", "c");
  asm.alu("or", "e");
  asm.stha(at(NR51));
  asm.ret();
}
