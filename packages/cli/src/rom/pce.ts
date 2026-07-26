/**
 * `pce` family ROM building (doc 06 §ROM building, doc 10).
 *
 * Assembles the PC Engine harness around the generated character / BAT /
 * palette blobs with the local WLA-DX (`wla-huc6280` → `wlalink`) — the same
 * build the SMS, SG-1000 and SNES families use, a fourth CPU target. Missing
 * toolchain yields a clear `E_TOOLCHAIN_MISSING`.
 *
 * Two things the portable `gen` blobs deliberately do not know are applied
 * here, because both are properties of *this* harness's VRAM map rather than of
 * the console:
 *
 * - The HuC6270's BAT is fixed at VRAM word $0000 and the harness gives it
 *   32×32 entries, so the character data starts at word $0400 — character
 *   number 64. That base is added to every BAT entry.
 * - A blank character is appended to the tileset and every BAT cell the image
 *   does not cover points at it, so the area outside the image is the backdrop
 *   color instead of whatever the BAT happens to look like read as pixels.
 */

import { join } from "node:path";

import type { ConsoleSpec, GenResult, TileLayout } from "@demake/core";

import type { CliEnv } from "../env.js";
import { EXIT } from "../exit-codes.js";
import { CliError } from "../io.js";

const WLA_TOOLS = ["wla-huc6280", "wlalink"] as const;
/** BAT geometry the harness selects through MWR (32×32 entries). */
const BAT_W = 32;
const BAT_H = 32;
/** First character number: the 32×32 BAT fills VRAM words $0000–$03FF. */
const CHAR_BASE = (BAT_W * BAT_H) / 16;
/** The contiguous data window the harness maps at $4000–$DFFF (ROM banks 1–5). */
const DATA_WINDOW = 40 * 1024;
const INSTALL_HINT =
  "install WLA-DX (run tools/toolchains/install-wladx.sh, or `pnpm toolchains`), " +
  "or emit bin/asm/c and assemble it yourself.";

function requireToolchain(env: CliEnv): void {
  for (const tool of WLA_TOOLS) {
    if (!env.which(tool)) {
      throw new CliError(
        EXIT.UNAVAILABLE,
        "E_TOOLCHAIN_MISSING",
        `WLA-DX tool '${tool}' is not on PATH`,
        INSTALL_HINT,
      );
    }
  }
}

function blob(result: GenResult, suffix: string): Uint8Array {
  const art = result.artifacts.find((a) => a.suffix === suffix);
  if (!art) throw new CliError(EXIT.INTERNAL, "E_INTERNAL", `pce gen missing ${suffix}`);
  return art.bytes;
}

/** Build a `.pce` from the PC Engine `bin` artifacts. */
export function buildPceRom(env: CliEnv, spec: ConsoleSpec, result: GenResult): Uint8Array {
  requireToolchain(env);

  const harnessRoot = env.harnessDir();
  if (!harnessRoot) {
    throw new CliError(EXIT.INTERNAL, "E_HARNESS_MISSING", "could not locate rom-harness/");
  }
  const pceDir = join(harnessRoot, "pce");
  let main: Uint8Array;
  let link: Uint8Array;
  try {
    main = env.readFile(join(pceDir, "main.asm"));
    link = env.readFile(join(pceDir, "link"));
  } catch {
    throw new CliError(
      EXIT.INTERNAL,
      "E_HARNESS_MISSING",
      `cannot read the PC Engine harness in ${pceDir}`,
    );
  }

  // Characters, plus one blank character for the cells the image does not fill.
  const tiles = blob(result, ".tiles.bin");
  const chars = new Uint8Array(tiles.length + 32);
  chars.set(tiles, 0);
  const blankChar = CHAR_BASE + tiles.length / 32;

  // The BAT: image entries top-left, rebased onto the harness's character base;
  // everything else the blank character in palette 0.
  const map = blob(result, ".map.bin");
  const layout = spec.layout as TileLayout;
  const tilesX = result.image.width / layout.tileW;
  const tilesY = result.image.height / layout.tileH;
  const bat = new Uint8Array(BAT_W * BAT_H * 2);
  for (let i = 0; i < BAT_W * BAT_H; i += 1) {
    bat[i * 2] = blankChar & 0xff;
    bat[i * 2 + 1] = (blankChar >> 8) & 0xff;
  }
  for (let ty = 0; ty < tilesY && ty < BAT_H; ty += 1) {
    for (let tx = 0; tx < tilesX && tx < BAT_W; tx += 1) {
      const s = (ty * tilesX + tx) * 2;
      const word = (map[s]! | (map[s + 1]! << 8)) + CHAR_BASE;
      const d = (ty * BAT_W + tx) * 2;
      bat[d] = word & 0xff;
      bat[d + 1] = (word >> 8) & 0xff;
    }
  }

  const pal = blob(result, ".pal.bin");
  const total = chars.length + bat.length + pal.length;
  if (total > DATA_WINDOW) {
    throw new CliError(
      EXIT.FAILURE,
      "E_ROM_TOO_LARGE",
      `PC Engine data is ${total} bytes; the harness maps a ${DATA_WINDOW}-byte window`,
      "prep to a smaller size, or emit bin/asm and write a bank-switching loader.",
    );
  }

  const dir = env.makeTempDir("demake-pce-");
  try {
    env.writeFileAtomic(join(dir, "tiles.bin"), chars, true);
    env.writeFileAtomic(join(dir, "screen.bin"), bat, true);
    env.writeFileAtomic(join(dir, "pal.bin"), pal, true);
    env.writeFileAtomic(join(dir, "main.asm"), main, true);
    env.writeFileAtomic(join(dir, "link"), link, true);

    runStep(env, dir, "wla-huc6280", ["-o", "main.o", "main.asm"]);
    runStep(env, dir, "wlalink", ["link", "out.pce"]);
    return env.readFile(join(dir, "out.pce"));
  } finally {
    env.removeDir(dir);
  }
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
