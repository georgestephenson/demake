/**
 * `nds` family ROM building (doc 06 §ROM building, doc 10).
 *
 * Assembles the Nintendo DS harness with the local GNU ARM binutils
 * (`arm-none-eabi-as` → `-ld` → `-objcopy -O binary`) and packs the two
 * resulting binaries into a `.nds` cartridge — demake writes the cartridge
 * header itself rather than depending on devkitARM/ndstool, exactly as it writes
 * the GB/NES/MD headers. The packing is `core`'s (`asm/nds-cart.ts`), because
 * the Demotic backend builds the same cartridge out of two programs it generated
 * rather than two it assembled, and a header written twice disagrees once.
 *
 * The image screen entries are placed top-left into a full 32-wide screen block
 * so the harness's flat copy reproduces them in VRAM. Missing toolchain yields a
 * clear `E_TOOLCHAIN_MISSING`.
 */

import { join } from "node:path";

import { packNdsRom, type ConsoleSpec, type GenResult, type TileLayout } from "@demake/core";

import type { CliEnv } from "../env.js";
import { EXIT } from "../exit-codes.js";
import { CliError } from "../io.js";

const AS = "arm-none-eabi-as";
const LD = "arm-none-eabi-ld";
const OBJCOPY = "arm-none-eabi-objcopy";
const MAP_W = 32; // screen-block stride (32×32 entries), the harness's BG0CNT
const MAP_H = 32;
const INSTALL_HINT =
  "install the GNU arm-none-eabi binutils (run tools/toolchains/install-arm.sh, or " +
  "`pnpm toolchains`), or emit bin/asm/c and assemble it yourself.";

function requireToolchain(env: CliEnv): void {
  for (const tool of [AS, LD, OBJCOPY]) {
    if (!env.which(tool)) {
      throw new CliError(
        EXIT.UNAVAILABLE,
        "E_TOOLCHAIN_MISSING",
        `ARM tool '${tool}' is not on PATH`,
        INSTALL_HINT,
      );
    }
  }
}

function blob(result: GenResult, suffix: string): Uint8Array {
  const art = result.artifacts.find((a) => a.suffix === suffix);
  if (!art) throw new CliError(EXIT.INTERNAL, "E_INTERNAL", `nds gen missing ${suffix}`);
  return art.bytes;
}

/** Build a `.nds` from the NDS-family `bin` artifacts. */
export function buildNdsRom(env: CliEnv, spec: ConsoleSpec, result: GenResult): Uint8Array {
  requireToolchain(env);

  const harnessRoot = env.harnessDir();
  if (!harnessRoot) {
    throw new CliError(EXIT.INTERNAL, "E_HARNESS_MISSING", "could not locate rom-harness/");
  }
  const ndsDir = join(harnessRoot, "nds");
  const sources: Record<string, Uint8Array> = {};
  try {
    for (const name of ["arm9.s", "arm9.ld", "arm7.s", "arm7.ld"]) {
      sources[name] = env.readFile(join(ndsDir, name));
    }
  } catch {
    throw new CliError(
      EXIT.INTERNAL,
      "E_HARNESS_MISSING",
      `cannot read the NDS harness in ${ndsDir}`,
    );
  }

  const layout = spec.layout as TileLayout;
  const screen = placeScreen(blob(result, ".map.bin"), result, layout);

  const dir = env.makeTempDir("demake-nds-");
  try {
    env.writeFileAtomic(join(dir, "tiles.bin"), blob(result, ".tiles.bin"), true);
    env.writeFileAtomic(join(dir, "pal.bin"), blob(result, ".pal.bin"), true);
    env.writeFileAtomic(join(dir, "screen.bin"), screen, true);
    for (const [name, bytes] of Object.entries(sources)) {
      env.writeFileAtomic(join(dir, name), bytes, true);
    }

    const arm9 = assemble(env, dir, "arm9", "arm946e-s");
    const arm7 = assemble(env, dir, "arm7", "arm7tdmi");
    return packNdsRom(arm9, arm7);
  } finally {
    env.removeDir(dir);
  }
}

/** Place the image screen entries top-left into the full 32×32-entry block. */
function placeScreen(map: Uint8Array, result: GenResult, layout: TileLayout): Uint8Array {
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
  return screen;
}

/** Assemble + link + objcopy one processor's harness into a flat binary. */
function assemble(env: CliEnv, dir: string, stem: string, cpu: string): Uint8Array {
  runStep(env, dir, AS, [`-mcpu=${cpu}`, `${stem}.s`, "-o", `${stem}.o`]);
  runStep(env, dir, LD, ["-T", `${stem}.ld`, `${stem}.o`, "-o", `${stem}.elf`]);
  runStep(env, dir, OBJCOPY, ["-O", "binary", `${stem}.elf`, `${stem}.bin`]);
  return env.readFile(join(dir, `${stem}.bin`));
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
