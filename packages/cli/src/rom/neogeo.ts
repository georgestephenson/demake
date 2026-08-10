/**
 * `neogeo` family ROM building (doc 06 §ROM building, doc 10).
 *
 * Assembles the Neo Geo harness with the local GNU m68k binutils — the same
 * toolchain the Mega Drive family uses, because it is the same processor — and
 * packs the result into a `.neo` container, which is the documented single-file
 * arrangement a board's four separate ROMs ship in.
 *
 * Four things the portable `gen` blobs do not know are applied here, and all
 * four are consequences of the one fact that makes this console cheap: **there
 * is no tilemap, and the playfield is sprites.**
 *
 *   - **The picture is strips.** A sprite is a vertical column of 16×16 tiles
 *     whose numbers live in a 64-word SCB1 table, so the `gen` map — which is
 *     row-major, like every other console's — is transposed into one table per
 *     column here. That transposition is this file's whole share of the
 *     hardware's strangeness.
 *   - **The strips are chained.** Only the leftmost carries a position; every
 *     one after it is *sticky* and is drawn sixteen pixels to the right of its
 *     neighbour, so a picture's placement is two words however wide it is.
 *   - **Tiles are not uploaded.** The video hardware reads them from the
 *     cartridge's C ROM pair, so `gen`'s two character blobs go into the
 *     container untouched and no part of this program copies them anywhere.
 *   - **The fix layer needs a tile.** It draws in front of every sprite, and its
 *     source is the cartridge's S ROM; a blank tile 0 is emitted so the map the
 *     program clears shows nothing rather than reading past the region.
 *
 * The machine constants the harness needs are *generated* into `plane.s` from
 * `core/src/asm/neo-lspc.ts` rather than written in the harness, for the reason
 * that file states: three things need those numbers, and a hardware fact
 * restated is a fact that disagrees in one entry in one of them.
 */

import { join } from "node:path";

import {
  encodeScb3,
  encodeScb4,
  packNeoFix,
  packNeoHeader,
  packNeoRom,
  NEO_BACKDROP_ENTRY,
  NEO_CODE_ORIGIN,
  NEO_FIRST_SPRITE,
  NEO_FIX_COLUMNS,
  NEO_FIX_MAP,
  NEO_FIX_ROWS,
  NEO_SCB1,
  NEO_SCB1_STRIDE,
  NEO_SCB2,
  NEO_SCB2_FULL,
  NEO_SCB3,
  NEO_SCB4,
  type ConsoleSpec,
  type GenResult,
} from "@demake/core";

import type { CliEnv } from "../env.js";
import { EXIT } from "../exit-codes.js";
import { CliError } from "../io.js";

const AS = "m68k-linux-gnu-as";
const LD = "m68k-linux-gnu-ld";
const OBJCOPY = "m68k-linux-gnu-objcopy";
const INSTALL_HINT =
  "install the GNU m68k binutils (run tools/toolchains/install-m68k.sh, or " +
  "`pnpm toolchains`), or emit bin/asm/c and assemble it yourself.";

/** Pixels a hardware tile is on a side. */
const HW_TILE = 16;
/** Rows of SCB1 one sprite has, of the 32 the hardware reads. */
const STRIP_ROWS = 32;
/**
 * The regions a Neo Geo board really carries, which is what each is padded to.
 *
 * A display program is a few kilobytes and a picture's tiles are a few tens, but
 * a cartridge is a set of *mask ROMs* — and this is the one console in the set
 * where the hardware reads past what a program uses: the fix layer's tile field
 * is twelve bits whatever the map holds, and the 68000's fixed bank is a
 * megabyte whatever a program is. So these are the smallest boards this console
 * shipped with rather than the smallest files that boot, which is the elastic
 * cartridge rule (doc 14) meeting hardware that indexes rather than addresses.
 */
const P_BYTES = 0x80000;
const S_BYTES = 0x20000;
const C_MIN_BYTES = 0x80000;

/** Where this program puts its stack: the top of work RAM, kept even. */
const STACK_TOP = 0x10f300;
/** Palette RAM in the 68000's map — ordinary memory here, not a port. */
const PALETTE_BASE = 0x400000;
/** The LSPC's ports, and the two byte-writes whose *address* is the command. */
const LSPC_ADDRESS = 0x3c0000;
const LSPC_DATA = 0x3c0002;
const LSPC_MODULO = 0x3c0004;
const WATCHDOG = 0x300001;
const REG_PALBANK0 = 0x3a001f;
const REG_CRTFIX = 0x3a001b;

function requireToolchain(env: CliEnv): void {
  for (const tool of [AS, LD, OBJCOPY]) {
    if (!env.which(tool)) {
      throw new CliError(
        EXIT.UNAVAILABLE,
        "E_TOOLCHAIN_MISSING",
        `m68k tool '${tool}' is not on PATH`,
        INSTALL_HINT,
      );
    }
  }
}

function blob(result: GenResult, suffix: string): Uint8Array {
  const art = result.artifacts.find((a) => a.suffix === suffix);
  if (!art) throw new CliError(EXIT.INTERNAL, "E_INTERNAL", `neogeo gen missing ${suffix}`);
  return art.bytes;
}

/** ASCII bytes for a generated source file. */
function asciiFile(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i += 1) out[i] = text.charCodeAt(i) & 0x7f;
  return out;
}

/**
 * The machine, as GNU-as `.set` lines.
 *
 * Every value here is `core`'s, including the three SCB words: the anchor's
 * position and height, the sticky word every strip after it takes, and the
 * anchor's X. Writing `(496 - y) << 7` in the harness instead would be a second
 * statement of this console's Y convention.
 */
function planeInclude(strips: number, rows: number, paletteWords: number): string {
  const lines = [
    "| Generated by demake from core/src/asm/neo-lspc.ts — do not edit.",
    `    .set STACK_TOP,    0x${STACK_TOP.toString(16).toUpperCase()}`,
    `    .set PALETTE_BASE, 0x${PALETTE_BASE.toString(16).toUpperCase()}`,
    `    .set BACKDROP,     0x${(PALETTE_BASE + NEO_BACKDROP_ENTRY * 2).toString(16).toUpperCase()}`,
    `    .set LSPC_ADDRESS, 0x${LSPC_ADDRESS.toString(16).toUpperCase()}`,
    `    .set LSPC_DATA,    0x${LSPC_DATA.toString(16).toUpperCase()}`,
    `    .set LSPC_MODULO,  0x${LSPC_MODULO.toString(16).toUpperCase()}`,
    `    .set WATCHDOG,     0x${WATCHDOG.toString(16).toUpperCase()}`,
    `    .set REG_PALBANK0, 0x${REG_PALBANK0.toString(16).toUpperCase()}`,
    `    .set REG_CRTFIX,   0x${REG_CRTFIX.toString(16).toUpperCase()}`,
    `    .set SCB1,         0x${NEO_SCB1.toString(16).toUpperCase()}`,
    `    .set SCB1_STRIDE,  ${NEO_SCB1_STRIDE}`,
    `    .set SCB2,         0x${NEO_SCB2.toString(16).toUpperCase()}`,
    `    .set SCB2_FULL,    0x${NEO_SCB2_FULL.toString(16).toUpperCase()}`,
    `    .set SCB3,         0x${NEO_SCB3.toString(16).toUpperCase()}`,
    `    .set SCB4,         0x${NEO_SCB4.toString(16).toUpperCase()}`,
    `    .set FIX_MAP,      0x${NEO_FIX_MAP.toString(16).toUpperCase()}`,
    `    .set FIX_COLUMNS,  ${NEO_FIX_COLUMNS}`,
    `    .set FIX_ROWS,     ${NEO_FIX_ROWS}`,
    `    .set FIRST_SPRITE, ${NEO_FIRST_SPRITE}`,
    `    .set STRIPS,       ${strips}`,
    `    .set SCB3_ANCHOR,  0x${encodeScb3({ y: 0, sticky: false, height: rows }).toString(16).toUpperCase()}`,
    `    .set SCB3_STICKY,  0x${encodeScb3({ y: 0, sticky: true, height: rows }).toString(16).toUpperCase()}`,
    `    .set SCB4_ANCHOR,  0x${encodeScb4(0).toString(16).toUpperCase()}`,
    `    .set PAL_WORDS,    ${paletteWords}`,
  ];
  return lines.join("\n") + "\n";
}

/** Build a `.neo` from the Neo Geo `bin` artifacts. */
export function buildNeogeoRom(env: CliEnv, spec: ConsoleSpec, result: GenResult): Uint8Array {
  requireToolchain(env);

  const harnessRoot = env.harnessDir();
  if (!harnessRoot) {
    throw new CliError(EXIT.INTERNAL, "E_HARNESS_MISSING", "could not locate rom-harness/");
  }
  const neoDir = join(harnessRoot, "neogeo");
  let main: Uint8Array;
  let link: Uint8Array;
  try {
    main = env.readFile(join(neoDir, "main.s"));
    link = env.readFile(join(neoDir, "link.ld"));
  } catch {
    throw new CliError(
      EXIT.INTERNAL,
      "E_HARNESS_MISSING",
      `cannot read the Neo Geo harness in ${neoDir}`,
    );
  }

  // The picture, transposed from `gen`'s row-major map into one SCB1 table a
  // column — which is what a strip *is*. A table is 32 rows of two words and the
  // picture fills the first `rows` of them; the rest stay zero and are never
  // reached, because the strip's height says how far the hardware reads.
  const map = blob(result, ".map.bin");
  const strips = Math.ceil(result.image.width / HW_TILE);
  const rows = Math.ceil(result.image.height / HW_TILE);
  if (rows > STRIP_ROWS) {
    throw new CliError(
      EXIT.FAILURE,
      "E_ROM_TOO_LARGE",
      `a Neo Geo strip holds ${STRIP_ROWS} tiles and this picture is ${rows} tall`,
      "prep to a smaller size, or emit bin/asm and write a two-strip loader.",
    );
  }
  const scb1 = new Uint8Array(strips * STRIP_ROWS * 4);
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < strips; column += 1) {
      const source = (row * strips + column) * 4;
      const target = (column * STRIP_ROWS + row) * 4;
      scb1.set(map.subarray(source, source + 4), target);
    }
  }

  const dir = env.makeTempDir("demake-neogeo-");
  let program: Uint8Array;
  try {
    env.writeFileAtomic(join(dir, "main.s"), main, true);
    env.writeFileAtomic(join(dir, "link.ld"), link, true);
    const palette = blob(result, ".pal.bin");
    env.writeFileAtomic(
      join(dir, "plane.s"),
      asciiFile(planeInclude(strips, rows, palette.length / 2)),
      true,
    );
    env.writeFileAtomic(join(dir, "pal.bin"), palette, true);
    env.writeFileAtomic(join(dir, "scb1.bin"), scb1, true);

    runStep(env, dir, AS, ["-m68000", "-o", "main.o", "main.s"]);
    runStep(env, dir, LD, ["-T", "link.ld", "-o", "main.elf", "main.o"]);
    runStep(env, dir, OBJCOPY, ["-O", "binary", "main.elf", "main.bin"]);
    // `objcopy -O binary` emits from the lowest section address, which the link
    // script put at $200 — so this is the program body and the header goes in
    // front of it rather than over anything.
    program = env.readFile(join(dir, "main.bin"));
  } finally {
    env.removeDir(dir);
  }

  if (NEO_CODE_ORIGIN + program.length > P_BYTES) {
    throw new CliError(
      EXIT.INTERNAL,
      "E_INTERNAL",
      `the Neo Geo display program is ${program.length} bytes; the P ROM is ${P_BYTES}`,
    );
  }
  const p = new Uint8Array(P_BYTES);
  p.set(
    packNeoHeader(p.length, {
      name: `demake ${spec.id}`,
      // Nothing in this cartridge takes an interrupt: the display program sets
      // the picture up once and then does nothing but kick the watchdog.
      vblank: NEO_CODE_ORIGIN,
      user: NEO_CODE_ORIGIN,
      stack: STACK_TOP,
    }),
    0,
  );
  p.set(program, NEO_CODE_ORIGIN);

  // One blank fix tile, in a region the size the board's chip is: this layer's
  // tile field is twelve bits, so the hardware may index anywhere in 128 KiB
  // whatever the map the program wrote holds.
  const s = new Uint8Array(S_BYTES);
  s.set(packNeoFix(new Uint8Array(64)), 0);

  // The character ROMs are indexed by a *mask* rather than addressed, so each of
  // the pair is a power of two.
  const half = C_MIN_BYTES / 2;
  const plane = (bytes: Uint8Array): Uint8Array => {
    let size = half;
    while (size < bytes.length) size *= 2;
    const out = new Uint8Array(size);
    out.set(bytes, 0);
    return out;
  };
  return packNeoRom(
    { p, s, c1: plane(blob(result, ".c1.bin")), c2: plane(blob(result, ".c2.bin")) },
    { name: `demake ${spec.id}` },
  );
}

function runStep(env: CliEnv, cwd: string, tool: string, args: readonly string[]): void {
  const r = env.run(tool, args, cwd);
  if (r.code !== 0) {
    const detail = (r.stderr || r.stdout).trim().split("\n").slice(0, 4).join("; ");
    throw new CliError(
      EXIT.FAILURE,
      "E_ROM_BUILD_FAILED",
      `${tool} failed (exit ${r.code})${detail ? `: ${detail}` : ""}`,
      "this is likely a harness/toolchain mismatch; please file a bug with the input.",
    );
  }
}
