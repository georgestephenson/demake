/**
 * What the demaker decides about vibrato (doc 17 §Vibrato).
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
