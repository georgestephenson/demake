/**
 * The Virtual Boy's player.
 *
 * The only core here that draws **two** pictures, and the only one whose player
 * therefore has to choose. A browser canvas is not a stereoscope, and this
 * display is red-only — so there is no second hue to build an anaglyph out of
 * and no way to show the depth this console's cartridges actually carry. What
 * the pane shows is the **left eye**, which is what every screenshot of this
 * machine has ever been; the depth is still there in the cartridge, and
 * `packages/cli/test/vb.e2e.test.ts` is where it is proved in both eyes against
 * a third-party emulator.
 *
 * There are no chips: this console has no in-game audio driver yet (doc 13
 * §Console rollout item 9), so a cartridge is silent and the pane's sound button
 * has nothing to attach to — which is the honest way to say a machine plays
 * nothing, rather than attaching a chip nobody writes to.
 *
 * `framebuffer` is the array the core refills rather than a fresh one per frame,
 * which is why `runFrame` renders: the pane captures the reference once and
 * reads it after every frame, and this core only fills it when asked.
 */

import { SCREEN_HEIGHT, SCREEN_WIDTH, Vb, type Button as VbButton } from "@demake/vb";

import type { Player } from "./player.js";

export function boot(rom: Uint8Array): Player {
  const machine = new Vb(rom);
  const framebuffer = machine.eye("left");
  return {
    width: SCREEN_WIDTH,
    height: SCREEN_HEIGHT,
    framebuffer,
    chips: [],
    setButtons: (down) => machine.setButtons(down as VbButton[]),
    runFrame: () => {
      machine.runFrame();
      machine.eye("left");
    },
    readMemory: (address, length) => machine.readMemory(address, length),
  };
}
