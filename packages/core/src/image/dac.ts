/**
 * DAC models (doc 03 schema `color.dac`, doc 04 §Stage 7, doc 10).
 *
 * A console's hardware color codes are not what a screen shows: the GBC's LCD
 * warms and dims its RGB555 values, the DMG renders four *shades* as a green LCD
 * ramp. The DAC model is the console→sRGB curve used both for the human-facing
 * preview and — crucially — for the emulator comparison in doc 10, so the same
 * model must decide "what the hardware shows" everywhere. Distances in the
 * pipeline are computed on DAC-decoded colors (doc 04 §Color distance).
 *
 * Every model here is pure integer/basic-op arithmetic: deterministic by
 * construction.
 */

import type { Rgb8 } from "../color/lattice.js";
import { expandChannel } from "../color/lattice.js";

/**
 * How a console turns stored hardware color into displayed sRGB.
 *
 * - `linear` — naive bit-replication expansion (an honest baseline; the CLI's
 *   `--raw-colors` selects this at encode time).
 * - `cgb` — the Game Boy Color LCD color-correction curve.
 * - `md-vdp` — the Mega Drive VDP's Mode-5 normal-intensity color: each 3-bit
 *   code is doubled and expanded to 5:6:5, exactly what genesis-plus-gx renders
 *   (its `MAKE_PIXEL(2·code, …)`), so the emulator comparison is byte-exact.
 * - `mono-ramp` — a fixed shade→color ramp (DMG green, Virtual Boy red, …).
 */
export type DacModel =
  | { readonly kind: "linear" }
  | { readonly kind: "cgb" }
  | { readonly kind: "md-vdp" }
  | { readonly kind: "mono-ramp"; readonly shades: readonly Rgb8[] };

/**
 * Decode raw per-channel hardware codes to displayed sRGB for an RGB-lattice
 * console. `codes` are the raw channel values at the spec's bit depth (e.g.
 * 0–31 for RGB555).
 */
export function dacDecodeCodes(
  model: DacModel,
  codes: readonly [number, number, number],
  bits: readonly [number, number, number],
): Rgb8 {
  switch (model.kind) {
    case "cgb":
      return cgbCorrect(codes[0], codes[1], codes[2]);
    case "md-vdp":
      return { r: mdChannel(codes[0], 5), g: mdChannel(codes[1], 6), b: mdChannel(codes[2], 5) };
    case "linear":
    case "mono-ramp":
      return {
        r: expandChannel(codes[0], bits[0]),
        g: expandChannel(codes[1], bits[1]),
        b: expandChannel(codes[2], bits[2]),
      };
    default: {
      const never: never = model;
      return never;
    }
  }
}

/**
 * Whether a console's *author space* — the colors `prep` fits, judges, and
 * stores by default — is the raw lattice expansion rather than the DAC-decoded
 * display color.
 *
 * The distinction: `md-vdp` and `mono-ramp` model the console's **DAC itself**
 * (the voltages/shades the machine actually outputs), so their decoded colors
 * *are* the hardware truth. `cgb` models the **LCD panel's** muting filter on
 * top of an RGB555 DAC — period artists authored saturated RGB555 and let the
 * panel mute it, emulators default to little or no correction, and doc 10's
 * pixel-perfect E2E captures SameBoy with color correction disabled (raw
 * readout). Fitting *through* the panel filter would bake its washout into the
 * chosen codes and the stored PNG, so panel filters are simulation-only
 * (`--dac-colors`), never the optimization target.
 */
export function authorSpaceUsesRaw(model: DacModel): boolean {
  return model.kind === "cgb";
}

/** Decode a mono shade index (0 = lightest) to displayed sRGB. */
export function dacDecodeShade(model: DacModel, shade: number): Rgb8 {
  if (model.kind !== "mono-ramp") {
    throw new Error("dacDecodeShade requires a mono-ramp DAC model");
  }
  const clamped = shade < 0 ? 0 : shade >= model.shades.length ? model.shades.length - 1 : shade;
  return model.shades[clamped]!;
}

/**
 * The Game Boy Color LCD color-correction curve.
 *
 * The integer form used by gambatte/SameBoy-style emulators: mix the raw 5-bit
 * channels, clamp each mixed channel to 960, and shift down by two to an 8-bit
 * (0–240) displayed value — the characteristic slightly-warm, slightly-dim CGB
 * screen. Inputs are 0–31.
 */
export function cgbCorrect(r5: number, g5: number, b5: number): Rgb8 {
  const r = clamp31(r5);
  const g = clamp31(g5);
  const b = clamp31(b5);
  const R = Math.min(960, r * 26 + g * 4 + b * 2) >> 2;
  const G = Math.min(960, g * 24 + b * 8) >> 2;
  const B = Math.min(960, r * 6 + g * 4 + b * 22) >> 2;
  return { r: R, g: G, b: B };
}

function clamp31(v: number): number {
  return v < 0 ? 0 : v > 31 ? 31 : v;
}

/**
 * One Mega Drive VDP channel at normal intensity. genesis-plus-gx builds its
 * Mode-5 color table as `MAKE_PIXEL(code<<1, …)` in 5:6:5 (the 3-bit code is
 * doubled, then packed with bit-replication into a 5- or 6-bit field). We
 * reproduce that field and expand it back to 8-bit, so the DAC-decoded color
 * reduces to the exact RGB565 the core displays. `code` is 0–7.
 */
function mdChannel(code: number, targetBits: 5 | 6): number {
  const v = (code & 7) << 1; // normal-intensity level (0, 2, …, 14)
  if (targetBits === 6) {
    const six = ((v << 2) | (v >> 2)) & 0x3f;
    return (six << 2) | (six >> 4);
  }
  const five = ((v << 1) | (v >> 3)) & 0x1f;
  return (five << 3) | (five >> 2);
}
