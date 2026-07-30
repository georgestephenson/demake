/**
 * Boot a cartridge in the core its console needs — fetching that core first.
 *
 * The family comes with the cartridge rather than being looked up here: which
 * consoles have a backend is `codegen/registry.ts`'s one list, and the page
 * reads it through the worker like everything else it knows about the engine.
 *
 * Every core is behind an `import()`, so a visitor downloads the one machine
 * they are playing rather than all five. That is the same split the engine's
 * emitters got and it is worth more here, because a core is a processor, a video
 * chip and at least one sound chip — and the Super Nintendo's is two processors.
 */

import type { Player } from "./player.js";

export { screenFor, SCREENS, type PadButton, type Player } from "./player.js";

export async function bootPlayer(
  rom: Uint8Array,
  family: string,
  consoleId: string,
): Promise<Player> {
  switch (family) {
    case "nes":
      return (await import("./nes.js")).boot(rom);
    case "sms":
      return (await import("./sms.js")).boot(rom);
    case "snes":
      return (await import("./snes.js")).boot(rom);
    case "md":
      return (await import("./md.js")).boot(rom);
    default:
      return (await import("./gb.js")).boot(rom, consoleId);
  }
}
