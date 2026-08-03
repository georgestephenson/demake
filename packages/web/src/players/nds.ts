/**
 * The Nintendo DS's player — the same emitter's cartridge on a bigger screen,
 * and the only one here whose sound is on a *second processor*.
 *
 * `chips` names one device and it is not reached through the machine that runs
 * the game: the sixteen channels answer the ARM7 alone, so the cartridge carries
 * a driver for it and what the pane listens to is that processor's output
 * (`@demake/nds`'s `arm7`). One chip, one gain, and no board balance to state —
 * unlike the Game Boy Advance's two, this console's sound is one device.
 */

import { FRAME_HEIGHT, FRAME_WIDTH, Nds, type Button as NdsButton } from "@demake/nds";

import type { Player } from "./player.js";

export function boot(rom: Uint8Array): Player {
  const machine = new Nds(rom);
  return {
    width: FRAME_WIDTH,
    height: FRAME_HEIGHT,
    framebuffer: machine.framebuffer,
    chips: [
      {
        get audioSink() {
          return machine.arm7.audioSink;
        },
        set audioSink(sink) {
          machine.arm7.audioSink = sink;
        },
        apu: machine.arm7.spu,
      },
    ],
    setButtons: (down) => machine.setButtons(down as readonly NdsButton[]),
    // This 2D engine draws when it is *asked* to, not as the beam passes, so a
    // frame has to end with a render — the same shape the Game Boy Advance's
    // player has, because it is the same engine.
    runFrame: () => {
      machine.runFrame();
      machine.ppu.view();
    },
    readMemory: (address, length) => machine.readMemory(address, length),
  };
}
