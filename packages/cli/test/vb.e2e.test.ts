/**
 * Pixel-perfect Virtual Boy E2E (doc 10) via libretro / beetle-vb.
 *
 * gen → Virtual Boy cartridge → boot in mednafen_vb → capture the framebuffer →
 * assert it matches demake's DAC reference, across the same extensive battery
 * every other family runs.
 *
 * Three things make this suite unlike the other eleven.
 *
 *   - **It checks two pictures.** The core is asked for `side-by-side`, so the
 *     captured frame is 768 pixels wide and carries the left eye beside the
 *     right one. Both halves are compared against the same reference, which is
 *     the *claim* a still picture makes on this console: a backdrop sits at the
 *     display plane, so the two eyes see it in exactly the same place. A world
 *     whose parallax had drifted would show as one half matching and the other
 *     not.
 *   - **There is no assembler to skip on.** This is the one family whose display
 *     program demake emits itself (`src/rom/vb.ts`), so the suite self-skips on
 *     the emulator alone. That also makes it the sharpest test of the V810
 *     encoder there is: every instruction in the cartridge is ours, and a
 *     third-party emulator is what decodes them.
 *   - **The comparison is exact in 8-bit.** This core renders XRGB8888 rather
 *     than the 16-bit framebuffers the Sega and Nintendo cores use, and the
 *     console spec's ramp was measured against it — so there is no reduction
 *     step and a single wrong shade is a mismatch.
 *
 * The picture is *centred*, because a `gen` image may be smaller than the screen
 * and this console has no border but `BKCOL`; the offset is computed the same
 * way the builder computes it.
 *
 * Self-skips unless the libretro runner/core are provisioned (`pnpm emulator`).
 * No Docker.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { gen, getConsole, renderCompliant, VB_SCREEN_H, VB_SCREEN_W } from "@demake/core";
import { describe, expect, it } from "vitest";

import { makeNodeEnv } from "../src/env.js";
import { buildVbRom } from "../src/rom/vb.js";
import { makeBattery, readPpm } from "./_emu-battery.js";

const TC = join(homedir(), ".cache", "demake", "toolchains");
const RETRORUN = join(TC, "libretro", "retrorun");
const CORE = join(TC, "libretro", "cores", "mednafen_vb_libretro.so");
const FRAMES = 40;

const hasEmu = existsSync(RETRORUN) && existsSync(CORE);
const maybe = hasEmu ? it : it.skip;

const CASES = makeBattery(VB_SCREEN_W, VB_SCREEN_H);

/**
 * Mismatching pixels between one eye of the capture and the reference.
 *
 * `countMismatches` compares from the frame's origin; here the picture is
 * centred inside a screen that is itself half of the capture, so the offsets are
 * spelled out rather than assumed.
 */
function mismatches(
  frame: { w: number; data: Uint8Array },
  ref: { width: number; height: number; data: Uint8Array },
  eyeX: number,
): number {
  const offsetX = eyeX + ((VB_SCREEN_W - ref.width) >> 1);
  const offsetY = (VB_SCREEN_H - ref.height) >> 1;
  let bad = 0;
  for (let y = 0; y < ref.height; y += 1) {
    for (let x = 0; x < ref.width; x += 1) {
      const p = ((y + offsetY) * frame.w + x + offsetX) * 3;
      const r = (y * ref.width + x) * 4;
      if (
        frame.data[p] !== ref.data[r] ||
        frame.data[p + 1] !== ref.data[r + 1] ||
        frame.data[p + 2] !== ref.data[r + 2]
      ) {
        bad += 1;
      }
    }
  }
  return bad;
}

describe("pixel-perfect Virtual Boy E2E (needs libretro/beetle-vb)", () => {
  for (const [name, png] of Object.entries(CASES)) {
    maybe(
      `vb/${name}: ROM boots in beetle-vb and matches the DAC reference in both eyes`,
      async () => {
        const dir = mkdtempSync(join(tmpdir(), "demake-vb-e2e-"));
        try {
          const result = await gen(png, {
            console: "vb",
            format: "bin",
            symbol: "demake",
            prep: { effort: "fast" },
          });
          const romPath = join(dir, "out.vb");
          writeFileSync(romPath, buildVbRom(makeNodeEnv(), getConsole("vb")!, result));

          const ppmPath = join(dir, "frame.ppm");
          execFileSync(RETRORUN, [
            CORE,
            romPath,
            String(FRAMES),
            ppmPath,
            dir,
            "vb_3dmode=side-by-side",
            "vb_anaglyph_preset=disabled",
            "vb_color_mode=black & red",
          ]);
          const frame = readPpm(readFileSync(ppmPath));
          expect(frame.w).toBe(VB_SCREEN_W * 2);

          const ref = renderCompliant(result.image, false);
          expect(mismatches(frame, ref, 0)).toBe(0);
          expect(mismatches(frame, ref, VB_SCREEN_W)).toBe(0);
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      },
      120000,
    );
  }
});
