/**
 * The WonderSwan Color's player.
 *
 * The one console here whose `chips` list is empty, and it is empty for a
 * reason rather than as a stub: this machine has no audio binding and no
 * generated driver (doc 13 §Console rollout item 4), so a demade cartridge
 * makes no sound at all. An empty list is how the pane says that — it takes the
 * sound control away rather than offering one that does nothing.
 *
 * Its pad is a handheld's: two face buttons and a Start, and the four
 * directions are the upper of the two D-pads a landscape game uses.
 */

import { SCREEN_HEIGHT, SCREEN_WIDTH, Wsc, type Button as WscButton } from "@demake/wsc";

import type { Player } from "./player.js";

export function boot(rom: Uint8Array): Player {
  const machine = new Wsc(rom);
  return {
    width: SCREEN_WIDTH,
    height: SCREEN_HEIGHT,
    framebuffer: machine.framebuffer,
    chips: [],
    setButtons: (down) => machine.setButtons(down as WscButton[]),
    runFrame: () => void machine.runFrame(),
    readMemory: (address, length) => machine.readMemory(address, length),
  };
}
