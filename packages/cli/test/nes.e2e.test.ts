/**
 * Pixel-perfect NES emulator E2E (doc 10) via libretro.
 *
 * The full loop across extreme images: gen → NROM ROM (cc65) → boot in fceumm
 * (libretro, the accuracy core) → capture the framebuffer → assert it is
 * byte-identical to demake's DAC reference. The core is pointed at demake's
 * master palette (written as `nes.pal` in the system dir), so its output matches
 * `renderCompliant` exactly — the same "calibrate the emulator to the model"
 * approach as the GB E2E. Self-skips unless cc65 + the libretro runner/core are
 * provisioned (`pnpm toolchains && pnpm emulator`). No Docker.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { encodeRgbaPng, gen, getConsole, renderCompliant } from "@demake/core";
import { describe, expect, it } from "vitest";

import { makeNodeEnv, type CliEnv } from "../src/env.js";
import { EXIT } from "../src/exit-codes.js";
import { run } from "../src/run.js";

const TC = join(homedir(), ".cache", "demake", "toolchains");
const RETRORUN = join(TC, "libretro", "retrorun");
const CORE = join(TC, "libretro", "cores", "fceumm_libretro.so");
const FRAMES = 120;

const hasCc65 = makeNodeEnv().which("ca65") !== null && makeNodeEnv().which("ld65") !== null;
const hasEmu = existsSync(RETRORUN) && existsSync(CORE);
const maybe = hasCc65 && hasEmu ? it : it.skip;

const clamp = (v: number): number => (v < 0 ? 0 : v > 255 ? 255 : v | 0);

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

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const CASES: Record<string, Uint8Array> = {
  gradient: image(128, 128, (x, y) => [clamp(x * 2), clamp(y * 2), 128]),
  flat: image(64, 64, () => [80, 140, 200]),
  noise: (() => {
    const r = lcg(11);
    return image(96, 96, () => [(r() * 255) | 0, (r() * 255) | 0, (r() * 255) | 0]);
  })(),
};

function nodeEnvCapturing(): CliEnv {
  return { ...makeNodeEnv(), out: () => {}, errOut: () => {}, stdoutIsTTY: () => true };
}

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

/** Write demake's NES master palette as a 192-byte libretro `nes.pal`. */
function writeNesPal(dir: string): void {
  const master = getConsole("nes").color.masterPalette!;
  const pal = new Uint8Array(192);
  master.forEach((c, i) => {
    pal[i * 3] = c.r;
    pal[i * 3 + 1] = c.g;
    pal[i * 3 + 2] = c.b;
  });
  writeFileSync(join(dir, "nes.pal"), pal);
}

describe("pixel-perfect NES E2E (needs cc65 + libretro/fceumm)", () => {
  for (const [name, png] of Object.entries(CASES)) {
    maybe(
      `nes/${name}: NROM boots in fceumm and matches the DAC reference`,
      async () => {
        const dir = mkdtempSync(join(tmpdir(), "demake-nes-e2e-"));
        try {
          const inPath = join(dir, "in.png");
          const romPath = join(dir, "out.nes");
          writeFileSync(inPath, png);

          const code = await run(
            ["gen", inPath, "-c", "nes", "--format", "rom", "-o", romPath],
            nodeEnvCapturing(),
          );
          expect(code).toBe(EXIT.OK);

          writeNesPal(dir);
          const ppmPath = join(dir, "frame.ppm");
          execFileSync(RETRORUN, [
            CORE,
            romPath,
            String(FRAMES),
            ppmPath,
            dir,
            "fceumm_palette=custom",
          ]);
          const frame = readPpm(readFileSync(ppmPath));

          // The reference: the exact image the ROM encoded, in master colors.
          const result = await gen(png, { console: "nes", format: "bin", symbol: "demake" });
          const ref = renderCompliant(result.image, false);

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
      60000,
    );
  }
});
