/**
 * The two machines this backend builds for, as a description rather than a
 * branch.
 *
 * A Nintendo DS's 2D engine A **is** a Game Boy Advance's: the same mode-0 text
 * backgrounds at the same register offsets, the same screen entries, the same
 * 4bpp and 256-colour characters, the same object attributes, the same DMA word.
 * Nintendo built it that way — it is how one machine runs the other's cartridges
 * — so this is a *variant* on the terms AGENTS.md §How to add a console sets
 * out, alongside the Game Gear on the Master System's family and the Mega Duck
 * on the Game Boy's. The rule that decides it is the one the Mega Duck settled:
 * if you find yourself copying an emitter, you are writing the wrong one of the
 * two.
 *
 * So what is here is every place the second machine differs, and there are only
 * five of them:
 *
 *   - **Where the program lives.** A Game Boy Advance runs from the cartridge
 *     bus with its header interleaved into the first 192 bytes of the code; a
 *     Nintendo DS has no cartridge in its address space at all — the binary is
 *     *copied* into main RAM before anything starts, so the header sits outside
 *     the image the program is assembled at and there is nothing to branch over.
 *   - **Where object characters answer.** One 96 KiB video region with the
 *     objects on top, against two address spaces filled by two video RAM banks.
 *   - **What has to be switched on.** A Game Boy Advance needs its cartridge
 *     wait states set and nothing else; a Nintendo DS needs its LCDs and its 2D
 *     engine powered and two video RAM banks pointed somewhere, or a program
 *     uploads a picture into memory nothing is reading.
 *   - **What `DISPCNT` means.** The low bits are the same; this console adds a
 *     display-mode field that decides whether the engine's output reaches the
 *     screen at all.
 *   - **How the main loop waits for the picture.** The Game Boy Advance takes a
 *     vertical-blank interrupt through the pointer its BIOS reads. The Nintendo
 *     DS's ARM9 reaches its handler through a vector inside data TCM, whose base
 *     is a CP15 setting rather than an address — a machine description this
 *     project would have to get exactly right, for a gain of nothing, since the
 *     main loop is what waits either way. So this one **watches the beam**, which
 *     is what a great deal of software on the console does and what needs no
 *     BIOS at all.
 *
 * Everything else — every rule, every collision, every tick, every cell written
 * — is byte-for-byte the same code, and `rom.test.ts` runs the whole example
 * library on both machines to keep it that way. That is the same property the
 * Game Boy Color build rests on, and it fails the moment something here becomes
 * a branch in an emitter instead of an entry in this file.
 *
 * Sources: GBATEK — *DS Memory Maps*, *DS Video*, *GBA Memory Map*
 * (https://problemkaputt.de/gbatek.htm).
 */

import { GBA_HEADER_SIZE, GBA_ORIGIN, NDS_ARM9_RAM } from "@demake/core";

/** One register a boot writes once, before anything else touches the hardware. */
export interface PowerWrite {
  /** The full address, so a description is readable against GBATEK. */
  at: number;
  value: number;
  /** Halfword unless this says otherwise; the bank controls are byte registers. */
  width: 1 | 2;
}

/** What this backend needs to know about the machine it is building for. */
export interface GbaMachine {
  /** The console id, which is also what the registry and the profile use. */
  id: string;
  /** Where the program is assembled and begins executing. */
  origin: number;
  /**
   * Bytes of the assembled image the cartridge header occupies.
   *
   * Non-zero only where the header is *inside* the program — a Game Boy
   * Advance's first word is a branch over its own 192-byte header, which no
   * other console in the set does. Zero means the wrapper prepends one.
   */
  headerBytes: number;
  /** Where the stack is put, which on both machines the program sets itself. */
  stackTop: number;
  /**
   * Bytes the program itself may occupy.
   *
   * A Game Boy Advance's limit is the cartridge bus — thirty-two megabytes, which
   * is not a limit a demade game can reach. A Nintendo DS's is the *megabyte
   * before its heap*: the binary is copied into main RAM and the allocator starts
   * a megabyte along, so a program that grew past that would be overwritten by
   * its own state rather than refused by a bus.
   */
  codeLimit: number;
  /** Where object character memory answers. */
  objVram: number;
  /** Bits this machine needs in `DISPCNT` beyond the ones both share. */
  dispcntExtra: number;
  /**
   * Whether `DISPCNT` is a word rather than a halfword.
   *
   * The one register whose *width* differs. A halfword store to a Nintendo DS's
   * would leave the display-mode field at zero — the screen blanked — with every
   * other register exactly right, which no trace can see.
   */
  dispcntWide: boolean;
  /** Registers written once at boot, in the order they are written. */
  power: readonly PowerWrite[];
  /**
   * How the main loop learns that a frame has passed.
   *
   * `interrupt` waits on a byte a handler sets; `beam` polls `VCOUNT`. See the
   * file header for why the second machine takes the second one.
   */
  frame: "interrupt" | "beam";
  /** Visible scanlines, which is where the beam enters the blanking interval. */
  visibleLines: number;
}

/** `WAITCNT` as the Game Boy Advance's boot leaves it. */
const GBA_WAITCNT = 0x4317;

export const GBA_MACHINE: GbaMachine = {
  id: "gba",
  origin: GBA_ORIGIN,
  headerBytes: GBA_HEADER_SIZE,
  /** Where a cartridge starts, which nothing here moves. */
  stackTop: 0x03007f00,
  codeLimit: 32 * 1024 * 1024,
  /** The top 32 KiB of the same 96 KiB the backgrounds read. */
  objVram: 0x06010000,
  dispcntExtra: 0,
  dispcntWide: false,
  power: [
    // Three cycles for a first cartridge access and one for a sequential, with
    // the prefetch buffer on. A game's instructions are fetched from the
    // cartridge on every cycle it runs, so this register is the single largest
    // thing a build can do about its own speed — the reset default is five and
    // eight, which is roughly twice as slow.
    { at: 0x04000204, value: GBA_WAITCNT, width: 2 },
  ],
  frame: "interrupt",
  visibleLines: 160,
};

export const NDS_MACHINE: GbaMachine = {
  id: "nds",
  origin: NDS_ARM9_RAM,
  // The header is a 16 KiB region *before* the binary rather than the first
  // bytes of it, so the program is assembled from its first instruction and the
  // wrapper puts the header in front (`core/src/asm/nds-cart.ts`).
  headerBytes: 0,
  // Below the ARM7's binary at `$2380000`, and well above a heap that stops at
  // `$2180000` — so a stack that grew a long way and a heap that grew a long way
  // would still not meet.
  stackTop: 0x0237ff00,
  // The heap starts at `$2100000` and the program at `$2000000`, so this is the
  // gap between them — and it is a *hard* limit rather than a budget, because
  // what a program past it overwrites is the state it is about to read.
  codeLimit: 0x100000,
  /** A second video RAM window, filled by a second bank. */
  objVram: 0x06400000,
  // Display mode 1: the engine's own graphics reach the screen. Zero would blank
  // it, and the other two show a video RAM bank or the capture unit — neither of
  // which a game programs, and both of which `@demake/nds` refuses.
  dispcntExtra: 0x00010000,
  dispcntWide: true,
  power: [
    // The LCDs, both 2D engines, and engine A on the top screen. A cartridge
    // that never writes this is drawing to hardware that is switched off.
    { at: 0x04000304, value: 0x8203, width: 2 },
    // No fade over the whole screen. The reset value is not guaranteed and a
    // fade left on would dim a picture that is otherwise exactly right.
    { at: 0x0400006c, value: 0x0000, width: 2 },
    // Bank A (128 KiB) to background memory at `$6000000`, and bank B to object
    // memory at `$6400000`. Until a bank is pointed somewhere, the address a
    // background reads answers with nothing at all — which is this console's one
    // genuinely new requirement on a build.
    { at: 0x04000240, value: 0x81, width: 1 },
    { at: 0x04000241, value: 0x82, width: 1 },
  ],
  frame: "beam",
  visibleLines: 192,
};

/** Every machine this backend builds for, in the order the registry lists them. */
export const GBA_MACHINES: readonly GbaMachine[] = [GBA_MACHINE, NDS_MACHINE];

/** The machine a console id names, or `undefined` for one this backend has not. */
export function machineFor(consoleId: string): GbaMachine | undefined {
  return GBA_MACHINES.find((machine) => machine.id === consoleId);
}
