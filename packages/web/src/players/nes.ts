/** The NES's player. */

import { Nes, SCREEN_HEIGHT, SCREEN_WIDTH, type Button as NesButton } from "@demake/nes";

import type { Player } from "./player.js";

export function boot(rom: Uint8Array): Player {
  const machine = new Nes(rom);
  return {
    width: SCREEN_WIDTH,
    height: SCREEN_HEIGHT,
    framebuffer: machine.framebuffer,
    chips: [machine],
    setButtons: (down) => machine.setButtons(down as readonly NesButton[]),
    runFrame: () => void machine.runFrame(),
    readMemory: (address, length) => machine.readMemory(address, length),
  };
}
