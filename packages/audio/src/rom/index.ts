/**
 * `ChipScript` → a bootable ROM (doc 16 §The driver contract).
 *
 * The console hand-off, and the one place a console without a driver backend is
 * refused. **A backend gap is a build error, never a silent difference** — the
 * rule doc 14 states for games holds here for exactly the same reason: a
 * cartridge that played a different arrangement from the preview would make the
 * schedule oracle report a divergence three layers from its cause.
 *
 * One family builds a *cartridge of its own* today, the Game Boy. A second CPU
 * has a driver — the NES's, in `nes-game.ts` — but only inside a game, because
 * that is what a cartridge whose only job is one track would need next and not
 * what a game needed. What either costs is not hidden: a register encoder (which
 * the binding already is), a driver emitter for its CPU, and a core to prove it
 * in — see doc 16 §The proof.
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
export { packScript, PackError, MAX_WRITES_PER_TICK, type DriverData } from "./data.js";

/** Chips a driver backend exists for, keyed by the chip a console names. */
const DRIVERS: Readonly<Record<string, "gb">> = { "gb-apu": "gb" };

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
  "nes-apu": "frame",
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
  const clock = GAME_CLOCKS[spec.chips[0] as string] ?? "timer";
  if (clock === "timer") return SFX_RATE_HZ / 2;
  return spec.driver.frameRate.num / spec.driver.frameRate.den;
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
  const chip = getConsole(consoleId).audio?.chips[0];
  return chip === undefined ? undefined : DRIVERS[chip];
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
