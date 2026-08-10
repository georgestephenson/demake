/**
 * Pixel-perfect emulator E2E (doc 10 — the credo) for all three `gb`-family
 * consoles.
 *
 * The whole loop, end to end, across a battery of deliberately extreme images:
 * gen → ROM → boot in SameBoy (the accuracy reference) → capture the framebuffer
 * → assert it is byte-identical to demake's DAC reference. SameBoy runs with
 * color correction disabled, so its output is the raw hardware readout (CGB:
 * RGB555 expanded exactly as demake's `expandChannel`; a mono model: the exact
 * ramp the console spec declares, handed to the capturer rather than restated in
 * it), directly comparable to `renderCompliant`.
 *
 * **The Mega Duck runs here rather than in a suite of its own**, because it is
 * the same harness, the same assembler and the same battery — the console is a
 * machine description (`core/src/asm/megaduck.ts`), and a second file would be
 * asserting that a description is a console. What is different is the emulator:
 * SameDuck, SameBoy's own fork, whose capturer is this repository's
 * `emu-harness/gb/capture.c` compiled against it. That fork is the *third-party*
 * opinion the whole doc-10 loop rests on: a register table of ours that was
 * wrong and self-consistent would still show the wrong picture there.
 *
 * The ROM comes from `buildGbRom`, so what is booted is the cartridge
 * `--format rom` really writes rather than a second assembly of the same
 * harness. Self-skips per console unless RGBDS and that console's capturer are
 * provisioned (`pnpm toolchains && pnpm emulator`). No Docker.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { encodeRgbaPng, gen, getConsole, renderCompliant, type ConsoleSpec } from "@demake/core";
import { describe, expect, it } from "vitest";

import { makeNodeEnv } from "../src/env.js";
import { buildGbRom } from "../src/rom/gb.js";

const SAMEBOY_VERSION = "1.0.1";
const TOOLCHAINS = join(homedir(), ".cache", "demake", "toolchains");
const EMU_DIR = process.env.DEMAKE_EMU_DIR ?? join(TOOLCHAINS, `sameboy-${SAMEBOY_VERSION}`);
const DUCK_DIR = process.env.DEMAKE_SAMEDUCK_DIR ?? join(TOOLCHAINS, "sameduck");
const CAPTURE = join(EMU_DIR, "capture");
const DUCK_CAPTURE = join(DUCK_DIR, "capture");
const HARNESS = join(makeNodeEnv().harnessDir() ?? "", "gb", "main.asm");
const FRAMES = 280;

const hasToolchain = makeNodeEnv().which("rgbasm") !== null;
const hasEmu = existsSync(CAPTURE) && existsSync(join(EMU_DIR, "dmg_boot.bin"));
const hasDuck = existsSync(DUCK_CAPTURE);
const ready = hasToolchain && existsSync(HARNESS);
const maybe = ready && hasEmu ? it : it.skip;
const maybeDuck = ready && hasDuck ? it : it.skip;

/**
 * The console's own shade ramp, as the capturer takes it: lightest first.
 *
 * The DAC model is a tested artifact of the spec, so it is passed rather than
 * carried a second time in C — one ramp, two readers, exactly as
 * `renderCompliant` on the other side of the comparison reads it.
 */
function shadeRamp(spec: ConsoleSpec): string {
  const dac = spec.color.dac;
  if (dac.kind !== "mono-ramp") throw new Error(`${spec.id} has no mono ramp`);
  const hex = (v: number): string => v.toString(16).toUpperCase().padStart(2, "0");
  return dac.shades.map((c) => `${hex(c.r)}${hex(c.g)}${hex(c.b)}`).join(",");
}

const clamp = (v: number): number => (v < 0 ? 0 : v > 255 ? 255 : v | 0);

/** Deterministic image builder (RGBA PNG). */
function image(
  w: number,
  h: number,
  fn: (x: number, y: number) => [number, number, number],
): Uint8Array {
  const d = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const o = (y * w + x) * 4;
      const [r, g, b] = fn(x, y);
      d[o] = r;
      d[o + 1] = g;
      d[o + 2] = b;
      d[o + 3] = 255;
    }
  }
  return encodeRgbaPng(w, h, d);
}

/** A deterministic LCG for the noise case (no Math.random → reproducible). */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/** Extreme cases: flat, full-screen smooth + full-screen noise (budget + bank 1),
 *  mirror symmetry (flip dedup), per-cell palettes, and the 8×8 minimum. */
const CASES: Record<string, Uint8Array> = {
  flat: image(64, 64, () => [80, 140, 200]),
  "gradient-full": image(160, 144, (x, y) => [clamp((x * 255) / 159), clamp((y * 255) / 143), 128]),
  "noise-full": (() => {
    const r = lcg(7);
    return image(160, 144, () => [(r() * 255) | 0, (r() * 255) | 0, (r() * 255) | 0]);
  })(),
  hmirror: image(64, 64, (x, y) => [(x < 32 ? x : 63 - x) * 8, y * 4, 100]),
  manycolors: image(64, 64, (x, y) => [
    ((x >> 3) * 40) % 256,
    ((y >> 3) * 40) % 256,
    (((x >> 3) + (y >> 3)) * 30) % 256,
  ]),
  tiny: image(8, 8, (x, y) => [x * 32, y * 32, 0]),
};

/** Parse a binary PPM (P6). */
function readPpm(bytes: Uint8Array): { w: number; data: Uint8Array } {
  const tokens: string[] = [];
  let pos = 0;
  const ws = (b: number): boolean => b === 0x20 || b === 0x0a || b === 0x09 || b === 0x0d;
  while (tokens.length < 4) {
    while (ws(bytes[pos]!)) pos += 1;
    let s = "";
    while (pos < bytes.length && !ws(bytes[pos]!)) s += String.fromCharCode(bytes[pos++]!);
    tokens.push(s);
  }
  pos += 1;
  return { w: Number(tokens[1]), data: bytes.subarray(pos) };
}

describe("pixel-perfect emulator E2E (needs RGBDS + SameBoy/SameDuck)", () => {
  for (const [consoleId, model] of [
    ["dmg", "dmg"],
    ["gbc", "cgb"],
    ["megaduck", "duck"],
  ] as const) {
    const isDuck = model === "duck";
    const emulator = isDuck ? "SameDuck" : "SameBoy";
    const runner = isDuck ? maybeDuck : maybe;
    for (const [name, png] of Object.entries(CASES)) {
      runner(
        `${consoleId}/${name}: ROM boots in ${emulator} and matches the DAC reference`,
        async () => {
          const dir = mkdtempSync(join(tmpdir(), "demake-emu-"));
          try {
            const spec = getConsole(consoleId);
            const isColor = consoleId === "gbc";
            // One gen result drives both the ROM and the reference (same prep run).
            const result = await gen(png, {
              console: consoleId,
              format: "asm",
              symbol: "demake",
              prep: { effort: "fast" },
            });
            const rom = join(dir, isDuck ? "out.duck" : "out.gb");
            writeFileSync(rom, buildGbRom(makeNodeEnv(), spec, result.artifacts[0]!.bytes));

            const ppmPath = join(dir, "frame.ppm");
            execFileSync(isDuck ? DUCK_CAPTURE : CAPTURE, [
              model,
              // The Mega Duck has no boot ROM: a cartridge begins at $0000.
              isDuck ? "-" : join(EMU_DIR, `${model}_boot.bin`),
              rom,
              String(FRAMES),
              ppmPath,
              ...(isColor ? [] : [shadeRamp(spec)]),
            ]);
            const frame = readPpm(readFileSync(ppmPath));
            const ref = renderCompliant(result.image, isColor);

            let mismatches = 0;
            for (let y = 0; y < ref.height; y += 1) {
              for (let x = 0; x < ref.width; x += 1) {
                const p = (y * frame.w + x) * 3;
                const r = (y * ref.width + x) * 4;
                if (
                  frame.data[p] !== ref.data[r] ||
                  frame.data[p + 1] !== ref.data[r + 1] ||
                  frame.data[p + 2] !== ref.data[r + 2]
                ) {
                  mismatches += 1;
                }
              }
            }
            expect(mismatches).toBe(0);
          } finally {
            rmSync(dir, { recursive: true, force: true });
          }
        },
      );
    }
  }
});
