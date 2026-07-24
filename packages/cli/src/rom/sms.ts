/**
 * `sms` family ROM building (doc 06 §ROM building, doc 10).
 *
 * Assembles the Master System / Game Gear harness around the generated tiles /
 * name table / palette blobs with the local WLA-DX (`wla-z80` → `wlalink`). The
 * image name table is placed top-left into a full 32-wide screen the harness
 * uploads to VRAM $3800. Missing toolchain yields a clear `E_TOOLCHAIN_MISSING`.
 */

import { join } from "node:path";

import type { ConsoleSpec, GenResult, TileLayout } from "@demake/core";

import type { CliEnv } from "../env.js";
import { EXIT } from "../exit-codes.js";
import { CliError } from "../io.js";

const WLA_TOOLS = ["wla-z80", "wlalink"] as const;
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
  if (!art) throw new CliError(EXIT.INTERNAL, "E_INTERNAL", `sms gen missing ${suffix}`);
  return art.bytes;
}

/** Build a `.sms`/`.gg` from the SMS-family `bin` artifacts. */
export function buildSmsRom(env: CliEnv, spec: ConsoleSpec, result: GenResult): Uint8Array {
  requireToolchain(env);

  const harnessRoot = env.harnessDir();
  if (!harnessRoot) {
    throw new CliError(EXIT.INTERNAL, "E_HARNESS_MISSING", "could not locate rom-harness/");
  }
  const smsDir = join(harnessRoot, "sms");
  let main: Uint8Array;
  let link: Uint8Array;
  try {
    main = env.readFile(join(smsDir, "main.asm"));
    link = env.readFile(join(smsDir, "link"));
  } catch {
    throw new CliError(
      EXIT.INTERNAL,
      "E_HARNESS_MISSING",
      `cannot read the SMS harness in ${smsDir}`,
    );
  }

  // Place the image name table into a full 32-wide screen (2 bytes/entry). The
  // VDP always renders a 256×192 frame; a console whose display is a windowed
  // crop of that (the Game Gear's 160×144 LCD) shows only the central region, so
  // the image is offset into the name table by the crop margin ((VDP−display)/2,
  // in tiles) to land at the visible window's top-left. The SMS is full-frame, so
  // its margin is zero and the image stays top-left.
  const VDP_W = 256;
  const VDP_H = 192;
  const map = blob(result, ".map.bin");
  const layout = spec.layout as TileLayout;
  const tilesX = result.image.width / layout.tileW;
  const tilesY = result.image.height / layout.tileH;
  const offX = Math.floor((VDP_W - spec.display.width) / 2 / layout.tileW);
  const offY = Math.floor((VDP_H - spec.display.height) / 2 / layout.tileH);
  const screen = new Uint8Array(32 * (offY + tilesY) * 2);
  for (let ty = 0; ty < tilesY; ty += 1) {
    for (let tx = 0; tx < tilesX; tx += 1) {
      const s = (ty * tilesX + tx) * 2;
      const d = ((ty + offY) * 32 + (tx + offX)) * 2;
      screen[d] = map[s]!;
      screen[d + 1] = map[s + 1]!;
    }
  }

  const dir = env.makeTempDir("demake-sms-");
  try {
    env.writeFileAtomic(join(dir, "tiles.bin"), blob(result, ".tiles.bin"), true);
    env.writeFileAtomic(join(dir, "pal.bin"), blob(result, ".pal.bin"), true);
    env.writeFileAtomic(join(dir, "screen.bin"), screen, true);
    env.writeFileAtomic(join(dir, "main.asm"), main, true);
    env.writeFileAtomic(join(dir, "link"), link, true);

    runStep(env, dir, "wla-z80", ["-o", "main.o", "main.asm"]);
    runStep(env, dir, "wlalink", ["link", "out.sms"]);
    return env.readFile(join(dir, "out.sms"));
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
