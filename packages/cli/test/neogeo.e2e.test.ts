/**
 * Pixel-perfect Neo Geo E2E (doc 10) via libretro / geolith.
 *
 * gen → `.neo` cartridge (GNU m68k binutils) → boot in geolith → capture the
 * framebuffer → assert it matches demake's DAC reference, across the same
 * extensive battery every other family runs.
 *
 * **This console has no tilemap, so the picture is sprites** — twenty vertical
 * strips chained by the sticky bit, each a 64-word column of 16×16 tiles read
 * out of the cartridge's C ROM. Three things about that arrangement are only
 * checkable here. The strips' *chain* is a hardware behaviour our own renderer
 * also implements, so a shared misreading would be invisible until somebody
 * else's emulator drew it. The SCB3 **Y convention** (`496 − y`) is one number
 * with three readers, and this is the one place it is settled against something
 * that is not ours. And **SCB2 has to be written at all**: zero means fully
 * shrunk rather than unshrunk, which is a cartridge that shows a row of dots.
 *
 * **The system ROM is demake's own** (`_neogeo-bios.ts`). geolith will not load
 * a cartridge without a system ROM archive, and its members are read by name
 * with no checksum, so what it is handed is the same three-line hand-off
 * `@demake/neogeo` implements — nothing copyrighted is shipped or needed, which
 * is the position doc 13 §Axis 3 already takes about this console.
 *
 * The comparison is in **RGB555**, and the reason is this console's palette
 * word. A channel is five bits of its own plus a sixth the three *share* — the
 * dark bit — so demake's reference expands five by replication and geolith's raw
 * LUT scales six as a percentage; the two agree exactly once both are reduced to
 * the five bits the hardware lets a fit choose. The core is asked for the raw
 * palette rather than its default resistor-network model for the same reason
 * every other family's E2E disables colour correction: what is being compared is
 * the hardware's readout, not a model of the display.
 *
 * Self-skips unless the m68k binutils and the libretro runner/core are
 * provisioned (`pnpm toolchains && pnpm emulator`). No Docker.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { gen, getConsole, renderCompliant } from "@demake/core";
import { describe, expect, it } from "vitest";

import { makeNodeEnv } from "../src/env.js";
import { buildNeogeoRom } from "../src/rom/neogeo.js";
import { countMismatches, makeBattery, readPpm, to555 } from "./_emu-battery.js";
import { neogeoBiosZip } from "./_neogeo-bios.js";

const TC = join(homedir(), ".cache", "demake", "toolchains");
const RETRORUN = join(TC, "libretro", "retrorun");
const CORE = join(TC, "libretro", "cores", "geolith_libretro.so");
const FRAMES = 60;

const hasToolchain = makeNodeEnv().which("m68k-linux-gnu-as") !== null;
const hasEmu = existsSync(RETRORUN) && existsSync(CORE);
const maybe = hasToolchain && hasEmu ? it : it.skip;

// The Neo Geo's frame is 320×224; the core crops eight pixels of horizontal
// overscan by default, so those two options ask for the whole active picture.
const CASES = makeBattery(320, 224);
const OPTIONS = [
  "geolith_system_type=aes",
  "geolith_palette=raw",
  "geolith_overscan_l=0",
  "geolith_overscan_r=0",
];

describe("pixel-perfect Neo Geo E2E (needs m68k binutils + libretro/geolith)", () => {
  for (const [name, png] of Object.entries(CASES)) {
    maybe(
      `neogeo/${name}: ROM boots in geolith and matches the DAC reference (RGB555)`,
      async () => {
        const dir = mkdtempSync(join(tmpdir(), "demake-neogeo-e2e-"));
        try {
          // The core looks for its system ROM archive in the system directory,
          // which the runner is handed as the working directory below.
          writeFileSync(join(dir, "aes.zip"), neogeoBiosZip());

          // One gen result drives both the ROM and the reference (same prep run).
          const result = await gen(png, {
            console: "neogeo",
            format: "bin",
            symbol: "demake",
            prep: { effort: "fast" },
          });
          const romPath = join(dir, "out.neo");
          writeFileSync(romPath, buildNeogeoRom(makeNodeEnv(), getConsole("neogeo"), result));

          const ppmPath = join(dir, "frame.ppm");
          execFileSync(RETRORUN, [CORE, romPath, String(FRAMES), ppmPath, dir, ...OPTIONS]);
          const frame = readPpm(readFileSync(ppmPath));

          const ref = renderCompliant(result.image, true);
          expect(countMismatches(frame, ref, to555)).toBe(0);
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      },
      180000,
    );
  }
});
