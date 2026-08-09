/**
 * The YM2612 (OPN2) — the Mega Drive's six four-operator FM voices.
 *
 * The first synthesizer in this package rather than a wave generator, and the
 * reason a Mega Drive demake is a ten-voice arrangement instead of a four-voice
 * one. Everything below is integer and table-driven, exactly as the hardware is,
 * so a render is reproducible sample for sample on any engine (doc 02
 * §Floating-point discipline).
 *
 * Four facts about this chip decide the shape of the model:
 *
 *   - **It is sample-rate, not edge-rate.** A tone generator is stepped by its
 *     next edge; an FM operator produces a new value every 144 master clocks
 *     whatever it is doing. So the "event" this model advances to is the internal
 *     sample, and {@link SampleSink}'s box integration still applies unchanged —
 *     the level really is constant across those 144 clocks.
 *   - **A voice is four operators and a wiring diagram.** Each operator is a
 *     phase accumulator, a log-sine lookup and an envelope; the eight algorithms
 *     say which outputs modulate which phases and which are heard. That is the
 *     whole of FM, and {@link ALGORITHMS} is the whole of the wiring.
 *   - **Everything is attenuation, in a logarithmic domain.** The sine table
 *     stores minus log2 of the sine and the envelope stores attenuation, so
 *     modulation depth, total level and the envelope all *add*, and one
 *     exponential lookup turns the sum into a sample. Two 256-entry tables,
 *     which are the two the hardware holds in ROM.
 *   - **The bus is four addresses, not a register file.** Two of them latch an
 *     address and write a datum for channels 1-3, two more do the same for 4-6.
 *     {@link Ym2612.write} therefore takes a *port*, 0-3, which is what a driver
 *     actually stores to — the same reason the SN76489's `write` takes its one
 *     port rather than a register number.
 *
 * **The whole chip is here.** The three things that were stored and inert — the
 * LFO's *pitch* modulation, the SSG-EG envelope modes, and channel 3's
 * per-operator frequency mode — are modelled, and none of them is reachable by
 * writing a register this project's binding does not write. So a demake sounds
 * exactly as it did (`$22` is written once, with the LFO off, and `$90`, `$A8`
 * and `$27`'s top two bits are never written at all), and a binding that reaches
 * for one of them from now on gets the hardware rather than a shrug. Three of
 * this chip's habits are worth knowing before touching any of them:
 *
 *   - **Pitch modulation is applied to the F-number, not to the increment.**
 *     A depth and an LFO step choose a signed offset *per F-number bit*, so the
 *     same vibrato is a different number of increment units at every pitch —
 *     which is what makes it a constant interval in cents rather than in hertz.
 *     {@link LFO_PM_OUTPUT} is the measured table and {@link LFO_PM_TABLE} the
 *     128 × 8 × 32 expansion of it that a sample actually indexes.
 *   - **SSG-EG runs the envelope four times as fast and folds it.** Decay,
 *     sustain and release step by four and stop at half attenuation rather than
 *     full, and the mode's low three bits say what happens when they get there:
 *     hold, invert, or restart the attack. Inverting is a *reading* of the
 *     envelope rather than a change to it, which is why {@link attenuationOf}
 *     exists and why the stored attenuation is untouched by it.
 *   - **Channel 3 can hold four pitches, and they are not in slot order.** The
 *     three extra F-numbers at `$A8`-`$AA` feed S3, S1 and S2 in that order,
 *     with S4 keeping the channel's own — so a table is the honest way to write
 *     it down and {@link SLOT3_FREQUENCY} is that table.
 *
 * What this model still does not do is the **bus's busy flag** (see
 * {@link Ym2612.read}) and the difference between the discrete and integrated
 * chips' output stages: the discrete YM2612 quantises each operator's output to
 * nine bits and the ASIC in a later Mega Drive does not, which is a ladder
 * effect on quiet notes rather than a note at the wrong pitch. Both are
 * deliberate: the first is honest for a model with no bus timing, and the second
 * is a *board* difference of the kind `mix()` already takes per-chip gains for.
 *
 * Sources:
 * - Sega — YM2612 application manual (register map, key-on slot order, F-number)
 * - Nemesis — YM2612 hardware research thread, which Nuked-OPN2 derives from
 * - Plutiedev — YM2612 access from the 68000: https://plutiedev.com/ym2612-registers
 */

import type { ChipId, ChipModel, SampleSink } from "./types.js";

/**
 * The chip's clock on an NTSC Mega Drive: the master clock divided by seven.
 *
 * The same divider the 68000 runs on, which is why the two are quoted together;
 * the PSG beside it takes master over fifteen instead, and that is the whole of
 * why `SN76489_CLOCK_HZ` is a different number on the same board.
 */
export const YM2612_CLOCK_HZ = 7670453;

/**
 * Master clocks per internal sample: six channels of twenty-four operator slots.
 *
 * About 53.267 kHz, which is this chip's real output rate and the rate every
 * envelope, LFO and phase step below is counted in.
 */
const SAMPLE_DIVIDER = 144;

/** Voices, and operators per voice. */
const CHANNELS = 6;
const OPERATORS = 4;

/** Envelope attenuation is ten bits, zero loud and this silent. */
const MAX_ATTENUATION = 0x3ff;

/**
 * Minus log2 of the sine over the first quarter cycle, in 1/256ths.
 *
 * The chip's own sine ROM: 256 entries of `-log2(sin((i + 0.5) * PI / 512)) * 256`
 * rounded, which is why it opens 2137, 1731, 1543. The other three quarters are
 * this one mirrored and negated, which is what {@link operatorOutput} does with
 * the top two bits of the phase. `ym2612.test.ts` recomputes both tables from
 * the transcendentals a test may use and asserts they match, so the literals
 * have a provenance rather than being magic.
 */
const LOGSIN: readonly number[] = [
  2137, 1731, 1543, 1419, 1326, 1252, 1190, 1137, 1091, 1050, 1013, 979, 949, 920, 894, 869, 846,
  825, 804, 785, 767, 749, 732, 717, 701, 687, 672, 659, 646, 633, 621, 609, 598, 587, 576, 566,
  556, 546, 536, 527, 518, 509, 501, 492, 484, 476, 468, 461, 453, 446, 439, 432, 425, 418, 411,
  405, 399, 392, 386, 380, 375, 369, 363, 358, 352, 347, 341, 336, 331, 326, 321, 316, 311, 307,
  302, 297, 293, 289, 284, 280, 276, 271, 267, 263, 259, 255, 251, 248, 244, 240, 236, 233, 229,
  226, 222, 219, 215, 212, 209, 205, 202, 199, 196, 193, 190, 187, 184, 181, 178, 175, 172, 169,
  167, 164, 161, 159, 156, 153, 151, 148, 146, 143, 141, 138, 136, 134, 131, 129, 127, 125, 122,
  120, 118, 116, 114, 112, 110, 108, 106, 104, 102, 100, 98, 96, 94, 92, 91, 89, 87, 85, 83, 82, 80,
  78, 77, 75, 74, 72, 70, 69, 67, 66, 64, 63, 62, 60, 59, 57, 56, 55, 53, 52, 51, 49, 48, 47, 46,
  45, 43, 42, 41, 40, 39, 38, 37, 36, 35, 34, 33, 32, 31, 30, 29, 28, 27, 26, 25, 24, 23, 23, 22,
  21, 20, 20, 19, 18, 17, 17, 16, 15, 15, 14, 13, 13, 12, 12, 11, 10, 10, 9, 9, 8, 8, 7, 7, 7, 6, 6,
  5, 5, 5, 4, 4, 4, 3, 3, 3, 2, 2, 2, 2, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0,
];

/**
 * Two to the minus i over 256, in 1/1024ths — attenuation back into a level.
 *
 * One octave of mantissa, 1024 down to 513; the octave itself is the shift.
 * Together with {@link LOGSIN} this is the pair the hardware holds in ROM, and
 * the pair is why an operator's modulation, total level and envelope can simply
 * be added before either is consulted.
 */
const POW2: readonly number[] = [
  1024, 1021, 1018, 1016, 1013, 1010, 1007, 1005, 1002, 999, 997, 994, 991, 989, 986, 983, 981, 978,
  975, 973, 970, 967, 965, 962, 960, 957, 954, 952, 949, 947, 944, 942, 939, 936, 934, 931, 929,
  926, 924, 921, 919, 916, 914, 911, 909, 907, 904, 902, 899, 897, 894, 892, 890, 887, 885, 882,
  880, 878, 875, 873, 870, 868, 866, 863, 861, 859, 856, 854, 852, 849, 847, 845, 843, 840, 838,
  836, 834, 831, 829, 827, 825, 822, 820, 818, 816, 813, 811, 809, 807, 805, 803, 800, 798, 796,
  794, 792, 790, 787, 785, 783, 781, 779, 777, 775, 773, 771, 769, 766, 764, 762, 760, 758, 756,
  754, 752, 750, 748, 746, 744, 742, 740, 738, 736, 734, 732, 730, 728, 726, 724, 722, 720, 718,
  716, 714, 712, 710, 709, 707, 705, 703, 701, 699, 697, 695, 693, 692, 690, 688, 686, 684, 682,
  680, 679, 677, 675, 673, 671, 669, 668, 666, 664, 662, 660, 659, 657, 655, 653, 652, 650, 648,
  646, 644, 643, 641, 639, 638, 636, 634, 632, 631, 629, 627, 626, 624, 622, 621, 619, 617, 616,
  614, 612, 611, 609, 607, 606, 604, 602, 601, 599, 597, 596, 594, 593, 591, 589, 588, 586, 585,
  583, 581, 580, 578, 577, 575, 574, 572, 571, 569, 567, 566, 564, 563, 561, 560, 558, 557, 555,
  554, 552, 551, 549, 548, 546, 545, 543, 542, 540, 539, 538, 536, 535, 533, 532, 530, 529, 527,
  526, 525, 523, 522, 520, 519, 518, 516, 515, 513,
];

/**
 * The eight algorithms, as who modulates whom.
 *
 * `mod[s]` lists the slots whose output is summed into slot `s`'s phase, and
 * `carriers` is the bitmask of slots that reach the output. Slots are in signal
 * order — S1, S2, S3, S4 — which is *not* the order they appear in the register
 * map (see {@link SLOT_OF_REGISTER}), and evaluating them 0 through 3 satisfies
 * every algorithm's dependencies because no algorithm feeds a slot from a later
 * one. Feedback is the one exception and belongs to S1 alone.
 */
const ALGORITHMS: readonly { mod: readonly (readonly number[])[]; carriers: number }[] = [
  // S1 -> S2 -> S3 -> S4
  { mod: [[], [0], [1], [2]], carriers: 0b1000 },
  // (S1 + S2) -> S3 -> S4
  { mod: [[], [], [0, 1], [2]], carriers: 0b1000 },
  // S1 and (S2 -> S3) both into S4
  { mod: [[], [], [1], [0, 2]], carriers: 0b1000 },
  // (S1 -> S2) and S3 both into S4
  { mod: [[], [0], [], [1, 2]], carriers: 0b1000 },
  // Two two-operator stacks
  { mod: [[], [0], [], [2]], carriers: 0b1010 },
  // S1 into each of the other three
  { mod: [[], [0], [0], [0]], carriers: 0b1110 },
  // One stack and two bare sines
  { mod: [[], [0], [], []], carriers: 0b1110 },
  // Four bare sines — additive, not FM
  { mod: [[], [], [], []], carriers: 0b1111 },
];

/**
 * Register slot order to signal slot order.
 *
 * The operator registers step by four with the *channel* in the low bits, and
 * the slots appear as S1, S3, S2, S4 — so `$30` is S1's detune and `$34` is
 * S3's, not S2's. The same permutation governs the key-on byte's slot mask,
 * which is why it is a table rather than two open-coded swaps.
 */
const SLOT_OF_REGISTER: readonly number[] = [0, 2, 1, 3];

/**
 * Detune, in phase-increment units, by detune index and key code.
 *
 * The published OPN table, whose values are already in the units the phase
 * accumulator counts in: a whole cycle is 2^20 here, and the table is quoted in
 * 10.10 fixed point against a 1024-entry sine, which is the same thing. Index 0
 * is no detune; 1-3 are increasingly sharp and 5-7 are their flat mirrors.
 *
 * It grows with the key code but slower than the pitch does, so what it produces
 * is a *beat* whose rate rises with pitch rather than a constant offset in
 * cents. That is what detune is for on this chip.
 */
const DETUNE: readonly (readonly number[])[] = [
  [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  [0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 3, 3, 3, 4, 4, 4, 5, 5, 6, 6, 7, 8, 8, 8, 8],
  [
    1, 1, 1, 1, 2, 2, 2, 2, 2, 3, 3, 3, 4, 4, 4, 5, 5, 6, 6, 7, 8, 8, 9, 10, 11, 12, 13, 14, 16, 16,
    16, 16,
  ],
  [
    2, 2, 2, 2, 2, 3, 3, 3, 4, 4, 4, 5, 5, 6, 6, 7, 8, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 20, 22,
    22, 22, 22,
  ],
];

/**
 * Envelope increments, by row and by the low three bits of the envelope counter.
 *
 * The chip has no divider fine enough for the slowest envelopes, so instead it
 * *dithers*: a rate that wants one and a half steps takes one, then two, then
 * one. Row 18 is the row a rate of zero selects, and it never moves at all —
 * which is how "attack rate 0" means "never attacks" rather than "attacks
 * slowly".
 */
const ENVELOPE_INCREMENT: readonly (readonly number[])[] = [
  [0, 1, 0, 1, 0, 1, 0, 1],
  [0, 1, 0, 1, 1, 1, 0, 1],
  [0, 1, 1, 1, 0, 1, 1, 1],
  [0, 1, 1, 1, 1, 1, 1, 1],
  [1, 1, 1, 1, 1, 1, 1, 1],
  [1, 1, 1, 2, 1, 1, 1, 2],
  [1, 2, 1, 2, 1, 2, 1, 2],
  [1, 2, 2, 2, 1, 2, 2, 2],
  [2, 2, 2, 2, 2, 2, 2, 2],
  [2, 2, 2, 4, 2, 2, 2, 4],
  [2, 4, 2, 4, 2, 4, 2, 4],
  [2, 4, 4, 4, 2, 4, 4, 4],
  [4, 4, 4, 4, 4, 4, 4, 4],
  [4, 4, 4, 8, 4, 4, 4, 8],
  [4, 8, 4, 8, 4, 8, 4, 8],
  [4, 8, 8, 8, 4, 8, 8, 8],
  [8, 8, 8, 8, 8, 8, 8, 8],
  [16, 16, 16, 16, 16, 16, 16, 16],
  [0, 0, 0, 0, 0, 0, 0, 0],
];

/**
 * How often an envelope steps, and which increment row it uses.
 *
 * Indexed by `32 + 2 * rate + keyScaling`, which is why both tables are 128 long
 * against 64 real rates: a rate register of zero indexes below 32 and lands on
 * the row that never moves, and the fastest rate with the highest key scaling
 * indexes above 95 and lands on the row that moves by sixteen every sample.
 */
const ENVELOPE_SHIFT: readonly number[] = buildEnvelopeShift();
const ENVELOPE_ROW: readonly number[] = buildEnvelopeRow();

function buildEnvelopeShift(): number[] {
  const out: number[] = [];
  for (let index = 0; index < 32; index += 1) out.push(11);
  for (let rate = 0; rate < 64; rate += 1) {
    const shift = 11 - (rate >> 2);
    out.push(shift > 0 ? shift : 0);
  }
  for (let index = 0; index < 32; index += 1) out.push(0);
  return out;
}

function buildEnvelopeRow(): number[] {
  const out: number[] = [];
  for (let index = 0; index < 32; index += 1) out.push(18);
  for (let rate = 0; rate < 64; rate += 1) {
    if (rate < 48) out.push(rate & 3);
    else if (rate < 60) out.push(4 + (rate - 48));
    else out.push(16);
  }
  for (let index = 0; index < 32; index += 1) out.push(16);
  return out;
}

/**
 * Internal samples between LFO steps, by the three-bit frequency setting.
 *
 * 3.98 Hz at the slowest and 72 Hz at the fastest, which is the documented
 * range: the top two settings are past vibrato and into a buzz, and are what a
 * sound effect reaches for.
 */
const LFO_PERIOD: readonly number[] = [108, 77, 71, 67, 62, 44, 8, 5];

/** How far the LFO's amplitude sweep is shifted down, by the two-bit AMS. */
const AMS_SHIFT: readonly number[] = [8, 3, 1, 0];

/**
 * The LFO's amplitude output while the LFO is switched off.
 *
 * Not zero: the hardware parks the sweep at its quiet end rather than at its
 * loud one, so an operator with AM enabled and the LFO disabled is attenuated
 * rather than left alone. Nothing in this project enables AM, so the number is
 * unreachable today and is here to be right rather than to be spent.
 */
const LFO_AM_PARKED = 126;

/**
 * Pitch modulation, per F-number bit, by depth and by an eighth of the sweep.
 *
 * The measured table, and the one genuinely surprising thing about vibrato on
 * this chip: the offset is not a function of the F-number but a *sum over its
 * bits*, seven rows of eight depths of eight steps. Reading it that way is what
 * makes the modulation proportional to the pitch — bit 10 contributes sixty-four
 * times what bit 4 does at the same depth — so one PMS setting is the same
 * interval in every octave, which a fixed offset in increment units would not be.
 *
 * Rows are bits 4 through 10 of the F-number; bits 0-3 contribute nothing at any
 * depth, which is why the table starts at bit 4 and why a channel's index into
 * it is seven bits rather than eleven.
 *
 * Source: Nemesis' YM2610/YM2612 measurements, the table every accurate OPN
 * model carries.
 */
const LFO_PM_OUTPUT: readonly (readonly number[])[] = [
  // F-number bit 4
  [0, 0, 0, 0, 0, 0, 0, 0],
  [0, 0, 0, 0, 0, 0, 0, 0],
  [0, 0, 0, 0, 0, 0, 0, 0],
  [0, 0, 0, 0, 0, 0, 0, 0],
  [0, 0, 0, 0, 0, 0, 0, 0],
  [0, 0, 0, 0, 0, 0, 0, 0],
  [0, 0, 0, 0, 0, 0, 0, 0],
  [0, 0, 0, 0, 1, 1, 1, 1],
  // F-number bit 5
  [0, 0, 0, 0, 0, 0, 0, 0],
  [0, 0, 0, 0, 0, 0, 0, 0],
  [0, 0, 0, 0, 0, 0, 0, 0],
  [0, 0, 0, 0, 0, 0, 0, 0],
  [0, 0, 0, 0, 0, 0, 0, 0],
  [0, 0, 0, 0, 0, 0, 0, 0],
  [0, 0, 0, 0, 1, 1, 1, 1],
  [0, 0, 1, 1, 2, 2, 2, 3],
  // F-number bit 6
  [0, 0, 0, 0, 0, 0, 0, 0],
  [0, 0, 0, 0, 0, 0, 0, 0],
  [0, 0, 0, 0, 0, 0, 0, 0],
  [0, 0, 0, 0, 0, 0, 0, 0],
  [0, 0, 0, 0, 0, 0, 0, 1],
  [0, 0, 0, 0, 1, 1, 1, 1],
  [0, 0, 1, 1, 2, 2, 2, 3],
  [0, 0, 2, 3, 4, 4, 5, 6],
  // F-number bit 7
  [0, 0, 0, 0, 0, 0, 0, 0],
  [0, 0, 0, 0, 0, 0, 0, 0],
  [0, 0, 0, 0, 0, 0, 1, 1],
  [0, 0, 0, 0, 1, 1, 1, 1],
  [0, 0, 0, 1, 1, 1, 1, 2],
  [0, 0, 1, 1, 2, 2, 2, 3],
  [0, 0, 2, 3, 4, 4, 5, 6],
  [0, 0, 4, 6, 8, 8, 10, 12],
  // F-number bit 8
  [0, 0, 0, 0, 0, 0, 0, 0],
  [0, 0, 0, 0, 1, 1, 1, 1],
  [0, 0, 0, 1, 1, 1, 2, 2],
  [0, 0, 1, 1, 2, 2, 3, 3],
  [0, 0, 1, 2, 2, 2, 3, 4],
  [0, 0, 2, 3, 4, 4, 5, 6],
  [0, 0, 4, 6, 8, 8, 10, 12],
  [0, 0, 8, 12, 16, 16, 20, 24],
  // F-number bit 9
  [0, 0, 0, 0, 0, 0, 0, 0],
  [0, 0, 0, 0, 2, 2, 2, 2],
  [0, 0, 0, 2, 2, 2, 4, 4],
  [0, 0, 2, 2, 4, 4, 6, 6],
  [0, 0, 2, 4, 4, 4, 6, 8],
  [0, 0, 4, 6, 8, 8, 10, 12],
  [0, 0, 8, 12, 16, 16, 20, 24],
  [0, 0, 16, 24, 32, 32, 40, 48],
  // F-number bit 10
  [0, 0, 0, 0, 0, 0, 0, 0],
  [0, 0, 0, 0, 4, 4, 4, 4],
  [0, 0, 0, 4, 4, 4, 8, 8],
  [0, 0, 4, 4, 8, 8, 12, 12],
  [0, 0, 4, 8, 8, 8, 12, 16],
  [0, 0, 8, 12, 16, 16, 20, 24],
  [0, 0, 16, 24, 32, 32, 40, 48],
  [0, 0, 32, 48, 64, 64, 80, 96],
];

/** F-number bits the modulation table has a row for, and depths and steps. */
const PM_BITS = 7;
const PM_DEPTHS = 8;
const PM_STEPS = 32;

/**
 * Every pitch offset, indexed by `fnum7 * 256 + depth * 32 + step`.
 *
 * {@link LFO_PM_OUTPUT} holds a *quarter* of the sweep, so the other three are
 * this one mirrored and negated — the same economy {@link LOGSIN} makes, and for
 * the same reason. Summing the bits once at load rather than seven times a
 * sample is what keeps a vibrato patch as cheap as a plain one.
 */
const LFO_PM_TABLE: Int16Array = buildLfoPmTable();

function buildLfoPmTable(): Int16Array {
  const table = new Int16Array(128 * PM_DEPTHS * PM_STEPS);
  for (let depth = 0; depth < PM_DEPTHS; depth += 1) {
    for (let fnum = 0; fnum < 128; fnum += 1) {
      for (let step = 0; step < 8; step += 1) {
        let value = 0;
        for (let bit = 0; bit < PM_BITS; bit += 1) {
          if ((fnum & (1 << bit)) === 0) continue;
          value += (LFO_PM_OUTPUT[bit * PM_DEPTHS + depth] as readonly number[])[step] as number;
        }
        const base = fnum * PM_DEPTHS * PM_STEPS + depth * PM_STEPS;
        table[base + step] = value;
        table[base + (step ^ 7) + 8] = value;
        table[base + step + 16] = -value;
        table[base + (step ^ 7) + 24] = -value;
      }
    }
  }
  return table;
}

/**
 * Which of channel 3's four F-numbers each slot takes, in signal order.
 *
 * `$A8`, `$A9` and `$AA` are three extra F-numbers, and they do *not* land on
 * S1, S2 and S3 in that order: S1 takes `$A9`, S2 takes `$AA`, S3 takes `$A8`,
 * and S4 keeps the channel's own from `$A2`. Which is a permutation nobody would
 * guess and every accurate model carries, so it is a table rather than three
 * lines of arithmetic. `-1` is "the channel's own".
 */
const SLOT3_FREQUENCY: readonly number[] = [1, 2, 0, -1];

/**
 * `$27`'s top two bits: what channel 3 is doing.
 *
 * Zero is one pitch for the whole voice and every other value is four, so the
 * frequency question is "not normal" rather than a match. Only `2` also runs
 * CSM, where timer A strikes the voice rather than a driver — which is why that
 * one has a name and `1` and `3` do not.
 */
const CH3_NORMAL = 0;
const CH3_CSM = 2;

/** One four-operator voice's worth of operator state. */
interface Operator {
  // --- registers -------------------------------------------------------------
  detune: number;
  /** Frequency multiple, stored doubled: 0 means one half. */
  multiple: number;
  totalLevel: number;
  keyScale: number;
  attackRate: number;
  decayRate: number;
  sustainRate: number;
  releaseRate: number;
  /** Attenuation the decay hands over to the sustain rate at. */
  sustainLevel: number;
  amEnable: boolean;
  /** `$90`: bit 3 arms SSG-EG, bits 0-2 say hold, invert and attack-again. */
  ssgEg: number;

  // --- state -----------------------------------------------------------------
  /** Twenty-bit accumulator; the top ten bits index the sine. */
  phase: number;
  increment: number;
  state: "off" | "attack" | "decay" | "sustain" | "release";
  attenuation: number;
  /**
   * SSG-EG's output inversion, as the 0 or 4 the mode bit is compared against.
   *
   * Kept in the bit's own position rather than as a boolean so the test against
   * `ssgEg & 0x04` is the equality it reads as, which is how the hardware's two
   * inversions — the mode's and the running one — cancel.
   */
  ssgInvert: number;
  /**
   * Whether the driver has this operator keyed on.
   *
   * Only CSM reads it: an automatic key-on must not silence a slot a driver is
   * holding, and an ordinary key-on is a retrigger whatever this says.
   */
  key: boolean;
  /** The last two outputs, which is what feedback averages. */
  out1: number;
  out2: number;
}

/** One voice. */
interface Channel {
  operators: Operator[];
  algorithm: number;
  feedback: number;
  fnum: number;
  block: number;
  /** The block and F-number high bits, held until the low byte lands. */
  latch: number;
  keyCode: number;
  /** The phase increment before detune and multiple, which those two scale. */
  base: number;
  left: boolean;
  right: boolean;
  ams: number;
  fms: number;
  /** What each slot produced this sample, for the modulation wiring. */
  slotOut: number[];
  /** Scratch for a sample's four phase increments, so PM allocates nothing. */
  increments: number[];
}

/**
 * One pitch, in the three forms the chip wants it in.
 *
 * A channel has one of these and channel 3 in its special mode has four, which
 * is the whole of what that mode is. The block and F-number are kept beside the
 * increment because pitch modulation works on *them* rather than on it.
 */
interface Frequency {
  fnum: number;
  block: number;
  keyCode: number;
  /** The phase increment before detune and multiple, which those two scale. */
  base: number;
}

/**
 * A YM2612, driven the way a driver drives it: four addresses on a bus.
 *
 * Output is stereo because the chip is — every channel has its own left and
 * right enables, which is more panning than any other chip in this set offers.
 */
export class Ym2612 implements ChipModel {
  readonly id: ChipId = "ym2612";
  readonly clockHz = YM2612_CLOCK_HZ;
  readonly outputChannels = 2 as const;

  private readonly channels: Channel[] = [];
  /** The address each half of the bus last latched. */
  private readonly address: [number, number] = [0, 0];

  private lfoEnabled = false;
  private lfoFrequency = 0;
  private lfoCounter = 0;
  private lfoTimer = 0;
  private lfoAm = LFO_AM_PARKED;
  /** The sweep as pitch modulation sees it: a quarter the resolution AM gets. */
  private lfoPm = 0;

  /**
   * What `$27`'s top two bits say channel 3 is doing, and the pitches it holds.
   *
   * The three extra F-numbers are the chip's rather than the channel's, because
   * they are written through registers that name no channel — `$A8`-`$AA` sit
   * where channel 4's would if the first half of the bus had one.
   */
  private ch3Mode = CH3_NORMAL;
  private readonly ch3: Frequency[] = [
    { fnum: 0, block: 0, keyCode: 0, base: 0 },
    { fnum: 0, block: 0, keyCode: 0, base: 0 },
    { fnum: 0, block: 0, keyCode: 0, base: 0 },
  ];
  private ch3Latch = 0;
  /**
   * CSM's key-on, as the two-sample shift register it has to be.
   *
   * Timer A's overflow keys channel 3 on and the *next* sample keys it off
   * again, unless the timer overflowed a second time first — so a one-shot flag
   * would either hold the note for ever or never let it sound.
   */
  private csmKey = 0;

  private dacEnabled = false;
  private dacSample = 0;

  private timerAPeriod = 0;
  private timerACounter = 0;
  private timerBPeriod = 0;
  private timerBCounter = 0;
  private timerBPrescale = 0;
  private timerAEnabled = false;
  private timerBEnabled = false;
  private timerARunning = false;
  private timerBRunning = false;
  private timerAFlag = false;
  private timerBFlag = false;

  private envelopeTimer = 0;
  private envelopeCounter = 0;
  private clocksToSample = SAMPLE_DIVIDER;
  private outLeft = 0;
  private outRight = 0;

  constructor() {
    for (let index = 0; index < CHANNELS; index += 1) {
      this.channels.push({
        operators: Array.from({ length: OPERATORS }, () => newOperator()),
        algorithm: 0,
        feedback: 0,
        fnum: 0,
        block: 0,
        latch: 0,
        keyCode: 0,
        base: 0,
        left: true,
        right: true,
        ams: 0,
        fms: 0,
        slotOut: [0, 0, 0, 0],
        increments: [0, 0, 0, 0],
      });
    }
    this.reset();
  }

  reset(): void {
    for (const channel of this.channels) {
      channel.algorithm = 0;
      channel.feedback = 0;
      channel.fnum = 0;
      channel.block = 0;
      channel.latch = 0;
      channel.keyCode = 0;
      channel.base = 0;
      channel.left = true;
      channel.right = true;
      channel.ams = 0;
      channel.fms = 0;
      channel.slotOut = [0, 0, 0, 0];
      channel.increments = [0, 0, 0, 0];
      for (let slot = 0; slot < OPERATORS; slot += 1) {
        channel.operators[slot] = newOperator();
      }
    }
    this.address[0] = 0;
    this.address[1] = 0;
    this.lfoEnabled = false;
    this.lfoFrequency = 0;
    this.lfoCounter = 0;
    this.lfoTimer = 0;
    this.lfoAm = LFO_AM_PARKED;
    this.lfoPm = 0;
    this.ch3Mode = CH3_NORMAL;
    for (const frequency of this.ch3) {
      frequency.fnum = 0;
      frequency.block = 0;
      frequency.keyCode = 0;
      frequency.base = 0;
    }
    this.ch3Latch = 0;
    this.csmKey = 0;
    this.dacEnabled = false;
    this.dacSample = 0;
    this.timerAPeriod = 0;
    this.timerACounter = 0;
    this.timerBPeriod = 0;
    this.timerBCounter = 0;
    this.timerBPrescale = 0;
    this.timerAEnabled = false;
    this.timerBEnabled = false;
    this.timerARunning = false;
    this.timerBRunning = false;
    this.timerAFlag = false;
    this.timerBFlag = false;
    this.envelopeTimer = 0;
    this.envelopeCounter = 0;
    this.clocksToSample = SAMPLE_DIVIDER;
    this.outLeft = 0;
    this.outRight = 0;
  }

  /**
   * Write one byte to one of the chip's four bus addresses.
   *
   * `0` and `2` latch an address for channels 1-3 and 4-6; `1` and `3` write the
   * datum the latched address names. A driver stores exactly these four bytes,
   * which is why this is the interface rather than a register number.
   */
  write(port: number, value: number): void {
    const half = (port >> 1) & 1;
    const byte = value & 0xff;
    if ((port & 1) === 0) {
      this.address[half] = byte;
      return;
    }
    this.writeRegister(half, this.address[half] as number, byte);
  }

  /**
   * The status byte, which is the same on all four addresses.
   *
   * Bit 7 is the busy flag and is always clear: this model applies a write the
   * instant it arrives, so a driver's busy-wait finds the chip ready. That is
   * the honest answer for a model with no bus timing — a driver written to spin
   * still spins correctly on hardware, and one that does not is not made wrong
   * here.
   */
  read(): number {
    return (this.timerBFlag ? 0x02 : 0) | (this.timerAFlag ? 0x01 : 0);
  }

  /**
   * Whether either timer is counting, which is the only state a bus can read.
   *
   * A console asks this to decide whether the chip has to be clocked at all when
   * nothing is rendering ({@link run}). It is not a fact about the audio: a chip
   * with both timers stopped and no sink attached is a chip whose every change
   * is invisible.
   */
  get timersRunning(): boolean {
    return this.timerARunning || this.timerBRunning;
  }

  /**
   * Master clocks until this chip's output can next change.
   *
   * An operator produces a new value every {@link SAMPLE_DIVIDER} clocks and holds
   * it in between, so a span no longer than this carries one level and integrates
   * exactly. Nothing here needs it — {@link run} already bounds its own steps —
   * but a *containing* chip does: the YM2610 is this FM core beside an SSG and
   * seven ADPCM voices, and it can only sum them into one flat span if every
   * section says when it will next move (`ym2610.ts` §The one run loop).
   */
  get clocksUntilSample(): number {
    return this.clocksToSample;
  }

  /**
   * Run the chip for `clocks` master cycles, rendering into `sink` if given.
   *
   * **The sink is optional because a timer is not audio.** Every other chip in
   * this set is write-only, so a model that only advanced while somebody was
   * listening was indistinguishable from one that always did. This chip has a
   * status byte the bus can *read* — two timer overflow flags — and a driver
   * whose clock is timer A polls exactly that, so a console has to clock this
   * chip with the speakers unplugged.
   *
   * What it does *not* have to do is clock it when nothing at all is observable,
   * which is why {@link timersRunning} is exposed beside this. A demade game
   * never programmes either timer — `binding/md.ts` writes `$27 = 0` at boot and
   * never again — so on that caller the whole simulation is dead weight, and it
   * is a fifth of the Mega Drive audio battery's budget rather than a rounding
   * error. The consequence to know: with no sink and no timer, the envelopes and
   * phases stop where they were, so a sink attached *later* resumes a chip whose
   * audio state is stale. Nothing here does that — every console attaches its
   * sink before it runs — and the alternative is paying for six four-operator
   * voices nobody can hear.
   */
  run(clocks: number, sink?: SampleSink): void {
    let remaining = clocks;
    while (remaining > 0) {
      const step = sink
        ? Math.min(remaining, sink.clocksUntilSampleBoundary(), this.clocksToSample)
        : Math.min(remaining, this.clocksToSample);
      sink?.add(this.outLeft, this.outRight, step);
      this.clocksToSample -= step;
      remaining -= step;
      if (this.clocksToSample <= 0) {
        this.clocksToSample += SAMPLE_DIVIDER;
        this.advance();
      }
    }
  }

  // --- registers ---------------------------------------------------------------

  private writeRegister(half: number, address: number, value: number): void {
    // Everything below `$30` is global and lives on the first half of the bus
    // only; the second half's copies of them do nothing on the hardware.
    if (address < 0x30) {
      if (half === 0) this.writeGlobal(address, value);
      return;
    }
    const index = address & 3;
    if (index === 3) return; // no fourth channel per half
    // `$A8`-`$AE` sit where a fourth channel's F-number would and belong to
    // channel 3's four-pitch mode instead. Only the first half of the bus has
    // them; the second half's copies do nothing, exactly as the globals do.
    if (address >= 0xa8 && address <= 0xae) {
      if (half === 0) this.writeSlot3(address, index, value);
      return;
    }
    const channelIndex = half * 3 + index;
    const channel = this.channels[channelIndex] as Channel;
    if (address < 0xa0) {
      const slot = SLOT_OF_REGISTER[(address >> 2) & 3] as number;
      this.writeOperator(channel, channelIndex, slot, address & 0xf0, value);
      return;
    }
    this.writeChannel(channel, channelIndex, address, value);
  }

  private writeGlobal(address: number, value: number): void {
    switch (address) {
      case 0x22:
        this.lfoEnabled = (value & 0x08) !== 0;
        this.lfoFrequency = value & 0x07;
        if (!this.lfoEnabled) {
          // Switching the LFO off *holds* the sweep rather than freeing it:
          // pitch modulation parks at the centre and amplitude modulation at
          // the quiet end, which is why the two constants differ.
          this.lfoTimer = 0;
          this.lfoCounter = 0;
          this.lfoAm = LFO_AM_PARKED;
          this.lfoPm = 0;
        }
        return;
      case 0x24:
        this.timerAPeriod = (this.timerAPeriod & 0x03) | ((value & 0xff) << 2);
        return;
      case 0x25:
        this.timerAPeriod = (this.timerAPeriod & 0x3fc) | (value & 0x03);
        return;
      case 0x26:
        this.timerBPeriod = value & 0xff;
        return;
      case 0x27:
        this.writeTimerControl(value);
        return;
      case 0x28:
        this.writeKey(value);
        return;
      case 0x2a:
        this.dacSample = value & 0xff;
        return;
      case 0x2b:
        this.dacEnabled = (value & 0x80) !== 0;
        return;
      default:
        // `$21` is a test register and `$29` selects the interrupt mode; neither
        // changes a sample, and a driver that writes one is not writing a note.
        return;
    }
  }

  private writeTimerControl(value: number): void {
    const startA = (value & 0x01) !== 0;
    const startB = (value & 0x02) !== 0;
    if (startA && !this.timerARunning) this.timerACounter = 1024 - this.timerAPeriod;
    if (startB && !this.timerBRunning) this.timerBCounter = 256 - this.timerBPeriod;
    this.timerARunning = startA;
    this.timerBRunning = startB;
    this.timerAEnabled = (value & 0x04) !== 0;
    this.timerBEnabled = (value & 0x08) !== 0;
    if ((value & 0x10) !== 0) this.timerAFlag = false;
    if ((value & 0x20) !== 0) this.timerBFlag = false;
    const mode = (value >> 6) & 0x03;
    // Leaving CSM releases whatever its last automatic key-on is still holding.
    // Without this a driver that turned the mode off mid-note would leave one of
    // channel 3's operators sounding with nothing able to key it off.
    if (this.ch3Mode === CH3_CSM && mode !== CH3_CSM) this.csmKeyOff();
    this.ch3Mode = mode;
    this.refreshChannel(2);
  }

  /**
   * Channel 3's three extra F-numbers.
   *
   * Their high byte has a latch of its own, separate from the one every other
   * channel shares — so a driver may leave a block half-written in `$A4` and
   * still set one of these, and the two must not see each other's.
   */
  private writeSlot3(address: number, index: number, value: number): void {
    if ((address & 0x0c) === 0x0c) {
      this.ch3Latch = value & 0x3f;
      return;
    }
    const frequency = this.ch3[index] as Frequency;
    frequency.fnum = ((this.ch3Latch & 0x07) << 8) | (value & 0xff);
    frequency.block = (this.ch3Latch >> 3) & 0x07;
    frequency.keyCode = keyCodeOf(frequency.block, frequency.fnum);
    frequency.base = (frequency.fnum << frequency.block) >> 1;
    this.refreshChannel(2);
  }

  /**
   * Key on or off, per operator.
   *
   * The slot mask is in register order — S1, S3, S2, S4 from bit 4 up — so it
   * takes the same permutation the operator registers do. Keying an operator
   * that is already on restarts its attack, which is what a retrigger is.
   */
  private writeKey(value: number): void {
    const within = value & 0x03;
    if (within === 3) return;
    const channelIndex = ((value & 0x04) !== 0 ? 3 : 0) + within;
    const channel = this.channels[channelIndex] as Channel;
    for (let bit = 0; bit < OPERATORS; bit += 1) {
      const slot = SLOT_OF_REGISTER[bit] as number;
      const operator = channel.operators[slot] as Operator;
      if ((value & (0x10 << bit)) !== 0) {
        keyOn(operator, this.frequencyOf(channel, channelIndex, slot).keyCode);
      } else keyOff(operator);
    }
  }

  private writeOperator(
    channel: Channel,
    channelIndex: number,
    slot: number,
    group: number,
    value: number,
  ): void {
    const operator = channel.operators[slot] as Operator;
    switch (group) {
      case 0x30:
        operator.detune = (value >> 4) & 0x07;
        // Stored doubled so that "multiple 0" — which means one half — is a
        // shift rather than a special case in the increment.
        operator.multiple = (value & 0x0f) === 0 ? 1 : (value & 0x0f) * 2;
        setIncrement(operator, this.frequencyOf(channel, channelIndex, slot));
        return;
      case 0x40:
        operator.totalLevel = value & 0x7f;
        return;
      case 0x50:
        operator.keyScale = (value >> 6) & 0x03;
        operator.attackRate = value & 0x1f;
        return;
      case 0x60:
        operator.amEnable = (value & 0x80) !== 0;
        operator.decayRate = value & 0x1f;
        return;
      case 0x70:
        operator.sustainRate = value & 0x1f;
        return;
      case 0x80:
        // Fifteen means full attenuation rather than fifteen sixteenths of it,
        // which is what makes a "decay to silence" patch expressible.
        operator.sustainLevel = value >> 4 === 0x0f ? MAX_ATTENUATION : (value >> 4) * 32;
        operator.releaseRate = value & 0x0f;
        return;
      case 0x90:
        // Only bit 3 arms the mode, so a driver may leave a shape in the low
        // bits with SSG-EG off and nothing happens — which is what makes this
        // register safe to write unconditionally.
        operator.ssgEg = value & 0x0f;
        return;
      default:
        return;
    }
  }

  private writeChannel(
    channel: Channel,
    channelIndex: number,
    address: number,
    value: number,
  ): void {
    const group = address & 0xfc;
    if (group === 0xa4) {
      // The high bits wait for the low byte, so that a note change is one
      // atomic move of the pitch rather than a moment at a wrong octave.
      channel.latch = value & 0x3f;
      return;
    }
    if (group === 0xa0) {
      channel.fnum = ((channel.latch & 0x07) << 8) | (value & 0xff);
      channel.block = (channel.latch >> 3) & 0x07;
      channel.keyCode = keyCodeOf(channel.block, channel.fnum);
      channel.base = (channel.fnum << channel.block) >> 1;
      this.refreshChannel(channelIndex);
      return;
    }
    if (group === 0xb0) {
      channel.feedback = (value >> 3) & 0x07;
      channel.algorithm = value & 0x07;
      return;
    }
    if (group === 0xb4) {
      channel.left = (value & 0x80) !== 0;
      channel.right = (value & 0x40) !== 0;
      channel.ams = (value >> 4) & 0x03;
      channel.fms = value & 0x07;
      return;
    }
    // `$A8`-`$AE` never reach here: `writeRegister` sends them to `writeSlot3`.
  }

  /**
   * The pitch a slot is played at, which is the channel's except on channel 3.
   *
   * In that channel's special mode three of its operators take an F-number of
   * their own, so *this* is what a phase increment, a detune lookup and an
   * envelope rate are all keyed on — and asking it in one place is what stops
   * the three from ever disagreeing about which note is sounding.
   */
  private frequencyOf(channel: Channel, channelIndex: number, slot: number): Frequency {
    if (channelIndex !== 2 || this.ch3Mode === CH3_NORMAL) return channel;
    const which = SLOT3_FREQUENCY[slot] as number;
    return which < 0 ? channel : (this.ch3[which] as Frequency);
  }

  /** Recompute every increment a channel's four operators step by. */
  private refreshChannel(channelIndex: number): void {
    const channel = this.channels[channelIndex] as Channel;
    for (let slot = 0; slot < OPERATORS; slot += 1) {
      setIncrement(
        channel.operators[slot] as Operator,
        this.frequencyOf(channel, channelIndex, slot),
      );
    }
  }

  // --- synthesis ---------------------------------------------------------------

  /** Produce the next internal sample, and step everything that moves with it. */
  private advance(): void {
    this.stepLfo();
    this.stepEnvelopes();
    this.stepTimers();
    this.stepSsgEg();

    let left = 0;
    let right = 0;
    for (let index = 0; index < CHANNELS; index += 1) {
      const channel = this.channels[index] as Channel;
      if (!this.dacEnabled && silent(channel)) continue;
      const value =
        index === CHANNELS - 1 && this.dacEnabled
          ? // The DAC replaces channel 6 entirely: an *offset-binary* byte, so
            // `$80` is silence and the conversion is a subtraction rather than
            // the sign-extension it looks like. Scaled to fill the same range a
            // voice reaches, because on this chip it genuinely does.
            (this.dacSample - 0x80) * 64
          : this.channelOutput(channel, index);
      // The hardware sums four carriers into a fourteen-bit accumulator and
      // clips there rather than at the mixer, which is audible on a loud patch.
      const clipped = value > 8191 ? 8191 : value < -8192 ? -8192 : value;
      if (channel.left) left += clipped;
      if (channel.right) right += clipped;
    }
    const scale = CHANNELS * 8192;
    this.outLeft = left / scale;
    this.outRight = right / scale;
  }

  /** One voice: run its four operators through the algorithm's wiring. */
  private channelOutput(channel: Channel, channelIndex: number): number {
    const algorithm = ALGORITHMS[channel.algorithm] as (typeof ALGORITHMS)[number];
    this.phaseSteps(channel, channelIndex);
    let output = 0;
    for (let slot = 0; slot < OPERATORS; slot += 1) {
      const operator = channel.operators[slot] as Operator;
      let modulation = 0;
      if (slot === 0) {
        if (channel.feedback !== 0) {
          // Feedback averages the last two outputs, which is what stops a
          // maximum-feedback operator from oscillating into a square wave.
          modulation = (operator.out1 + operator.out2) >> (10 - channel.feedback);
        }
      } else {
        for (const source of algorithm.mod[slot] as readonly number[]) {
          modulation += (channel.slotOut[source] as number) >> 1;
        }
      }
      let attenuation = attenuationOf(operator) + (operator.totalLevel << 3);
      if (operator.amEnable) attenuation += this.lfoAm >> (AMS_SHIFT[channel.ams] as number);
      const value = operatorOutput(
        (operator.phase >> 10) + modulation,
        attenuation > MAX_ATTENUATION ? MAX_ATTENUATION : attenuation,
      );
      channel.slotOut[slot] = value;
      if (slot === 0) {
        operator.out2 = operator.out1;
        operator.out1 = value;
      }
      operator.phase = (operator.phase + (channel.increments[slot] as number)) & 0xfffff;
      if ((algorithm.carriers & (1 << slot)) !== 0) output += value;
    }
    return output;
  }

  /**
   * What each of a voice's four operators steps its phase by this sample.
   *
   * The cached increment, unless the LFO is sweeping this channel's pitch — in
   * which case the offset goes on the *F-number* and the whole increment is
   * rebuilt, because a modulation applied to the increment instead would be a
   * fixed number of hertz and therefore a different interval in every octave.
   * The block and the key code are deliberately left alone: the hardware does
   * not re-derive them, so a vibrato cannot change an envelope rate or push a
   * note into the next octave's detune row.
   */
  private phaseSteps(channel: Channel, channelIndex: number): void {
    for (let slot = 0; slot < OPERATORS; slot += 1) {
      const operator = channel.operators[slot] as Operator;
      if (!this.lfoEnabled || channel.fms === 0) {
        channel.increments[slot] = operator.increment;
        continue;
      }
      const frequency = this.frequencyOf(channel, channelIndex, slot);
      const offset = LFO_PM_TABLE[
        ((frequency.fnum >> 4) & 0x7f) * (PM_DEPTHS * PM_STEPS) +
          channel.fms * PM_STEPS +
          this.lfoPm
      ] as number;
      if (offset === 0) {
        channel.increments[slot] = operator.increment;
        continue;
      }
      // The sweep is applied at one more bit of precision than the F-number
      // has, which is what lets the shallowest depth be less than one step.
      const modulated = (((frequency.fnum << 1) + offset) & 0xfff) << frequency.block;
      const table = DETUNE[operator.detune & 0x03] as readonly number[];
      const detune = table[frequency.keyCode] as number;
      const base = modulated >> 2;
      const detuned = (operator.detune & 0x04) !== 0 ? base - detune : base + detune;
      channel.increments[slot] = ((detuned & 0x1ffff) * operator.multiple) >> 1;
    }
  }

  private stepLfo(): void {
    if (!this.lfoEnabled) return;
    this.lfoTimer += 1;
    if (this.lfoTimer < (LFO_PERIOD[this.lfoFrequency] as number)) return;
    this.lfoTimer = 0;
    this.lfoCounter = (this.lfoCounter + 1) & 0x7f;
    // A triangle: up over the first half of the counter and down over the
    // second, doubled so a full sweep spans the seven bits the depth shifts.
    const magnitude =
      (this.lfoCounter & 0x40) !== 0 ? this.lfoCounter & 0x3f : (this.lfoCounter & 0x3f) ^ 0x3f;
    this.lfoAm = magnitude * 2;
    // Pitch modulation reads the same counter two bits coarser, so its sweep is
    // thirty-two steps where the amplitude one is a hundred and twenty-eight.
    this.lfoPm = this.lfoCounter >> 2;
  }

  /**
   * Step every operator's envelope.
   *
   * The generator runs at a third of the sample rate, which is where the
   * envelope rates' absolute times come from — and why the increment tables
   * dither rather than divide further.
   */
  private stepEnvelopes(): void {
    this.envelopeTimer += 1;
    if (this.envelopeTimer < 3) return;
    this.envelopeTimer = 0;
    this.envelopeCounter = (this.envelopeCounter + 1) & 0xfffff;
    for (let index = 0; index < CHANNELS; index += 1) {
      const channel = this.channels[index] as Channel;
      for (let slot = 0; slot < OPERATORS; slot += 1) {
        stepEnvelope(
          channel.operators[slot] as Operator,
          this.frequencyOf(channel, index, slot).keyCode,
          this.envelopeCounter,
        );
      }
    }
  }

  /**
   * Take whatever SSG-EG does when an envelope reaches its half-way point.
   *
   * This is the whole of what makes the mode a *loop* rather than a fast decay,
   * and it is checked every sample rather than only when the envelope steps —
   * because an operator whose attack is running can invert on any of them.
   * Every branch is behind bit 3, so an operator that never armed the mode
   * costs one test.
   */
  private stepSsgEg(): void {
    for (let index = 0; index < CHANNELS; index += 1) {
      const channel = this.channels[index] as Channel;
      for (let slot = 0; slot < OPERATORS; slot += 1) {
        const operator = channel.operators[slot] as Operator;
        if ((operator.ssgEg & 0x08) === 0) continue;
        if (operator.attenuation < 0x200) continue;
        if (operator.state === "off" || operator.state === "release") continue;
        if ((operator.ssgEg & 0x01) !== 0) {
          // Hold: the envelope stops where it is, at whichever end the mode's
          // invert bit says. Setting the flag rather than toggling it is what
          // makes "hold" hold instead of alternating.
          if ((operator.ssgEg & 0x02) !== 0) operator.ssgInvert = 4;
          if (operator.state !== "attack" && operator.ssgInvert === (operator.ssgEg & 0x04)) {
            operator.attenuation = MAX_ATTENUATION;
          }
          continue;
        }
        // Loop: either fold the output over or restart the wave, and then take
        // the attack again — which is a key-on the driver never asked for, and
        // is why this mode can make an envelope into an oscillator.
        if ((operator.ssgEg & 0x02) !== 0) operator.ssgInvert ^= 4;
        else operator.phase = 0;
        if (operator.state !== "attack") {
          restartAttack(operator, this.frequencyOf(channel, index, slot).keyCode);
        }
      }
    }
  }

  private stepTimers(): void {
    // CSM's key-off is owed a sample after its key-on, so the shift happens
    // before timer A is stepped rather than after — a second overflow inside
    // one sample would otherwise cancel the note it had just started.
    this.csmKey <<= 1;
    if (this.timerARunning) {
      this.timerACounter -= 1;
      if (this.timerACounter <= 0) {
        this.timerACounter += 1024 - this.timerAPeriod;
        if (this.timerAEnabled) this.timerAFlag = true;
        if (this.ch3Mode === CH3_CSM) this.csmKeyOn();
      }
    }
    if ((this.csmKey & 2) !== 0) this.csmKeyOff();
    if (!this.timerBRunning) return;
    this.timerBPrescale += 1;
    if (this.timerBPrescale < 16) return;
    this.timerBPrescale = 0;
    this.timerBCounter -= 1;
    if (this.timerBCounter <= 0) {
      this.timerBCounter += 256 - this.timerBPeriod;
      if (this.timerBEnabled) this.timerBFlag = true;
    }
  }

  /**
   * Channel 3's automatic key-on, which timer A rather than a driver performs.
   *
   * CSM exists so a program can re-strike one voice at an exact rate without
   * touching the bus — speech, on the machines this core was sold into. An
   * operator the driver is *itself* holding is left alone, because a key-off a
   * sample later would otherwise cut a note nobody released.
   */
  private csmKeyOn(): void {
    const channel = this.channels[2] as Channel;
    for (let slot = 0; slot < OPERATORS; slot += 1) {
      const operator = channel.operators[slot] as Operator;
      if (operator.key) continue;
      operator.phase = 0;
      operator.ssgInvert = 0;
      restartAttack(operator, this.frequencyOf(channel, 2, slot).keyCode);
    }
    this.csmKey = 1;
  }

  private csmKeyOff(): void {
    const channel = this.channels[2] as Channel;
    for (const operator of channel.operators) {
      if (!operator.key) keyOff(operator);
    }
    this.csmKey = 0;
  }
}

/**
 * Whether a voice can be skipped this sample, exactly rather than nearly.
 *
 * An operator whose envelope has run out sits at full attenuation, and full
 * attenuation shifts the exponential lookup all the way to zero — so a channel
 * with four of them contributes exactly nothing, and its phases are reset by the
 * key-on that would make it audible again. Worth having because a track using
 * three voices should not pay for six, and because the patch search plays one
 * voice a hundred-odd times.
 */
function silent(channel: Channel): boolean {
  for (const operator of channel.operators) {
    if (operator.state !== "off") return false;
  }
  return true;
}

function newOperator(): Operator {
  return {
    detune: 0,
    multiple: 1,
    totalLevel: 0,
    keyScale: 0,
    attackRate: 0,
    decayRate: 0,
    sustainRate: 0,
    releaseRate: 0,
    sustainLevel: MAX_ATTENUATION,
    amEnable: false,
    ssgEg: 0,
    phase: 0,
    increment: 0,
    state: "off",
    attenuation: MAX_ATTENUATION,
    ssgInvert: 0,
    key: false,
    out1: 0,
    out2: 0,
  };
}

/**
 * The increment an operator steps its phase by, from a pitch and its own two
 * scalings.
 *
 * Detune is added in the accumulator's own units and wraps in seventeen bits,
 * which is the hardware's overflow rather than a clamp — a detuned note near the
 * top of the range really does come back round.
 */
function setIncrement(operator: Operator, frequency: Frequency): void {
  const table = DETUNE[operator.detune & 0x03] as readonly number[];
  const offset = table[frequency.keyCode] as number;
  const detuned =
    (operator.detune & 0x04) !== 0 ? frequency.base - offset : frequency.base + offset;
  operator.increment = ((detuned & 0x1ffff) * operator.multiple) >> 1;
}

/**
 * The attenuation an operator is heard at, which SSG-EG can turn upside down.
 *
 * The inversion is a *reading* and not a state change: the envelope keeps
 * counting up either way, and what changes is whether the chip subtracts it from
 * half scale before the exponential lookup. Two inversions cancel, which is what
 * the mode's own bit and the running flag being compared rather than or-ed is
 * for.
 */
function attenuationOf(operator: Operator): number {
  if ((operator.ssgEg & 0x08) === 0) return operator.attenuation;
  if (operator.ssgInvert === (operator.ssgEg & 0x04)) return operator.attenuation;
  return (0x200 - operator.attenuation) & MAX_ATTENUATION;
}

/**
 * Begin an attack from wherever the envelope stands, without silencing first.
 *
 * Shared by an ordinary key-on, SSG-EG's loop and CSM's automatic strike,
 * because all three are the same event on this chip: the attack is skipped
 * outright at the fastest rate, which is what makes a percussive patch land on
 * the sample it was asked for rather than one later.
 */
function restartAttack(operator: Operator, keyCode: number): void {
  if (effectiveRate(operator.attackRate, operator.keyScale, keyCode) < 62) {
    operator.state =
      operator.attenuation <= 0 ? (operator.sustainLevel === 0 ? "sustain" : "decay") : "attack";
    return;
  }
  operator.attenuation = 0;
  operator.state = operator.sustainLevel === 0 ? "sustain" : "decay";
}

/**
 * One operator's sample, from its phase and its total attenuation.
 *
 * The phase index is ten bits: the low eight index the quarter-wave table, bit 8
 * mirrors it and bit 9 negates the result. Adding the modulation *before* the
 * mask is what makes deep modulation wrap through the wave rather than clip
 * against its ends, which is the whole character of FM.
 */
function operatorOutput(phase: number, attenuation: number): number {
  const index = phase & 0x3ff;
  const quadrant = (index >> 8) & 3;
  const position = (quadrant & 1) !== 0 ? 255 - (index & 0xff) : index & 0xff;
  const total = (LOGSIN[position] as number) + (attenuation << 2);
  // Sixteen octaves down is silence, and it is also where the tables end.
  if (total >= 4096) return 0;
  const magnitude = ((POW2[total & 0xff] as number) << 2) >> (total >> 8);
  return (quadrant & 2) !== 0 ? -magnitude : magnitude;
}

/**
 * The key code: the block, plus two bits distilled from the F-number.
 *
 * Envelope rates and detune both scale with pitch, and this five-bit number is
 * what they scale by — so a note high in a block decays faster than one low in
 * it, which is what makes a patch sound consistent across the keyboard.
 */
function keyCodeOf(block: number, fnum: number): number {
  const f11 = (fnum >> 10) & 1;
  const f10 = (fnum >> 9) & 1;
  const f9 = (fnum >> 8) & 1;
  const f8 = (fnum >> 7) & 1;
  const n3 = f11 !== 0 ? (f10 | f9 | f8) & 1 : f10 & f9 & f8;
  return (block << 2) | (f11 << 1) | n3;
}

/** Start an operator's attack, from wherever its envelope had reached. */
function keyOn(operator: Operator, keyCode: number): void {
  operator.key = true;
  operator.ssgInvert = 0;
  if (operator.state !== "off" && operator.state !== "release") {
    // A retrigger restarts the attack without silencing first, which is the
    // difference between a re-struck note and a new one.
    operator.state = "attack";
    operator.phase = 0;
    return;
  }
  operator.state = "attack";
  operator.phase = 0;
  if (effectiveRate(operator.attackRate, operator.keyScale, keyCode) >= 62) {
    // The fastest attack is instantaneous rather than merely quick, and the
    // hardware skips the attack state entirely — which matters, because an
    // attack that took one step would be audibly late on a percussive patch.
    operator.attenuation = 0;
    operator.state = "decay";
  }
}

function keyOff(operator: Operator): void {
  operator.key = false;
  if (operator.state === "off" || operator.state === "release") return;
  operator.state = "release";
  if ((operator.ssgEg & 0x08) === 0) return;
  // An SSG-EG release counts down from what the listener was *hearing*, so an
  // envelope that was being read upside down is folded the right way up first —
  // and one already past half scale has nowhere to fall and stops here.
  if (operator.ssgInvert !== (operator.ssgEg & 0x04)) {
    operator.attenuation = (0x200 - operator.attenuation) & MAX_ATTENUATION;
  }
  if (operator.attenuation >= 0x200) {
    operator.attenuation = MAX_ATTENUATION;
    operator.state = "off";
  }
}

/** `2 * rate + keyScaling`, offset past the rows that never move. */
function effectiveRate(rate: number, keyScale: number, keyCode: number): number {
  if (rate === 0) return 0;
  return 2 * rate + (keyCode >> (3 - keyScale));
}

/** The table index a rate reaches, which is what selects a row and a shift. */
function rateIndex(rate: number, keyScale: number, keyCode: number): number {
  if (rate === 0) return 0;
  const index = 32 + 2 * rate + (keyCode >> (3 - keyScale));
  return index > 127 ? 127 : index;
}

function stepEnvelope(operator: Operator, keyCode: number, counter: number): void {
  if (operator.state === "off") return;
  const rate =
    operator.state === "attack"
      ? rateIndex(operator.attackRate, operator.keyScale, keyCode)
      : operator.state === "decay"
        ? rateIndex(operator.decayRate, operator.keyScale, keyCode)
        : operator.state === "sustain"
          ? rateIndex(operator.sustainRate, operator.keyScale, keyCode)
          : // The release rate is four bits where the others are five, and the
            // hardware reads it as an odd five-bit rate rather than an even one.
            rateIndex(operator.releaseRate * 2 + 1, operator.keyScale, keyCode);
  const shift = ENVELOPE_SHIFT[rate] as number;
  if ((counter & ((1 << shift) - 1)) !== 0) return;
  const row = ENVELOPE_ROW[rate] as number;
  const increment = (ENVELOPE_INCREMENT[row] as readonly number[])[
    (counter >> shift) & 7
  ] as number;
  if (increment === 0) return;

  switch (operator.state) {
    case "attack": {
      // Attack is exponential *towards* zero attenuation, so it is a fraction of
      // what is left rather than a fixed step — which is why a long attack still
      // reaches the top rather than crawling for ever.
      operator.attenuation += (~operator.attenuation * increment) >> 4;
      if (operator.attenuation <= 0) {
        operator.attenuation = 0;
        operator.state = "decay";
      }
      return;
    }
    case "decay": {
      if ((operator.ssgEg & 0x08) !== 0) {
        // Four times the step, and a stop at *half* attenuation rather than
        // full: the top half of the range is where the loop lives, so a decay
        // that ran into it would take the fold away.
        if (operator.attenuation < 0x200) operator.attenuation += increment * 4;
        if (operator.attenuation >= operator.sustainLevel) operator.state = "sustain";
        return;
      }
      operator.attenuation += increment;
      if (operator.attenuation >= operator.sustainLevel) {
        operator.attenuation = operator.sustainLevel;
        operator.state = "sustain";
      }
      return;
    }
    case "sustain": {
      if ((operator.ssgEg & 0x08) !== 0) {
        if (operator.attenuation < 0x200) operator.attenuation += increment * 4;
        return;
      }
      operator.attenuation += increment;
      // Reaching silence in the sustain phase is not a state change, which is
      // verified hardware behaviour rather than an omission: a key-off from
      // here still has to run the release rate.
      if (operator.attenuation >= MAX_ATTENUATION) operator.attenuation = MAX_ATTENUATION;
      return;
    }
    default: {
      if ((operator.ssgEg & 0x08) !== 0) {
        if (operator.attenuation < 0x200) operator.attenuation += increment * 4;
        if (operator.attenuation >= 0x200) {
          operator.attenuation = MAX_ATTENUATION;
          operator.state = "off";
        }
        return;
      }
      operator.attenuation += increment;
      if (operator.attenuation >= MAX_ATTENUATION) {
        operator.attenuation = MAX_ATTENUATION;
        operator.state = "off";
      }
      return;
    }
  }
}
