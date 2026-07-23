/**
 * Pixel-perfect NES emulator E2E (doc 10) via libretro.
 *
 * The full loop across the same extensive battery every console uses: gen → NROM
 * ROM (cc65) → boot in fceumm (libretro, the accuracy core) → capture the
 * framebuffer → assert it is byte-identical to demake's DAC reference. The core is
 * pointed at demake's master palette (written as `nes.pal` in the system dir), so
 * its output matches `renderCompliant` exactly — the same "calibrate the emulator
 * to the model" approach as the GB E2E. Self-skips unless cc65 + the libretro
 * runner/core are provisioned (`pnpm toolchains && pnpm emulator`). No Docker.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { gen, getConsole, renderCompliant } from "@demake/core";
import { describe, expect, it } from "vitest";

import { makeNodeEnv } from "../src/env.js";
import { buildNesRom } from "../src/rom/nes.js";
import { countMismatches, makeBattery, readPpm } from "./_emu-battery.js";

const TC = join(homedir(), ".cache", "demake", "toolchains");
const RETRORUN = join(TC, "libretro", "retrorun");
const CORE = join(TC, "libretro", "cores", "fceumm_libretro.so");
const FRAMES = 120;

const hasCc65 = makeNodeEnv().which("ca65") !== null && makeNodeEnv().which("ld65") !== null;
const hasEmu = existsSync(RETRORUN) && existsSync(CORE);
const maybe = hasCc65 && hasEmu ? it : it.skip;

// The NES renders the full 256×240 frame (the fitter clips to the ROM's tile budget).
const CASES = makeBattery(256, 240);

/** Write demake's NES master palette as a 192-byte libretro `nes.pal`. */
function writeNesPal(dir: string): void {
  const master = getConsole("nes").color.masterPalette!;
  const pal = new Uint8Array(192);
  master.forEach((c, i) => {
    pal[i * 3] = c.r;
    pal[i * 3 + 1] = c.g;
    pal[i * 3 + 2] = c.b;
  });
  writeFileSync(join(dir, "nes.pal"), pal);
}

describe("pixel-perfect NES E2E (needs cc65 + libretro/fceumm)", () => {
  for (const [name, png] of Object.entries(CASES)) {
    maybe(
      `nes/${name}: NROM boots in fceumm and matches the DAC reference`,
      async () => {
        const dir = mkdtempSync(join(tmpdir(), "demake-nes-e2e-"));
        try {
          // One gen result drives both the ROM and the reference (same prep run).
          const result = await gen(png, {
            console: "nes",
            format: "bin",
            symbol: "demake",
            prep: { effort: "fast" },
          });
          const romPath = join(dir, "out.nes");
          writeFileSync(romPath, buildNesRom(makeNodeEnv(), getConsole("nes"), result));

          writeNesPal(dir);
          const ppmPath = join(dir, "frame.ppm");
          execFileSync(RETRORUN, [
            CORE,
            romPath,
            String(FRAMES),
            ppmPath,
            dir,
            "fceumm_palette=custom",
          ]);
          const frame = readPpm(readFileSync(ppmPath));

          const ref = renderCompliant(result.image, false);
          expect(countMismatches(frame, ref)).toBe(0);
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      },
      120000,
    );
  }
});
