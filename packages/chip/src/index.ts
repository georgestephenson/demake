/**
 * `@demake/chip` — every sound chip demake targets, as a register-driven model.
 *
 * It exists for the reason `@demake/dmg` exists: two jobs need a sound chip and
 * neither can take a dependency on someone else's. The emulator needs an APU to
 * give the web app sound; the audio pipeline needs one to render a preview, to
 * score candidates in its fitting loops, and to answer "what will this actually
 * sound like on the hardware". Those must be the *same* code — a second
 * implementation of a chip is how the preview and the emulator quietly stop
 * agreeing (doc 16 §Packages).
 *
 * Depends on nothing, on the same terms as `@demake/dmg`: this is a hardware
 * model, not conversion logic, and the dependency direction is what keeps that
 * honest.
 */

import { GbApu } from "./gb-apu.js";
import { NesApu } from "./nes-apu.js";
import { SDsp } from "./s-dsp.js";
import { Sn76489 } from "./sn76489.js";
import type { ChipId, ChipModel } from "./types.js";

export type { ChipId, ChipModel, Pcm, RegisterWrite, SampleSink } from "./types.js";
export { GbApu, GB_CLOCK_HZ } from "./gb-apu.js";
export { Sn76489, SN76489_CLOCK_HZ } from "./sn76489.js";
export { NesApu, NES_CLOCK_HZ } from "./nes-apu.js";
export {
  SDsp,
  encodeBrrBlock,
  ARAM_SIZE,
  SDSP_CLOCK_HZ,
  SDSP_SAMPLE_CLOCKS,
  SDSP_SAMPLE_RATE,
  SDSP_VOICES,
} from "./s-dsp.js";
export {
  blockDc,
  DcBlocker,
  mix,
  normalize,
  renderSchedule,
  type OutputStage,
  type Rational,
  type RenderOptions,
  type ScheduleTick,
} from "./mix.js";
export { StreamSink, type StreamOptions } from "./stream.js";

/** Construct a chip model by id — the one place a chip id becomes an object. */
export function createChip(
  id: ChipId,
  options: { stereo?: boolean; ram?: Uint8Array } = {},
): ChipModel {
  switch (id) {
    case "gb-apu":
      return new GbApu();
    case "sn76489":
      return new Sn76489(options);
    case "nes-apu":
      return new NesApu();
    case "s-dsp":
      // The only chip here that needs to be *given* something: a sample player
      // with no samples in its RAM renders silence, so whoever holds the
      // waveform bank passes it in (doc 16 §The sample bank).
      return new SDsp(options.ram === undefined ? {} : { ram: options.ram });
    default: {
      const exhaustive: never = id;
      throw new Error(`unknown chip: ${String(exhaustive)}`);
    }
  }
}
