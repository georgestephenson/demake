/**
 * The PC Engine's player, and the only one here with nothing to listen to.
 *
 * `chips` is empty, and that is the honest answer rather than a placeholder:
 * this console's PSG has no model in `@demake/chip`, so the cartridge a build
 * makes carries no audio driver at all (doc 13 §Console rollout). An empty list
 * is what tells the pane there is nothing to play, so the sound control is
 * absent instead of present and silent.
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
    chips: [],
    setButtons: (down) => machine.setButtons(down.map((name) => MAP[name] ?? (name as PceButton))),
    runFrame: () => void machine.runFrame(),
    readMemory: (address, length) => machine.readMemory(address, length),
  };
}
