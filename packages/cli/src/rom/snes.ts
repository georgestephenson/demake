/**
 * `snes` family ROM building (doc 06 §ROM building, doc 10).
 *
 * Assembles the Super Nintendo harness around the generated tiles / tilemap /
 * palette blobs with the local WLA-DX (`wla-65816` → `wlalink`) — the same
 * toolchain the SMS and SG-1000 families use, a different CPU target. The image
 * tilemap is placed top-left into a full 32×32-entry BG1 map so the harness's
 * single DMA to VRAM word $7800 reproduces it. Missing toolchain yields a clear
 * `E_TOOLCHAIN_MISSING`.
 */

import { join } from "node:path";

import type { ConsoleSpec, GenResult, TileLayout } from "@demake/core";

import type { CliEnv } from "../env.js";
import { EXIT } from "../exit-codes.js";
import { CliError } from "../io.js";

const WLA_TOOLS = ["wla-65816", "wlalink"] as const;
const MAP_W = 32; // BG1 tilemap stride (32×32 entries, the harness's BG1SC)
const MAP_H = 32;
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
  if (!art) throw new CliError(EXIT.INTERNAL, "E_INTERNAL", `snes gen missing ${suffix}`);
  return art.bytes;
}

/** Build a `.sfc` from the SNES-family `bin` artifacts. */
export function buildSnesRom(env: CliEnv, spec: ConsoleSpec, result: GenResult): Uint8Array {
  requireToolchain(env);

  const harnessRoot = env.harnessDir();
  if (!harnessRoot) {
    throw new CliError(EXIT.INTERNAL, "E_HARNESS_MISSING", "could not locate rom-harness/");
  }
  const snesDir = join(harnessRoot, "snes");
  let main: Uint8Array;
  let link: Uint8Array;
  try {
    main = env.readFile(join(snesDir, "main.asm"));
    link = env.readFile(join(snesDir, "link"));
  } catch {
    throw new CliError(
      EXIT.INTERNAL,
      "E_HARNESS_MISSING",
      `cannot read the SNES harness in ${snesDir}`,
    );
  }

  // Place the image tilemap top-left into the full 32×32-entry BG1 map. The
  // visible frame is 32×28 cells, so the unused rows are never rendered.
  const map = blob(result, ".map.bin");
  const layout = spec.layout as TileLayout;
  const tilesX = result.image.width / layout.tileW;
  const tilesY = result.image.height / layout.tileH;
  const screen = new Uint8Array(MAP_W * MAP_H * 2);
  for (let ty = 0; ty < tilesY && ty < MAP_H; ty += 1) {
    for (let tx = 0; tx < tilesX && tx < MAP_W; tx += 1) {
      const s = (ty * tilesX + tx) * 2;
      const d = (ty * MAP_W + tx) * 2;
      screen[d] = map[s]!;
      screen[d + 1] = map[s + 1]!;
    }
  }

  const dir = env.makeTempDir("demake-snes-");
  try {
    env.writeFileAtomic(join(dir, "tiles.bin"), blob(result, ".tiles.bin"), true);
    env.writeFileAtomic(join(dir, "pal.bin"), blob(result, ".pal.bin"), true);
    env.writeFileAtomic(join(dir, "screen.bin"), screen, true);
    env.writeFileAtomic(join(dir, "main.asm"), main, true);
    env.writeFileAtomic(join(dir, "link"), link, true);

    runStep(env, dir, "wla-65816", ["-o", "main.o", "main.asm"]);
    runStep(env, dir, "wlalink", ["link", "out.sfc"]);
    return env.readFile(join(dir, "out.sfc"));
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
