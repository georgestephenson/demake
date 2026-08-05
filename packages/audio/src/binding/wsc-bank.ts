/**
 * The WonderSwan's waveforms (doc 16 §The sample bank).
 *
 * The fifth of these, and the second whose chip generates its own waveform
 * rather than playing a recording — so it is the PC Engine's file with one
 * difference that decides its whole shape. On that console a waveform reaches
 * the chip only through a register port, so `pce-bank.ts` produces *register
 * writes* and there is nothing in ROM. Here the chip reads **the console's own
 * RAM**: port `$8F` names a sixty-four-byte, sixty-four-byte-aligned page, and
 * the four channels take sixteen bytes each in order.
 *
 * So this file produces a **page of bytes**, and the driver copies it into RAM
 * at boot the way a Nintendo DS's driver copies its bank. Two consequences worth
 * knowing:
 *
 *   - **The address is an agreement.** Whoever copies the page and whoever
 *     writes `$8F` have to name the same place, and it has to be below `$4000`
 *     and aligned, because those are the bits the register carries. One
 *     definition, two readers — the Super Nintendo's rule (`sdsp-bank.ts`).
 *   - **A timbre is a memory write.** Changing one mid-track would be sixteen
 *     bytes rather than the PC Engine's thirty-two register writes, so it is
 *     cheaper here than anywhere else — and nothing above this line asks for it,
 *     because the arranger's `duty` is a strategy-wide constant (doc 17 §Stage
 *     4). What that buys instead is what it buys on the PC Engine: the pitched
 *     voices take *different* shapes rather than copies of one.
 *
 * Source: WSdev wiki — Sound (https://ws.nesdev.org/wiki/Sound).
 */

import { WS_SOUND_CHANNELS, WS_WAVE_CHANNEL_BYTES, WS_WAVE_SAMPLES } from "@demake/chip";

/**
 * Where the sixty-four bytes live, in the console's own memory.
 *
 * One definition and three readers — the binding (which writes `$8F`), the
 * renderer (which puts the page behind the model so a standalone track sounds
 * like a cartridge), and the game's memory plan (which reserves it) — because
 * this is exactly the Super Nintendo's rule: a second copy of this number is a
 * game whose bass plays the snare (`sdsp-bank.ts`).
 *
 * It has to be sixty-four-byte aligned and below `$4000`, because those are the
 * bits port `$8F` carries — and it has to be free on **both** WonderSwans, whose
 * memory maps agree about almost nothing: the mono machine has sixteen kilobytes
 * with its tile bank in the top half, so the colour machine's roomy gap below
 * `$4000` is tiles over there.
 *
 * What both have is the processor's interrupt-vector table, which neither uses:
 * a demade cartridge takes no interrupt anywhere — the main loop watches the
 * beam and the audio driver reads a timer's counter — so the last aligned page
 * of that first kilobyte is free on either machine. That is what keeps this one
 * number one number, which is the Super Nintendo's rule: a second copy of it is
 * a game whose bass plays the snare (`sdsp-bank.ts`).
 */
export const WS_WAVE_BASE = 0x0300;

/** Samples in one channel's wave table, which is also its pitch lattice's step. */
export const WS_WAVE_STEP = WS_WAVE_SAMPLES;

/** Bytes the whole table occupies: sixteen a channel, four channels. */
export const WS_BANK_BYTES = WS_WAVE_CHANNEL_BYTES * WS_SOUND_CHANNELS;

/** The waveforms a demade arrangement can be given. */
export const WS_WAVEFORMS = ["pulse12", "pulse25", "pulse50", "triangle", "saw"] as const;

/** One of them. */
export type WsWaveform = (typeof WS_WAVEFORMS)[number];

/**
 * Peak and trough, which are the whole four-bit range.
 *
 * Nothing has to be held back from full scale: four channels at full amplitude
 * sum to exactly nominal full scale in `WsSound` (§`levels`), because that is
 * what the hardware's own summing does. So a waveform uses every code it has and
 * the loudness question is the volume register's alone.
 */
const HIGH = 15;
const LOW = 0;

/**
 * One cycle, as thirty-two unsigned four-bit samples.
 *
 * Unsigned because the chip is: it subtracts eight itself, so a flat table of
 * eight is silence rather than a click.
 *
 * Sixteen codes rather than the PC Engine's thirty-two, and that costs the one
 * thing that file could have: a shape here **cannot be exactly centred**. Any
 * ramp over all sixteen codes has a mean of 7.5, half a code below the chip's
 * own midpoint, so a triangle and a saw both carry half a code of DC. Nudging
 * them up a code would trade it for the same offset the other way and cost the
 * shape its top value, so they are drawn true and the renderer's DC blocker
 * removes what is left — which is what that blocker is for.
 */
export function wsWaveform(waveform: WsWaveform): Uint8Array {
  const out = new Uint8Array(WS_WAVE_SAMPLES);
  const half = WS_WAVE_SAMPLES / 2;
  for (let index = 0; index < WS_WAVE_SAMPLES; index += 1) {
    switch (waveform) {
      case "pulse12":
        out[index] = index < WS_WAVE_SAMPLES / 8 ? HIGH : LOW;
        break;
      case "pulse25":
        out[index] = index < WS_WAVE_SAMPLES / 4 ? HIGH : LOW;
        break;
      case "pulse50":
        out[index] = index < half ? HIGH : LOW;
        break;
      case "triangle": {
        // Up over the first half and down over the second, a code a sample, so
        // one cycle walks every value the table can hold exactly twice.
        out[index] = index < half ? index : WS_WAVE_SAMPLES - 1 - index;
        break;
      }
      default:
        out[index] = index >> 1;
        break;
    }
  }
  return out;
}

/**
 * Which waveform a channel plays, by its declared kind and its position among
 * the channels of that kind.
 *
 * The PC Engine's table with one entry fewer, and for the same reasons: the
 * `wave` entry takes the triangle a bass line is prized for, and the `pulse`
 * entries take one duty each, narrowest first — so the voice a sound effect
 * borrows (the spec's first pitched channel, and therefore this one) is the thin
 * blip an arcade cabinet would have used. A list that runs out repeats its last
 * entry rather than failing.
 */
export function wsWaveformFor(kind: string, ordinal: number): WsWaveform {
  const shapes =
    kind === "pulse" ? (["pulse12", "pulse50"] as const) : (["triangle", "saw"] as const);
  const at = ordinal < 0 ? 0 : ordinal >= shapes.length ? shapes.length - 1 : ordinal;
  return shapes[at] as WsWaveform;
}

/**
 * The whole sixty-four-byte page, packed as the hardware reads it.
 *
 * Two samples a byte and the **low nibble first**, which is the one thing about
 * this table a driver cannot get away with guessing: swap them and every
 * waveform plays half a sample early, which is inaudible on a square and wrong
 * on everything else.
 */
export function wsWaveBank(shapes: readonly WsWaveform[]): Uint8Array {
  const out = new Uint8Array(WS_BANK_BYTES);
  for (let channel = 0; channel < WS_SOUND_CHANNELS; channel += 1) {
    const samples = wsWaveform(shapes[channel] ?? "pulse50");
    const base = channel * WS_WAVE_CHANNEL_BYTES;
    for (let index = 0; index < WS_WAVE_SAMPLES; index += 2) {
      out[base + (index >> 1)] =
        ((samples[index] as number) & 0x0f) | (((samples[index + 1] as number) & 0x0f) << 4);
    }
  }
  return out;
}

/**
 * The shapes this chip's four channels are given, in hardware order.
 *
 * The binding derives the same list from the spec's channel kinds
 * (`wsc.ts` §`wsWaveforms`); this is the answer for the arrangement both
 * WonderSwans declare — two pulses, a wavetable voice and the shift register —
 * and it exists so `render.ts` can place the page without reaching for the
 * binding registry and the import cycle that would come with it. A test pins the
 * two against each other, which is what stops the shortcut drifting.
 */
export function wsDefaultWaveforms(): WsWaveform[] {
  return [
    wsWaveformFor("pulse", 0),
    wsWaveformFor("pulse", 1),
    wsWaveformFor("wave", 0),
    wsWaveformFor("noise", 0),
  ];
}

/**
 * The console's whole memory with the waveforms in it, for a standalone render.
 *
 * `WsSound` reads its samples out of RAM rather than out of a register file, so
 * a model with nothing behind it renders a flat table and therefore silence.
 * This is what `render.ts` hands it — the Nintendo DS's arrangement, on a
 * console whose "sample bank" is sixty-four bytes rather than a page.
 */
export function wsWaveRam(shapes: readonly WsWaveform[]): Uint8Array {
  const ram = new Uint8Array(0x10000);
  ram.set(wsWaveBank(shapes), WS_WAVE_BASE);
  return ram;
}
