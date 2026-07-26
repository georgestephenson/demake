/**
 * Pixel-perfect PC Engine E2E (doc 10) via libretro / beetle-pce-fast.
 *
 * gen → PCE HuCard (WLA-DX huc6280) → boot in mednafen_pce_fast → capture the
 * framebuffer → assert it matches demake's DAC reference, across the same
 * extensive battery the GB family established (flat, full-screen gradient +
 * noise, mirror, per-cell palettes, the 8×8 minimum). The core renders into a
 * 16-bit framebuffer, so the comparison is in its native RGB565 precision. That
 * is exact rather than lenient here: the core expands each 3-bit VCE code as
 * `36 × code` where demake's `expandChannel` replicates bits, and the two agree
 * on every one of the eight codes once reduced to 5:6:5 — the RGB565 field is
 * the whole of what a 9-bit console can distinguish.
 *
 * The captured frame is 256×243 (the core's full vertical window); the harness
 * programs VDS + VSW = 14 so the first active line is the first captured line
 * and the image sits at the frame's top-left, the way every other family's does.
 *
 * Self-skips unless WLA-DX + the libretro runner/core are provisioned
 * (`pnpm toolchains && pnpm emulator`). No Docker.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { gen, getConsole, renderCompliant } from "@demake/core";
import { describe, expect, it } from "vitest";

import { makeNodeEnv } from "../src/env.js";
import { buildPceRom } from "../src/rom/pce.js";
import { countMismatches, makeBattery, readPpm, to565 } from "./_emu-battery.js";

const TC = join(homedir(), ".cache", "demake", "toolchains");
const RETRORUN = join(TC, "libretro", "retrorun");
const CORE = join(TC, "libretro", "cores", "mednafen_pce_fast_libretro.so");
const FRAMES = 60;

const env = makeNodeEnv();
const hasWla = env.which("wla-huc6280") !== null && env.which("wlalink") !== null;
const hasEmu = existsSync(RETRORUN) && existsSync(CORE);
const maybe = hasWla && hasEmu ? it : it.skip;

// The harness drives a 256×224 frame (the console's canonical display).
const CASES = makeBattery(256, 224);

describe("pixel-perfect PC Engine E2E (needs WLA-DX + libretro/beetle-pce-fast)", () => {
  for (const [name, png] of Object.entries(CASES)) {
    maybe(
      `pce/${name}: ROM boots in beetle-pce-fast and matches the DAC reference (RGB565)`,
      async () => {
        const dir = mkdtempSync(join(tmpdir(), "demake-pce-e2e-"));
        try {
          // One gen result drives both the ROM and the reference (same prep run).
          const result = await gen(png, {
            console: "pce",
            format: "bin",
            symbol: "demake",
            prep: { effort: "fast" },
          });
          const romPath = join(dir, "out.pce");
          writeFileSync(romPath, buildPceRom(makeNodeEnv(), getConsole("pce"), result));

          const ppmPath = join(dir, "frame.ppm");
          execFileSync(RETRORUN, [CORE, romPath, String(FRAMES), ppmPath, dir]);
          const frame = readPpm(readFileSync(ppmPath));

          const ref = renderCompliant(result.image, false);
          expect(countMismatches(frame, ref, to565)).toBe(0);
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      },
      120000,
    );
  }
});
