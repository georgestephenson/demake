/**
 * What every game driver does to a schedule before a CPU ever sees it.
 *
 * Every console's builder sits beside this file and each owns one instruction
 * set — two of them share one, because a HuC6280 is a 6502 — and none of them
 * owns *this*, because none of it is about a processor. The
 * boot prefix comes off because the ROM initialises the chip once and not at the
 * head of every stream; an effect is cut down to the channel it borrowed because
 * the rest of its writes are the music's notes being silenced; a player is
 * emitted once and therefore needs the union of what its streams ask for. Those
 * are facts about the hand-off (doc 16 §The driver contract), and a second copy
 * of any of them is a second chance for one console to answer differently.
 *
 * What is *not* here is anything a chip decides. `psg.ts` holds the SN76489's
 * side of the same hand-off, because two of those consoles drive that chip from
 * different processors and it is the chip that has the opinions. `mos-player.ts`
 * is the third kind of thing again: nobody's console and nobody's chip, but one
 * *processor's*, shared by the two machines that run it.
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

// --- handing a borrowed channel back -----------------------------------------

/** One register of a stealable channel, and where the music's copy of it lives. */
export interface ShadowRegister {
  /** Which device it addresses, for the one console with two. */
  chip: number;
  /** The byte the packed data carries — the driver's own key for the register. */
  port: number;
  /** Offset into the shadow. */
  slot: number;
}

/** What the music remembers about one channel an effect can borrow. */
export interface ShadowChannel {
  /** Channel bit, as the steal mask numbers it. */
  channel: number;
  chip: number;
  /** Lowest packed byte this channel is written through. */
  base: number;
  /** Where `base` sits in the shadow. */
  slot: number;
  length: number;
  /**
   * Registers to replay, ascending.
   *
   * The order is not arbitrary: on every chip in the set the byte that
   * re-triggers a note is the highest-numbered of its channel's and the byte
   * that *selects* one is the lowest, so a replay states the whole voice and
   * then strikes it. A chip that put its trigger first would need its own order
   * and would say so here.
   */
  writes: readonly ShadowRegister[];
}

/** What the music has to remember so a borrowed channel can be given back. */
export interface ShadowPlan {
  /** Bytes of driver RAM; zero when no channel is stealable. */
  bytes: number;
  /** One entry per stealable channel the music ever writes, by channel bit. */
  channels: readonly ShadowChannel[];
  /**
   * What each byte holds before the music has said anything, slot by slot.
   *
   * Taken from the chip initialisation the ROM performs at boot, because that is
   * what those registers really hold at that point — the schedules have it
   * stripped off their first tick ({@link stripBoot}), so zero would be a guess
   * that happens to be right on the chips whose registers power up at zero and
   * wrong on the one whose silence is attenuation `$F`.
   */
  init: readonly number[];
}

/** The plan for a build whose effects borrow nothing. */
export const NO_SHADOW: ShadowPlan = { bytes: 0, channels: [], init: [] };

/**
 * Bytes to reserve for a shadow before anyone knows what the game's effects are.
 *
 * A console's audio RAM is a compile-time constant, because the game's memory
 * plan is settled before its music is demade — so the reservation has to be the
 * worst case: every channel borrowable, each with a window as wide as its own
 * registers. Derived by asking the tag which channel each register belongs to,
 * rather than written down, so a chip whose map changes cannot leave a number
 * behind. A chip that puts the channel in the *value* cannot be measured this
 * way and states its own.
 */
export function shadowReserve(tag: ChannelTag, lo: number, hi: number): number {
  const bounds = new Map<number, { lo: number; hi: number }>();
  for (let reg = lo; reg <= hi; reg += 1) {
    const channels = tag(reg, 0, 0);
    for (let bit = 1; bit <= channels; bit <<= 1) {
      if ((channels & bit) === 0) continue;
      const seen = bounds.get(bit);
      if (!seen) bounds.set(bit, { lo: reg, hi: reg });
      else seen.hi = reg;
    }
  }
  let bytes = 0;
  for (const { lo: first, hi: last } of bounds.values()) bytes += last - first + 1;
  return bytes;
}

/** Where a channel's copy of `register` sits, relative to the shadow's address. */
export function shadowBias(channel: ShadowChannel): number {
  return channel.slot - channel.base;
}

/**
 * What the music must remember about the channels effects can borrow.
 *
 * The packed music is a *delta* stream: a register is written when the music's
 * own value for it changes and not otherwise. That is exactly right until an
 * effect borrows the channel, because then the chip holds the effect's value and
 * the music — whose value did not change — never states its own again. The
 * borrowed channel comes back holding whatever the effect left in it, until the
 * music's next note on that channel, which for a held chord tone is a whole bar.
 * It is heard as one long, badly out-of-tune note per effect, and it was heard.
 *
 * So the music keeps a copy of every register belonging to a channel an effect
 * can take, updated whether or not the write reached the chip, and the release
 * routine replays it. A channel gets a window of its own rather than sharing one
 * with the others, which is what makes this work on a chip that *selects* a
 * channel instead of addressing it: on a PC Engine two voices are written
 * through the same register numbers, so one window per register would have each
 * channel replaying the other's note. Within a window the index is the packed
 * byte, so recording a write is a subtraction and not a search.
 *
 * A register two streams *merge* into is excluded: it is folded rather than
 * stored, and the merge already keeps a shadow per stream. On the Super
 * Nintendo it is also a pulse — `KON` starts the voices whose bits are set — so
 * replaying one would strike a note nothing asked for.
 *
 * The registers of one channel must live on one device. Only the Mega Drive has
 * two, and there an effect takes a voice on one chip or the other and never a
 * voice made of both, so a channel that reached across them would be a tagging
 * bug rather than a layout to support.
 */
export function shadowPlan(
  tracks: readonly ChipScript[],
  stealable: number,
  channelOf: () => ChannelTag,
  boot: readonly RegisterWrite[] = [],
  port: (reg: number, chip: number) => number = (reg) => reg,
  merge: ReadonlySet<number> = new Set(),
): ShadowPlan {
  if (stealable === 0) return NO_SHADOW;
  // Which (chip, register) pairs each stealable channel is written through. The
  // tag is fresh per schedule and sees every write in order, because on a chip
  // that latches its selection the answer depends on the writes before it.
  const owned = new Map<number, Map<number, number>>();
  const chips = new Map<number, number>();
  for (const script of tracks) {
    const tag = channelOf();
    for (const tick of script.ticks) {
      for (const write of tick.writes) {
        const chip = write.chip ?? 0;
        const channels = tag(write.reg, write.value, chip) & stealable;
        // A merged register belongs to no one stream — it is folded rather than
        // stored, and on one of these chips it is a *pulse* that starts a voice
        // rather than state a voice holds. Copying one would have the release
        // strike a note the schedule never asked for.
        if (merge.has(write.reg)) continue;
        for (let bit = 1; bit <= channels; bit <<= 1) {
          if ((channels & bit) === 0) continue;
          const was = chips.get(bit);
          if (was !== undefined && was !== chip) {
            throw new AudioRomError(
              "E_SHADOW_CHIPS",
              `channel ${bit} of this game's music is written through two different sound chips`,
              "a borrowable channel's registers have to live on one device for the driver to replay them; this is a bug in the channel tag, not in the track.",
            );
          }
          chips.set(bit, chip);
          let regs = owned.get(bit);
          if (!regs) owned.set(bit, (regs = new Map()));
          regs.set(port(write.reg, chip), write.reg);
        }
      }
    }
  }
  if (owned.size === 0) return NO_SHADOW;

  const channels: ShadowChannel[] = [];
  let bytes = 0;
  for (const channel of [...owned.keys()].sort((a, b) => a - b)) {
    const regs = owned.get(channel) as Map<number, number>;
    const ports = [...regs.keys()].sort((a, b) => a - b);
    const chip = chips.get(channel) as number;
    const base = ports[0] as number;
    const length = (ports[ports.length - 1] as number) - base + 1;
    const slot = bytes;
    channels.push({
      channel,
      chip,
      base,
      slot,
      length,
      writes: ports.map((one) => ({ chip, port: one, slot: slot + one - base })),
    });
    bytes += length;
  }

  // Seeded through a tag of its own, in order, for the same reason the tracks
  // are: on a chip that *selects* a channel, which voice a boot write lands on
  // depends on the writes before it, and a seed keyed by register number alone
  // would give every channel the last one's settings.
  const init = new Array<number>(bytes).fill(0);
  const bootTag = channelOf();
  for (const write of boot) {
    const chip = write.chip ?? 0;
    const named = bootTag(write.reg, write.value, chip);
    // Asked *after* the tag, because a boot write may be a register no channel
    // owns — a master volume, on one of these chips — and the port map is only
    // defined for the ones a schedule can carry.
    if (merge.has(write.reg) || (named & stealable) === 0) continue;
    const byte = port(write.reg, chip);
    for (const channel of channels) {
      if ((named & channel.channel) === 0 || channel.chip !== chip) continue;
      if (byte < channel.base || byte >= channel.base + channel.length) continue;
      init[channel.slot + byte - channel.base] = write.value & 0xff;
    }
  }
  return { bytes, channels, init };
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
