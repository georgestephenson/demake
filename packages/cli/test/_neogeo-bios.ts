/**
 * A Neo Geo system ROM archive, written by demake, for the Neo Geo E2E.
 *
 * geolith will not load a cartridge until it has a *system ROM archive*, which
 * is the one thing on the emulator side of doc 10 that is not simply a build. It
 * is also not a reason to need somebody's dump, and doc 13 §Axis 3 already says
 * why: owning the hand-off turns the question from "can we run somebody else's
 * BIOS" into "what does the hardware do before it gives the cartridge control",
 * and here that is three instructions. The archive's members are read by *name*
 * with no checksum anywhere, so what this file builds is a system ROM of ours —
 * the same three-line hand-off `@demake/neogeo` already implements, assembled
 * with `@demake/core`'s own 68000 encoder.
 *
 * Nothing copyrighted is shipped, reimplemented or needed. A commercial
 * cartridge leans on the system ROM constantly (its font, its soft dips, its
 * coin handling); one this project writes calls none of it, because we author
 * both sides — which is the position `@demake/snes` takes about the S-SMP's boot
 * ROM and `@demake/ngp` about SNK's other console.
 *
 * Two regions go in, and the second is the surprise:
 *
 *   - **`neo-epo.bin`** — the system ROM. The 68000 resets out of *its* first
 *     two longwords, because `$000000`–`$00007F` answers from the system ROM
 *     until a cartridge asks for its own vectors; so this program takes the
 *     stack pointer, switches the vector table over with `REG_SWPROM`, and jumps
 *     to the cartridge's header entry.
 *   - **`000-lo.lo`** — the sprite *shrinking* table, 256 tables of 256 bytes
 *     that map a sprite row to a source row. It is a lookup rather than a
 *     program, and a demade cartridge never shrinks anything: at full height the
 *     mapping is the identity, so that is what this generates, and it is exact
 *     for every sprite this project places.
 */

import { Asm68k, crc32, eaAbs, eaImm, swapNeoProgram } from "@demake/core";

/** Where the system ROM answers the bus, and where its reset vectors are read. */
const BIOS_BASE = 0xc00000;
/** The cartridge header's `JMP USER`, which is where the hand-off lands. */
const USER_ENTRY = 0x122;
/** Writing here points the vector table at the cartridge rather than the BIOS. */
const REG_SWPROM = 0x3a0013;
/** Bytes the system ROM region is; the hardware mirrors it every 128 KiB. */
const BIOS_BYTES = 0x20000;

/**
 * The system ROM: two vectors and three instructions.
 *
 * The reset PC has to be an address inside the system ROM's own window, because
 * that is where these bytes are executing from — the low 128 bytes are a mirror
 * of them and nothing else of the region is mapped down there.
 */
function systemRom(): Uint8Array {
  const rom = new Uint8Array(BIOS_BYTES);
  const asm = new Asm68k(BIOS_BASE + 8);
  asm.label("Boot");
  // Hand the vector table to the cartridge, then enter at its header's `JMP USER`.
  asm.move("b", eaImm(0), eaAbs(REG_SWPROM));
  asm.jmp(USER_ENTRY);
  const code = asm.assemble();

  const view = new DataView(rom.buffer);
  // The stack pointer the cartridge's own first longword names is read by the
  // program this jumps to; the one here only has to be legal work RAM.
  view.setUint32(0x000, 0x0010f300, false);
  view.setUint32(0x004, BIOS_BASE + 8, false);
  rom.set(code, 8);
  // A system ROM is stored byte-swapped, exactly as a P ROM is: the emulator
  // swaps both back at load, so what goes in the archive is `swapNeoProgram`'s
  // output rather than the assembler's.
  return swapNeoProgram(rom);
}

/**
 * The vertical shrinking table.
 *
 * `l0[(vshrink << 8) + row]` answers which source row a sprite row comes from,
 * and at `vshrink = 255` — full height, which is the only value a demade
 * cartridge writes — that is the row itself. The upper nibble is the tile within
 * the strip and the lower one is the line within the tile, so the identity is
 * both the correct answer and the obvious one.
 */
function shrinkTable(): Uint8Array {
  const table = new Uint8Array(0x10000);
  for (let shrink = 0; shrink < 256; shrink += 1) {
    for (let row = 0; row < 256; row += 1) table[shrink * 256 + row] = row;
  }
  return table;
}

/** One stored (uncompressed) member of a zip archive. */
interface Member {
  name: string;
  bytes: Uint8Array;
}

/**
 * A zip archive with stored members.
 *
 * `crc32` is `@demake/core`'s — the PNG codec's own, public precisely so an edge
 * that needs a zip does not implement one beside it (doc 19 §Opening, saving).
 * Members are *stored* rather than deflated because the emulator only has to
 * read this back: a stored member is a length and a checksum.
 */
function zip(members: readonly Member[]): Uint8Array {
  const encoder = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const member of members) {
    const name = encoder.encode(member.name);
    const sum = crc32(member.bytes);
    const local = new Uint8Array(30 + name.length + member.bytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true); // version needed
    lv.setUint16(8, 0, true); // stored
    lv.setUint32(14, sum, true);
    lv.setUint32(18, member.bytes.length, true);
    lv.setUint32(22, member.bytes.length, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);
    local.set(member.bytes, 30 + name.length);
    locals.push(local);

    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(10, 0, true); // stored
    cv.setUint32(16, sum, true);
    cv.setUint32(20, member.bytes.length, true);
    cv.setUint32(24, member.bytes.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    central.set(name, 46);
    centrals.push(central);
    offset += local.length;
  }

  const centralBytes = centrals.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, members.length, true);
  ev.setUint16(10, members.length, true);
  ev.setUint32(12, centralBytes, true);
  ev.setUint32(16, offset, true);

  const total = offset + centralBytes + end.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of [...locals, ...centrals, end]) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/**
 * `aes.zip`, as geolith reads it in AES mode: a system ROM and the shrink table.
 *
 * The MVS archive would additionally want a fix-layer ROM and a sound-program
 * ROM, which is why the E2E asks for the home console: fewer regions, and none
 * of them anything a demade cartridge uses.
 */
export function neogeoBiosZip(): Uint8Array {
  return zip([
    { name: "neo-epo.bin", bytes: systemRom() },
    { name: "000-lo.lo", bytes: shrinkTable() },
  ]);
}
