/**
 * The T6W28's side of the driver hand-off — the part no processor decides.
 *
 * `psg.ts` for the chip one console along, and most of this file is that one
 * with a second port in it. What is genuinely different is worth reading before
 * touching either, because the two look alike enough to be conflated:
 *
 *   - **There are two write ports and each has its own latch.** An SN76489 has
 *     one, so `psgChannelTag` carries one selection through a whole schedule;
 *     here a byte's meaning depends on which port it went to *and* what that
 *     port last selected, so {@link t6w28ChannelTag} carries two.
 *   - **The two ports carry different registers**, and one field lies about
 *     itself. On the left port a channel field means its channel. On the right
 *     port it means its channel's *attenuator* for a volume latch — but a tone
 *     latch there addresses the noise generator, and channel 2's tone latch
 *     addresses the **noise's own divisor** rather than tone 2's period. So the
 *     tag maps it to the noise channel, which is the one place on this chip
 *     where "which voice is this write for" is not the field's own answer.
 *   - **A channel's copy is four bytes, not three.** Its period and the data
 *     byte that continues it come from the left port, and its attenuation exists
 *     *twice* — once a side — so handing a borrowed channel back means replaying
 *     both. That is the cost of stereo being a level rather than a switch, and
 *     it is the only cost: there is no shared register to merge, so a game here
 *     emits no merge routine at all.
 *
 * Sources: MAME `src/devices/sound/t6w28.cpp` and higan's `component/audio/t6w28`
 * (the register split, independently), and doc 16 §Handing a borrowed channel
 * back for what the copy is for.
 */

import type { RegisterWrite } from "@demake/chip";

import type { ChipScript } from "../chipscript.js";

import type { ChannelTag } from "./data.js";
import { AudioRomError } from "./gb.js";

/** The two write ports, which are this chip's register numbers. */
export const T6W28_RIGHT = 0;
export const T6W28_LEFT = 1;

/** Channels the chip has, which is also the width of the packed channel field. */
export const T6W28_CHANNELS = 4;

/** The channel a tone latch on the *right* port really addresses. */
const NOISE_CHANNEL = 3;

/**
 * A channel tag with both of the chip's latches in it.
 *
 * Fresh per schedule, because a latch is hardware state that runs *through* a
 * stream: the second byte of a period write means nothing without the first.
 * `data.ts` asks for a factory for exactly this reason, and here it is asked for
 * twice over — one selection a port.
 *
 * A byte with bit 7 set is a latch, `%1cctdddd`: `cc` selects a channel and `t`
 * says whether the rest is an attenuation or a period. A byte with bit 7 clear
 * is the high six bits of whatever that port last selected. What the channel
 * field *means* is the port's business, which is the one asymmetry below.
 */
export function t6w28ChannelTag(): ChannelTag {
  const latched: [number, number] = [0, 0];
  return (reg: number, value: number): number => {
    const port = reg & 1;
    if ((value & 0x80) !== 0) latched[port] = (value >> 4) & 0x07;
    const selected = latched[port] as number;
    const channel = (selected >> 1) & 0x03;
    const isVolume = (selected & 1) !== 0;
    // An attenuation always belongs to the channel it names, on either port —
    // that is what having two of them means. A *period* on the right port is the
    // noise generator's, whichever channel the field happens to say, because the
    // three tone periods live on the other one.
    if (!isVolume && port === T6W28_RIGHT) return 1 << NOISE_CHANNEL;
    return 1 << channel;
  };
}

/**
 * The latch that cuts one channel on one side: `%1cc1 1111`.
 *
 * Attenuation, not volume — fifteen is silence and zero is full scale, which
 * this chip inherits from the SN76489 and which is the one place its register map
 * reads backwards from every other chip in the set. Silencing a voice takes
 * *two* of these, one a port, because there are two attenuators.
 */
export function t6w28AttenuationOff(channel: number): number {
  return 0x90 | (channel << 5) | 0x0f;
}

/**
 * The four things one channel of this chip holds, as a driver has to remember.
 *
 * A register-indexed copy — which is what `shadowPlan` builds and what most of
 * the chips in the set take — cannot work here, because two ports carry every
 * byte under the same two "register" numbers. So a channel's copy is keyed by
 * what the *byte* is and which port it went to, which is the same pair
 * {@link t6w28ChannelTag} already reads.
 */
export const T6W28_SHADOW = {
  /** Left port, `%1cc0dddd`: the low four bits of a period. */
  TONE: 0,
  /** Left port, `%0dddddd`: the high six bits of the period the latch selected. */
  DATA: 1,
  /** Left port, `%1cc1dddd`: the left-hand attenuation. */
  LEFT: 2,
  /** Right port, `%1cc1dddd`: the right-hand attenuation. */
  RIGHT: 3,
  /** Right port, `%1cc0dddd`: the noise control, or the noise's own divisor. */
  NOISE: 4,
  /** Right port, `%0dddddd`: the high six bits of that divisor. */
  NOISE_DATA: 5,
} as const;

/** How many bytes one borrowable channel's copy takes. */
export const T6W28_SHADOW_BYTES = 6;

/** Which of a channel's copies this byte is, given the port it went to. */
export function t6w28ShadowSlot(port: number, value: number): number {
  const right = (port & 1) === T6W28_RIGHT;
  if ((value & 0x80) === 0) return right ? T6W28_SHADOW.NOISE_DATA : T6W28_SHADOW.DATA;
  if ((value & 0x10) !== 0) return right ? T6W28_SHADOW.RIGHT : T6W28_SHADOW.LEFT;
  return right ? T6W28_SHADOW.NOISE : T6W28_SHADOW.TONE;
}

/**
 * Which of a channel's six bytes the music has ever written, per channel.
 *
 * The counterpart of `shadowPlan` for a chip whose register number is a port. A
 * tone channel writes four of them and never the two noise slots; the noise
 * channel writes the two attenuations and its own control, and the two divisor
 * slots only when the deepest colour is used. Emitting only what a channel really
 * uses is what keeps a replay from sending a byte that would set something
 * nobody ever set.
 */
export function t6w28ShadowPlan(
  tracks: readonly ChipScript[],
  stealable: number,
): { channel: number; slots: readonly number[] }[] {
  const owned = new Map<number, Set<number>>();
  for (const script of tracks) {
    const tag = t6w28ChannelTag();
    for (const tick of script.ticks) {
      for (const write of tick.writes) {
        const channels = tag(write.reg, write.value, write.chip ?? 0) & stealable;
        for (let bit = 1; bit <= channels; bit <<= 1) {
          if ((channels & bit) === 0) continue;
          let slots = owned.get(bit);
          if (!slots) owned.set(bit, (slots = new Set()));
          slots.add(t6w28ShadowSlot(write.reg, write.value));
        }
      }
    }
  }
  return [...owned.keys()]
    .sort((a, b) => a - b)
    .map((channel) => ({
      channel,
      // Ascending, so a period is stated before the attenuation turns the voice
      // back up — the same order every other chip's replay uses, and here it also
      // puts the left attenuation before the right, which nothing depends on and
      // which keeps the emitted replay in one fixed order.
      slots: [...(owned.get(channel) as Set<number>)].sort((a, b) => a - b),
    }));
}

/**
 * What each copied byte holds before the music has said anything.
 *
 * The chip initialisation the ROM performs at boot, read the same way the run
 * walk reads the music — because that is what those latches really hold at that
 * point, and the schedules have the boot prefix stripped off their first tick.
 * On this chip it matters as much as on the SN76489: silence is attenuation `$F`,
 * so a copy that started at zero would replay *full volume* on a channel the
 * music had not yet touched — and here it would do it on both sides.
 */
export function t6w28ShadowInit(
  boot: readonly RegisterWrite[],
  copies: readonly { channel: number; slots: readonly number[] }[],
): number[][] {
  const init = copies.map((copy) => copy.slots.map(() => 0));
  const tag = t6w28ChannelTag();
  for (const write of boot) {
    const channels = tag(write.reg, write.value, write.chip ?? 0);
    const slot = t6w28ShadowSlot(write.reg, write.value);
    for (let index = 0; index < copies.length; index += 1) {
      const copy = copies[index] as { channel: number; slots: readonly number[] };
      if ((channels & copy.channel) === 0) continue;
      const at = copy.slots.indexOf(slot);
      if (at >= 0) (init[index] as number[])[at] = write.value & 0xff;
    }
  }
  return init;
}

/**
 * Check that no tick leaves a data byte without the latch that gives it meaning.
 *
 * The whole of preemption on this chip rests on it, exactly as it does on the
 * SN76489: a run is a maximal group of consecutive writes that agree about which
 * channel they belong to, so a skipped run whose latch was in the tick before it
 * would leave that port's selection pointing at the wrong thing. The binding
 * never emits one — it writes a channel's registers together, leading with the
 * latch — which is why this is checked rather than worked around.
 *
 * **Per port**, because the two latches are independent: a left-hand data byte
 * is not excused by a right-hand latch in front of it, and a driver that thought
 * otherwise would write a period into an attenuator.
 */
export function checkLatchDiscipline(script: ChipScript): void {
  for (let tick = 0; tick < script.ticks.length; tick += 1) {
    const latched = [false, false];
    for (const write of script.ticks[tick]?.writes ?? []) {
      const port = write.reg & 1;
      if ((write.value & 0x80) !== 0) {
        latched[port] = true;
        continue;
      }
      if (!latched[port]) {
        throw new AudioRomError(
          "E_PSG_LATCH",
          `tick ${tick} of an audio schedule opens the ${port === T6W28_LEFT ? "left" : "right"} port with a data byte and no latch in front of it`,
          "this chip carries the channel in the latch byte and keeps a latch per port, so a driver could not tell which voice the write belongs to; this is a bug in the binding, not in the track.",
        );
      }
    }
  }
}
