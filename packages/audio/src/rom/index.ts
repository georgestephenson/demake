/**
 * `ChipScript` → a bootable ROM (doc 16 §The driver contract).
 *
 * The console hand-off, and the one place a console without a driver backend is
 * refused. **A backend gap is a build error, never a silent difference** — the
 * rule doc 14 states for games holds here for exactly the same reason: a
 * cartridge that played a different arrangement from the preview would make the
 * schedule oracle report a divergence three layers from its cause.
 *
 * One family builds a *cartridge of its own* today, the Game Boy. Two more CPUs
 * have drivers — the NES's in `nes-game.ts`, the Sega 8-bits' in `sms-game.ts` —
 * but only inside a game, because that is what a cartridge whose only job is one
 * track would need next and not what a game needed. What any of them costs is not
 * hidden: a register encoder (which the binding already is), a driver emitter for
 * its CPU, and a core to prove it in — see doc 16 §The proof.
 */

import { getConsole } from "@demake/core";

import type { ChipScript } from "../chipscript.js";
import { SFX_RATE_HZ } from "../sfx/index.js";

import {
  AudioRomError,
  buildGbAudioRom,
  type AudioRomOptions,
  type AudioRomStats,
  type BuiltAudioRom,
} from "./gb.js";

export { AudioRomError, buildGbAudioRom };
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
const DRIVERS: Readonly<Record<string, "gb">> = { dmg: "gb", gbc: "gb", gb: "gb" };

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
  // The YM2612 *has* a programmable timer, and `mdBinding.fitRate` will offer it
  // to a standalone track. A game cannot have it: on this board the chip's
  // interrupt line goes to the Z80, not to the 68000, so a game's driver would
  // have to poll the status byte from its main loop — which is a clock whose
  // rate is the loop's rather than the timer's, and therefore not a clock at
  // all. The picture's interrupt is the one this CPU actually gets.
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
  "wsc",
  // The mono machine's sound hardware *is* the colour machine's — same chip,
  // same ports, same waveform page in the same place (`binding/wsc-bank.ts`) —
  // so the driver is one driver and this is one more console for it.
  "ws",
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
  for (const id of ["dmg", "gbc", "gb"]) {
    try {
      if (romFamily(id)) out.push(id);
    } catch {
      // A console the registry does not know is simply not a target.
    }
  }
  return out;
}

/** The driver family a console's audio hardware resolves to, or `undefined`. */
function romFamily(consoleId: string): "gb" | undefined {
  return getConsole(consoleId).audio === undefined ? undefined : DRIVERS[consoleId];
}

/**
 * Build a cartridge that plays this schedule on its own console.
 *
 * `script.console` is authoritative rather than a caller's argument: a schedule
 * carries the console it was fitted to, and building it for another would be a
 * different arrangement, not a different output format.
 */
export function buildAudioRom(
  script: ChipScript,
  options: AudioRomOptions = {},
): BuiltAudioRom & { family: "gb"; suffix: string } {
  const spec = getConsole(script.console);
  const family = romFamily(spec.id);
  if (family !== "gb") {
    throw new AudioRomError(
      "E_DRIVER_UNSUPPORTED",
      `there is no audio driver backend for ${spec.name} yet`,
      "the Game Boy family is the one that boots today (doc 16 §The proof); `demake render` plays any console's schedule exactly.",
    );
  }
  const built = buildGbAudioRom(script, options);
  // A Game Boy Color cartridge with no CGB flag is a DMG cartridge, and the APU
  // is the same on both — so the suffix follows the console the user asked for
  // rather than anything in the header.
  return { ...built, family, suffix: spec.id === "gbc" ? ".gbc" : ".gb" };
}
