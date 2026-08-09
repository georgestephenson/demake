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

import {
  Asm810,
  packVbRom,
  SR_PSW,
  V810_R0,
  VB_BGMAP,
  VB_BKCOL,
  VB_BRTA,
  VB_BRTB,
  VB_BRTC,
  VB_CHR_MIRROR,
  VB_DPCTRL,
  VB_DPCTRL_ON,
  VB_FRMCYC,
  VB_GPLT0,
  VB_INTCLR,
  VB_INTENB,
  VB_REST,
  VB_ROM,
  VB_WORLDS,
  VB_WORLD_BYTES,
  VB_WORLD_END,
  VB_WORLD_LON,
  VB_WORLD_RON,
  VB_XPCTRL,
  VB_XP_XPEN,
  packPacked2Le,
} from "@demake/core";
import { Vb, VB_NEARER } from "@demake/vb";

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

/**
 * A cartridge with two layers at two depths, built by hand.
 *
 * Small enough to read: one character that is solid, two BGMap cells, and two
 * worlds — the far one at the display plane and the near one pulled toward the
 * viewer. It is hand-built rather than produced by `gen` because `gen` demakes a
 * *picture*, and a picture has nothing in front of it; what is being checked
 * here is the depth axis itself.
 */
function depthCartridge(nearParallax: number): Uint8Array {
  const ADDR = 10;
  const VALUE = 11;
  const asm = new Asm810(VB_ROM);
  const poke = (address: number, value: number): void => {
    asm.movImm32(address, ADDR);
    asm.movImm32(value & 0xffff, VALUE);
    asm.sth(VALUE, 0, ADDR);
  };

  asm.ldsr(V810_R0, SR_PSW);
  poke(VB_INTENB, 0);
  poke(VB_INTCLR, 0xffff);
  poke(VB_REST, 0);
  poke(VB_FRMCYC, 0);
  poke(VB_XPCTRL, 0);

  // Character 0: every pixel value 3. Character 1: every pixel value 1, so the
  // two layers are told apart by shade as well as by position.
  const solid = packPacked2Le(new Uint8Array(64).fill(3), 8, 8);
  const faint = packPacked2Le(new Uint8Array(64).fill(1), 8, 8);
  for (let i = 0; i < 16; i += 2) {
    poke(VB_CHR_MIRROR + i, solid[i]! | (solid[i + 1]! << 8));
    poke(VB_CHR_MIRROR + 16 + i, faint[i]! | (faint[i + 1]! << 8));
  }
  // BGMap 0 cell 0 is the near layer; BGMap 1 cell 0 is the far one.
  poke(VB_BGMAP, 0);
  poke(VB_BGMAP + 0x2000, 1);

  poke(VB_GPLT0, 0xe4);
  poke(VB_BKCOL, 0);
  poke(VB_BRTA, 32);
  poke(VB_BRTB, 64);
  poke(VB_BRTC, 32);

  const world = (index: number, fields: Record<number, number>): void => {
    const base = VB_WORLDS + index * VB_WORLD_BYTES;
    for (let offset = 0; offset < VB_WORLD_BYTES; offset += 2)
      poke(base + offset, fields[offset] ?? 0);
  };
  // World 31 is drawn first and world 30 over it, so the near layer is the
  // *lower* index — the display list runs backwards.
  world(31, { 0: VB_WORLD_LON | VB_WORLD_RON | 1, 2: 100, 4: 0, 6: 40, 14: 7, 16: 7 });
  world(30, { 0: VB_WORLD_LON | VB_WORLD_RON, 2: 100, 4: nearParallax, 6: 80, 14: 7, 16: 7 });
  world(29, { 0: VB_WORLD_END });

  poke(VB_XPCTRL, VB_XP_XPEN);
  poke(VB_DPCTRL, VB_DPCTRL_ON);
  asm.label("Idle");
  asm.br("Idle");
  return packVbRom(asm.assemble(), { title: "DEPTH" });
}

describe("Virtual Boy depth (needs libretro/beetle-vb)", () => {
  maybe(
    "a nearer layer crosses the eyes, and demake's own core agrees pixel for pixel",
    () => {
      const dir = mkdtempSync(join(tmpdir(), "demake-vb-depth-"));
      try {
        const parallax = VB_NEARER * 8;
        const rom = depthCartridge(parallax);
        const romPath = join(dir, "depth.vb");
        writeFileSync(romPath, rom);
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

        // Where each layer starts on its own row, in each eye.
        const edge = (eyeX: number, row: number): number => {
          for (let x = 0; x < VB_SCREEN_W; x += 1) {
            if (frame.data[(row * frame.w + eyeX + x) * 3]! !== 0) return x;
          }
          return -1;
        };
        // The far layer sits at the display plane: both eyes see it in one place.
        expect(edge(0, 44)).toBe(100);
        expect(edge(VB_SCREEN_W, 44)).toBe(100);
        // The near one is crossed — the left eye sees it to the *right* of where
        // the right eye does, which is what converging on something nearer than
        // the screen means. This is the assertion `VB_NEARER` exists for, and the
        // only place in the project where it is checked against hardware.
        expect(edge(0, 84)).toBeGreaterThan(edge(VB_SCREEN_W, 84));
        expect(edge(0, 84) - edge(VB_SCREEN_W, 84)).toBe(16);

        // And demake's own video processor draws the same scene the same way —
        // every pixel of both eyes, against a third-party emulator.
        const machine = new Vb(rom);
        for (let f = 0; f < FRAMES; f += 1) machine.runFrame();
        for (const [eyeX, which] of [
          [0, "left"],
          [VB_SCREEN_W, "right"],
        ] as const) {
          const ours = machine.eye(which);
          let bad = 0;
          for (let y = 0; y < VB_SCREEN_H; y += 1) {
            for (let x = 0; x < VB_SCREEN_W; x += 1) {
              const p = (y * frame.w + eyeX + x) * 3;
              const q = (y * VB_SCREEN_W + x) * 4;
              if (frame.data[p] !== ours[q]) bad += 1;
            }
          }
          expect(bad).toBe(0);
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    120000,
  );
});
