/**
 * Pixel-perfect Game Boy Advance emulator E2E (doc 10) via libretro / mGBA.
 *
 * gen → GBA ROM (GNU ARM binutils) → boot in mGBA → capture the framebuffer →
 * assert it matches demake's DAC reference, across the same extensive battery
 * every console family marches through (flat, full-screen gradient + noise,
 * mirror, per-cell palettes, the 8×8 minimum). mGBA renders 32-bit with its
 * color correction off by default, expanding each RGB555 channel by
 * bit-replication — precisely demake's `linear` DAC — so the comparison is exact
 * in 8-bit, no reduction. Self-skips unless the ARM binutils + the libretro
 * runner/core are provisioned (`pnpm toolchains && pnpm emulator`). No Docker.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { gen, getConsole, renderCompliant } from "@demake/core";
import { describe, expect, it } from "vitest";

import { makeNodeEnv } from "../src/env.js";
import { buildGbaRom } from "../src/rom/gba.js";
import { countMismatches, makeBattery, readPpm, to555 } from "./_emu-battery.js";

const TC = join(homedir(), ".cache", "demake", "toolchains");
const RETRORUN = join(TC, "libretro", "retrorun");
const CORE = join(TC, "libretro", "cores", "mgba_libretro.so");
const FRAMES = 60;

const env = makeNodeEnv();
const hasArm =
  env.which("arm-none-eabi-as") !== null &&
  env.which("arm-none-eabi-ld") !== null &&
  env.which("arm-none-eabi-objcopy") !== null;
const hasEmu = existsSync(RETRORUN) && existsSync(CORE);
const maybe = hasArm && hasEmu ? it : it.skip;

// The GBA renders the full 240×160 frame.
const CASES = makeBattery(240, 160);

describe("pixel-perfect GBA E2E (needs ARM binutils + libretro/mGBA)", () => {
  for (const [name, png] of Object.entries(CASES)) {
    maybe(
      `gba/${name}: ROM boots in mGBA and matches the DAC reference (RGB555)`,
      async () => {
        const dir = mkdtempSync(join(tmpdir(), "demake-gba-e2e-"));
        try {
          // One gen result drives both the ROM and the reference (same prep run).
          const result = await gen(png, {
            console: "gba",
            format: "bin",
            symbol: "demake",
            prep: { effort: "fast" },
          });
          const romPath = join(dir, "out.gba");
          writeFileSync(romPath, buildGbaRom(makeNodeEnv(), getConsole("gba"), result));

          const ppmPath = join(dir, "frame.ppm");
          execFileSync(RETRORUN, [CORE, romPath, String(FRAMES), ppmPath, dir]);
          const frame = readPpm(readFileSync(ppmPath));

          const ref = renderCompliant(result.image, false);
          // Compare in RGB555 — the GBA's own color depth (see to555).
          expect(countMismatches(frame, ref, to555)).toBe(0);
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      },
      120000,
    );
  }
});
