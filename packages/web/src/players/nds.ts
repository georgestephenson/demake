/**
 * The Nintendo DS's player — the same emitter's cartridge on a bigger screen.
 *
 * `chips` is empty on purpose. This console has sixteen sample channels and they
 * are the **ARM7's**, not the processor a demade game runs on — so playing them
 * needs a driver for a second processor, which does not exist yet (doc 13 §D4).
 * An empty list is what says so; offering the sound control here would be
 * offering a button that does nothing (doc 07 §The ROM pane).
 */

import { FRAME_HEIGHT, FRAME_WIDTH, Nds, type Button as NdsButton } from "@demake/nds";

import type { Player } from "./player.js";

export function boot(rom: Uint8Array): Player {
  const machine = new Nds(rom);
  return {
    width: FRAME_WIDTH,
    height: FRAME_HEIGHT,
    framebuffer: machine.framebuffer,
    chips: [],
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
