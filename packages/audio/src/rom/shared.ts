/**
 * What every game driver does to a schedule before a CPU ever sees it.
 *
 * Four consoles' builders sit beside this file and each owns one instruction
 * set; none of them owns *this*, because none of it is about a processor. The
 * boot prefix comes off because the ROM initialises the chip once and not at the
 * head of every stream; an effect is cut down to the channel it borrowed because
 * the rest of its writes are the music's notes being silenced; a player is
 * emitted once and therefore needs the union of what its streams ask for. Those
 * are facts about the hand-off (doc 16 §The driver contract), and a fourth copy
 * of any of them is a fourth chance for one console to answer differently.
 *
 * What is *not* here is anything a chip decides. `psg.ts` holds the SN76489's
 * side of the same hand-off, because two of those four consoles drive that chip
 * from different processors and it is the chip that has the opinions.
 */

import type { RegisterWrite } from "@demake/chip";

import type { ChipScript, Rational } from "../chipscript.js";

import { packScript, PackError, type ChannelTag, type DriverData } from "./data.js";
import { AudioRomError } from "./gb.js";

/**
 * Frames a frame-clocked driver may fall behind before it stops counting them.
 *
 * A game that has been stopped — a tab in the background, a breakpoint, a scene
 * change that took half a second — would otherwise come back owing hundreds of
 * ticks and perform them all in one burst.
 */
export const MAX_PENDING = 4;

/**
 * A schedule with the chip's initialisation taken off its first tick.
 *
 * The ROM performs those writes once, at boot. Leaving them at the head of every
 * stream would mean an effect powered the chip up — and silenced every channel —
 * each time it fired.
 */
export function stripBoot(script: ChipScript, boot: readonly RegisterWrite[]): ChipScript {
  const ticks = script.ticks.map((tick) => ({ ...tick, writes: [...tick.writes] }));
  const head = ticks[0];
  if (head === undefined) return script;
  const matches = boot.every((write, index) => {
    const got = head.writes[index];
    return got !== undefined && got.reg === write.reg && got.value === write.value;
  });
  if (!matches) {
    throw new AudioRomError(
      "E_BOOT_PREFIX",
      "an audio schedule does not open with the chip initialisation the ROM performs at boot",
      "this is a bug in the ROM builder, not in the track.",
    );
  }
  ticks[0] = { ...head, writes: head.writes.slice(boot.length) };
  return { ...script, ticks };
}

/**
 * A schedule cut down to the channels it is allowed to touch.
 *
 * An effect borrows one channel from the music; every write it makes to another
 * one would be the music's note being silenced. A write belonging to no channel
 * stays — the Game Boy's `NR51`, the NES's `$4015` and the Game Gear's stereo
 * latch are merged rather than stored, and nothing else survives the boot strip.
 *
 * The tag is the caller's and it sees *every* write, dropped ones included: on a
 * chip that latches its channel selection the tag is schedule state, and skipping
 * the writes that set it would tag the survivors from a selection the chip never
 * made.
 */
export function restrict(
  script: ChipScript,
  owned: number,
  tag: ChannelTag,
): { script: ChipScript; dropped: number } {
  let dropped = 0;
  const ticks = script.ticks.map((tick) => {
    const writes = tick.writes.filter((write) => {
      const channels = tag(write.reg, write.value, write.chip ?? 0);
      const keep = channels === 0 || (channels & owned) !== 0;
      if (!keep) dropped += 1;
      return keep;
    });
    return { ...tick, writes };
  });
  return { script: { ...script, ticks }, dropped };
}

/**
 * The shape one player has to cope with, across every stream it plays.
 *
 * A player is emitted once and walks any of its streams, so what it needs is the
 * *union* of what they ask for: one track with a rest in it means the rest path
 * is emitted, and every track can then use one. Taking the first stream's flags
 * instead would produce a player that read the second stream's data wrong — the
 * kind of bug that presents as music turning to noise halfway through a game.
 */
export function shapeOf(streams: readonly DriverData[]): DriverData {
  const base = streams[0] as DriverData;
  return {
    ...base,
    hasRests: streams.some((one) => one.hasRests),
    hasMerges: streams.some((one) => one.hasMerges),
    hasOrder: streams.some((one) => one.hasOrder),
    oneShot: streams.some((one) => one.oneShot),
  };
}

/** {@link packScript}, with a packing failure reported as a ROM-build failure. */
export function pack(script: ChipScript, options: Parameters<typeof packScript>[1]): DriverData {
  try {
    return packScript(script, options);
  } catch (error) {
    if (error instanceof PackError) throw new AudioRomError(error.code, error.message, error.hint);
    throw error;
  }
}

/** A driver rate, for an error message. */
export function rateHz(rate: Rational): string {
  return (rate.num / rate.den).toFixed(3);
}

/** An effect's priority, as the one byte a table entry holds. */
export function clampByte(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}
