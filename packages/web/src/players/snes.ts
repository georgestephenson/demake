/** The Super Nintendo's player. */

import { SCREEN_HEIGHT, SCREEN_WIDTH, Snes, type Button as SnesButton } from "@demake/snes";

import type { Player } from "./player.js";

export function boot(rom: Uint8Array): Player {
  const machine = new Snes(rom);
  return {
    width: SCREEN_WIDTH,
    height: SCREEN_HEIGHT,
    framebuffer: machine.framebuffer,
    // The sound chip is a second computer's, and the cartridge uploaded its
    // program at boot — so what plays here is the game's own generated SPC700
    // driver, through the same `StreamSink` every other console uses.
    chips: [
      {
        get audioSink() {
          return machine.audioSink;
        },
        set audioSink(sink) {
          machine.audioSink = sink;
        },
        apu: machine.smp.dsp,
      },
    ],
    setButtons: (down) =>
      // This pad's B and Y sit where the NES's A and B sat, which is the mapping
      // every game on it used and the one the cartridge assumes.
      machine.setButtons(
        down.map((name) => (name === "a" ? "b" : name === "b" ? "y" : (name as SnesButton))),
      ),
    runFrame: () => void machine.runFrame(),
    readMemory: (address, length) => machine.readMemory(address, length),
  };
}
