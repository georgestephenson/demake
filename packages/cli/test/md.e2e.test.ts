/**
 * Pixel-perfect Mega Drive / Genesis emulator E2E (doc 10) via libretro /
 * genesis-plus-gx.
 *
 * gen → MD ROM (GNU m68k binutils) → boot in genesis-plus-gx → capture the
 * framebuffer → assert it matches demake's DAC reference, across the same
 * extensive battery every console uses (flat, full-screen gradient + noise,
 * mirror, per-cell palettes, the 8×8 minimum). genesis-plus-gx renders 16-bit, so
 * the comparison is in native RGB565 — and demake's `md-vdp` DAC reproduces the
 * VDP's exact Mode-5 normal-intensity color, so the two agree. Self-skips unless
 * the m68k binutils + the libretro runner/core are provisioned (`pnpm toolchains
 * && pnpm emulator`). No Docker.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { gen, getConsole, renderCompliant } from "@demake/core";
import { describe, expect, it } from "vitest";

import { makeNodeEnv } from "../src/env.js";
import { buildMdRom } from "../src/rom/md.js";
import { countMismatches, makeBattery, readPpm, to565 } from "./_emu-battery.js";

const TC = join(homedir(), ".cache", "demake", "toolchains");
const RETRORUN = join(TC, "libretro", "retrorun");
const CORE = join(TC, "libretro", "cores", "genesis_plus_gx_libretro.so");
const FRAMES = 60;

const env = makeNodeEnv();
const hasM68k =
  env.which("m68k-linux-gnu-as") !== null &&
  env.which("m68k-linux-gnu-ld") !== null &&
  env.which("m68k-linux-gnu-objcopy") !== null;
const hasEmu = existsSync(RETRORUN) && existsSync(CORE);
const maybe = hasM68k && hasEmu ? it : it.skip;

// The Mega Drive renders the full 320×224 (H40) frame.
const CASES = makeBattery(320, 224);

describe("pixel-perfect MD E2E (needs m68k binutils + libretro/genesis-plus-gx)", () => {
  for (const [name, png] of Object.entries(CASES)) {
    maybe(
      `md/${name}: ROM boots in genesis-plus-gx and matches the DAC reference (RGB565)`,
      async () => {
        const dir = mkdtempSync(join(tmpdir(), "demake-md-e2e-"));
        try {
          // One gen result drives both the ROM and the reference (same prep run).
          const result = await gen(png, {
            console: "md",
            format: "bin",
            symbol: "demake",
            prep: { effort: "fast" },
          });
          const romPath = join(dir, "out.md");
          writeFileSync(romPath, buildMdRom(makeNodeEnv(), getConsole("md"), result));

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
