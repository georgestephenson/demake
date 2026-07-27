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
 * track: **the rate**. A console has one interrupt a driver can ride, so music
 * and effects step on the same tick; the game states the rate and everything is
 * fitted to it through the binding's own `fitRate` (doc 16 §Two streams, one
 * clock). What the rate *is* is the driver backend's business rather than this
 * file's, and the two machines answer differently — a Game Boy has a
 * programmable timer and an NES has the frame the picture already runs on and
 * nothing else — which is why `gameDriverRate` is asked rather than assumed.
 *
 * Audio is optional at every step. A program with no `music` and no `sound`
 * builds exactly as before, and so does one whose edge chose not to load the
 * files — `stats.missingAudio` says which ones were not supplied, and the game
 * plays silently rather than failing to build.
 */

import {
  demakeSfx,
  arrangeScore,
  gameDriverRate,
  parseMidi,
  SFX_RATE_HZ,
  type ChipScript,
  type GameEffect,
} from "@demake/audio";
import { getConsole, type Executor } from "@demake/core";

import type { Program } from "../program.js";

import type { AssetBytes } from "./art.js";

/**
 * The tick rate a game's audio runs at on the Game Boy family.
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

/** What the program's audio came to, whichever console's driver was built. */
export interface BoundAudio<Driver> {
  /** The driver, or `undefined` for a game with nothing to play. */
  driver?: Driver;
  /** Files the program names that no bytes were supplied for. */
  missing: readonly string[];
  /** Notes worth reporting: parts dropped, effects trimmed, channels borrowed. */
  notes: readonly string[];
}

/**
 * How one console turns demade schedules into a driver.
 *
 * A backend supplies this rather than a driver builder's arguments, because
 * *where* a driver keeps its state is the console's answer and not something a
 * shared binding pass could hold an opinion about: the Game Boy's lives in high
 * RAM at a fixed address, the NES's in page zero at one the allocator chose.
 */
export interface AudioTarget<Driver> {
  build(tracks: readonly ChipScript[], effects: readonly GameEffect[]): Driver;
}

/** Demake every track and effect the program names, and build its driver. */
export async function bindAudio<Driver>(
  program: Program,
  assets: AssetBytes,
  target: AudioTarget<Driver>,
  executor?: Executor,
): Promise<BoundAudio<Driver>> {
  const missing: string[] = [];
  const notes: string[] = [];
  if (program.tracks.length === 0 && program.sounds.length === 0) {
    return { missing, notes };
  }

  const consoleId = program.profile.id;
  const spec = getConsole(consoleId).audio;
  if (spec === undefined) return { missing: [...program.tracks, ...program.sounds], notes };
  // What clock the driver rides is the driver backend's answer, not this file's:
  // a Game Boy has a timer and an NES has the frame and nothing else.
  const rateHz = gameDriverRate(consoleId);

  const tracks: ChipScript[] = [];
  for (const file of program.tracks) {
    const bytes = assets.get(file);
    if (bytes === undefined) {
      missing.push(file);
      continue;
    }
    const result = arrangeScore(parseMidi(bytes), {
      console: consoleId,
      driverHz: rateHz,
      title: file,
    });
    for (const dropped of result.dropped) {
      notes.push(
        `${file}: dropped ${dropped.kind} ${dropped.partId} (${dropped.count} notes, ${dropped.reason})`,
      );
    }
    tracks.push(result.script);
  }

  // Effects have nothing in common — no shared pool, no shared budget — so they
  // are demade at once and reported in the order the program names them. What is
  // ordered is the reporting and the effect list, because an effect's index is
  // what a rule fires, and "whichever gesture tournament finished first" is not
  // an index.
  const present = program.sounds.filter((file) => {
    if (assets.has(file)) return true;
    missing.push(file);
    return false;
  });
  const demade = await Promise.all(
    present.map((file) =>
      demakeSfx(assets.get(file) as Uint8Array, {
        console: consoleId,
        rateHz,
        title: file,
        ...(executor === undefined ? {} : { executor }),
      }),
    ),
  );
  const effects: GameEffect[] = [];
  for (let index = 0; index < present.length; index += 1) {
    const file = present[index]!;
    const result = demade[index]!;
    const channel = spec.channels.findIndex((one) => one.id === result.placement.channelId);
    notes.push(`${file}: ${result.tournament.winner} on ${result.placement.channelId}`);
    effects.push({ script: result.script, channel, priority: result.placement.priority });
  }

  // A game whose files were all missing has nothing to build, and that is not an
  // error: the same edge may simply not have loaded them (see `art.ts`).
  if (tracks.length === 0 && effects.length === 0) return { missing, notes };

  return { driver: target.build(tracks, effects), missing, notes };
}

/**
 * Which track each scene plays, as the index the driver's request byte takes.
 *
 * `-1` for a silent scene, and for one whose file was not supplied — a game
 * missing its music plays silently rather than playing the wrong scene's theme.
 */
export function trackForScene(program: Program, bound: BoundAudio<unknown>): number[] {
  const supplied = program.tracks.filter((file) => !bound.missing.includes(file));
  return program.scenes.map((scene) =>
    scene.music === undefined ? -1 : supplied.indexOf(scene.music),
  );
}

/** The driver index of each of the program's sounds, or `-1` when unsupplied. */
export function effectIndices(program: Program, bound: BoundAudio<unknown>): number[] {
  const supplied = program.sounds.filter((file) => !bound.missing.includes(file));
  return program.sounds.map((file) => supplied.indexOf(file));
}
