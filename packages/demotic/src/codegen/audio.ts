/**
 * Binding a program's audio: where the game pipeline meets the sound one.
 *
 * The counterpart of `art.ts`, and it exists for the same reason. The whole tool
 * demakes *assets*, so a `.dmt` that says `music theme.mid` has to end up with
 * that theme playing on the console's own chip — demade by the same engine that
 * demakes a track handed to `demake arrange`, not by a second arranger written
 * for games. This module works out what the program needs, hands the bytes to
 * `@demake/audio`, and hands the schedules back to the emitter. Every decision
 * about notes and registers is made in the audio engine.
 *
 * The one decision that *is* made here belongs to the game rather than to any
 * track: **the rate**. The Game Boy has one timer, so music and effects step on
 * one interrupt, and a game that let each piece pick its own rate could not play
 * two of them. The game states the rate and everything is fitted to it (doc 16
 * §Two streams, one clock).
 *
 * Audio is optional at every step. A program with no `music` and no `sound`
 * builds exactly as before, and so does one whose edge chose not to load the
 * files — `stats.missingAudio` says which ones were not supplied, and the game
 * plays silently rather than failing to build.
 */

import {
  buildGameAudio,
  demakeSfx,
  arrangeScore,
  parseMidi,
  SFX_RATE_HZ,
  type ChipScript,
  type GameAudio,
  type GameEffect,
} from "@demake/audio";
import { getConsole } from "@demake/core";

import type { Program } from "../program.js";

import type { AssetBytes } from "./art.js";

/**
 * The tick rate a game's audio runs at.
 *
 * Half the rate a standalone effect gets ({@link SFX_RATE_HZ}), and the halving
 * is where the game's constraints show. Music barely notices the rate at all —
 * row placement is absolute, so tempo is exact either way and the schedule is
 * nearly the same size. An effect notices twice: a long one packs to fewer
 * bytes, and the cartridge it shares with nine aliens' worth of collision code
 * has a few hundred to spare. What it costs is the resolution of an attack, and
 * at 120 Hz that is eight milliseconds — twice as fine as the sixty-hertz tick
 * the machine's own games ran their drivers on.
 */
export const GAME_AUDIO_HZ = SFX_RATE_HZ / 2;

/** What the program's audio came to. */
export interface BoundAudio {
  /** The driver, or `undefined` for a game with nothing to play. */
  driver?: GameAudio;
  /** Files the program names that no bytes were supplied for. */
  missing: readonly string[];
  /** Notes worth reporting: parts dropped, effects trimmed, channels borrowed. */
  notes: readonly string[];
}

/** Demake every track and effect the program names, and build its driver. */
export function bindAudio(program: Program, assets: AssetBytes, hram: number): BoundAudio {
  const missing: string[] = [];
  const notes: string[] = [];
  if (program.tracks.length === 0 && program.sounds.length === 0) {
    return { missing, notes };
  }

  const consoleId = program.profile.id;
  const spec = getConsole(consoleId).audio;
  if (spec === undefined) return { missing: [...program.tracks, ...program.sounds], notes };

  const tracks: ChipScript[] = [];
  for (const file of program.tracks) {
    const bytes = assets.get(file);
    if (bytes === undefined) {
      missing.push(file);
      continue;
    }
    const result = arrangeScore(parseMidi(bytes), {
      console: consoleId,
      driverHz: GAME_AUDIO_HZ,
      title: file,
    });
    for (const dropped of result.dropped) {
      notes.push(
        `${file}: dropped ${dropped.kind} ${dropped.partId} (${dropped.count} notes, ${dropped.reason})`,
      );
    }
    tracks.push(result.script);
  }

  const effects: GameEffect[] = [];
  for (const file of program.sounds) {
    const bytes = assets.get(file);
    if (bytes === undefined) {
      missing.push(file);
      continue;
    }
    const result = demakeSfx(bytes, { console: consoleId, rateHz: GAME_AUDIO_HZ, title: file });
    const channel = spec.channels.findIndex((one) => one.id === result.placement.channelId);
    notes.push(`${file}: ${result.tournament.winner} on ${result.placement.channelId}`);
    effects.push({ script: result.script, channel, priority: result.placement.priority });
  }

  // A game whose files were all missing has nothing to build, and that is not an
  // error: the same edge may simply not have loaded them (see `art.ts`).
  if (tracks.length === 0 && effects.length === 0) return { missing, notes };

  return { driver: buildGameAudio({ tracks, effects, hram }), missing, notes };
}

/**
 * Which track each scene plays, as the index the driver's request byte takes.
 *
 * `-1` for a silent scene, and for one whose file was not supplied — a game
 * missing its music plays silently rather than playing the wrong scene's theme.
 */
export function trackForScene(program: Program, bound: BoundAudio): number[] {
  const supplied = program.tracks.filter((file) => !bound.missing.includes(file));
  return program.scenes.map((scene) =>
    scene.music === undefined ? -1 : supplied.indexOf(scene.music),
  );
}

/** The driver index of each of the program's sounds, or `-1` when unsupplied. */
export function effectIndices(program: Program, bound: BoundAudio): number[] {
  const supplied = program.sounds.filter((file) => !bound.missing.includes(file));
  return program.sounds.map((file) => supplied.indexOf(file));
}
