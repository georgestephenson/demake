/**
 * What a Mega Drive's *two* chips make of the driver hand-off.
 *
 * `psg.ts` is the SN76489's side and is shared with the Sega 8-bits; this is the
 * part that only exists because a console has two devices and a driver has to
 * reach both. Three questions, and all three have answers the format was already
 * shaped for:
 *
 *   - **Where does a write go?** Five destinations: the FM chip's four bus
 *     addresses and the PSG's one. That is one byte, which is exactly what the
 *     packed data already spends on a register — so {@link mdPort} is a `port`
 *     mapping like every other console's, and the Mega Drive's driver pays
 *     nothing extra for having twice the hardware.
 *   - **Which voice does a write belong to?** Ten of them, and the run format's
 *     channel field is four bits. It does not have to hold all ten: the only
 *     thing preemption asks is "may an effect be using this voice right now",
 *     and an effect takes one voice. So {@link mdChannelTag} numbers the
 *     *stealable* voices — the handful a game's effects were placed on — and
 *     tags everything else zero, which the driver reads as "never skip this".
 *     Four bits is then more than enough, and the FM half of a track plays
 *     straight through an effect instead of ducking for it.
 *   - **When is a data byte meaningless?** Both chips latch. The PSG latches a
 *     channel in a byte with bit 7 set; the FM chip latches an *address* on one
 *     bus port and takes the datum on the next. Either way a run that was skipped
 *     must not leave the next one reading a stale latch, and
 *     {@link checkMdLatchDiscipline} refuses a schedule where that could happen
 *     rather than letting it become a note on the wrong voice.
 *
 * Sources:
 * - Sega — YM2612 application manual (bus ports, key-on, register map)
 * - SMS Power! — SN76489: https://www.smspower.org/Development/SN76489
 */

import type { ChipScript } from "../chipscript.js";

import type { ChannelTag } from "./data.js";
import { AudioRomError } from "./gb.js";
import { psgChannelTag } from "./psg.js";

/** The two chips, as `BoundWrite.chip` indexes them. */
export const YM_CHIP = 0;
export const PSG_CHIP = 1;

/** FM voices, which are the first six of the console's ten channels. */
export const MD_FM_CHANNELS = 6;

/** The packed byte that means "the PSG", the four below it being the FM's ports. */
export const MD_PSG_PORT = 4;

/**
 * Where a write goes, as the one byte the packed data holds.
 *
 * `0`-`3` are the FM chip's bus addresses — which is what the schedule's register
 * already *is* for that chip, so this is the identity there — and `4` is the PSG.
 * The driver turns the byte into an address with one comparison.
 */
export function mdPort(reg: number, chip: number): number {
  return chip === PSG_CHIP ? MD_PSG_PORT : reg & 3;
}

/**
 * A tag that numbers the voices an effect may take, and nothing else.
 *
 * Fresh per schedule, because both chips carry state a tag has to follow: the
 * PSG's channel latch, and the FM chip's two address latches. `data.ts` asks for
 * a factory for exactly this reason, and sharing one between two schedules would
 * read the second from the first's last write.
 *
 * `stealable` is the console channel index of each voice an effect can borrow, in
 * the order the bits are assigned — so bit 0 is `stealable[0]`. At most four,
 * which is the width of the field and more voices than a game's effects use.
 */
export function mdChannelTag(stealable: readonly number[]): () => ChannelTag {
  return (): ChannelTag => {
    const psg = psgChannelTag();
    /** The address each half of the FM bus last latched. */
    const latched: [number, number] = [-1, -1];
    return (reg: number, value: number, chip: number): number => {
      const channel =
        chip === PSG_CHIP ? psgVoice(psg(reg, value, chip)) : ymVoice(reg, value, latched);
      if (channel < 0) return 0;
      const at = stealable.indexOf(channel);
      return at < 0 ? 0 : 1 << at;
    };
  };
}

/** The PSG's own four-bit mask, as a console channel index. */
function psgVoice(mask: number): number {
  if (mask === 0) return -1;
  for (let bit = 0; bit < 4; bit += 1) {
    if ((mask & (1 << bit)) !== 0) return MD_FM_CHANNELS + bit;
  }
  return -1;
}

/**
 * Which FM voice a bus write belongs to, following the address latch.
 *
 * An address port write moves the latch and belongs to whatever it selected; a
 * data port write belongs to whatever the latch holds. Which is the same shape
 * as the PSG's latch one register file over, and the reason both live here.
 */
function ymVoice(port: number, value: number, latched: [number, number]): number {
  const half = (port >> 1) & 1;
  if ((port & 1) === 0) {
    latched[half] = value & 0xff;
    return voiceOfAddress(half, value & 0xff, -1);
  }
  return voiceOfAddress(half, latched[half] as number, value & 0xff);
}

/**
 * The voice an FM register belongs to, or `-1` for one that belongs to none.
 *
 * The key register is the exception worth naming: it lives on the first half of
 * the bus for *every* voice and carries the channel in its datum, so it is the
 * one address whose voice cannot be known until the data byte arrives. `datum`
 * is `-1` when it has not yet.
 */
function voiceOfAddress(half: number, address: number, datum: number): number {
  if (address === 0x28) {
    if (datum < 0) return -1;
    const within = datum & 0x03;
    if (within === 3) return -1;
    return ((datum & 0x04) !== 0 ? 3 : 0) + within;
  }
  if (address < 0x30) return -1; // LFO, timers, the DAC: the chip's, not a voice's
  const within = address & 3;
  if (within === 3) return -1;
  // `$A8`-`$AE` are channel 3's per-operator frequencies, which nothing here
  // writes and which do not follow the channel-in-the-low-bits rule.
  if (address >= 0xa8 && address <= 0xaf) return -1;
  return half * 3 + within;
}

/**
 * Refuse a schedule whose runs could be skipped into nonsense.
 *
 * The whole of preemption rests on a skipped run taking its own latches with it.
 * For the PSG that means every run opens with a channel latch; for the FM chip it
 * means a data byte never opens a tick without the address that gives it meaning.
 * Both are properties the bindings hold by construction — which is exactly why
 * they are *checked* rather than assumed, because if either stops being true the
 * symptom is a note on the wrong voice several ticks later.
 */
export function checkMdLatchDiscipline(script: ChipScript): void {
  for (let tick = 0; tick < script.ticks.length; tick += 1) {
    let psgLatched = false;
    const ymLatched: [boolean, boolean] = [false, false];
    for (const write of script.ticks[tick]?.writes ?? []) {
      if ((write.chip ?? 0) === PSG_CHIP) {
        if ((write.value & 0x80) !== 0) {
          psgLatched = true;
          continue;
        }
        if (!psgLatched) {
          throw new AudioRomError(
            "E_PSG_LATCH",
            `tick ${tick} of an audio schedule opens with a PSG data byte and no latch in front of it`,
            "this chip carries the channel in the latch byte, so a driver could not tell which voice the write belongs to; this is a bug in the binding, not in the track.",
          );
        }
        continue;
      }
      const half = (write.reg >> 1) & 1;
      if ((write.reg & 1) === 0) {
        ymLatched[half] = true;
        continue;
      }
      if (!ymLatched[half]) {
        throw new AudioRomError(
          "E_FM_LATCH",
          `tick ${tick} of an audio schedule writes FM data on bus half ${half} with no address in front of it`,
          "this chip latches the register address on a separate port, so a driver could not tell which register the write belongs to; this is a bug in the binding, not in the track.",
        );
      }
    }
  }
}

/**
 * Silence every voice on both chips.
 *
 * Four attenuation latches for the tone half, and a key-off for each of the six
 * FM voices — which is what "stop the music" means on this console, and is a very
 * different pair of gestures for two chips on one board.
 */
export function mdSilenceWrites(): { reg: number; value: number; chip: number }[] {
  const out: { reg: number; value: number; chip: number }[] = [];
  for (let voice = 0; voice < MD_FM_CHANNELS; voice += 1) {
    const encoded = voice < 3 ? voice : voice + 1;
    out.push({ reg: 0, value: 0x28, chip: YM_CHIP }, { reg: 1, value: encoded, chip: YM_CHIP });
  }
  for (let channel = 0; channel < 4; channel += 1) {
    out.push({ reg: 0, value: 0x9f | (channel << 5), chip: PSG_CHIP });
  }
  return out;
}
