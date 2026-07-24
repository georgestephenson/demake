/**
 * Pixel-perfect Nintendo DS emulator E2E (doc 10) via libretro / DeSmuME.
 *
 * gen → NDS ROM (GNU ARM binutils + demake's own cartridge packer) → boot in
 * DeSmuME → capture the framebuffer → assert it matches demake's DAC reference,
 * across the same extensive battery every console family marches through (flat,
 * full-screen gradient + noise, mirror, per-cell palettes, the 8×8 minimum).
 *
 * DeSmuME is the DS core of record here (the doc-13 standing decision between it
 * and melonDS): it direct-boots a cartridge with no BIOS or firmware images, so
 * the harness is reproducible from source on any machine. It renders into a
 * 16-bit framebuffer and widens the DS's RGB555 green with a plain shift, so the
 * comparison is in RGB555 — the console's own color depth. The captured frame
 * holds both screens stacked; the harness puts engine A on the top one, which is
 * the frame's top-left region. Self-skips unless the ARM binutils + the libretro
 * runner/core are provisioned (`pnpm toolchains && pnpm emulator`). No Docker.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { gen, getConsole, renderCompliant } from "@demake/core";
import { describe, expect, it } from "vitest";

import { makeNodeEnv } from "../src/env.js";
import { buildNdsRom } from "../src/rom/nds.js";
import { countMismatches, makeBattery, readPpm, to555 } from "./_emu-battery.js";

const TC = join(homedir(), ".cache", "demake", "toolchains");
const RETRORUN = join(TC, "libretro", "retrorun");
const CORE = join(TC, "libretro", "cores", "desmume_libretro.so");
const FRAMES = 60;

const env = makeNodeEnv();
const hasArm =
  env.which("arm-none-eabi-as") !== null &&
  env.which("arm-none-eabi-ld") !== null &&
  env.which("arm-none-eabi-objcopy") !== null;
const hasEmu = existsSync(RETRORUN) && existsSync(CORE);
const maybe = hasArm && hasEmu ? it : it.skip;

// One DS screen is 256×192; the harness draws the image on the top one.
const CASES = makeBattery(256, 192);

describe("pixel-perfect NDS E2E (needs ARM binutils + libretro/DeSmuME)", () => {
  for (const [name, png] of Object.entries(CASES)) {
    maybe(
      `nds/${name}: ROM boots in DeSmuME and matches the DAC reference (RGB555)`,
      async () => {
        const dir = mkdtempSync(join(tmpdir(), "demake-nds-e2e-"));
        try {
          // One gen result drives both the ROM and the reference (same prep run).
          const result = await gen(png, {
            console: "nds",
            format: "bin",
            symbol: "demake",
            prep: { effort: "fast" },
          });
          const romPath = join(dir, "out.nds");
          writeFileSync(romPath, buildNdsRom(makeNodeEnv(), getConsole("nds"), result));

          const ppmPath = join(dir, "frame.ppm");
          execFileSync(RETRORUN, [CORE, romPath, String(FRAMES), ppmPath, dir]);
          const frame = readPpm(readFileSync(ppmPath));

          const ref = renderCompliant(result.image, false);
          // Compare in RGB555 — the DS's own color depth (see to555).
          expect(countMismatches(frame, ref, to555)).toBe(0);
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      },
      180000,
    );
  }
});
