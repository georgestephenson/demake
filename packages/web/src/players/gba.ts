/**
 * The Game Boy Advance's player — the one console here with nothing to play.
 *
 * `chips` is empty on purpose. This machine has more sound hardware than any
 * other in the set — the Game Boy's four channels *and* two sample channels fed
 * by DMA — but `demake build` emits no driver for it yet, so a cartridge really
 * does have nothing to play. An empty list is what says so; offering the sound
 * control here would be offering a button that does nothing (doc 07 §The ROM
 * pane).
 */

import { FRAME_HEIGHT, FRAME_WIDTH, Gba, type Button as GbaButton } from "@demake/gba";

import type { Player } from "./player.js";

export function boot(rom: Uint8Array): Player {
  const machine = new Gba(rom);
  return {
    width: FRAME_WIDTH,
    height: FRAME_HEIGHT,
    framebuffer: machine.framebuffer,
    chips: [],
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
