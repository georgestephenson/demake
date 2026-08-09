/**
 * Boot a cartridge in the core its console needs — fetching that core first.
 *
 * The family comes with the cartridge rather than being looked up here: which
 * consoles have a backend is `codegen/registry.ts`'s one list, and the page
 * reads it through the worker like everything else it knows about the engine.
 *
 * Every core is behind an `import()`, so a visitor downloads the one machine
 * they are playing rather than all eight. That is the same split the engine's
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
    case "pce":
      return (await import("./pce.js")).boot(rom);
    case "ngpc":
      return (await import("./ngpc.js")).boot(rom, consoleId);
    case "vb":
      return (await import("./vb.js")).boot(rom);
    case "wsc":
      // Two machines behind one family again, and here the *core* is the one
      // that has to be told: a WonderSwan and a WonderSwan Color do not differ
      // in anything a cartridge header could record.
      return (await import("./wsc.js")).boot(rom, consoleId);
    case "gba":
      // Two machines behind one family, decided by the console rather than the
      // family: a Nintendo DS runs the same cartridge code on a bigger screen,
      // so it is a second *player* and not a second backend.
      return consoleId === "nds"
        ? (await import("./nds.js")).boot(rom)
        : (await import("./gba.js")).boot(rom);
    default:
      return (await import("./gb.js")).boot(rom, consoleId);
  }
}
