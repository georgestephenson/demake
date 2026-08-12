/**
 * `ChipScript` → a bootable ROM (doc 16 §The driver contract).
 *
 * The console hand-off, and the one place a console without a driver backend is
 * refused. **A backend gap is a build error, never a silent difference** — the
 * rule doc 14 states for games holds here for exactly the same reason: a
 * cartridge that played a different arrangement from the preview would make the
 * schedule oracle report a divergence three layers from its cause.
 *
 * Seven families build a *cartridge of their own* today: the Game Boy, the NES,
 * the PC Engine, the Sega 8-bits, the Mega Drive, the Game Boy Advance and both
 * WonderSwans. The rest have drivers but
 * only inside a game, because that is what a game needed and a cartridge whose
 * only job is one track is a different caller. What any of them costs is no
 * longer an estimate: the stream player belongs to the *processor* and already
 * exists for all of them, so what a console adds is a boot sequence, a clock and
 * a cartridge wrapper — which is the whole of the difference between `gb.ts`,
 * `nes.ts`, `pce.ts`, `sms.ts`, `md.ts`, `gba.ts` and `wsc.ts`, three of which
 * share a player with another console and two of which cover two machines each.
 *
 * **A standalone cartridge is not a game with the game taken out**, and two of
 * them are where that stops being a turn of phrase. On the Mega Drive a game
 * can only have the frame, because the FM chip's timer interrupt goes to the Z80
 * and a game polling it would be reading the status byte once per pass of a loop
 * that is also running a game. A cartridge whose loop does nothing else polls it
 * every few microseconds, so it keeps the timer's rate exactly — which is why
 * `resolveMdClock` and `resolveMdAudioClock` refuse *opposite* sources.
 *
 * The Game Boy Advance is where the distinction stops mattering again, and for a
 * reason worth keeping: neither caller polls. Half that machine's voices are a
 * software mixer, so a driver tick *is* a block of samples and the sample
 * transfer's own interrupt counts the blocks out — 128 Hz on both callers, with
 * nothing to fit and nothing to drift. `resolveGbaClock` is therefore *called* by
 * the standalone rather than mirrored by it.
 */

import { getConsole } from "@demake/core";

import type { ChipScript } from "../chipscript.js";
import { bindingFor } from "../binding/registry.js";
import { SFX_RATE_HZ } from "../sfx/index.js";

// The *only* static import of anything under `rom/` that a family owns, and it
// deliberately owns nothing: `artifact.ts` is four declarations and no
// assembler. Each family is reached through an `import()` below, so a visitor
// downloads the driver for the console they are building and not the other four
// (doc 07 §The web JS budget). Statically importing one builder here — which is
// what this file did while it was five `?:` arms — puts that console's whole
// assembler in the always-loaded bundle, and five of them cost eight kilobytes
// gzipped of every visitor's payload.
import {
  AudioRomError,
  type AudioRomOptions,
  type AudioRomStats,
  type BuiltAudioRom,
} from "./artifact.js";

export { AudioRomError };
export type { AudioRomOptions, AudioRomStats, BuiltAudioRom };
export {
  buildWscGameAudio,
  resolveWscClock,
  STOP as WSC_STOP,
  WSC_AUDIO_BYTES,
  type WscGameAudio,
  type WscGameAudioInput,
  type WscGameAudioStats,
} from "./wsc-game.js";
export {
  buildSpcGameAudio,
  resolveSpcClock,
  SPC_CODE_BASE,
  SPC_IMAGE_BASE,
  SPC_PORT,
  STOP as SPC_STOP,
  type SpcGameAudio,
  type SpcGameAudioInput,
  type SpcGameAudioStats,
} from "./spc-game.js";
export {
  packScript,
  PackError,
  MAX_WRITES_PER_TICK,
  type ChannelTag,
  type DriverData,
} from "./data.js";

/**
 * Consoles a *standalone* audio cartridge can be built for.
 *
 * Keyed by console rather than by chip, and the Game Boy Advance is why: its
 * four Game Boy channels are the same `gb-apu`, and an SM83 cartridge is no use
 * to it. A driver is a CPU's, so the machine is what decides.
 */
const DRIVERS: Readonly<Record<string, AudioRomFamily>> = {
  dmg: "gb",
  gbc: "gb",
  gb: "gb",
  nes: "nes",
  pce: "pce",
  sms: "sms",
  gg: "sms",
  md: "md",
  gba: "gba",
  wsc: "wsc",
  // The mono machine's sound hardware *is* the colour machine's, so this is one
  // more console for the same driver and the same cartridge — the Game Gear's
  // bargain with a different byte in the footer (`rom/wsc.ts` §Two machines).
  ws: "wsc",
};

/**
 * The driver families a standalone cartridge can be built with.
 *
 * Seven, over six stream players: the NES and the PC Engine share
 * `mos-player.ts` because a HuC6280 *is* a 6502, the two Sega 8-bits share
 * `sms-driver.ts` because a Game Gear *is* a Master System, and the two
 * WonderSwans share `wsc-driver.ts` because they are one machine with different
 * memory — so what a family is here is a boot sequence, a clock and a cartridge
 * wrapper rather than a driver.
 *
 * The seventh is the first whose console's second sound device is not a chip:
 * six of a Game Boy Advance's ten voices are a software mixer, so that
 * cartridge's idle loop is the only one in the set that is not idle.
 */
export type AudioRomFamily = "gb" | "nes" | "pce" | "sms" | "md" | "gba" | "wsc";

/**
 * The clock a *game's* driver rides on each chip that has one.
 *
 * `timer` means the console can be asked for a rate finer than its frame and
 * will produce it; `frame` means the picture's own interrupt is the only clock
 * a driver can have. The 2A03 is the second: the NES's other candidate is the
 * DMC's interrupt, which costs the channel and lands on rates a table happens to
 * offer rather than the one a track asked for.
 */
const GAME_CLOCKS: Readonly<Record<string, "timer" | "frame">> = {
  "gb-apu": "timer",
  // The Super Nintendo is the one console here whose driver clock is its own: the
  // sound processor has three timers, and none of them is shared with the game.
  "s-dsp": "timer",
  "nes-apu": "frame",
  // The Sega 8-bits' other candidate is the VDP's line interrupt, and on paper it
  // is a timer: `psgBinding.fitRate` will hand back rates a long way above the
  // frame. What it is not is *uniform* — the line counter is reloaded on every
  // scanline outside the active display, so a line interrupt every N lines fires
  // a handful of times inside the picture and then not at all until the next
  // frame. A driver on it would perform the schedule correctly and play it
  // unevenly, which is worse than a coarser clock.
  sn76489: "frame",
  // The T6W28's console has 8-bit timers the processor can have, and
  // `t6w28Binding.fitRate` will offer them to a *standalone* track. A game
  // cannot have one for the reason every frame-clocked console here gives: its
  // two streams share one clock with the picture, and the vertical blank is what
  // a demade cartridge already takes.
  t6w28: "frame",
  // The YM2612 *has* a programmable timer, and `mdBinding.fitRate` offers it to a
  // standalone track — which `rom/md.ts` now takes, so this entry is genuinely
  // about a game rather than about the hardware. On this board the chip's
  // interrupt line goes to the Z80, not to the 68000, so a driver has to poll the
  // status byte from its main loop. A cartridge whose loop does nothing else
  // polls it every few microseconds and keeps the timer's rate exactly; a game's
  // loop is also running a game, so what it would keep is the loop's rate. The
  // picture's interrupt is the one *this* caller actually gets.
  ym2612: "frame",
  // The HuC6280 has a timer of its own — seven bits of reload at master ÷ 3 ÷
  // 1024 — and nothing else in a demade cartridge uses it, so this console gets
  // the Game Boy's clock discipline rather than the NES's.
  "huc6280-psg": "timer",
  // The WonderSwan has two timers with interrupts and a demade cartridge takes
  // neither: its interrupt controller vectors through the processor's own table
  // in the first kilobyte of RAM, and a main loop that already waits for the
  // beam gains nothing by one. The frame is the clock — and, unusually, the
  // driver reads how many of them have passed rather than being told, because
  // the vertical-blank timer's counter is readable (`wsc-game.ts`).
  "ws-sound": "frame",
};

/**
 * The tick rate a game's audio driver runs at on a console.
 *
 * Half the standalone effect rate where there is a timer to programme, and the
 * console's frame rate where there is not. It lives here rather than with the
 * game backend because it is a fact about the driver that has to keep it: a
 * schedule fitted to twice the frame rate on a machine with only a frame would
 * be performed two ticks at a time at the top of each one — correct against the
 * proof and wrong in the ear.
 */
export function gameDriverRate(consoleId: string): number {
  const spec = getConsole(consoleId).audio;
  if (spec === undefined) return SFX_RATE_HZ / 2;
  // The console before the chip, because on one machine the rate is a fact about
  // neither: a Game Boy Advance driver's tick *is* a block of mixer samples, so
  // its rate is the sample rate divided by that block and has nothing to do with
  // the Game Boy APU its first chip happens to be.
  const byConsole = CONSOLE_RATES[consoleId];
  if (byConsole !== undefined) return byConsole;
  const chip = spec.chips[0] as string;
  const exact = GAME_RATES[chip];
  if (exact !== undefined) return exact;
  const clock = GAME_CLOCKS[chip] ?? "timer";
  if (clock === "timer") return SFX_RATE_HZ / 2;
  return spec.driver.frameRate.num / spec.driver.frameRate.den;
}

/**
 * Consoles whose timer hits a *different* rate exactly.
 *
 * The general answer is half the standalone effect rate, and it is right
 * wherever the timer is fine-grained. The sound processor's timer is an 8 kHz
 * prescaler over an eight-bit divisor, so 125 Hz is exact and 120 Hz is a third
 * of a per cent out — and a rate a register can state exactly is worth more here
 * than one that matches the other consoles, because nothing compares the two.
 */
const GAME_RATES: Readonly<Record<string, number>> = { "s-dsp": 125 };

/**
 * Consoles whose rate is the *machine's* answer rather than a chip's.
 *
 * One so far, and it is the console whose second device is a software mixer: a
 * driver tick there is one block of samples the processor computes, and a block
 * is what the sample transfer's own interrupt counts out. 32768 ÷ 256 is 128
 * exactly — no remainder, no drift, and no timer to programme (`gba-game.ts`
 * §the clock is the transfer).
 */
const CONSOLE_RATES: Readonly<Record<string, number>> = { gba: 32768 / 256 };

/**
 * Consoles a *game* can embed a driver for — the fourth registry the support
 * matrix is derived from.
 *
 * By console rather than by chip, because a driver is a *CPU's*: the Game Boy
 * Advance's four Game Boy channels are the same `gb-apu` a Game Boy has, and the
 * SM83 player that drives them there is no use to an ARM7. So this list names
 * the machines where both halves exist, and the CPU each one's driver is written
 * in:
 *
 *   - `dmg`, `gbc`, `gb`, `megaduck` — SM83 (`rom/gb-game.ts`)
 *   - `nes` — 6502 (`rom/nes-game.ts`)
 *   - `sms`, `gg` — Z80 (`rom/sms-game.ts`)
 *   - `md` — 68000 (`rom/md-game.ts`)
 *   - `snes` — SPC700 (`rom/spc-game.ts`), and it is not the console's own CPU
 *   - `gba` — ARM (`rom/gba-game.ts`), and it is the one that has to *compute*
 *     half of what it plays rather than only describing it
 *   - `nds` — ARM (`rom/nds-game.ts`), and it is not the console's own processor
 *     either: the sound channels answer the ARM7 alone, so the cartridge's second
 *     binary *is* the driver and the game reaches it by writing two bytes of
 *     shared memory
 *   - `pce` — 6502 (`rom/pce-game.ts`), sharing `mos-player.ts` with the NES
 *     because a HuC6280 *is* a 6502, and clocked by that CPU's own timer
 *   - `wsc` — V30MZ (`rom/wsc-game.ts`), and the only one whose clock is not an
 *     interrupt at all: this cartridge takes none, so the driver reads the
 *     vertical-blank timer's *counter* and pays whatever frames it finds owed
 *   - `ngpc` — TLCS-900/H (`rom/ngp-game.ts`), and the only one that has to
 *     *ask* for its chip: the T6W28's own bus belongs to a Z80 sound processor,
 *     so the driver writes two bytes of the main CPU's I/O page before anything
 *     it sends is listened to
 *
 * Keeping it by console is what let the Game Boy Advance be absent from it for
 * as long as its ARM driver was: its four Game Boy channels are the same
 * `gb-apu` a Game Boy has, and deriving the matrix from the *spec* said it
 * played music the day the hardware was described.
 */
const GAME_DRIVERS: readonly string[] = [
  "dmg",
  "gbc",
  "gb",
  "megaduck",
  "nes",
  "sms",
  "gg",
  "snes",
  "md",
  "gba",
  "nds",
  "pce",
  // The eighth driver and the only one that is a whole program of its own: the
  // cartridge's M region, on a bus the 68000 cannot see.
  "neogeo",
  "wsc",
  // The mono machine's sound hardware *is* the colour machine's — same chip,
  // same ports, same waveform page in the same place (`binding/wsc-bank.ts`) —
  // so the driver is one driver and this is one more console for it.
  "ws",
  // The Neo Geo Pocket Color, whose driver is the seventh CPU's. The mono
  // machine is *not* here and it is not an oversight: it has the same sound
  // hardware and the same driver would run on it, but `demake build` has no
  // backend for that console, and this list is about what a *cartridge* can do.
  "ngpc",
];

/** Whether a `demake build` cartridge for this console can play its audio. */
export function hasGameAudio(consoleId: string): boolean {
  return GAME_DRIVERS.includes(consoleId);
}

/** Every console whose cartridges can play their own audio. */
export function gameAudioConsoles(): readonly string[] {
  return GAME_DRIVERS;
}

/** Console ids `--format rom` can build an audio cartridge for. */
export function audioRomConsoles(): string[] {
  const out: string[] = [];
  for (const id of Object.keys(DRIVERS)) {
    try {
      if (romFamily(id)) out.push(id);
    } catch {
      // A console the registry does not know is simply not a target.
    }
  }
  return out;
}

/** The driver family a console's audio hardware resolves to, or `undefined`. */
function romFamily(consoleId: string): AudioRomFamily | undefined {
  return getConsole(consoleId).audio === undefined ? undefined : DRIVERS[consoleId];
}

/** The file a built cartridge takes, which the console rather than the chip decides. */
const SUFFIXES: Readonly<Record<string, string>> = {
  gbc: ".gbc",
  nes: ".nes",
  pce: ".pce",
  sms: ".sms",
  gg: ".gg",
  md: ".md",
  gba: ".gba",
  wsc: ".wsc",
  ws: ".ws",
};

/**
 * Build a cartridge that plays this schedule on its own console.
 *
 * `script.console` is authoritative rather than a caller's argument: a schedule
 * carries the console it was fitted to, and building it for another would be a
 * different arrangement, not a different output format.
 */
export async function buildAudioRom(
  script: ChipScript,
  options: AudioRomOptions = {},
): Promise<BuiltAudioRom & { family: AudioRomFamily; suffix: string }> {
  const spec = getConsole(script.console);
  const family = romFamily(spec.id);
  if (family === undefined) {
    throw new AudioRomError(
      "E_DRIVER_UNSUPPORTED",
      `there is no standalone audio driver backend for ${spec.name} yet`,
      `${audioRomConsoles().join(", ")} boot today (doc 16 §The proof); ` +
        "`demake render` plays any console's schedule exactly, and `demake build` " +
        "puts one in a game on every console with a driver.",
    );
  }
  const built = await buildFor(family, spec.id, script, options);
  // A Game Boy Color cartridge with no CGB flag is a DMG cartridge, and the APU
  // is the same on both — so the suffix follows the console the user asked for
  // rather than anything in the header.
  return { ...built, family, suffix: SUFFIXES[spec.id] ?? ".gb" };
}

/**
 * Reach one family's builder, and only that one.
 *
 * The reason this is a `switch` over `import()` rather than a table is the same
 * reason `demotic`'s `codegen/registry.ts` is: a table's values would have to be
 * the modules themselves, which is a static import wearing a lookup's clothes.
 * Every question this file answers *about* a family — which consoles it serves,
 * what suffix it takes — is answered from the static descriptions above, so
 * nothing but an actual build pulls a driver down.
 */
async function buildFor(
  family: AudioRomFamily,
  consoleId: string,
  script: ChipScript,
  options: AudioRomOptions,
): Promise<BuiltAudioRom> {
  switch (family) {
    case "gb":
      return (await import("./gb.js")).buildGbAudioRom(script, options);
    case "nes":
      return (await import("./nes.js")).buildNesAudioRom(
        script,
        bindingFor(consoleId).spec.driver.frameRate,
        options,
      );
    case "pce":
      return (await import("./pce.js")).buildPceAudioRom(script, options);
    case "sms":
      return (await import("./sms.js")).buildSmsAudioRom(script, options);
    case "md":
      return (await import("./md.js")).buildMdAudioRom(script, options);
    case "gba":
      return (await import("./gba.js")).buildGbaAudioRom(script, options);
    case "wsc":
      return (await import("./wsc.js")).buildWscAudioRom(script, options);
  }
}
