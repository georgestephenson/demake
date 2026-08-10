/**
 * Pixel-perfect WonderSwan (mono) E2E (doc 10) via libretro / beetle-wswan.
 *
 * gen → WonderSwan cartridge (NASM, 16-bit x86 for the V30MZ) → boot in
 * mednafen_wswan → capture the framebuffer → assert it matches demake's DAC
 * reference, across the same extensive battery every other family runs. Same
 * core as the Color suite beside it, in the mode that console's own hardware
 * puts it in: nothing ever writes port `$60`, so the display controller stays in
 * mono and reads sixteen-byte planar tiles.
 *
 * What this suite proves that `wsc.e2e.test.ts` does not is the **pool**. A
 * shade here is two indirections from a pixel — a cell names one of sixteen
 * four-entry palettes, an entry is a three-bit slot in a shared pool of eight,
 * and a slot is one of the sixteen levels the panel shows — and every one of
 * those is a fit decision (`pipeline/fit-mono-tiled.ts`). A pool the emitter
 * wrote to the wrong ports, or ordered against what the palettes index, is a
 * picture in shades nobody chose, and no assertion inside the engine can see it.
 *
 * The comparison is exact rather than tolerant, and the arithmetic is worth
 * writing down because it looks like a coincidence. The core stores a shade
 * register as `15 - level` and lerps its mono ramp from black to white over that
 * index, which is `round(17 × (15 - level))`; demake's `ws` ramp is
 * `round(255 × (1 - level / 15))`, the same number. So both sides reduce to the
 * core's native RGB565 and agree bit for bit.
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
import { buildWsRom } from "../src/rom/ws.js";
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

describe("pixel-perfect WonderSwan E2E (needs NASM + libretro/beetle-wswan)", () => {
  for (const [name, png] of Object.entries(CASES)) {
    maybe(
      `ws/${name}: ROM boots in beetle-wswan and matches the DAC reference (RGB565)`,
      async () => {
        const dir = mkdtempSync(join(tmpdir(), "demake-ws-e2e-"));
        try {
          // One gen result drives both the ROM and the reference (same prep run).
          const result = await gen(png, {
            console: "ws",
            format: "bin",
            symbol: "demake",
            prep: { effort: "fast" },
          });
          const romPath = join(dir, "out.ws");
          writeFileSync(romPath, buildWsRom(makeNodeEnv(), getConsole("ws"), result));

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
