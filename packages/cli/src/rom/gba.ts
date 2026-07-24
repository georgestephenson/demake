/**
 * `gba` family ROM building (doc 06 §ROM building, doc 10).
 *
 * Assembles the Game Boy Advance harness around the generated tiles / screen
 * entries / palette blobs with the local GNU ARM binutils (`arm-none-eabi-as` →
 * `-ld` → `-objcopy -O binary`) — a stock distro cross-assembler, no devkitARM
 * needed, since the harness is pure assembly and carries its own cartridge
 * header. The image screen entries are placed top-left into a full 32-wide
 * screen block so the harness's flat copy reproduces them in VRAM. Missing
 * toolchain yields a clear `E_TOOLCHAIN_MISSING`.
 */

import { join } from "node:path";

import type { ConsoleSpec, GenResult, TileLayout } from "@demake/core";

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
  if (!art) throw new CliError(EXIT.INTERNAL, "E_INTERNAL", `gba gen missing ${suffix}`);
  return art.bytes;
}

/** Build a `.gba` from the GBA-family `bin` artifacts. */
export function buildGbaRom(env: CliEnv, spec: ConsoleSpec, result: GenResult): Uint8Array {
  requireToolchain(env);

  const harnessRoot = env.harnessDir();
  if (!harnessRoot) {
    throw new CliError(EXIT.INTERNAL, "E_HARNESS_MISSING", "could not locate rom-harness/");
  }
  const gbaDir = join(harnessRoot, "gba");
  let main: Uint8Array;
  let link: Uint8Array;
  try {
    main = env.readFile(join(gbaDir, "main.s"));
    link = env.readFile(join(gbaDir, "link.ld"));
  } catch {
    throw new CliError(
      EXIT.INTERNAL,
      "E_HARNESS_MISSING",
      `cannot read the GBA harness in ${gbaDir}`,
    );
  }

  // Place the image screen entries top-left into the full 32×32-entry block.
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

  const dir = env.makeTempDir("demake-gba-");
  try {
    env.writeFileAtomic(join(dir, "tiles.bin"), blob(result, ".tiles.bin"), true);
    env.writeFileAtomic(join(dir, "pal.bin"), blob(result, ".pal.bin"), true);
    env.writeFileAtomic(join(dir, "screen.bin"), screen, true);
    env.writeFileAtomic(join(dir, "main.s"), main, true);
    env.writeFileAtomic(join(dir, "link.ld"), link, true);

    runStep(env, dir, AS, ["-mcpu=arm7tdmi", "main.s", "-o", "main.o"]);
    runStep(env, dir, LD, ["-T", "link.ld", "main.o", "-o", "main.elf"]);
    runStep(env, dir, OBJCOPY, ["-O", "binary", "main.elf", "out.gba"]);
    return env.readFile(join(dir, "out.gba"));
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
