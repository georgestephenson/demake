/**
 * The Game Boy Advance's player — the one console here whose two devices are not
 * two chips.
 *
 * `chips` carries both halves of this machine's sound, and they are different
 * *kinds* of thing rather than two of a kind. The first is `@demake/chip`'s
 * `GbApu` behind a permuted register map — a Game Boy's four channels at
 * addresses of their own — and the second is the pair of eight-bit converters
 * DMA feeds, whose samples the cartridge's own driver computed. So the second
 * one's `clockHz` is the *system* clock rather than a chip's: the converters are
 * advanced by the cycles the processor spent, because that is what the machine
 * charges them in.
 *
 * How loud the Game Boy half sits against the sample half is a fact about the
 * board rather than about either device, which is why `PSG_MIX_GAIN` arrives
 * here with the machine instead of being asked of a model — the same arrangement
 * the Mega Drive's player has, and the same one `render()` takes its per-chip
 * gains from (doc 16 §Packages).
 */

import {
  CLOCK_HZ,
  FRAME_HEIGHT,
  FRAME_WIDTH,
  Gba,
  PSG_MIX_GAIN,
  type Button as GbaButton,
} from "@demake/gba";

import type { Player } from "./player.js";

export function boot(rom: Uint8Array): Player {
  const machine = new Gba(rom);
  return {
    width: FRAME_WIDTH,
    height: FRAME_HEIGHT,
    framebuffer: machine.framebuffer,
    chips: [
      {
        get audioSink() {
          return machine.audioSink;
        },
        set audioSink(sink) {
          machine.audioSink = sink;
        },
        apu: machine.psg,
        gain: PSG_MIX_GAIN,
      },
      {
        get audioSink() {
          return machine.pcmSink;
        },
        set audioSink(sink) {
          machine.pcmSink = sink;
        },
        // Not a chip's clock: the converters hold whatever byte the last timer
        // overflow handed them, so what advances them is system cycles.
        apu: { clockHz: CLOCK_HZ },
      },
    ],
    setButtons: (down) => machine.setButtons(down as readonly GbaButton[]),
    // This 2D engine draws when it is *asked* to, not as the beam passes, so a
    // frame has to end with a render — the same shape the Mega Drive's player
    // has, and without it the canvas keeps showing the frame boot drew.
    runFrame: () => {
      machine.runFrame();
      machine.ppu.view();
    },
    readMemory: (address, length) => machine.readMemory(address, length),
  };
}
