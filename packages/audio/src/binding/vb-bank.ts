/**
 * The Virtual Boy's built-in waveforms.
 *
 * The **fifth** kind of bank in the set, and it is nearest the PC Engine's: this
 * chip's wave RAM is reachable only as part of its own register page, so what
 * this file produces is *register writes* — nothing in ROM, nothing to copy, and
 * no address anybody has to agree about. What makes it a fifth kind rather than
 * the third again is that the tables are a **shared pool of five** rather than
 * one per channel: a table is a timbre and a channel names one, so two voices
 * can play the same shape without a second copy of it and the fifth table is a
 * fifth *sound* rather than a fifth channel.
 *
 * That is what this file spends. Five tables against six channels means the
 * choice is which five timbres a track gets, and — exactly as on the PC Engine —
 * they are five *different* ones rather than five copies of one, because
 * identical hardware says nothing about what to put in it and the demaker is
 * what spends the machine (AGENTS.md §Iron rules).
 *
 * Six bits a sample, which is two more than the WonderSwan's and one more than
 * the PC Engine's, so a saw here is genuinely a ramp rather than a staircase.
 */

import { VSU_WAVE_SAMPLES, Vsu } from "@demake/chip";

import type { BoundWrite } from "./types.js";

/** The five shapes, in the order the tables hold them. */
export type VbWaveform = "pulse8" | "pulse4" | "pulse2" | "saw" | "triangle";

/** Which table each shape is uploaded into. */
export const VB_TABLES: readonly VbWaveform[] = ["pulse8", "pulse4", "pulse2", "saw", "triangle"];

/** The largest sample value six bits hold. */
const PEAK = 63;

/**
 * One cycle of a shape, as thirty-two six-bit samples.
 *
 * Unsigned and centred on 32, because that is what the hardware's DAC reads and
 * what {@link Vsu} subtracts — a flat table of 32 is silence rather than a step.
 */
export function vbWaveTable(shape: VbWaveform): Uint8Array {
  const out = new Uint8Array(VSU_WAVE_SAMPLES);
  for (let index = 0; index < VSU_WAVE_SAMPLES; index += 1) {
    const phase = index / VSU_WAVE_SAMPLES;
    let value: number;
    switch (shape) {
      case "pulse8":
        value = phase < 0.125 ? PEAK : 0;
        break;
      case "pulse4":
        value = phase < 0.25 ? PEAK : 0;
        break;
      case "pulse2":
        value = phase < 0.5 ? PEAK : 0;
        break;
      case "saw":
        value = Math.round(phase * PEAK);
        break;
      case "triangle":
        value = Math.round((phase < 0.5 ? phase * 2 : 2 - phase * 2) * PEAK);
        break;
    }
    out[index] = value;
  }
  return out;
}

/**
 * Which table a channel of this kind and ordinal is given.
 *
 * A pulse takes a narrower duty the further down the list it is, so two pulses
 * are told apart by timbre as well as by pitch; the wave channels take the saw
 * and the triangle. The noise channel asks for nothing, because it has no
 * waveform at all.
 */
export function vbTableFor(kind: string, ordinal: number): number {
  if (kind === "pulse") return ordinal === 0 ? 2 : ordinal === 1 ? 1 : 0;
  return ordinal === 0 ? 4 : 3;
}

/**
 * The whole bank, as the writes that put it in the chip.
 *
 * A hundred and sixty of them — five tables of thirty-two — which is why a
 * cartridge strips this into its boot rather than leaving it at the head of a
 * schedule: the packed format's run count does not hold a hundred and sixty
 * writes, so on this console as on the PC Engine the strip is what makes tick
 * zero packable at all rather than merely what stops an effect powering the chip
 * up again.
 */
export function vbBankWrites(): BoundWrite[] {
  const out: BoundWrite[] = [];
  VB_TABLES.forEach((shape, table) => {
    const samples = vbWaveTable(shape);
    for (let index = 0; index < VSU_WAVE_SAMPLES; index += 1) {
      out.push({ reg: Vsu.waveBase(table) + index * 4, value: samples[index] as number });
    }
  });
  return out;
}
