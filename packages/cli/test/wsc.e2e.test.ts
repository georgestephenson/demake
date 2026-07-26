/**
 * Pixel-perfect WonderSwan Color E2E (doc 10) via libretro / beetle-wswan.
 *
 * gen → WonderSwan Color cartridge (NASM, 16-bit x86 for the V30MZ) → boot in
 * mednafen_wswan → capture the framebuffer → assert it matches demake's DAC
 * reference, across the same extensive battery every other family runs. The
 * core renders 224×144 into a 16-bit framebuffer, so the comparison is in its
 * native RGB565 precision; both sides expand a 4-bit channel by replication
 * (the core's `code * 17`), so the agreement is exact rather than tolerant.
 *
 * The display is asked for landscape explicitly through a core option: the
 * core's default is landscape, but the WonderSwan is the one console here whose
 * screen orientation is a *setting*, and a rotated capture would fail in a way
 * that looks like a fitter bug.
 *
 * Self-skips unless NASM + the libretro runner/core are provisioned
 * (`pnpm toolchains && pnpm emulator`). No Docker.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { gen, getConsole, renderCompliant } from "@demake/core";
import { describe, expect, it } from "vitest";

import { makeNodeEnv } from "../src/env.js";
import { buildWscRom } from "../src/rom/wsc.js";
import { countMismatches, makeBattery, readPpm, to565 } from "./_emu-battery.js";

const TC = join(homedir(), ".cache", "demake", "toolchains");
const RETRORUN = join(TC, "libretro", "retrorun");
const CORE = join(TC, "libretro", "cores", "mednafen_wswan_libretro.so");
const FRAMES = 60;

const hasNasm = makeNodeEnv().which("nasm") !== null;
const hasEmu = existsSync(RETRORUN) && existsSync(CORE);
const maybe = hasNasm && hasEmu ? it : it.skip;

// The WonderSwan's landscape screen is 224×144, exactly the frame it renders.
const CASES = makeBattery(224, 144);

describe("pixel-perfect WonderSwan Color E2E (needs NASM + libretro/beetle-wswan)", () => {
  for (const [name, png] of Object.entries(CASES)) {
    maybe(
      `wsc/${name}: ROM boots in beetle-wswan and matches the DAC reference (RGB565)`,
      async () => {
        const dir = mkdtempSync(join(tmpdir(), "demake-wsc-e2e-"));
        try {
          // One gen result drives both the ROM and the reference (same prep run).
          const result = await gen(png, {
            console: "wsc",
            format: "bin",
            symbol: "demake",
            prep: { effort: "fast" },
          });
          const romPath = join(dir, "out.wsc");
          writeFileSync(romPath, buildWscRom(makeNodeEnv(), getConsole("wsc"), result));

          const ppmPath = join(dir, "frame.ppm");
          execFileSync(RETRORUN, [
            CORE,
            romPath,
            String(FRAMES),
            ppmPath,
            dir,
            "wswan_rotate_display=landscape",
          ]);
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
