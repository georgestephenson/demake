/**
 * The PC Engine's player.
 *
 * This console's sound chip is a PSG, not an APU, so it is adapted rather than
 * renamed — the core keeps calling it what it is. What it plays is the
 * cartridge's own generated HuC6280 driver, through the same `StreamSink` every
 * other console uses.
 */

import { Pce, SCREEN_HEIGHT, SCREEN_WIDTH, type Button as PceButton } from "@demake/pce";

import type { Player } from "./player.js";

/** The abstract set to this pad's own names: I, II and Run. */
const MAP: Readonly<Record<string, PceButton>> = { a: "i", b: "ii", start: "run" };

export function boot(rom: Uint8Array): Player {
  const machine = new Pce(rom);
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
        apu: machine.psg,
      },
    ],
    setButtons: (down) => machine.setButtons(down.map((name) => MAP[name] ?? (name as PceButton))),
    runFrame: () => void machine.runFrame(),
    readMemory: (address, length) => machine.readMemory(address, length),
  };
}
