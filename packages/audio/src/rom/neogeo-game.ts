/**
 * The Neo Geo's sound program — the eighth generated driver, and the first that
 * is a **cartridge region of its own**.
 *
 * Every other driver in this directory is either routines a game calls
 * (`gb-game.ts`, `nes-game.ts`, `sms-game.ts`, `md-game.ts`, `pce-game.ts`,
 * `wsc-game.ts`, `ngp-game.ts`), a block the cartridge uploads (`spc-game.ts`) or
 * a second binary in memory both processors share (`nds-game.ts`). This one is a
 * **whole Z80 program in the cartridge's M region**, on a bus the 68000 cannot
 * see: it boots itself, clocks itself, and the game reaches it by storing one byte
 * to `REG_SOUND`.
 *
 * Four things about it are this console's and none is a predecessor restated.
 *
 * ### The clock is the chip's own timer, and the interrupt comes here
 *
 * A Mega Drive has exactly this hardware with the wire the other way round: there
 * the YM2612's timer line goes to the Z80, so a *game* has to poll the status byte
 * from a loop that is also running a game and gets the loop's rate rather than the
 * timer's (`md-game.ts` §resolveMdClock). Here the driver *is* the Z80, so it
 * takes the interrupt directly and keeps the timer's rate exactly — which is why
 * this console's fitted tick is 119.99 Hz and its schedules say `timer` with no
 * frame candidate anywhere near them.
 *
 * The handler still only *counts*. Performing a tick inside it would be no
 * cheaper here than anywhere else and would make a long tick able to be missed;
 * the main loop has nothing else to do, so it pays whatever the counter says.
 *
 * ### A request is an interrupt rather than a poll
 *
 * The 68000 stores a byte and the hardware latches it and pulls this processor's
 * non-maskable line. So a game asking for a track costs **one store** — no
 * handshake, no waiting, and no shared memory. The handler reads port `$00`,
 * which both takes the byte and acknowledges it.
 *
 * The one race is worth stating rather than hiding: the main loop reads the
 * pending byte and clears it in two instructions, and a request landing between
 * them is lost. That window is about two microseconds against a game that asks for
 * something a few times a second, and closing it would cost either the hardware's
 * NMI-disable ports (which drop the interrupt rather than deferring it, so the
 * request is lost anyway) or a queue this processor has no reason to need.
 *
 * ### An effect borrows a square, never an FM voice
 *
 * `neogeoAudio` lists the three squares first precisely so that `sfx` places an
 * effect on one. That is what this console's own games did, and it buys the driver
 * something concrete: the FM key-on byte names its channel in the *datum*, which
 * an address byte cannot know, so an effect on an FM voice would need a tag that
 * cannot be computed. Off the FM voices, the tag is exact.
 *
 * ### A borrowed channel is given back, and its shadow is told apart by the port
 *
 * The music is a delta stream, so a channel an effect has borrowed comes back
 * holding the effect's registers unless the release replays the music's own
 * (doc 13 §Handing a borrowed channel back). Every driver in the set does that;
 * what is this console's is *how the copy is filled in*. A packed byte here is a
 * **port** rather than a register number, so a recorder cannot tell one of a
 * channel's bytes from another by looking at it — an even port latched a register
 * and the byte is that register's number, an odd one is the datum and the latch
 * says which of the three copies it belongs to. That is why the shadow is four
 * bytes rather than three (`neogeo-driver.ts` §{@link NEOGEO_SHADOW}), and it is
 * the SN76489's problem two chips along with a different mechanism.
 *
 * Three registers is the whole of it because an effect only ever borrows a square,
 * which the section above is why. An FM voice's state is a patch, so a driver that
 * had to give one of those back would be replaying thirty registers rather than
 * three — and it never has to.
 *
 * The stream player is `z80-player.ts`'s, unchanged — the walk belongs to the
 * processor — and what this chip adds is in `neogeo-driver.ts`.
 */

import { AsmZ80, label } from "@demake/core";

import type { ChipScript, Rational } from "../chipscript.js";
import { bindingFor } from "../binding/registry.js";
import { adpcmABank, adpcmBBank } from "../binding/neogeo-bank.js";

import type { DriverData } from "./data.js";
import { AudioRomError } from "./gb.js";
import type { GameEffect } from "./gb-game.js";
import {
  checkAddressDiscipline,
  neogeoChannelTag,
  neogeoRecord,
  neogeoShadowRegisters,
  neogeoShadowTake,
  NEOGEO_SHADOW,
  neogeoOwnerTag,
  neogeoPortOf,
  neogeoWrite,
  NEOGEO_SOUND_PORT,
} from "./neogeo-driver.js";
import { MAX_PENDING, pack, rateHz, restrict, shapeOf, stripBoot } from "./shared.js";
import { emitStream, emitStreamData, type Z80StreamState } from "./z80-player.js";

/** The command byte that stops the music rather than starting a track. */
export const STOP = 0xff;

/** Commands at or above this start an effect; below it, a track. */
export const SFX_BASE = 0x40;

/** The Z80's work RAM, which this program owns entirely. */
const RAM = 0xf800;
const RAM_SIZE = 0x0800;

/** How many channels an effect may be spread across; the run field is a nibble. */
const MAX_STEAL = 4;

/** What the game hands the driver builder. */
export interface NeogeoGameAudioInput {
  tracks: readonly ChipScript[];
  effects: readonly GameEffect[];
}

/** Sizes and reductions, reported rather than assumed. */
export interface NeogeoGameAudioStats {
  code: number;
  data: number;
  tracks: number;
  effects: number;
  blocks: number;
  blocksSaved: number;
  helpers: readonly string[];
  rate: Rational;
  writesRestricted: number;
}

/** A built sound program: a whole M region, and how the game asks it for things. */
export interface NeogeoGameAudio {
  clock: { rate: Rational; divisor: number };
  /** The M region: a complete Z80 program, 32 KiB, ready for the container. */
  rom: Uint8Array;
  /** The two ADPCM sample ROMs, which are the container's two V regions. */
  samplesA: Uint8Array;
  samplesB: Uint8Array;
  /** What the 68000 stores to `REG_SOUND`. */
  command: {
    /** Track `index`, zero based. */
    music(index: number): number;
    /** Effect `index`, zero based. */
    sfx(index: number): number;
    stop: number;
  };
  /**
   * Addresses a harness watches, which the ROM has anyway.
   *
   * `tick` is entered once per driver tick and `tickEnd` once it is over, which is
   * what makes a group of writes *this* tick's rather than everything between two
   * arrivals — the distinction the Mega Drive's cartridge made necessary, because
   * a driver whose clock is a chip register writes it outside the tick.
   */
  symbols: { tick: number; tickEnd: number };
  /** The schedules as the program will really perform them (doc 16 §The proof). */
  performed: { tracks: readonly ChipScript[]; effects: readonly ChipScript[] };
  stats: NeogeoGameAudioStats;
}

/** Where the driver keeps its state, in the two kilobytes it has. */
interface Layout {
  ticks: number;
  command: number;
  steal: number;
  music: Z80StreamState;
  sfx: Z80StreamState;
  /** Where each borrowable channel's copy of the music's registers lives. */
  shadow(index: number): number;
  top: number;
}

function layout(): Layout {
  let at = RAM;
  const byte = (): number => at++;
  const word = (): number => {
    const here = at;
    at += 2;
    return here;
  };
  const shadowBase = RAM + 0x20;
  return {
    ticks: byte(),
    command: byte(),
    steal: byte(),
    music: { data: word(), order: word(), loop: word(), rest: byte(), active: byte() },
    sfx: { data: word(), order: word(), rest: byte(), active: byte() },
    // Four bytes per borrowable channel, reserved rather than fitted: the number
    // of them is not known until the effects are demade, and this processor has
    // two kilobytes it uses a few dozen of.
    shadow: (index: number): number => shadowBase + index * NEOGEO_SHADOW.bytes,
    // The stack grows down from the top of the two kilobytes. This processor comes
    // up with none at all — everything below `$F800` is ROM — so a program that
    // took an interrupt without setting one would push its return address into a
    // ROM that drops it and come back to whatever the ROM happened to hold.
    top: RAM + RAM_SIZE - 2,
  };
}

/** Build the sound program a Neo Geo cartridge carries. */
export function buildNeogeoGameAudio(input: NeogeoGameAudioInput): NeogeoGameAudio {
  const scripts = [...input.tracks, ...input.effects.map((effect) => effect.script)];
  const first = scripts[0];
  if (first === undefined) {
    throw new AudioRomError("E_NO_AUDIO", "this game has no audio to build");
  }
  for (const script of scripts) {
    if (script.driver.rate.num !== first.driver.rate.num) {
      throw new AudioRomError(
        "E_RATE_MISMATCH",
        `two schedules disagree about the driver rate: ${rateHz(first.driver.rate)} Hz and ${rateHz(script.driver.rate)} Hz`,
        "music and effects share one interrupt, so they must be fitted to one rate.",
      );
    }
    checkAddressDiscipline(script);
  }
  const reload = first.driver.divisor;
  if (reload === undefined) {
    throw new AudioRomError(
      "E_NO_DIVISOR",
      "this console's driver rides timer A, so a schedule must carry the reload that makes it",
    );
  }

  const binding = bindingFor(first.console);
  const boot = binding.init();
  const state = layout();

  // Which channels an effect takes, in the order their bits appear in a run's
  // channel field. Everything else tags zero, so a track's other thirteen voices
  // play *through* an effect rather than ducking for it — the Mega Drive's and the
  // Nintendo DS's arrangement, and the reason a four-bit field is enough here.
  const numbered: number[] = [];
  for (const effect of input.effects) {
    if (!numbered.includes(effect.channel)) numbered.push(effect.channel);
  }
  if (numbered.length > MAX_STEAL) {
    throw new AudioRomError(
      "E_TOO_MANY_STOLEN",
      `effects are spread over ${numbered.length} channels and a run names at most ${MAX_STEAL}`,
      "place this game's effects on fewer channels.",
    );
  }
  const tag = neogeoChannelTag(numbered);

  const tracks = input.tracks.map((script) => stripBoot(script, boot));
  let writesRestricted = 0;
  const effects = input.effects.map((effect) => {
    // Numbered by *channel* rather than by run bit, because restriction asks a
    // different question from preemption: which channel a write belongs to, over
    // all fourteen, rather than which of the four an effect might be on.
    const result = restrict(stripBoot(effect.script, boot), 1 << effect.channel, neogeoOwnerTag());
    writesRestricted += result.dropped;
    return result.script;
  });

  const options = { channelOf: tag, port: neogeoPortOf } as const;
  const musicData = tracks.map((script) => pack(script, options));
  // `stop` rather than `silence`, which is the whole difference between a
  // cartridge that owns the chip and one borrowing a channel from the music: the
  // silence block turns *every* channel off and then rests for ever, so it would
  // take the music with it and hold the borrowed channel long after the effect
  // had finished. The order list's terminator is what says an effect is over, and
  // the release is what hands the channel back.
  const effectData = effects.map((script) => pack(script, { ...options, end: "stop" }));

  const stealMasks = input.effects.map(
    (effect) => 1 << Math.max(0, numbered.indexOf(effect.channel)),
  );

  const built = assemble({
    state,
    boot,
    reload,
    musicData,
    effectData,
    stealMasks,
    numbered,
    hasSteal: numbered.length > 0 && tracks.length > 0,
  });

  const blocks = [...musicData, ...effectData].reduce((sum, one) => sum + one.blocks.length, 0);
  return {
    clock: { rate: first.driver.rate, divisor: reload },
    rom: built.rom,
    samplesA: adpcmABank().rom,
    samplesB: adpcmBBank().rom,
    symbols: built.symbols,
    command: {
      music: (index: number): number => index + 1,
      sfx: (index: number): number => SFX_BASE + index,
      stop: STOP,
    },
    performed: { tracks, effects },
    stats: {
      code: built.code,
      data: built.data,
      tracks: tracks.length,
      effects: effects.length,
      blocks,
      blocksSaved: 0,
      helpers: built.helpers,
      rate: first.driver.rate,
      writesRestricted,
    },
  };
}

interface AssembleInput {
  state: Layout;
  boot: readonly { reg: number; value: number }[];
  reload: number;
  musicData: readonly DriverData[];
  effectData: readonly DriverData[];
  stealMasks: readonly number[];
  /** The spec channels effects were placed on, in run-bit order. */
  numbered: readonly number[];
  hasSteal: boolean;
}

/** Emit the whole program, and report what it pulled in and what it cost. */
function assemble(input: AssembleInput): {
  rom: Uint8Array;
  code: number;
  data: number;
  helpers: string[];
  symbols: { tick: number; tickEnd: number };
} {
  const { state, musicData, effectData } = input;
  const asm = new AsmZ80(0);
  const helpers: string[] = [];

  // Reset, and the two vectors this machine has. They are a few bytes apart, so
  // each is a jump to the routine that does the work.
  asm.di();
  asm.ld16("sp", state.top);
  asm.jp("Boot");

  asm.padTo(0x0038);
  asm.jp("AudioIrq");
  asm.padTo(0x0066);
  asm.jp("AudioNmi");

  const codeStart = asm.pc;

  // --- the timer, which is this processor's clock ------------------------------
  //
  // `af` is saved because an interrupt lands between two instructions of whatever
  // it interrupted, and everything below holds values in `a` across a load and a
  // store. The counter is capped for the reason every frame-clocked driver caps
  // its own: coming back owing hundreds of ticks is a schedule performed at once.
  asm.label("AudioIrq");
  asm.push("af");
  asm.lda(state.ticks);
  asm.aluN("cp", MAX_PENDING);
  asm.jr("AudioIrqFull", "z");
  asm.inc("a");
  asm.sta(state.ticks);
  asm.label("AudioIrqFull");
  // `$27` again: bit 4 resets timer A's overflow flag while bits 0 and 2 keep it
  // running and enabled. The line is level triggered, so a handler that left this
  // out would be re-entered the instant `ei` ran and the main loop would never
  // get another instruction.
  chipWrite(asm, 0, 0x27, 0x15);
  asm.pop("af");
  asm.ei();
  asm.reti();

  // --- a request from the 68000 -------------------------------------------------
  asm.label("AudioNmi");
  asm.push("af");
  asm.inN(NEOGEO_SOUND_PORT.command);
  asm.sta(state.command);
  asm.pop("af");
  asm.retn();

  // --- boot ---------------------------------------------------------------------
  asm.label("Boot");
  asm.ld16("hl", state.ticks);
  asm.ld("a", "h");
  asm.alu("xor", "a");
  for (let offset = state.ticks; offset < state.top; offset += 1) {
    // Nothing here is a loop on purpose: the whole state is a couple of dozen
    // bytes, and a clear loop would cost more than it saved.
    if (offset - state.ticks > 24) break;
    asm.sta(offset);
  }
  asm.ld16("hl", label("AudioBoot"));
  asm.call("AudioTable");
  // Timer A's ten bits, then load and enable it. The reload is the schedule's own
  // (`fitRate`), so the tick the driver keeps is the tick the music was written
  // against rather than one this file chose.
  chipWrite(asm, 0, 0x24, (input.reload >> 2) & 0xff);
  chipWrite(asm, 0, 0x25, input.reload & 3);
  chipWrite(asm, 0, 0x27, 0x05);
  asm.im(1);
  asm.inN(NEOGEO_SOUND_PORT.enableNmi);
  // And take whatever is already waiting. The 68000 boots in a few hundred cycles
  // and this program takes tens of thousands, so a game that asks for its entry
  // scene's track asks before this processor was listening — the hardware latches
  // the byte either way, and only the interrupt is lost. Reading the port here is
  // what turns that into a track that plays rather than a cartridge that is
  // silent until the second scene.
  asm.inN(NEOGEO_SOUND_PORT.command);
  asm.sta(state.command);
  asm.ei();

  asm.label("Loop");
  asm.ld16("hl", state.command);
  asm.ld("a", "hlp");
  asm.alu("or", "a");
  asm.jr("LoopTick", "z");
  asm.ldn("hlp", 0);
  asm.call("AudioCommand");
  asm.label("LoopTick");
  asm.lda(state.ticks);
  asm.alu("or", "a");
  asm.jr("Loop", "z");
  asm.dec("a");
  asm.sta(state.ticks);
  // A tick nothing is playing is not a tick. This driver runs from boot whether
  // or not the game has asked for anything — it is a separate program, so there
  // is nobody to start it — and ticking through silence would put the schedule's
  // tick 0 several ticks after the first one the hardware delivered. Every other
  // console is spared this because its driver is a routine the game calls.
  const play = "LoopPlay";
  if (musicData.length > 0 && effectData.length > 0) {
    asm.lda(state.music.active as number);
    asm.alu("or", "a");
    asm.jr(play, "nz");
    asm.lda(state.sfx.active as number);
    asm.alu("or", "a");
    asm.jp("Loop", "z");
  } else {
    asm.lda((musicData.length > 0 ? state.music.active : state.sfx.active) as number);
    asm.alu("or", "a");
    asm.jp("Loop", "z");
  }
  asm.label(play);
  // One label per driver tick, so a conformance harness can attribute writes by
  // program counter without anything being added to the ROM to make it visible
  // (doc 16 §The proof).
  asm.label("AudioTick");
  if (musicData.length > 0) asm.call("AudioMusTick");
  if (effectData.length > 0) asm.call("AudioSfxTick");
  asm.label("AudioTickEnd");
  asm.jp("Loop");

  // --- what a command means ------------------------------------------------------
  asm.label("AudioCommand");
  if (musicData.length > 0) {
    asm.aluN("cp", STOP);
    asm.jr("AudioStop", "z");
  }
  if (effectData.length > 0) {
    asm.aluN("cp", SFX_BASE);
    asm.jr("AudioSfxCommand", "nc");
  }
  if (musicData.length > 0) {
    asm.dec("a");
    asm.jp("AudioMusStart");
  } else {
    asm.ret();
  }
  if (effectData.length > 0) {
    asm.label("AudioSfxCommand");
    asm.aluN("sub", SFX_BASE);
    asm.jp("AudioSfxStart");
  }
  if (musicData.length > 0) {
    asm.label("AudioStop");
    asm.alu("xor", "a");
    asm.sta(state.music.active as number);
    asm.ld16("hl", label("AudioQuiet"));
    asm.jp("AudioTable");
    helpers.push("stop");
  }

  // --- the two tables the boot and the stop walk ----------------------------------
  //
  // A table rather than a run of stores, for the PC Engine's reason: this chip's
  // initialisation is a hundred-odd register writes, and a pair of bytes each is a
  // quarter of what the instructions would cost.
  asm.label("AudioTable");
  asm.label("AudioTableNext");
  asm.ld("a", "hlp");
  asm.inc16("hl");
  asm.aluN("cp", 0xff);
  asm.ret("z");
  asm.ld("c", "a");
  asm.ld("a", "hlp");
  asm.inc16("hl");
  asm.outC("a");
  asm.push("af");
  asm.pop("af");
  asm.push("af");
  asm.pop("af");
  asm.jr("AudioTableNext");
  helpers.push("register-table");

  if (musicData.length > 0) {
    emitStart(asm, "AudioMus", state.music, "AudioTracks", undefined);
    helpers.push(
      ...emitStream(asm, {
        prefix: "AudioMus",
        state: state.music,
        data: shapeOf(musicData),
        write: neogeoWrite,
        ...(input.hasSteal ? { steal: state.steal } : {}),
        ...(input.hasSteal
          ? {
              shadow: {
                channels: input.numbered.map((channel, index) => ({
                  bit: 1 << index,
                  at: state.shadow(index),
                  slots: neogeoShadowRegisters(channel),
                })),
                take: neogeoShadowTake,
                record: neogeoRecord,
              },
            }
          : {}),
      }).map((name) => `music-${name}`),
    );
  }
  if (effectData.length > 0) {
    emitStart(asm, "AudioSfx", state.sfx, "AudioEffects", {
      steal: state.steal,
      masks: "AudioSfxSteal",
    });
    emitRelease(asm, state, input);
    helpers.push(input.hasSteal ? "borrowed-channel-replay" : "sfx-release");
    helpers.push(
      ...emitStream(asm, {
        prefix: "AudioSfx",
        state: state.sfx,
        data: shapeOf(effectData),
        write: neogeoWrite,
        onEnd: "AudioSfxRelease",
      }).map((name) => `sfx-${name}`),
    );
  }

  const code = asm.pc - codeStart;
  const dataStart = asm.pc;

  asm.label("AudioBoot");
  for (const write of input.boot) asm.db(neogeoPortOf(write.reg), write.value & 0xff);
  asm.db(0xff);
  if (musicData.length > 0) {
    asm.label("AudioQuiet");
    for (const write of quietWrites()) asm.db(neogeoPortOf(write.reg), write.value);
    asm.db(0xff);
    asm.label("AudioTracks");
    for (let index = 0; index < musicData.length; index += 1) {
      asm.dw(label(`AudioMusOrder${index}`));
    }
  }
  if (effectData.length > 0) {
    asm.label("AudioEffects");
    for (let index = 0; index < effectData.length; index += 1) {
      asm.dw(label(`AudioSfxOrder${index}`));
    }
    asm.label("AudioSfxSteal");
    for (const mask of input.stealMasks) asm.db(mask);
  }
  for (const [index, data] of musicData.entries()) emitStreamData(asm, "AudioMus", index, data);
  for (const [index, data] of effectData.entries()) emitStreamData(asm, "AudioSfx", index, data);

  const symbols = { tick: asm.addressOf("AudioTick"), tickEnd: asm.addressOf("AudioTickEnd") };
  const image = asm.assemble();
  if (image.length > 0x8000) {
    throw new AudioRomError(
      "E_SOUND_ROM_FULL",
      `the sound program is ${image.length} bytes and the fixed window is 32768`,
      "shorten the music, or teach the driver to page the M ROM's banked windows.",
    );
  }
  const rom = new Uint8Array(0x8000);
  rom.set(image);
  return { rom, code, data: asm.pc - dataStart, helpers, symbols };
}

/**
 * Hand a borrowed channel back holding the music's own registers.
 *
 * Not a note-off: the packed music is a **delta** stream, so a register the
 * music's own value did not change is one it never states again — and after an
 * effect has borrowed the channel the chip is holding the effect's period for it.
 * Left alone, the music's next level step re-triggers the voice at whatever pitch
 * the effect ended on, which is the "comes back a whole tone sharp" failure
 * `shared.ts` §shadowPlan names. So the release replays the three registers a
 * square is, from the copy the run walk has been keeping.
 *
 * Only `a` is used, and nothing is saved: this is called from the stream player's
 * own dispatch rather than from inside its data walk.
 *
 * The shape is `z80-player.ts`'s `perChannel` — every channel tested up front with
 * a `jp`, then the bodies — for its reason and one more. Each body here is about
 * fifty bytes, so four of them laid out to fall through would put the last one's
 * exit branch two hundred bytes from its target: a relative jump that assembles
 * for every game in the library until one places effects on all four borrowable
 * channels, which is the trap the SM83 player already fell into once (§Which is
 * why a branch across a driver's run walk is a long branch).
 */
function emitRelease(asm: AsmZ80, state: Layout, input: AssembleInput): void {
  asm.label("AudioSfxRelease");
  if (!input.hasSteal) {
    asm.alu("xor", "a");
    asm.sta(state.steal);
    asm.ret();
    return;
  }
  const channels = input.numbered;
  // The last channel is not tested: the release only runs because an effect was
  // playing, so one of these bits is set and the dispatch falls into it.
  for (let index = 0; index < channels.length - 1; index += 1) {
    asm.lda(state.steal);
    asm.aluN("and", 1 << index);
    asm.jp(`AudioSfxGiveBack${index}`, "nz");
  }
  for (const [index, channel] of channels.entries()) {
    asm.label(`AudioSfxGiveBack${index}`);
    const registers = neogeoShadowRegisters(channel);
    const slots = [NEOGEO_SHADOW.fine, NEOGEO_SHADOW.coarse, NEOGEO_SHADOW.level];
    for (const [slot, register] of registers.entries()) {
      asm.ldn("a", register);
      asm.outN(0x04);
      settle(asm);
      asm.lda(state.shadow(index) + (slots[slot] as number));
      asm.outN(0x05);
      settle(asm);
    }
    asm.alu("xor", "a");
    asm.sta(state.steal);
    asm.ret();
  }
}

/**
 * Start a stream: point it at an order list and take the first block.
 *
 * `NextBlock` is the player's own, so a start is a pointer and a call rather than
 * a second walk over the same tables.
 */
function emitStart(
  asm: AsmZ80,
  prefix: string,
  state: Z80StreamState,
  table: string,
  steal: { steal: number; masks: string } | undefined,
): void {
  asm.label(`${prefix}Start`);
  if (steal) {
    // The mask goes in before the stream does, so a music tick that lands between
    // the two cannot write the channel the effect is about to take.
    asm.push("af");
    asm.ld("l", "a");
    asm.ldn("h", 0);
    asm.ld16("de", label(steal.masks));
    asm.addHL("de");
    asm.ld("a", "hlp");
    asm.sta(steal.steal);
    asm.pop("af");
  }
  asm.ld("l", "a");
  asm.ldn("h", 0);
  asm.addHL("hl");
  asm.ld16("de", label(table));
  asm.addHL("de");
  asm.ld("e", "hlp");
  asm.inc16("hl");
  asm.ld("d", "hlp");
  asm.exDEHL();
  asm.st16To(state.order, "hl");
  if (state.loop !== undefined) asm.st16To(state.loop, "hl");
  asm.alu("xor", "a");
  asm.sta(state.rest);
  asm.ldn("a", 1);
  asm.sta(state.active as number);
  asm.jp(`${prefix}NextBlock`);
}

/** One register write, as the two port stores it really is, with its settling. */
function chipWrite(asm: AsmZ80, pair: 0 | 1, register: number, value: number): void {
  const port = 0x04 + pair * 2;
  asm.ldn("a", register);
  asm.outN(port);
  settle(asm);
  asm.ldn("a", value);
  asm.outN(port + 1);
  settle(asm);
}

/** The time this chip needs after a store, which is four bytes and no register. */
function settle(asm: AsmZ80): void {
  asm.push("af");
  asm.pop("af");
  asm.push("af");
  asm.pop("af");
}

/**
 * What stopping the music writes: every section silenced by its own means.
 *
 * Four different mechanisms, because this chip's four sections have nothing in
 * common — the FM voices are keyed off, the squares are set to level zero, the
 * six sample voices are dumped by one masked pulse, and the seventh is reset.
 */
function quietWrites(): { reg: number; value: number }[] {
  const out: { reg: number; value: number }[] = [];
  const write = (pair: 0 | 1, register: number, value: number): void => {
    out.push({ reg: pair * 2, value: register }, { reg: pair * 2 + 1, value });
  };
  for (const code of [0x01, 0x02, 0x05, 0x06]) write(0, 0x28, code);
  for (let channel = 0; channel < 3; channel += 1) write(0, 0x08 + channel, 0);
  write(1, 0x00, 0xbf);
  write(0, 0x10, 0x01);
  return out;
}
