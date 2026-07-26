/**
 * `ChipScript` → a bootable ROM (doc 16 §The driver contract).
 *
 * The console hand-off, and the one place a console without a driver backend is
 * refused. **A backend gap is a build error, never a silent difference** — the
 * rule doc 14 states for games holds here for exactly the same reason: a
 * cartridge that played a different arrangement from the preview would make the
 * schedule oracle report a divergence three layers from its cause.
 *
 * One family today, the Game Boy, and that is the same shape Phase 2 started
 * with on the image side. What a second family costs is not hidden: a register
 * encoder (which the binding already is), a driver emitter for its CPU, and a
 * core to prove it in — see doc 16 §The proof.
 */

import { getConsole } from "@demake/core";

import type { ChipScript } from "../chipscript.js";

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
