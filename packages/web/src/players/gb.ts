/** The Game Boy family's player: a DMG, a Game Boy Color and a Mega Duck. */

import { Gameboy, SCREEN_HEIGHT, SCREEN_WIDTH, type Button } from "@demake/dmg";

import type { Player } from "./player.js";

export function boot(rom: Uint8Array, consoleId: string): Player {
  // The one place the console id is needed rather than the family, and the
  // reason is the absence of a fact rather than a preference: a Mega Duck
  // cartridge has no header at all, so unlike the two Game Boys (whose CGB flag
  // decides) and the two Sega machines (whose region nibble does), there is
  // nothing in these bytes to read it out of.
  const machine = new Gameboy(rom, consoleId === "megaduck" ? "megaduck" : "gameboy");
  return {
    width: SCREEN_WIDTH,
    height: SCREEN_HEIGHT,
    framebuffer: machine.framebuffer,
    chips: [machine],
    setButtons: (down) => machine.setButtons(down as readonly Button[]),
    runFrame: () => void machine.runFrame(),
    readMemory: (address, length) => machine.readMemory(address, length),
  };
}
