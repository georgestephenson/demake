/**
 * `wsc` family ROM building (doc 06 §ROM building, doc 10).
 *
 * Assembles the WonderSwan Color harness around the generated tile / screen-map
 * / palette blobs with NASM — the V30MZ is an 8086-compatible core, so a stock
 * x86 assembler emitting a flat 16-bit binary is the native tool rather than an
 * approximation. Missing toolchain yields a clear `E_TOOLCHAIN_MISSING`.
 *
 * Three things the portable `gen` blobs do not know are applied here:
 *
 * - The screen map is 32×32 entries whatever the image's shape, and a blank tile
 *   is appended so the cells the image does not cover read as the backdrop.
 * - A cartridge is at least 4 Mbit, and its *last* 64 KiB bank is the one the
 *   V30MZ answers segment $F with after reset. NASM assembles that bank; the
 *   padding in front of it is prepended here.
 * - The footer's checksum is the sum of every ROM byte but the two it lives in,
 *   which can only be computed once the whole cartridge exists.
 */

import { join } from "node:path";

import type { ConsoleSpec, GenResult, TileLayout } from "@demake/core";

import type { CliEnv } from "../env.js";
import { EXIT } from "../exit-codes.js";
import { CliError } from "../io.js";

const NASM = "nasm";
/** Screen-map geometry the harness selects through port $07 (32×32 entries). */
const MAP_W = 32;
const MAP_H = 32;
/** Tiles the display controller holds in bank 0, which is all the harness uses. */
const BANK_TILES = 512;
/** Cartridge size and the bank NASM assembles (the last one). */
const BANK_BYTES = 64 * 1024;
const ROM_BYTES = 512 * 1024;
const INSTALL_HINT =
  "install NASM (run tools/toolchains/install-nasm.sh, or `pnpm toolchains`), " +
  "or emit bin/asm/c and assemble it yourself.";

function requireToolchain(env: CliEnv): void {
  if (!env.which(NASM)) {
    throw new CliError(
      EXIT.UNAVAILABLE,
      "E_TOOLCHAIN_MISSING",
      `'${NASM}' is not on PATH`,
      INSTALL_HINT,
    );
  }
}

function blob(result: GenResult, suffix: string): Uint8Array {
  const art = result.artifacts.find((a) => a.suffix === suffix);
  if (!art) throw new CliError(EXIT.INTERNAL, "E_INTERNAL", `wsc gen missing ${suffix}`);
  return art.bytes;
}

/** Build a `.wsc` from the WonderSwan Color `bin` artifacts. */
export function buildWscRom(env: CliEnv, spec: ConsoleSpec, result: GenResult): Uint8Array {
  requireToolchain(env);

  const harnessRoot = env.harnessDir();
  if (!harnessRoot) {
    throw new CliError(EXIT.INTERNAL, "E_HARNESS_MISSING", "could not locate rom-harness/");
  }
  const wscDir = join(harnessRoot, "wsc");
  let main: Uint8Array;
  try {
    main = env.readFile(join(wscDir, "main.asm"));
  } catch {
    throw new CliError(
      EXIT.INTERNAL,
      "E_HARNESS_MISSING",
      `cannot read the WonderSwan Color harness in ${wscDir}`,
    );
  }

  // Tiles, plus one blank tile for the cells the image does not fill.
  const tiles = blob(result, ".tiles.bin");
  const tileCount = tiles.length / 32;
  if (tileCount + 1 > BANK_TILES) {
    throw new CliError(
      EXIT.FAILURE,
      "E_ROM_TOO_LARGE",
      `WonderSwan Color image needs ${tileCount} tiles; the harness uploads one ${BANK_TILES}-tile bank`,
      "prep to a smaller size, or emit bin/asm and write a two-bank loader.",
    );
  }
  const tileData = new Uint8Array(tiles.length + 32);
  tileData.set(tiles, 0);

  // The screen map: image entries top-left, the blank tile in palette 0 elsewhere.
  const map = blob(result, ".map.bin");
  const layout = spec.layout as TileLayout;
  const tilesX = result.image.width / layout.tileW;
  const tilesY = result.image.height / layout.tileH;
  const screen = new Uint8Array(MAP_W * MAP_H * 2);
  for (let i = 0; i < MAP_W * MAP_H; i += 1) {
    screen[i * 2] = tileCount & 0xff;
    screen[i * 2 + 1] = (tileCount >> 8) & 1;
  }
  for (let ty = 0; ty < tilesY && ty < MAP_H; ty += 1) {
    for (let tx = 0; tx < tilesX && tx < MAP_W; tx += 1) {
      const s = (ty * tilesX + tx) * 2;
      const d = (ty * MAP_W + tx) * 2;
      screen[d] = map[s]!;
      screen[d + 1] = map[s + 1]!;
    }
  }

  const dir = env.makeTempDir("demake-wsc-");
  let bank: Uint8Array;
  try {
    env.writeFileAtomic(join(dir, "tiles.bin"), tileData, true);
    env.writeFileAtomic(join(dir, "screen.bin"), screen, true);
    env.writeFileAtomic(join(dir, "pal.bin"), blob(result, ".pal.bin"), true);
    env.writeFileAtomic(join(dir, "main.asm"), main, true);

    const r = env.run(NASM, ["-f", "bin", "-o", "bank.bin", "main.asm"], dir);
    if (r.code !== 0) {
      const detail = (r.stderr || r.stdout).trim().split("\n").slice(0, 4).join("; ");
      throw new CliError(
        EXIT.FAILURE,
        "E_ROM_BUILD_FAILED",
        `${NASM} failed (exit ${r.code})${detail ? `: ${detail}` : ""}`,
        "this is likely a harness/toolchain mismatch; please file a bug with the input.",
      );
    }
    bank = env.readFile(join(dir, "bank.bin"));
  } finally {
    env.removeDir(dir);
  }

  if (bank.length !== BANK_BYTES) {
    throw new CliError(
      EXIT.INTERNAL,
      "E_INTERNAL",
      `the WonderSwan harness assembled to ${bank.length} bytes, expected ${BANK_BYTES}`,
    );
  }

  // A 4 Mbit cartridge whose last bank is the assembled one; unused space is
  // $FF, the erased state of a mask/flash ROM.
  const rom = new Uint8Array(ROM_BYTES).fill(0xff);
  rom.set(bank, ROM_BYTES - BANK_BYTES);

  // Footer checksum: the sum of every byte except the two it is stored in.
  let sum = 0;
  for (let i = 0; i < ROM_BYTES - 2; i += 1) sum = (sum + rom[i]!) & 0xffff;
  rom[ROM_BYTES - 2] = sum & 0xff;
  rom[ROM_BYTES - 1] = (sum >> 8) & 0xff;
  return rom;
}
