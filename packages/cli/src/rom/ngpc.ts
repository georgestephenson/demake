/**
 * `ngpc` family ROM building (doc 06 §ROM building, doc 10).
 *
 * The second display ROM in this project with **no toolchain behind it**. No
 * distribution ships a TLCS-900/H assembler, so — exactly as the Virtual Boy's
 * builder does for the V810 — this one emits the display program with
 * `@demake/core`'s own {@link Asm900}, the same encoder `demake build` compiles
 * a game with. What that costs is a second opinion on the *assembly*; what it
 * keeps is the opinion that matters, because `ngpc.e2e.test.ts` boots the
 * cartridge in beetle-ngp and compares the picture pixel for pixel.
 *
 * Five things the portable `gen` blobs do not know are applied here:
 *
 *   - **There is no video memory.** The character bank, the palettes, the two
 *     scroll maps and the object table are ordinary addresses, so this program
 *     is four `ldir`s and a run of stores rather than a port protocol.
 *   - **The plane's map is 32×32 whatever the image's shape**, and the cells the
 *     picture does not cover get a blank character appended after it — on *both*
 *     planes, because plane two draws behind plane one and its own cell zero
 *     would otherwise be the picture's first tile.
 *   - **The backdrop is a register, and it is a different palette.** Colour 0 of
 *     a plane palette is transparent, so wherever the fit reached for it what
 *     shows is `BGC`'s entry in the eight-colour background palette — which the
 *     `ngpc` family does not emit, because a game's is a compile-time decision
 *     and a picture's is the fit's. It is read back out of the picture's own
 *     palette block rather than re-encoded here: entry 0 of palette 0 is the
 *     backdrop the family already put there, in the BGR444 the hardware wants.
 *   - **The window is the screen.** `WBA`/`WSI` name the rectangle outside which
 *     the background colour shows, and a display ROM wants all of it.
 *   - **Every object is hidden**, which on this chip is a priority of zero
 *     rather than a link to cut or a position off screen.
 */

import {
  Asm900,
  ngpRomSize,
  packNgpRom,
  t9Abs,
  t9At,
  NGP_BACKGROUND_PALETTE,
  NGP_BGC,
  NGP_CHARACTER_BYTES,
  NGP_CHARACTER_COUNT,
  NGP_CHARACTERS,
  NGP_CONTROL,
  NGP_HEADER_SIZE,
  NGP_MODE,
  NGP_PALETTE,
  NGP_PALETTE_STRIDE,
  NGP_PLANE_COLUMNS,
  NGP_PLANE_PRIORITY,
  NGP_PLANE_ROWS,
  NGP_PLANE1,
  NGP_PLANE2,
  NGP_PO_H,
  NGP_PO_V,
  NGP_RAM_RESERVED,
  NGP_ROM_BASE,
  NGP_S1SO_H,
  NGP_S1SO_V,
  NGP_S2SO_H,
  NGP_S2SO_V,
  NGP_SPRITE_COUNT,
  NGP_SPRITE_PALETTES,
  NGP_SPRITES,
  NGP_WBA_H,
  NGP_WBA_V,
  NGP_WSI_H,
  NGP_WSI_V,
  label,
  type ConsoleSpec,
  type GenResult,
  type TileLayout,
} from "@demake/core";

import type { CliEnv } from "../env.js";
import { EXIT } from "../exit-codes.js";
import { CliError } from "../io.js";

/** Where the program is assembled: the first byte after the header region. */
const CODE_ORIGIN = NGP_ROM_BASE + NGP_HEADER_SIZE;

/** Bytes one plane's map is: 32×32 entries of a word. */
const PLANE_BYTES = NGP_PLANE_COLUMNS * NGP_PLANE_ROWS * 2;

/** Which of the three palette blocks scroll plane one reads (sprites are first). */
const PLANE1_PALETTES = NGP_PALETTE + NGP_PALETTE_STRIDE;

function blob(result: GenResult, suffix: string): Uint8Array {
  const art = result.artifacts.find((a) => a.suffix === suffix);
  if (!art) throw new CliError(EXIT.INTERNAL, "E_INTERNAL", `ngpc gen missing ${suffix}`);
  return art.bytes;
}

/** `ldir` from a cartridge label into an address: this program's only bulk move. */
function copy(asm: Asm900, from: string, to: number, bytes: number): void {
  if (bytes === 0) return;
  asm.ldn("xhl", label(from));
  asm.ldn("xde", to);
  asm.ldn("bc", bytes);
  asm.ldir(t9At("xde"), "b");
}

/** Store a byte at an absolute address, which is most of what a boot does here. */
function poke(asm: Asm900, address: number, value: number): void {
  asm.stmi(t9Abs(address), "b", value);
}

/**
 * Fill a region with a repeated *word*.
 *
 * `ldir` moves rather than fills, so a run of one value is written by seeding
 * the first word and copying the region onto itself one word along — the
 * overlapping-copy idiom, which is exact here because the hardware's block move
 * steps a byte at a time from the low end.
 */
function fillWord(asm: Asm900, at: number, bytes: number, value: number): void {
  asm.stmi(t9Abs(at), "w", value);
  asm.ldn("xhl", at);
  asm.ldn("xde", at + 2);
  asm.ldn("bc", bytes - 2);
  asm.ldir(t9At("xde"), "b");
}

/** Build a `.ngc` from the Neo Geo Pocket Color `bin` artifacts. */
export function buildNgpcRom(_env: CliEnv, spec: ConsoleSpec, result: GenResult): Uint8Array {
  const tiles = blob(result, ".tiles.bin");
  const map = blob(result, ".map.bin");
  const palette = blob(result, ".pal.bin");

  // Tiles, plus one blank character for the cells the picture does not cover.
  const tileCount = tiles.length / NGP_CHARACTER_BYTES;
  if (tileCount + 1 > NGP_CHARACTER_COUNT) {
    throw new CliError(
      EXIT.FAILURE,
      "E_ROM_TOO_LARGE",
      `Neo Geo Pocket Color image needs ${tileCount} characters; the bank holds ${NGP_CHARACTER_COUNT}`,
      "prep to a smaller size, or emit bin/asm and write your own loader.",
    );
  }
  const tileData = new Uint8Array(tiles.length + NGP_CHARACTER_BYTES);
  tileData.set(tiles, 0);

  // The picture's rows, laid into a 32-cell map stride.
  const layout = spec.layout as TileLayout;
  const tilesX = result.image.width / layout.tileW;
  const tilesY = result.image.height / layout.tileH;
  const rows = Math.min(tilesY, NGP_PLANE_ROWS);
  const columns = Math.min(tilesX, NGP_PLANE_COLUMNS);
  const picture = new Uint8Array(rows * NGP_PLANE_COLUMNS * 2);
  for (let ty = 0; ty < rows; ty += 1) {
    for (let tx = 0; tx < columns; tx += 1) {
      const s = (ty * tilesX + tx) * 2;
      const d = (ty * NGP_PLANE_COLUMNS + tx) * 2;
      picture[d] = map[s]!;
      picture[d + 1] = map[s + 1]!;
    }
  }

  const asm = new Asm900(CODE_ORIGIN);
  asm.label("Entry");
  asm.di();
  // The stack grows down from the first byte the boot ROM keeps for itself.
  asm.ldn("xsp", NGP_RAM_RESERVED);

  // The Color's palettes rather than the mono machine's shade tables.
  poke(asm, NGP_MODE, 0x00);

  // The window is the whole screen, and neither layer scrolls.
  poke(asm, NGP_WBA_H, 0);
  poke(asm, NGP_WBA_V, 0);
  poke(asm, NGP_WSI_H, spec.display.width);
  poke(asm, NGP_WSI_V, spec.display.height);
  poke(asm, NGP_PLANE_PRIORITY, 0x00);
  poke(asm, NGP_S1SO_H, 0);
  poke(asm, NGP_S1SO_V, 0);
  poke(asm, NGP_S2SO_H, 0);
  poke(asm, NGP_S2SO_V, 0);
  poke(asm, NGP_PO_H, 0);
  poke(asm, NGP_PO_V, 0);

  copy(asm, "Tiles", NGP_CHARACTERS, tileData.length);
  copy(asm, "Palette", PLANE1_PALETTES, palette.length);

  // The backdrop: entry 0 of palette 0 is what the fit chose, already in this
  // chip's blue-first RGB444. `BGC` bit 7 turns it on and its low three bits
  // pick the entry; `CONTROL` picks the colour outside the window from the same
  // eight, which for a full-screen window is never seen and is set anyway.
  asm.stmi(t9Abs(NGP_BACKGROUND_PALETTE), "w", (palette[0]! | (palette[1]! << 8)) & 0xffff);
  poke(asm, NGP_BGC, 0x80);
  poke(asm, NGP_CONTROL, 0x00);

  // Both planes get the blank character everywhere, and then plane one gets the
  // picture on top. Plane two is behind plane one and is never written again.
  const blank = tileCount & 0x1ff;
  fillWord(asm, NGP_PLANE1, PLANE_BYTES, blank);
  fillWord(asm, NGP_PLANE2, PLANE_BYTES, blank);
  copy(asm, "Picture", NGP_PLANE1, picture.length);

  // A priority of zero is what stops the hardware drawing an object.
  fillWord(asm, NGP_SPRITES, NGP_SPRITE_COUNT * 4, 0);
  fillWord(asm, NGP_SPRITE_PALETTES, NGP_SPRITE_COUNT, 0);

  asm.label("Lock");
  asm.jp(label("Lock"));

  asm.label("Tiles");
  asm.bytes(tileData);
  asm.label("Palette");
  asm.bytes(palette);
  asm.label("Picture");
  asm.bytes(picture);

  const code = asm.assemble();
  return packNgpRom(code, {
    title: "DEMAKE",
    color: true,
    size: ngpRomSize(NGP_HEADER_SIZE + code.length),
  });
}
