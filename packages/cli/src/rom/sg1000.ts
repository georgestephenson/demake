/**
 * `sg1000` family ROM building (doc 06 §ROM building, doc 10).
 *
 * Assembles the SG-1000 harness around the generated TMS9918 Graphics II pattern
 * and color tables with the local WLA-DX (`wla-z80` → `wlalink`). The per-tile
 * blobs (row-major image order) are arranged here into the VDP's three 256-tile
 * banks and a companion name table, so a byte copy reproduces them in VRAM.
 * Missing toolchain yields a clear `E_TOOLCHAIN_MISSING`.
 */

import { join } from "node:path";

import type { ConsoleSpec, GenResult } from "@demake/core";

import type { CliEnv } from "../env.js";
import { EXIT } from "../exit-codes.js";
import { CliError } from "../io.js";

const WLA_TOOLS = ["wla-z80", "wlalink"] as const;
const BANK = 2048; // one VRAM third: 256 tiles × 8 bytes
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
  if (!art) throw new CliError(EXIT.INTERNAL, "E_INTERNAL", `sg1000 gen missing ${suffix}`);
  return art.bytes;
}

/** Build a `.sg` from the SG-1000-family `bin` artifacts. */
export function buildSg1000Rom(env: CliEnv, _spec: ConsoleSpec, result: GenResult): Uint8Array {
  requireToolchain(env);

  const harnessRoot = env.harnessDir();
  if (!harnessRoot) {
    throw new CliError(EXIT.INTERNAL, "E_HARNESS_MISSING", "could not locate rom-harness/");
  }
  const dirName = join(harnessRoot, "sg1000");
  let main: Uint8Array;
  let link: Uint8Array;
  try {
    main = env.readFile(join(dirName, "main.asm"));
    link = env.readFile(join(dirName, "link"));
  } catch {
    throw new CliError(
      EXIT.INTERNAL,
      "E_HARNESS_MISSING",
      `cannot read the SG-1000 harness in ${dirName}`,
    );
  }

  // Arrange the row-major per-tile blobs into three 256-tile VRAM banks (the
  // TMS9918 Graphics II thirds) plus the standard bitmap name table. Screen cell
  // (tc, tr) lives in third tr>>3 at slot (tr&7)*32+tc; the image is top-left.
  const pattern = blob(result, ".pattern.bin");
  const color = blob(result, ".color.bin");
  const tilesX = result.image.width / 8;
  const tileRows = result.image.height / 8;

  const vramPattern = new Uint8Array(3 * BANK);
  const vramColor = new Uint8Array(3 * BANK);
  const name = new Uint8Array(768);
  for (let tr = 0; tr < tileRows; tr += 1) {
    for (let tc = 0; tc < tilesX; tc += 1) {
      const src = (tr * tilesX + tc) * 8;
      const slot = (tr & 7) * 32 + tc;
      const dst = (tr >> 3) * BANK + slot * 8;
      vramPattern.set(pattern.subarray(src, src + 8), dst);
      vramColor.set(color.subarray(src, src + 8), dst);
      name[tr * 32 + tc] = slot;
    }
  }

  const dir = env.makeTempDir("demake-sg1000-");
  try {
    env.writeFileAtomic(join(dir, "pattern.bin"), vramPattern, true);
    env.writeFileAtomic(join(dir, "color.bin"), vramColor, true);
    env.writeFileAtomic(join(dir, "name.bin"), name, true);
    env.writeFileAtomic(join(dir, "main.asm"), main, true);
    env.writeFileAtomic(join(dir, "link"), link, true);

    runStep(env, dir, "wla-z80", ["-o", "main.o", "main.asm"]);
    runStep(env, dir, "wlalink", ["link", "out.sg"]);
    return env.readFile(join(dir, "out.sg"));
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
