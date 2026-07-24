/**
 * Pixel-perfect SG-1000 emulator E2E (doc 10) via libretro / genesis-plus-gx.
 *
 * gen → SG-1000 ROM (WLA-DX / Z80) → boot in genesis-plus-gx (SG-1000 mode) →
 * capture the framebuffer → assert it matches demake's DAC reference, across the
 * same extensive battery every console uses. The SG-1000's TMS9918 Graphics II
 * puts two of the 16 fixed colors on each 8×1 row; the master palette is derived
 * from the core's native RGB565 `tms_palette`, so the comparison is exact in
 * RGB565. Self-skips unless WLA-DX + the libretro runner/core are provisioned
 * (`pnpm toolchains && pnpm emulator`). No Docker.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { gen, getConsole, renderCompliant } from "@demake/core";
import { describe, expect, it } from "vitest";

import { makeNodeEnv } from "../src/env.js";
import { buildSg1000Rom } from "../src/rom/sg1000.js";
import { countMismatches, makeBattery, readPpm, to565 } from "./_emu-battery.js";

const TC = join(homedir(), ".cache", "demake", "toolchains");
const RETRORUN = join(TC, "libretro", "retrorun");
const CORE = join(TC, "libretro", "cores", "genesis_plus_gx_libretro.so");
const FRAMES = 60;

const hasWla = makeNodeEnv().which("wla-z80") !== null && makeNodeEnv().which("wlalink") !== null;
const hasEmu = existsSync(RETRORUN) && existsSync(CORE);
const maybe = hasWla && hasEmu ? it : it.skip;

// The SG-1000 renders the full 256×192 TMS9918 frame.
const CASES = makeBattery(256, 192);

describe("pixel-perfect SG-1000 E2E (needs WLA-DX + libretro/genesis-plus-gx)", () => {
  for (const [name, png] of Object.entries(CASES)) {
    maybe(
      `sg1000/${name}: ROM boots in genesis-plus-gx and matches the DAC reference (RGB565)`,
      async () => {
        const dir = mkdtempSync(join(tmpdir(), "demake-sg1000-e2e-"));
        try {
          // One gen result drives both the ROM and the reference (same prep run).
          const result = await gen(png, {
            console: "sg1000",
            format: "bin",
            symbol: "demake",
            prep: { effort: "fast" },
          });
          const romPath = join(dir, "out.sg");
          writeFileSync(romPath, buildSg1000Rom(makeNodeEnv(), getConsole("sg1000"), result));

          const ppmPath = join(dir, "frame.ppm");
          execFileSync(RETRORUN, [CORE, romPath, String(FRAMES), ppmPath, dir]);
          const frame = readPpm(readFileSync(ppmPath));

          const ref = renderCompliant(result.image, false);
          // Compare in the core's native RGB565 precision.
          expect(countMismatches(frame, ref, to565)).toBe(0);
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      },
      120000,
    );
  }
});
