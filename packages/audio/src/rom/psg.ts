/**
 * The SN76489's side of the driver hand-off — the part no processor decides.
 *
 * Two consoles now drive this chip from two instruction sets: a Z80 reaching it
 * through `out (c), a` on a Master System, and a 68000 storing a byte to
 * `$C00011` on a Mega Drive. What is the *same* on both is everything in this
 * file, and it is the same because it is the chip's:
 *
 *   - **The channel is in the data, and it is latched.** A Game Boy register
 *     belongs to a channel by its address and an NES register by its address
 *     divided by four; an SN76489 has one write port and puts the channel in the
 *     top bits of the byte — and only in *some* bytes, because a byte with bit 7
 *     clear continues whatever the byte before it selected. So the packer is
 *     handed a tag that carries a latch ({@link psgChannelTag}), and preemption
 *     skips whole runs rather than writes: every run opens with a latch byte, so
 *     a skipped run takes its own selection with it and the next one that is
 *     written selects again before writing anything. That property is checked
 *     rather than assumed — see {@link checkLatchDiscipline}.
 *   - **Silencing is one write per channel.** A Game Boy channel goes off by
 *     powering its DAC down and an NES channel by clearing one bit of a shared
 *     register; here it is the chip's own attenuation latch at full cut. No
 *     shared byte to recompute and no second register to remember, which is the
 *     hardware being simpler rather than a driver being cleverer.
 *
 * Sources:
 * - SMS Power! — SN76489: https://www.smspower.org/Development/SN76489
 * - SMS Power! — Game Gear stereo port ($06): https://www.smspower.org/Development/AudioPort
 */

import type { RegisterWrite } from "@demake/chip";

import type { ChipScript } from "../chipscript.js";

import type { ChannelTag } from "./data.js";
import { AudioRomError } from "./gb.js";

/**
 * The schedule register that carries a Game Gear's panning.
 *
 * `@demake/chip`'s SN76489 models the stereo latch as register `$06` and the
 * write port as register `0`, which is the numbering `binding/psg.ts` emits — so
 * this is the schedule's own name for the latch, not a port or an address. It
 * exists on exactly one of the machines this chip appears in; the Master System
 * and the Mega Drive never produce a write to it.
 */
export const PSG_STEREO_REG = 0x06;

/** Channels the chip has, which is also the width of the packed channel field. */
export const PSG_CHANNELS = 4;

/**
 * A channel tag with the chip's latch in it.
 *
 * Fresh per schedule, because the latch is hardware state that runs *through* a
 * stream: the third byte of a tone write means nothing without the two before
 * it. `data.ts` asks for a factory for exactly this reason.
 *
 * The mapping is the chip's own encoding. A byte with bit 7 set is a latch:
 * `%1cctdddd`, where `cc` selects one of four channels and `t` says whether the
 * rest is a volume or a tone/noise value — and it *is* the write, for a volume or
 * a noise-control change. A byte with bit 7 clear is the high six bits of
 * whatever the last latch selected. The stereo latch is a different device
 * entirely and belongs to no single channel, which is what makes it a merge.
 */
export function psgChannelTag(): ChannelTag {
  let latched = 0;
  return (reg: number, value: number): number => {
    if (reg === PSG_STEREO_REG) return 0;
    // A latch byte moves the selection and *is* a write on it; a data byte only
    // reads it. Which is why there is one return: the answer is the selection
    // either way, and the only difference is whether this byte set it.
    if ((value & 0x80) !== 0) latched = (value >> 5) & 0x03;
    return 1 << latched;
  };
}

/**
 * The latch byte that cuts one channel: `%1cc1 1111`.
 *
 * Attenuation, not volume — fifteen is silence on this chip and zero is full
 * scale, which is the one place its register map reads backwards from every other
 * chip in the set.
 */
export function psgAttenuationOff(channel: number): number {
  return 0x90 | (channel << 5) | 0x0f;
}

/**
 * The three things one channel of this chip holds, as a driver has to remember.
 *
 * A register-indexed copy — which is what {@link shadowPlan} builds and what
 * every other chip in the set takes — cannot work here, because this chip has
 * one write port and no register numbers: every byte of the packed music carries
 * the same "register". So a channel's copy is keyed by what the *byte* is
 * instead, which is the same encoding {@link psgChannelTag} already reads.
 */
export const PSG_SHADOW = {
  /** `%1cc0dddd`: the low four bits of a tone period, or the noise control. */
  TONE: 0,
  /** `%0dddddd`: the high six bits of the tone period the latch selected. */
  DATA: 1,
  /** `%1cc1dddd`: attenuation, which is this chip's whole note-off. */
  LEVEL: 2,
} as const;

/** How many bytes one borrowable channel's copy takes. */
export const PSG_SHADOW_BYTES = 3;

/** Which of a channel's three bytes this one is. */
export function psgShadowSlot(value: number): number {
  if ((value & 0x80) === 0) return PSG_SHADOW.DATA;
  return (value & 0x10) !== 0 ? PSG_SHADOW.LEVEL : PSG_SHADOW.TONE;
}

/**
 * Check that a data byte only ever continues a *tone* latch.
 *
 * {@link psgShadowSlot} classifies a byte on its own, with no latch to carry,
 * and that is only sound while the byte after an attenuation latch is never a
 * data byte. The binding never emits one — attenuation is four bits and fits in
 * the latch — so this is checked rather than worked around, on
 * {@link checkLatchDiscipline}'s terms: if it stops being true, the symptom is a
 * borrowed channel coming back at the wrong volume, and the cause is nowhere
 * near the driver.
 */
export function checkDataDiscipline(script: ChipScript): void {
  for (let tick = 0; tick < script.ticks.length; tick += 1) {
    let level = false;
    for (const write of script.ticks[tick]?.writes ?? []) {
      if (write.reg === PSG_STEREO_REG) continue;
      if ((write.value & 0x80) !== 0) {
        level = (write.value & 0x10) !== 0;
        continue;
      }
      if (level) {
        throw new AudioRomError(
          "E_PSG_DATA",
          `tick ${tick} of an audio schedule continues an attenuation latch with a data byte`,
          "this driver classifies a packed byte on its own so it can remember what a borrowed channel was holding; this is a bug in the binding, not in the track.",
        );
      }
    }
  }
}

/**
 * Which of a channel's three bytes the music has ever written, per channel.
 *
 * The counterpart of {@link shadowPlan} for a chip that has no register numbers.
 * A tone channel writes all three; the noise channel writes two, because its
 * "tone" latch is the noise control and carries no data byte. Emitting only what
 * a channel really uses is what keeps a replay from sending a data byte that
 * would set a period nobody ever set.
 */
export function psgShadowPlan(
  tracks: readonly ChipScript[],
  stealable: number,
): { channel: number; slots: readonly number[] }[] {
  const owned = new Map<number, Set<number>>();
  for (const script of tracks) {
    const tag = psgChannelTag();
    for (const tick of script.ticks) {
      for (const write of tick.writes) {
        const channels = tag(write.reg, write.value, write.chip ?? 0) & stealable;
        if (write.reg === PSG_STEREO_REG) continue;
        for (let bit = 1; bit <= channels; bit <<= 1) {
          if ((channels & bit) === 0) continue;
          let slots = owned.get(bit);
          if (!slots) owned.set(bit, (slots = new Set()));
          slots.add(psgShadowSlot(write.value));
        }
      }
    }
  }
  return [...owned.keys()]
    .sort((a, b) => a - b)
    .map((channel) => ({
      channel,
      // Ascending, so the period is stated before the attenuation turns the
      // voice back up — the same order every other chip's replay uses.
      slots: [...(owned.get(channel) as Set<number>)].sort((a, b) => a - b),
    }));
}

/**
 * What each copied byte holds before the music has said anything.
 *
 * The chip initialisation the ROM performs at boot, read the same way the run
 * walk reads the music — because that is what those latches really hold at that
 * point, and the schedules have the boot prefix stripped off their first tick.
 * On this chip it matters more than on any other: silence here is attenuation
 * `$F`, so a copy that started at zero would replay *full volume* on a channel
 * the music had not yet touched.
 */
export function psgShadowInit(
  boot: readonly RegisterWrite[],
  copies: readonly { channel: number; slots: readonly number[] }[],
): number[][] {
  const init = copies.map((copy) => copy.slots.map(() => 0));
  const tag = psgChannelTag();
  for (const write of boot) {
    const channels = tag(write.reg, write.value, write.chip ?? 0);
    if (write.reg === PSG_STEREO_REG) continue;
    const slot = psgShadowSlot(write.value);
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
 * The whole of preemption on this chip rests on it: a run is a maximal group of
 * consecutive writes that agree about which channel they belong to, so a data
 * byte can only ever *start* a run if it is the first write of a tick — and a
 * skipped run whose latch was in the tick before it would leave the next stream's
 * selection pointing at the wrong channel. The binding never emits one (it writes
 * a channel's registers together, leading with the latch), which is exactly why
 * this is checked rather than worked around: if it ever stops being true, the
 * symptom is a note on the wrong voice several ticks later.
 */
export function checkLatchDiscipline(script: ChipScript): void {
  for (let tick = 0; tick < script.ticks.length; tick += 1) {
    let latched = false;
    for (const write of script.ticks[tick]?.writes ?? []) {
      if (write.reg === PSG_STEREO_REG) continue;
      if ((write.value & 0x80) !== 0) {
        latched = true;
        continue;
      }
      if (!latched) {
        throw new AudioRomError(
          "E_PSG_LATCH",
          `tick ${tick} of an audio schedule opens with a data byte and no latch in front of it`,
          "this chip carries the channel in the latch byte, so a driver could not tell which voice the write belongs to; this is a bug in the binding, not in the track.",
        );
      }
    }
  }
}
