/**
 * Pixel-perfect SNES emulator E2E (doc 10) via libretro / snes9x.
 *
 * gen → SNES ROM (WLA-DX, wla-65816) → boot in snes9x → capture the framebuffer
 * → assert it matches demake's DAC reference, across the same extensive battery
 * every console family marches through (flat, full-screen gradient + noise,
 * mirror, per-cell palettes, the 8×8 minimum). snes9x renders into a 16-bit
 * framebuffer, so the comparison is in the emulator's native RGB565 precision:
 * red and blue are the CGRAM 5-bit codes untouched, green is bit-replicated to 6
 * bits — exactly what demake's `linear` DAC expansion reduces to. Self-skips
 * unless WLA-DX + the libretro runner/core are provisioned (`pnpm toolchains &&
 * pnpm emulator`). No Docker.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { gen, getConsole, renderCompliant } from "@demake/core";
import { describe, expect, it } from "vitest";

import { makeNodeEnv } from "../src/env.js";
import { buildSnesRom } from "../src/rom/snes.js";
import { countMismatches, makeBattery, readPpm, to565 } from "./_emu-battery.js";

const TC = join(homedir(), ".cache", "demake", "toolchains");
const RETRORUN = join(TC, "libretro", "retrorun");
const CORE = join(TC, "libretro", "cores", "snes9x_libretro.so");
const FRAMES = 60;

const env = makeNodeEnv();
const hasWla = env.which("wla-65816") !== null && env.which("wlalink") !== null;
const hasEmu = existsSync(RETRORUN) && existsSync(CORE);
const maybe = hasWla && hasEmu ? it : it.skip;

// The SNES renders the full 256×224 frame.
const CASES = makeBattery(256, 224);

describe("pixel-perfect SNES E2E (needs WLA-DX + libretro/snes9x)", () => {
  for (const [name, png] of Object.entries(CASES)) {
    maybe(
      `snes/${name}: ROM boots in snes9x and matches the DAC reference (RGB565)`,
      async () => {
        const dir = mkdtempSync(join(tmpdir(), "demake-snes-e2e-"));
        try {
          // One gen result drives both the ROM and the reference (same prep run).
          const result = await gen(png, {
            console: "snes",
            format: "bin",
            symbol: "demake",
            prep: { effort: "fast" },
          });
          const romPath = join(dir, "out.sfc");
          writeFileSync(romPath, buildSnesRom(makeNodeEnv(), getConsole("snes"), result));

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
