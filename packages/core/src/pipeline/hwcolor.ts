/**
 * Hardware color space for an RGB-lattice console (doc 04 §Stage 3, §Color
 * distance).
 *
 * Bridges the pipeline's continuous linear-light / Oklab working space and the
 * console's discrete displayable colors. Snapping a working color yields a
 * {@link PaletteColor} carrying its raw lattice codes, its naive expansion, and
 * — the important part — its **DAC-decoded** display color, whose Oklab is what
 * all fitting distances are measured against ("optimize what the hardware
 * shows"). The mono consoles use a separate path (`mono.ts`).
 */

import { channelCode, expandChannel, type ChannelBits, type Rgb8 } from "../color/lattice.js";
import { deltaESq, linearToOklab, type Oklab } from "../color/oklab.js";
import { linearToSrgb8, srgb8ToLinear } from "../color/srgb.js";
import { dacDecodeCodes, type DacModel } from "../image/dac.js";
import type { ConsoleSpec } from "../consoles/types.js";

import type { PaletteColor } from "./types.js";

/** A palette color with its DAC-decoded Oklab cached for distance math. */
export interface HwColor extends PaletteColor {
  lab: Oklab;
}

/** Snaps working colors to a console's displayable lattice. */
export interface HwColorSpace {
  readonly bits: ChannelBits;
  /** Nearest displayable color to a linear-light RGB working color. */
  snapLinear(r: number, g: number, b: number): HwColor;
  /** Build an {@link HwColor} from explicit raw channel codes. */
  fromCodes(codes: readonly [number, number, number]): HwColor;
}

/** Construct the hardware color space for an RGB-lattice console spec. */
export function makeHwColorSpace(spec: ConsoleSpec): HwColorSpace {
  if (spec.color.model !== "rgb" || !spec.color.bitsPerChannel) {
    throw new Error(`makeHwColorSpace requires an RGB-lattice console (got ${spec.id})`);
  }
  const bits = spec.color.bitsPerChannel;
  const dac = spec.color.dac;
  return {
    bits,
    snapLinear(r, g, b) {
      const codes: [number, number, number] = [
        channelCode(linearToSrgb8(r), bits[0]),
        channelCode(linearToSrgb8(g), bits[1]),
        channelCode(linearToSrgb8(b), bits[2]),
      ];
      return buildHwColor(codes, bits, dac);
    },
    fromCodes(codes) {
      return buildHwColor([codes[0], codes[1], codes[2]], bits, dac);
    },
  };
}

function buildHwColor(codes: [number, number, number], bits: ChannelBits, dac: DacModel): HwColor {
  const raw: Rgb8 = {
    r: expandChannel(codes[0], bits[0]),
    g: expandChannel(codes[1], bits[1]),
    b: expandChannel(codes[2], bits[2]),
  };
  const display = dacDecodeCodes(dac, codes, bits);
  const lab = linearToOklab(
    srgb8ToLinear(display.r),
    srgb8ToLinear(display.g),
    srgb8ToLinear(display.b),
  );
  return { codes, raw, display, lab };
}

/**
 * Construct the hardware color space for a `fixed-master` console (NES/TMS): the
 * displayable colors are a fixed list, so "snapping" is a nearest-entry search
 * in Oklab. A color's code is its master-palette index.
 */
export function makeFixedMasterColorSpace(spec: ConsoleSpec): HwColorSpace {
  if (spec.color.model !== "fixed-master" || !spec.color.masterPalette) {
    throw new Error(`makeFixedMasterColorSpace requires a fixed-master console (got ${spec.id})`);
  }
  const master = spec.color.masterPalette;
  const entries: HwColor[] = master.map((c, i) => ({
    codes: [i],
    display: { ...c },
    raw: { ...c },
    lab: linearToOklab(srgb8ToLinear(c.r), srgb8ToLinear(c.g), srgb8ToLinear(c.b)),
  }));
  const nearest = (lab: Oklab): HwColor => {
    let best = entries[0]!;
    let bestD = Infinity;
    for (const e of entries) {
      const d = deltaESq(lab, e.lab, 1);
      if (d < bestD) {
        bestD = d;
        best = e;
      }
    }
    return best;
  };
  return {
    bits: [8, 8, 8],
    snapLinear(r, g, b) {
      return nearest(linearToOklab(r, g, b));
    },
    fromCodes(codes) {
      return entries[codes[0]] ?? entries[0]!;
    },
  };
}

/** Construct the hardware color space appropriate to a console's color model. */
export function makeColorSpace(spec: ConsoleSpec): HwColorSpace {
  return spec.color.model === "fixed-master"
    ? makeFixedMasterColorSpace(spec)
    : makeHwColorSpace(spec);
}

/** A stable string key for a palette color (its raw codes). */
export function colorKey(color: PaletteColor): string {
  return color.codes.join(",");
}
