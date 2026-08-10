/**
 * `vb` family ROM building (doc 06 §ROM building, doc 10).
 *
 * The one display ROM in this project with **no toolchain behind it**. Every
 * other family shells out to an assembler — RGBDS, cc65, WLA-DX, binutils,
 * NASM — because a well-tested one exists for that processor; no distribution
 * ships a V810 assembler, so this builder emits the display program with
 * `@demake/core`'s own {@link Asm810}, exactly as `demake build` emits a game.
 *
 * That is not a weaker proof than the others, and it is worth saying why: the
 * cartridge these bytes make is booted in **beetle-vb** by
 * `packages/cli/test/vb.e2e.test.ts` and compared to the DAC reference pixel for
 * pixel, so an encoder and a decoder of ours that agreed with each other and not
 * with the hardware would still fail. What is lost against, say, the NASM path
 * is a second opinion on the *assembly*; what is kept is the opinion that
 * matters, which is the picture.
 *
 * Four things the portable `gen` blobs do not know are applied here:
 *
 *   - **The display list is the frame.** A picture is one world with the
 *     rectangle the image actually occupies, and a second world that ends the
 *     list — because the drawing processor walks from world 31 downward and
 *     stops nowhere else.
 *   - **The picture is centred**, since a `gen` image may be smaller than the
 *     screen and this console has no border colour but `BKCOL`.
 *   - **Characters go in through the mirror at `$78000`**, which is one loop
 *     rather than four; the four blocks the drawing processor reads have the
 *     framebuffers between them.
 *   - **The brightness registers have to be written**, or the picture is perfect
 *     and the screen is dark. The values are the ones the DAC model in the
 *     console spec was measured against, so this is the one place they are
 *     chosen and `vb.ts`'s ramp is what they mean.
 */

import {
  Asm810,
  packVbRom,
  vbRomSize,
  V810_R0,
  SR_PSW,
  type ConsoleSpec,
  type GenResult,
  VB_BGMAP,
  VB_BKCOL,
  VB_BRIGHTNESS,
  VB_BRTA,
  VB_BRTB,
  VB_BRTC,
  VB_CHR_MIRROR,
  VB_DPCTRL,
  VB_DPCTRL_ON,
  VB_FRMCYC,
  VB_GPLT0,
  VB_INTCLR,
  VB_INTENB,
  VB_REST,
  VB_ROM,
  VB_SCREEN_H,
  VB_SCREEN_W,
  VB_WORLDS,
  VB_WORLD_BYTES,
  VB_WORLD_END,
  VB_WORLD_LON,
  VB_WORLD_RON,
  VB_XPCTRL,
  VB_XP_XPEN,
} from "@demake/core";

import type { CliEnv } from "../env.js";
import { EXIT } from "../exit-codes.js";
import { CliError } from "../io.js";

/** Entries across one BGMap, which is what a row of the map costs. */
const BGMAP_W = 64;

/** The brightness the console spec's ramp was measured at. */

/** Registers the display program uses, named for what they hold. */
const ADDR = 10;
const VALUE = 11;
const SRC = 12;
const COUNT = 13;
const WORD = 14;

function blob(result: GenResult, suffix: string): Uint8Array {
  const art = result.artifacts.find((a) => a.suffix === suffix);
  if (!art) throw new CliError(EXIT.INTERNAL, "E_INTERNAL", `vb gen missing ${suffix}`);
  return art.bytes;
}

/** `st.h value, address` for a constant pair — the display program's whole idiom. */
function poke(asm: Asm810, address: number, value: number): void {
  asm.movImm32(address, ADDR);
  asm.movImm32(value & 0xffff, VALUE);
  asm.sth(VALUE, 0, ADDR);
}

/**
 * Copy `count` halfwords from a label in the cartridge to an address.
 *
 * A loop rather than a run of stores, because a full-screen picture is 1104
 * characters and a store apiece would be a program bigger than the board. The
 * V810 has no block move, so this is four instructions a halfword and there is
 * nothing shorter.
 */
function copyHalfwords(asm: Asm810, from: string, to: number, count: number, tag: string): void {
  asm.movImm32(from, SRC);
  asm.movImm32(to, ADDR);
  asm.movImm32(count, COUNT);
  asm.label(`${tag}Loop`);
  asm.ldh(0, SRC, WORD);
  asm.sth(WORD, 0, ADDR);
  asm.addImm5(2, SRC);
  asm.addImm5(2, ADDR);
  asm.addImm5(-1, COUNT);
  asm.bcond("nz", `${tag}Loop`);
}

/** Build a `.vb` from the Virtual Boy `bin` artifacts. */
export function buildVbRom(_env: CliEnv, spec: ConsoleSpec, result: GenResult): Uint8Array {
  const chars = blob(result, ".chr.bin");
  const map = blob(result, ".map.bin");
  const palette = blob(result, ".pal.bin");

  const width = result.image.width;
  const height = result.image.height;
  const cellsX = Math.ceil(width / 8);
  const cellsY = Math.ceil(height / 8);
  if (cellsX > BGMAP_W || cellsY > BGMAP_W) {
    throw new CliError(
      EXIT.USAGE,
      "E_UNSUPPORTED_OUTPUT",
      `a ${spec.name} BGMap is ${BGMAP_W}x${BGMAP_W} cells; this image needs ${cellsX}x${cellsY}`,
    );
  }

  // `gen` packs the map at the image's own width; the hardware's row is 64
  // entries, so it is re-laid here. Packing it again on the way out would be the
  // Super Nintendo's stride hazard, three consoles along.
  const bgmap = new Uint8Array(BGMAP_W * BGMAP_W * 2);
  for (let row = 0; row < cellsY; row += 1) {
    const from = row * cellsX * 2;
    bgmap.set(map.subarray(from, from + cellsX * 2), (row * BGMAP_W + 0) * 2);
  }

  const asm = new Asm810(VB_ROM);

  // Reset leaves `PSW.NP` set, which masks everything; this program takes no
  // interrupt at all, and clears it so that saying so is a choice rather than an
  // accident of the reset state.
  asm.ldsr(V810_R0, SR_PSW);
  poke(asm, VB_INTENB, 0);
  poke(asm, VB_INTCLR, 0xffff);
  poke(asm, VB_REST, 0);
  poke(asm, VB_FRMCYC, 0);
  poke(asm, VB_XPCTRL, 0);

  copyHalfwords(asm, "Chars", VB_CHR_MIRROR, Math.ceil(chars.length / 2), "Chr");
  copyHalfwords(asm, "Map", VB_BGMAP, bgmap.length / 2, "Map");

  // Four palette bytes, one register each, and then the backdrop — which is the
  // fifth byte of the same blob because on this console it *is* a palette entry:
  // colour 0 is transparent on every layer, so a picture's lightest shade only
  // ever reaches the screen through `BKCOL`. The `gen` family has already
  // reversed all five for this display, so they go in as they come.
  for (let index = 0; index < 4; index += 1) {
    poke(asm, VB_GPLT0 + index * 2, palette[index] ?? 0);
  }
  poke(asm, VB_BKCOL, palette[4] ?? 0);
  poke(asm, VB_BRTA, VB_BRIGHTNESS.a);
  poke(asm, VB_BRTB, VB_BRIGHTNESS.b);
  poke(asm, VB_BRTC, VB_BRIGHTNESS.c);

  // One world for the picture, at the display plane and centred, and one that
  // ends the list.
  const world = VB_WORLDS + 31 * VB_WORLD_BYTES;
  poke(asm, world, VB_WORLD_LON | VB_WORLD_RON);
  poke(asm, world + 2, (VB_SCREEN_W - width) >> 1); // GX
  poke(asm, world + 4, 0); // GP — a still picture is at the screen
  poke(asm, world + 6, (VB_SCREEN_H - height) >> 1); // GY
  poke(asm, world + 8, 0); // MX
  poke(asm, world + 10, 0); // MP
  poke(asm, world + 12, 0); // MY
  poke(asm, world + 14, width - 1); // W
  poke(asm, world + 16, height - 1); // H
  poke(asm, VB_WORLDS + 30 * VB_WORLD_BYTES, VB_WORLD_END);

  poke(asm, VB_XPCTRL, VB_XP_XPEN);
  poke(asm, VB_DPCTRL, VB_DPCTRL_ON);
  asm.label("Idle");
  asm.br("Idle");

  asm.align(4);
  asm.label("Chars");
  asm.bytes(chars);
  if ((chars.length & 1) !== 0) asm.db(0);
  asm.label("Map");
  asm.bytes(bgmap);

  const code = asm.assemble();
  return packVbRom(code, { title: "DEMAKE", code: "DMKE", size: vbRomSize(code.length) });
}
