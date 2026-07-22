/**
 * Stage 0 — decode & normalize (doc 04 §Stage 0).
 *
 * Turns an 8-bit sRGB {@link RgbaImage} into the linear-light working buffer the
 * rest of the pipeline operates on. Alpha is composited over a matte
 * (`--background`, default black) because the Phase-1 consoles have no
 * background transparent index; `keepTransparency` is reserved for
 * sprite/transparent-index layouts in a later phase. All resampling and
 * averaging downstream happens in linear light, as the doc requires.
 */

import { parseColorRgb } from "../color/parse.js";
import { srgb8ToLinear } from "../color/srgb.js";
import type { RgbaImage } from "../image/rgba.js";

import type { LinImage } from "./types.js";

/** Convert an RGBA raster to a linear-light RGB working image. */
export function normalize(source: RgbaImage, background = "#000000"): LinImage {
  const matte = parseColorRgb(background);
  const bgR = srgb8ToLinear(matte.r);
  const bgG = srgb8ToLinear(matte.g);
  const bgB = srgb8ToLinear(matte.b);

  const { width, height, data } = source;
  const out = new Float32Array(width * height * 3);
  for (let i = 0, o = 0; i < data.length; i += 4, o += 3) {
    const a = data[i + 3]! / 255;
    const r = srgb8ToLinear(data[i]!);
    const g = srgb8ToLinear(data[i + 1]!);
    const b = srgb8ToLinear(data[i + 2]!);
    if (a >= 1) {
      out[o] = r;
      out[o + 1] = g;
      out[o + 2] = b;
    } else {
      // Composite over the matte in linear light.
      out[o] = r * a + bgR * (1 - a);
      out[o + 1] = g * a + bgG * (1 - a);
      out[o + 2] = b * a + bgB * (1 - a);
    }
  }
  return { width, height, data: out };
}
