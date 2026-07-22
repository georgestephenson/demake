/**
 * `nes` family ROM building (doc 06 §ROM building, doc 10).
 *
 * Assembles the NROM harness around the generated CHR / nametable / attribute /
 * palette blobs with the local cc65 (`ca65` → `ld65`). The nametable is placed
 * into a full 32×30 screen followed by its 64-byte attribute table (contiguous
 * in PPU memory), so the harness uploads one 1024-byte block. Missing toolchain
 * yields a clear `E_TOOLCHAIN_MISSING`.
 */

import { join } from "node:path";

import type { ConsoleSpec, GenResult, TileLayout } from "@demake/core";

import type { CliEnv } from "../env.js";
import { EXIT } from "../exit-codes.js";
import { CliError } from "../io.js";

const CC65_TOOLS = ["ca65", "ld65"] as const;
const INSTALL_HINT =
  "install cc65 (run tools/toolchains/install-cc65.sh, or `pnpm toolchains`), " +
  "or emit bin/asm/c and assemble it yourself.";

function requireToolchain(env: CliEnv): void {
  for (const tool of CC65_TOOLS) {
    if (!env.which(tool)) {
      throw new CliError(
        EXIT.UNAVAILABLE,
        "E_TOOLCHAIN_MISSING",
        `cc65 tool '${tool}' is not on PATH`,
        INSTALL_HINT,
      );
    }
  }
}

function blob(result: GenResult, suffix: string): Uint8Array {
  const art = result.artifacts.find((a) => a.suffix === suffix);
  if (!art) throw new CliError(EXIT.INTERNAL, "E_INTERNAL", `nes gen missing ${suffix}`);
  return art.bytes;
}

/** Build a `.nes` (NROM) from the NES `bin` artifacts. */
export function buildNesRom(env: CliEnv, spec: ConsoleSpec, result: GenResult): Uint8Array {
  requireToolchain(env);

  const harnessRoot = env.harnessDir();
  if (!harnessRoot) {
    throw new CliError(EXIT.INTERNAL, "E_HARNESS_MISSING", "could not locate rom-harness/");
  }
  const nesDir = join(harnessRoot, "nes");
  let main: Uint8Array;
  let cfg: Uint8Array;
  try {
    main = env.readFile(join(nesDir, "main.asm"));
    cfg = env.readFile(join(nesDir, "nrom.cfg"));
  } catch {
    throw new CliError(
      EXIT.INTERNAL,
      "E_HARNESS_MISSING",
      `cannot read the NES harness in ${nesDir}`,
    );
  }

  // Place the image nametable top-left into a full 32×30 screen, then append the
  // 64-byte attribute table ($2000..$23FF is contiguous).
  const nam = blob(result, ".nam.bin");
  const attr = blob(result, ".attr.bin");
  const layout = spec.layout as TileLayout;
  const tilesX = result.image.width / layout.tileW;
  const tilesY = result.image.height / layout.tileH;
  const screen = new Uint8Array(1024);
  for (let ty = 0; ty < tilesY; ty += 1) {
    for (let tx = 0; tx < tilesX; tx += 1) screen[ty * 32 + tx] = nam[ty * tilesX + tx]!;
  }
  screen.set(attr, 960);

  const dir = env.makeTempDir("demake-nes-");
  try {
    env.writeFileAtomic(join(dir, "chr.bin"), blob(result, ".chr.bin"), true);
    env.writeFileAtomic(join(dir, "pal.bin"), blob(result, ".pal.bin"), true);
    env.writeFileAtomic(join(dir, "screen.bin"), screen, true);
    env.writeFileAtomic(join(dir, "main.asm"), main, true);
    env.writeFileAtomic(join(dir, "nrom.cfg"), cfg, true);

    runStep(env, dir, "ca65", ["main.asm", "-o", "main.o"]);
    runStep(env, dir, "ld65", ["-C", "nrom.cfg", "main.o", "-o", "out.nes"]);
    return env.readFile(join(dir, "out.nes"));
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
