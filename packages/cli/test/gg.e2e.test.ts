/**
 * Pixel-perfect Game Gear emulator E2E (doc 10) via libretro / genesis-plus-gx.
 *
 * The GG shares the SMS VDP and codegen family but has an RGB444 LCD and a
 * 160×144 viewport that is the *central crop* of the 256×192 VDP frame. The ROM
 * builder offsets the image into the name table by that crop margin (6×3 tiles),
 * so the image lands at the visible window's top-left and the emulator frame is
 * directly comparable to `renderCompliant`. Same extensive battery as every other
 * console. genesis-plus-gx renders 16-bit, so the comparison is in native RGB565.
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
import { buildSmsRom } from "../src/rom/sms.js";
import { countMismatches, makeBattery, readPpm, to565 } from "./_emu-battery.js";

const TC = join(homedir(), ".cache", "demake", "toolchains");
const RETRORUN = join(TC, "libretro", "retrorun");
const CORE = join(TC, "libretro", "cores", "genesis_plus_gx_libretro.so");
const FRAMES = 60;

const hasWla = makeNodeEnv().which("wla-z80") !== null && makeNodeEnv().which("wlalink") !== null;
const hasEmu = existsSync(RETRORUN) && existsSync(CORE);
const maybe = hasWla && hasEmu ? it : it.skip;

// The Game Gear shows the central 160×144 window of the VDP frame.
const CASES = makeBattery(160, 144);

describe("pixel-perfect GG E2E (needs WLA-DX + libretro/genesis-plus-gx)", () => {
  for (const [name, png] of Object.entries(CASES)) {
    maybe(
      `gg/${name}: ROM boots in genesis-plus-gx and matches the DAC reference (RGB565)`,
      async () => {
        const dir = mkdtempSync(join(tmpdir(), "demake-gg-e2e-"));
        try {
          // One gen result drives both the ROM and the reference (same prep run).
          const result = await gen(png, {
            console: "gg",
            format: "bin",
            symbol: "demake",
            prep: { effort: "fast" },
          });
          const romPath = join(dir, "out.gg");
          writeFileSync(romPath, buildSmsRom(makeNodeEnv(), getConsole("gg"), result));

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
