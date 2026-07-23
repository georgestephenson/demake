/**
 * `md` family ROM building (doc 06 §ROM building, doc 10).
 *
 * Assembles the Mega Drive / Genesis harness around the generated tiles / plane
 * map / palette blobs with the local GNU m68k binutils (`m68k-linux-gnu-as` →
 * `-ld` → `-objcopy -O binary`). The image plane map is placed top-left into a
 * 64-cell-wide plane-A block (the VDP plane stride the harness configures), so a
 * byte copy to VRAM $C000 reproduces it. Missing toolchain yields a clear
 * `E_TOOLCHAIN_MISSING`.
 */

import { join } from "node:path";

import type { ConsoleSpec, GenResult, TileLayout } from "@demake/core";

import type { CliEnv } from "../env.js";
import { EXIT } from "../exit-codes.js";
import { CliError } from "../io.js";

const AS = "m68k-linux-gnu-as";
const LD = "m68k-linux-gnu-ld";
const OBJCOPY = "m68k-linux-gnu-objcopy";
const PLANE_W = 64; // plane-A stride the harness configures (reg16 = 64×32)
const INSTALL_HINT =
  "install the GNU m68k binutils (run tools/toolchains/install-m68k.sh, or " +
  "`pnpm toolchains`), or emit bin/asm/c and assemble it yourself.";

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
  if (!art) throw new CliError(EXIT.INTERNAL, "E_INTERNAL", `md gen missing ${suffix}`);
  return art.bytes;
}

/** Build a `.md` from the MD-family `bin` artifacts. */
export function buildMdRom(env: CliEnv, spec: ConsoleSpec, result: GenResult): Uint8Array {
  requireToolchain(env);

  const harnessRoot = env.harnessDir();
  if (!harnessRoot) {
    throw new CliError(EXIT.INTERNAL, "E_HARNESS_MISSING", "could not locate rom-harness/");
  }
  const mdDir = join(harnessRoot, "md");
  let main: Uint8Array;
  let link: Uint8Array;
  try {
    main = env.readFile(join(mdDir, "main.s"));
    link = env.readFile(join(mdDir, "link.ld"));
  } catch {
    throw new CliError(
      EXIT.INTERNAL,
      "E_HARNESS_MISSING",
      `cannot read the MD harness in ${mdDir}`,
    );
  }

  // Place the plane map top-left into a 64-cell-wide plane block (2 bytes/entry).
  const map = blob(result, ".map.bin");
  const layout = spec.layout as TileLayout;
  const tilesX = result.image.width / layout.tileW;
  const tilesY = result.image.height / layout.tileH;
  const screen = new Uint8Array(PLANE_W * tilesY * 2);
  for (let ty = 0; ty < tilesY; ty += 1) {
    for (let tx = 0; tx < tilesX; tx += 1) {
      const s = (ty * tilesX + tx) * 2;
      const d = (ty * PLANE_W + tx) * 2;
      screen[d] = map[s]!;
      screen[d + 1] = map[s + 1]!;
    }
  }

  const dir = env.makeTempDir("demake-md-");
  try {
    env.writeFileAtomic(join(dir, "tiles.bin"), blob(result, ".tiles.bin"), true);
    env.writeFileAtomic(join(dir, "pal.bin"), blob(result, ".pal.bin"), true);
    env.writeFileAtomic(join(dir, "screen.bin"), screen, true);
    env.writeFileAtomic(join(dir, "main.s"), main, true);
    env.writeFileAtomic(join(dir, "link.ld"), link, true);

    runStep(env, dir, AS, ["-m68000", "main.s", "-o", "main.o"]);
    runStep(env, dir, LD, ["-T", "link.ld", "main.o", "-o", "main.elf"]);
    runStep(env, dir, OBJCOPY, ["-O", "binary", "main.elf", "out.md"]);
    return padRom(env.readFile(join(dir, "out.md")));
  } finally {
    env.removeDir(dir);
  }
}

/** Pad the raw image up to the next power-of-two ≥ 128 KiB (a valid cart size). */
function padRom(rom: Uint8Array): Uint8Array {
  let size = 1 << 17; // 128 KiB
  while (size < rom.length) size <<= 1;
  if (size === rom.length) return rom;
  const out = new Uint8Array(size);
  out.set(rom);
  return out;
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
