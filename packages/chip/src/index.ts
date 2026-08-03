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
import { GbaPcm } from "./gba-pcm.js";
import { Huc6280Psg } from "./huc6280-psg.js";
import { NdsSpu } from "./nds-spu.js";
import { NesApu } from "./nes-apu.js";
import { SDsp } from "./s-dsp.js";
import { Sn76489 } from "./sn76489.js";
import { Ym2612 } from "./ym2612.js";
import type { ChipId, ChipModel } from "./types.js";
import type { GbaSample } from "./gba-pcm.js";

export type { ChipId, ChipModel, Pcm, RegisterWrite, SampleSink } from "./types.js";
export { GbApu, GB_CLOCK_HZ } from "./gb-apu.js";
export {
  GbaPcm,
  GBA_PCM_KOF,
  GBA_PCM_KON,
  GBA_PCM_RATE_HZ,
  GBA_PCM_REGISTERS,
  GBA_PCM_VOICES,
  type GbaSample,
} from "./gba-pcm.js";
export {
  NdsSpu,
  NDS_CH,
  NDS_CHANNEL_STRIDE,
  NDS_FIRST_NOISE_CHANNEL,
  NDS_FIRST_PSG_CHANNEL,
  NDS_MASTER_ENABLE,
  NDS_MASTER_VOLUME,
  NDS_RAM_BASE,
  NDS_SOUNDCNT,
  NDS_SPU_CHANNELS,
  NDS_SPU_CLOCK_HZ,
  NDS_SPU_REGISTERS,
  type NdsSpuOptions,
} from "./nds-spu.js";
export {
  Huc6280Psg,
  HUC6280_FIRST_NOISE_CHANNEL,
  HUC6280_PSG_CHANNELS,
  HUC6280_PSG_CLOCK_HZ,
  HUC6280_PSG_REG,
  HUC6280_WAVE_BITS,
  HUC6280_WAVE_SAMPLES,
} from "./huc6280-psg.js";
export { Sn76489, SN76489_CLOCK_HZ } from "./sn76489.js";
export { NesApu, NES_CLOCK_HZ } from "./nes-apu.js";
export { Ym2612, YM2612_CLOCK_HZ } from "./ym2612.js";
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
  options: {
    stereo?: boolean;
    ram?: Uint8Array;
    /** Where {@link ram}'s first byte answers, for a chip that sees an address. */
    ramBase?: number;
    bank?: readonly GbaSample[];
  } = {},
): ChipModel {
  switch (id) {
    case "gb-apu":
      return new GbApu();
    case "nds-spu":
      // The third sample player, and the one that reads an *address space* rather
      // than a private RAM: a source register is an absolute address, so the
      // model is told where the memory it was handed begins as well as what is in
      // it (doc 16 §The sample bank).
      return new NdsSpu({
        ...(options.ram === undefined ? {} : { ram: options.ram }),
        ...(options.ramBase === undefined ? {} : { ramBase: options.ramBase }),
      });
    case "sn76489":
      return new Sn76489(options);
    case "huc6280-psg":
      return new Huc6280Psg();
    case "nes-apu":
      return new NesApu();
    case "ym2612":
      return new Ym2612();
    case "gba-pcm":
      // A mixer with no waveforms renders silence, for the same reason a sample
      // player with empty RAM does.
      return new GbaPcm(options.bank === undefined ? {} : { bank: options.bank });
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
