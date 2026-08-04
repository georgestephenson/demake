/**
 * Rendering — the load-bearing export (doc 16 §The render contract).
 *
 * The CLI writes files by calling this, the web app plays the buffer this
 * returns through a bare `AudioBufferSourceNode`, and the desktop app plays the
 * file the CLI produced. Three surfaces, one synthesis, which is what makes "the
 * file sounds exactly like the cartridge" a testable claim rather than a hope.
 *
 * Nothing here interprets music. It hands a register schedule to a chip model
 * and collects samples, so what is rendered is what a driver would deliver — and
 * the register schedule the ROM executes is the same object (doc 16 §Claim 1).
 */

import { createChip, mix, renderSchedule, type OutputStage, type Pcm } from "@demake/chip";

import { bindingFor } from "./binding/registry.js";
import { sampleBank } from "./binding/gba-bank.js";
import { ndsSampleRam } from "./binding/nds-bank.js";
import { sampleAram } from "./binding/sdsp-bank.js";
import { wsDefaultWaveforms, wsWaveRam } from "./binding/wsc-bank.js";
import type { ChipScript } from "./chipscript.js";

export interface RenderAudioOptions {
  /** Delivery rate. 48 kHz unless a caller has a specific reason. */
  sampleRate?: number;
  outputStage?: OutputStage;
  /** Extra seconds after the last tick, so decays and releases are not cut. */
  tailSeconds?: number;
  /** Repeat from the script's loop point this many extra times. */
  loops?: number;
}

/** Render a script to PCM through the chip models. */
export function render(script: ChipScript, options: RenderAudioOptions = {}): Pcm {
  const ticks = withLoops(script, options.loops ?? 0);
  const parts: Pcm[] = [];
  for (let index = 0; index < script.chips.length; index += 1) {
    const id = script.chips[index] as Parameters<typeof createChip>[0];
    // A sample player is handed the RAM its waveforms live in, and the built-in
    // bank is the default rather than something every caller has to remember —
    // a schedule may override it, and nothing does yet (doc 16 §The sample bank).
    const ram = script.sampleRam ?? (id === "s-dsp" ? sampleAram() : undefined);
    // The third sample player reads an *address space* rather than a private RAM,
    // so it is handed the bank and the address the bank's first byte answers at.
    // Without the second half every source register points somewhere the model
    // has nothing at, which renders as silence and looks like a wrong schedule.
    const ndsRam = id === "nds-spu" && script.sampleRam === undefined ? ndsSampleRam() : undefined;
    // The other sample player takes its waveforms as a *bank* rather than as a
    // block of RAM, because that is what it plays: the mixer reads cartridge
    // ROM, so a build hands it the table rather than an address space.
    const bank = id === "gba-pcm" ? sampleBank() : undefined;
    // And the fourth: this chip's waveforms are sixty-four bytes of the
    // *console's* RAM rather than a register file, so a model with nothing
    // behind it walks a flat table and renders silence. The shapes are the
    // binding's, so the page a standalone render hears is the page a cartridge
    // copies (`binding/wsc-bank.ts`).
    const waveRam =
      id === "ws-sound" && script.sampleRam === undefined
        ? wsWaveRam(wsDefaultWaveforms())
        : undefined;
    const chip = createChip(id, {
      stereo: true,
      ...(ram === undefined ? {} : { ram }),
      ...(ndsRam === undefined ? {} : { ram: ndsRam.ram, ramBase: ndsRam.base }),
      ...(bank === undefined ? {} : { bank }),
      ...(waveRam === undefined ? {} : { ram: waveRam }),
    });
    // Filtered per *write* rather than per tick: a console with two chips writes
    // both within one driver tick, and a tick-level tag could not say so.
    const schedule = ticks.map((tick) => ({
      writes: tick.writes.filter((write) => (write.chip ?? tick.chip ?? 0) === index),
    }));
    parts.push(
      renderSchedule(chip, schedule, script.driver.rate, {
        ...(options.sampleRate === undefined ? {} : { sampleRate: options.sampleRate }),
        ...(options.outputStage ? { outputStage: options.outputStage } : {}),
        tailSeconds: options.tailSeconds ?? 0.25,
      }),
    );
  }
  if (parts.length === 1) return parts[0] as Pcm;
  // How loud each chip is against the other is a fact about the *board* rather
  // than about either model — an SN76489 that normalised itself for a Master
  // System would drown six FM voices — so the balance comes from the binding.
  return mix(parts, bindingFor(script.console).chipGains);
}

/**
 * Expand a script's loop for rendering.
 *
 * A loop is a property of the schedule, not of the audio, so repeating it here
 * is purely a listening convenience — the artifact still carries one pass plus
 * the loop point, which is what the driver and every VGM player consume.
 */
function withLoops(script: ChipScript, loops: number): ChipScript["ticks"] {
  if (loops <= 0 || script.loopTick < 0 || script.loopTick >= script.ticks.length) {
    return script.ticks;
  }
  const out = [...script.ticks];
  for (let i = 0; i < loops; i += 1) {
    out.push(...script.ticks.slice(script.loopTick));
  }
  return out;
}
