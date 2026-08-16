/**
 * Stereo placement, as the two shapes a chip can take it in.
 *
 * `ChannelFrame.pan` is a signed position and every chip here reduces it one of
 * exactly two ways, so both reductions live in one file rather than once per
 * binding. The distinction is the hardware's:
 *
 *   - **Panned by level.** Two attenuators, one a side, so a voice can sit
 *     anywhere across the image: the T6W28's pair of four-bit attenuators, the
 *     S-DSP's signed per-side volumes, the Nintendo DS's seven-bit pan, the
 *     VSU's two nibbles, the HuC6280's balance byte and the WonderSwan's volume
 *     byte. These call {@link panGains}.
 *   - **Panned by switch.** One bit a side and nothing between: `NR51`, the
 *     Game Gear's stereo latch, a Game Boy Advance converter's two enables and
 *     an FM voice's two output bits. These call {@link panSides}.
 *
 * **Centre is both sides at full under both laws**, which is deliberate and
 * load-bearing. It is what the boolean pair this replaced defaulted to, so a
 * part the arranger leaves centred encodes byte-for-byte what it always did and
 * only a part that is actually *placed* moves — which is what keeps the change
 * reviewable, and what keeps a console whose arrangement is all centre out of
 * the re-baselining entirely.
 *
 * That makes this a **balance** law rather than a constant-power one: a hard
 * pan cuts one side to nothing and leaves the other where it was, instead of
 * lifting it by 3 dB. Constant power is the right law for a mixing desk, whose
 * centre has headroom above it to give back; these are attenuators feeding a
 * chip whose full level *is* the ceiling, so the only thing a power law could
 * do at centre is start every voice quieter than the hardware can play it.
 */

/** Per-side multipliers, each 0–1, for a chip that pans by level. */
export interface PanGains {
  left: number;
  right: number;
}

/** Which sides carry the voice at all, for a chip that pans by switch. */
export interface PanSides {
  left: boolean;
  right: boolean;
}

/** Beyond this far from centre, a switch-panned chip drops the far side. */
const SIDE_THRESHOLD = 0.5;

/** Clamp a position into the range the two laws are defined on. */
function position(pan: number | undefined): number {
  if (pan === undefined || !Number.isFinite(pan)) return 0;
  return pan < -1 ? -1 : pan > 1 ? 1 : pan;
}

/**
 * A position as two multipliers: the near side stays at full, the far side
 * falls away linearly and reaches silence only at a hard pan.
 */
export function panGains(pan: number | undefined): PanGains {
  const at = position(pan);
  return { left: at <= 0 ? 1 : 1 - at, right: at >= 0 ? 1 : 1 + at };
}

/**
 * A position as two switches.
 *
 * Anything within half the image of centre is heard on both sides, which is
 * where a chip with one bit a side has to leave it: cutting a side for a part
 * placed gently would be louder than the placement asked for, not quieter, and
 * on a four-channel console it would take that part out of one speaker
 * entirely. Only a part placed past the threshold gives a side up.
 */
export function panSides(pan: number | undefined): PanSides {
  const at = position(pan);
  return { left: at < SIDE_THRESHOLD, right: at > -SIDE_THRESHOLD };
}

/**
 * Scale a level by a side's gain, on the chip's own integer step scale.
 *
 * Rounding rather than truncating is what keeps a gentle placement audible on
 * a four-bit attenuator: at fifteen steps a gain of 0.9 truncates to 13 and
 * rounds to 14, and the difference between those two is most of what a small
 * placement was asking for. A side that is genuinely cut is exactly zero
 * because `panGains` reaches zero exactly.
 */
export function attenuate(steps: number, gain: number): number {
  const scaled = Math.round(steps * gain);
  return scaled < 0 ? 0 : scaled > steps ? steps : scaled;
}
