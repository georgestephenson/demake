/**
 * The two machines this backend builds for, as a description rather than a
 * branch.
 *
 * A WonderSwan and a WonderSwan Color are one processor, one display controller,
 * one screen map format, one object table format and one sound chip. Bandai
 * built the second as the first with more memory and a colour path bolted on —
 * it is how one machine runs the other's cartridges — so this is a *variant* on
 * the terms AGENTS.md §How to add a console sets out, alongside the Game Gear on
 * the Master System's family, the Mega Duck on the Game Boy's and the Nintendo
 * DS on the Game Boy Advance's. The rule that decides it is the Mega Duck's: if
 * you find yourself copying an emitter, you are writing the wrong one of the two.
 *
 * So what is here is every place the mono machine differs, and there are four:
 *
 *   - **How much memory there is.** Sixteen kilobytes against sixty-four, and
 *     the top half of the sixteen is the tile bank — so every address in this
 *     plan moves, and the heap is a quarter what the colour machine's is.
 *   - **What a tile is.** Planar 2bpp, sixteen bytes, at `$2000`; against packed
 *     4bpp, thirty-two bytes, at `$4000`. That is a fact about the *art path*
 *     and the boot copy's length, not about any instruction.
 *   - **Where a palette is.** The colour machine has palette RAM at `$FE00` and
 *     a scene block-copies five hundred and twelve bytes into it. The mono one
 *     has thirty-six *ports* — four for the shade pool at `$1C`–`$1F` and
 *     thirty-two for the palettes at `$20`–`$3F` — so a scene writes a run of
 *     ports instead. Same bytes in the cartridge, a different destination.
 *   - **What the cartridge says it needs.** The footer's minimum-system byte is
 *     0 for a cartridge a mono console can run and 1 for one it cannot, which is
 *     the `$C0` of a Game Boy Color cartridge reached by different hardware.
 *
 * Everything else — every rule, every collision, every tick, every cell written,
 * every object built — is byte-for-byte the same code, and `rom.test.ts` runs
 * the whole example library on both machines to keep it that way. That is the
 * property the Game Boy Color build rests on, and it fails the moment something
 * here becomes a branch in an emitter instead of an entry in this file.
 *
 * Sources: WSdev wiki — Display/IO Ports, Display/Palette, Cartridge.
 */

import { WS_MEMORY, WSC_MEMORY, type MemoryPlan } from "../layout.js";

/** Where everything the display reads lives, on one of the two machines. */
export interface WsRam {
  /** The world: the plane the camera scrolls. Two kilobytes, 2 KiB-aligned. */
  SCR1: number;
  /** The HUD: the plane in front of it, whose scroll never moves. */
  SCR2: number;
  /** What a frame's objects are built into, before the blanking interval. */
  SHADOW: number;
  /** What the display reads — the shadow's destination, 512-byte aligned. */
  OAM: number;
  /** The tile bank, at the address the display controller decodes. */
  TILES: number;
}

/** What this backend needs to know about the machine it is building for. */
export interface WsMachine {
  /** The console id, which is also what the registry and the profile use. */
  id: "wsc" | "ws";
  /** This machine's RAM plan, which the emitter programs the chip with. */
  ram: WsRam;
  /** Where the stack starts, growing down. */
  stackTop: number;
  /** Bytes one tile is: thirty-two packed 4bpp, or sixteen planar 2bpp. */
  tileBytes: number;
  /**
   * What port `$60` is set to, or `undefined` where the port does not exist.
   *
   * A SPHINX needs telling it is in colour mode with sixteen colours a tile and
   * packed tiles; an ASWAN has one arrangement and no register to say so.
   */
  dispMode: number | undefined;
  /**
   * Where a scene's palette block goes: RAM on one machine, ports on the other.
   *
   * Exactly one of these is set. `ram` is a destination address for a block
   * copy; `port` is the first of a run of consecutive ports, written a byte at a
   * time because there is nothing on this bus a block copy could reach.
   */
  palette: { ram: number; bytes: number } | { port: number; bytes: number };
  /** The footer's minimum-system byte: 0 runs on both, 1 needs a Color. */
  minimumSystem: number;
  /** This machine's RAM allocator plan. */
  memory: MemoryPlan;
}

/**
 * Bytes a palette block is on each machine.
 *
 * Sixteen palettes of sixteen RGB444 words on the colour one; four shade-pool
 * bytes and sixteen palettes of four three-bit entries — two entries a byte — on
 * the mono one.
 */
export const WSC_PALETTE_BYTES = 16 * 16 * 2;
export const WS_PALETTE_BYTES = 4 + 16 * 2;

/** The first port of the mono machine's palette block: the shade pool. */
export const WS_PALETTE_PORT = 0x1c;

export const WSC_MACHINE: WsMachine = {
  id: "wsc",
  ram: { SCR1: 0x2000, SCR2: 0x2800, SHADOW: 0x3000, OAM: 0x3200, TILES: 0x4000 },
  stackTop: 0x4000,
  tileBytes: 32,
  // Colour mode, sixteen colours a tile, packed 4bpp — chosen before anything is
  // copied in, so the tiles are decoded in the layout they were emitted in.
  dispMode: 0xe0,
  palette: { ram: 0xfe00, bytes: WSC_PALETTE_BYTES },
  minimumSystem: 1,
  memory: WSC_MEMORY,
};

export const WS_MACHINE: WsMachine = {
  id: "ws",
  ram: { SCR1: 0x1000, SCR2: 0x1800, SHADOW: 0x0c00, OAM: 0x0e00, TILES: 0x2000 },
  stackTop: 0x0c00,
  tileBytes: 16,
  dispMode: undefined,
  palette: { port: WS_PALETTE_PORT, bytes: WS_PALETTE_BYTES },
  minimumSystem: 0,
  memory: WS_MEMORY,
};

/** Every machine this backend builds for, in the order the registry lists them. */
export const WS_MACHINES: readonly WsMachine[] = [WSC_MACHINE, WS_MACHINE];

/** The machine a console id names, or `undefined` for one this backend has not. */
export function machineFor(consoleId: string): WsMachine | undefined {
  return WS_MACHINES.find((machine) => machine.id === consoleId);
}
