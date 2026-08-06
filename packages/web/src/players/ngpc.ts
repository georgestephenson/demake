/**
 * The Neo Geo Pocket Color's player.
 *
 * **It has no chip list, and that is the honest answer rather than an
 * oversight.** `@demake/ngp` models no sound yet and `demake build` emits no
 * driver for this console (doc 13 §The order item 6), so a cartridge here is
 * genuinely silent — and an empty list is what says so: the pane offers no sound
 * control at all instead of one that does nothing. The day the ARM7-shaped work
 * for this machine lands (a T6W28 on the bus and a TLCS-900 driver), this is one
 * entry rather than a rewrite.
 *
 * Its pad is a handheld's: two face buttons and an Option, which is the button
 * this console has instead of a Start — so the abstract "start" lands there,
 * exactly as the cartridge's own input routine maps it.
 *
 * It is both Neo Geo Pockets, and which one is the *caller's* rather than the
 * cartridge's — the same arrangement `@demake/wsc` has, for the same reason:
 * these two machines differ only in their palettes, which no header records.
 * Only the Color has a game backend today, so only the Color can be booted here.
 */

import { Ngp, SCREEN_HEIGHT, SCREEN_WIDTH, type Button as NgpButton } from "@demake/ngp";

import type { Player } from "./player.js";

export function boot(rom: Uint8Array, consoleId = "ngpc"): Player {
  const machine = new Ngp(rom, consoleId === "ngp" ? "ngp" : "ngpc");
  return {
    width: SCREEN_WIDTH,
    height: SCREEN_HEIGHT,
    framebuffer: machine.framebuffer,
    chips: [],
    setButtons: (down) => machine.setButtons(down as NgpButton[]),
    runFrame: () => void machine.runFrame(),
    readMemory: (address, length) => machine.readMemory(address, length),
  };
}
