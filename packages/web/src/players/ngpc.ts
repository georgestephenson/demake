/**
 * The Neo Geo Pocket Color's player.
 *
 * Its sound is a T6W28 — a Master System's four voices with two attenuators
 * apiece, one a side — and what plays it is the cartridge's own generated
 * TLCS-900/H driver, through the same `StreamSink` every other console uses. The
 * chip reaches the pane the way every other core's does, and the one thing
 * unusual about it is invisible from here: on this machine the chip belongs to a
 * Z80 sound processor until the cartridge asks for it.
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
    chips: [
      {
        get audioSink() {
          return machine.audioSink;
        },
        set audioSink(sink) {
          machine.audioSink = sink;
        },
        apu: machine.sound,
      },
    ],
    setButtons: (down) => machine.setButtons(down as NgpButton[]),
    runFrame: () => void machine.runFrame(),
    readMemory: (address, length) => machine.readMemory(address, length),
  };
}
