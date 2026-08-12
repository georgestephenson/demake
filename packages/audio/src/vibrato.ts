/**
 * What the demaker decides about vibrato and tremolo (doc 17 §Vibrato).
 *
 * The *depth* is the source's — General MIDI puts it on the modulation wheel
 * and `score/midi.ts` reads it. Everything here is what the source does not
 * state and the demaker therefore chooses: how fast, how wide, and how long
 * after the attack it begins.
 *
 * A module of its own because these have **two kinds of reader** and neither
 * may hold a copy. `arrange/compile.ts` spends them by moving a pitch, which is
 * the only vibrato a chip without an LFO can be given; the two OPN bindings
 * spend them by programming one — and a rate the arranger and the chip
 * disagreed about is a track whose FM half vibrates at a different speed from
 * its PSG half, which is not a wrong note anywhere and would never be caught by
 * a register diff.
 *
 * It also sits below both for the layering: a binding may not import the
 * arranger, and the arranger should not have to ask a binding what the rate is.
 */

/**
 * Cycles a second.
 *
 * Where instrumental vibrato sits. It is also, not by accident, within a tenth
 * of a hertz of the YM2612 LFO's setting 1 (5.56 Hz) — so the one console in
 * the set that performs vibrato in hardware performs it at the speed everything
 * else is written to.
 */
export const VIBRATO_HZ = 5.5;

/**
 * Peak deviation at the top of the modulation wheel, in cents.
 *
 * A quarter-tone, which is about as wide as a chip channel goes before it stops
 * reading as one note. Widening it is not free on the consoles that have to
 * write the modulation: a coarser pitch lattice swallows a small deviation and
 * emits no write at all, so depth and schedule size are related.
 */
export const VIBRATO_MAX_CENTS = 50;

/**
 * How long after the attack the modulation starts, in seconds.
 *
 * Because a player's does: a note is placed in tune and leaned into. The delay
 * earns its place twice on this hardware — it is what a listener expects, and
 * it costs no pitch writes at all, so a schedule pays for vibrato only on notes
 * long enough to have any and a sixteenth-note line carries none however hard
 * the wheel was pushed.
 */
export const VIBRATO_DELAY_SECONDS = 0.15;

/**
 * Peak attenuation at the top of the tremolo controller, in decibels.
 *
 * Six, which is a halving at the bottom of the swing — audibly a tremolo and
 * short of the pulsing an organ's fastest setting gives. It is an *attenuation*
 * rather than a swing about the written level because that is what the hardware
 * does: a YM2612's LFO only ever adds attenuation, so a note peaks at the level
 * it was given and dips below it, and a software tremolo that oscillated either
 * side of the level would be louder than the same note on the one console that
 * performs it in hardware.
 */
export const TREMOLO_MAX_DB = 6;

/**
 * The rate and the delay are the *same* as vibrato's, and that is the hardware.
 *
 * A YM2612 has one LFO, and both its outputs — the pitch sweep and the
 * amplitude sweep — come off it. So a track whose tremolo ran at a different
 * speed from its vibrato could not be played on the console that has the
 * hardware for either, and `binding/md.ts` would have to choose which of the
 * two to honour. Naming them here rather than declaring a second pair is what
 * makes that impossible to get wrong.
 */
export const TREMOLO_HZ = VIBRATO_HZ;
export const TREMOLO_DELAY_SECONDS = VIBRATO_DELAY_SECONDS;
