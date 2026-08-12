/**
 * Pixel-perfect Neo Geo Pocket Color E2E (doc 10) via libretro / beetle-ngp.
 *
 * gen → Neo Geo Pocket Color cartridge (TLCS-900/H, demake's own encoder) →
 * boot in mednafen_ngp → capture the framebuffer → assert it matches demake's
 * DAC reference, across the same extensive battery every other family runs.
 *
 * This is the second family whose display program has **no third-party
 * assembler behind it**, after the Virtual Boy's, and that makes this suite the
 * sharpest test of an encoder there is: every instruction in the cartridge is
 * ours and somebody else's emulator is what decodes them. It also settles the
 * thing `@demake/ngp` alone could not — the palette word is **BGR**444 on this
 * console, red in the low nibble, which is the opposite of every other RGB444
 * machine in the matrix, and an encoder and a renderer of ours that agreed with
 * each other would draw every picture in exactly the wrong colours and pass
 * every byte comparison there is.
 *
 * The core renders 160×152 into a 16-bit framebuffer and expands each 4-bit
 * channel by replication, exactly as demake's `expandChannel` does, so the
 * comparison is in its native RGB565 and is exact rather than tolerant.
 *
 * Self-skips unless the libretro runner/core is provisioned (`pnpm emulator`).
 * No assembler is needed at all. No Docker.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { gen, getConsole, renderCompliant } from "@demake/core";
import { describe, expect, it } from "vitest";

import { makeNodeEnv } from "../src/env.js";
import { buildNgpcRom } from "../src/rom/ngpc.js";
import { countMismatches, makeBattery, readPpm, to565 } from "./_emu-battery.js";

const TC = join(homedir(), ".cache", "demake", "toolchains");
const RETRORUN = join(TC, "libretro", "retrorun");
const CORE = join(TC, "libretro", "cores", "mednafen_ngp_libretro.so");
const FRAMES = 60;

const maybe = existsSync(RETRORUN) && existsSync(CORE) ? it : it.skip;

// The Neo Geo Pocket's screen is 160×152, exactly the frame it renders.
const CASES = makeBattery(160, 152);

describe("pixel-perfect Neo Geo Pocket Color E2E (needs libretro/beetle-ngp)", () => {
  for (const [name, png] of Object.entries(CASES)) {
    maybe(
      `ngpc/${name}: ROM boots in beetle-ngp and matches the DAC reference (RGB565)`,
      async () => {
        const dir = mkdtempSync(join(tmpdir(), "demake-ngpc-e2e-"));
        try {
          // One gen result drives both the ROM and the reference (same prep run).
          const result = await gen(png, {
            console: "ngpc",
            format: "bin",
            symbol: "demake",
            prep: { effort: "fast" },
          });
          const romPath = join(dir, "out.ngc");
          writeFileSync(romPath, buildNgpcRom(makeNodeEnv(), getConsole("ngpc"), result));

          const ppmPath = join(dir, "frame.ppm");
          execFileSync(RETRORUN, [CORE, romPath, String(FRAMES), ppmPath, dir]);
          const frame = readPpm(readFileSync(ppmPath));

          const ref = renderCompliant(result.image, true);
          expect(countMismatches(frame, ref, to565)).toBe(0);
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      },
      120000,
    );
  }
});
