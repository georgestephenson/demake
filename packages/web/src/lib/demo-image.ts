/**
 * The bundled demo image (doc 07 §UX: "Load demo image" so the page demos
 * itself).
 *
 * Drawn in code rather than shipped as a file: it costs no bytes in the bundle
 * beyond this function, it is public-domain by construction (the repo ships no
 * third-party art), and it is deliberately *hard* — a smooth sky gradient, a sun
 * with a hard edge, saturated hills, and a dark foreground silhouette all
 * compete for a handful of sub-palettes, which is exactly what makes the
 * tournament and the palette strip interesting to look at.
 *
 * Deterministic: no randomness, no clock, and no transcendentals — the hill
 * crests are triangle waves built from basic arithmetic, so the demo is
 * bit-identical in every engine (doc 02 §Floating-point discipline). That
 * matters: the browser-vs-Node determinism suite converts this very image.
 */

export interface DemoImage {
  width: number;
  height: number;
  /** RGBA, row-major. */
  data: Uint8Array;
}

const clamp = (v: number): number => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));

/** A smooth-ish triangle wave in [-1, 1] with period 1 — `sin` without `sin`. */
function wave(t: number): number {
  const frac = t - Math.floor(t);
  const tri = frac < 0.5 ? frac * 4 - 1 : 3 - frac * 4;
  // One shaping pass rounds the peaks; still only +, −, × (bit-exact anywhere).
  return tri * (2 - (tri < 0 ? -tri : tri)) * 0.5 + tri * 0.5;
}

/** Build the demo scene at a comfortable source size (downscaled by `prep`). */
export function buildDemoImage(width = 480, height = 432): DemoImage {
  const data = new Uint8Array(width * height * 4);
  const sunX = width * 0.68;
  const sunY = height * 0.3;
  const sunR = Math.min(width, height) * 0.12;

  for (let y = 0; y < height; y += 1) {
    const v = y / (height - 1);
    for (let x = 0; x < width; x += 1) {
      const u = x / (width - 1);
      let r: number;
      let g: number;
      let b: number;

      // Sky: a warm-to-cool vertical gradient with a slight horizontal drift.
      const sky = v * 1.15;
      r = 250 - sky * 190 + u * 18;
      g = 150 - sky * 60 + u * 10;
      b = 90 + sky * 120;

      // Sun disc: a hard edge against the gradient (palette-pressure stress).
      const dx = x - sunX;
      const dy = (y - sunY) * 1.05;
      if (dx * dx + dy * dy < sunR * sunR) {
        r = 255;
        g = 236;
        b = 168;
      }

      // Hills: two saturated bands with a soft crest, then a dark foreground.
      const crest1 = height * 0.62 + wave(u * 0.95) * height * 0.045;
      const crest2 = height * 0.74 + wave(u * 0.52 + 0.27) * height * 0.05;
      if (y > crest2) {
        const d = (y - crest2) / (height - crest2);
        r = 24 + d * 26;
        g = 40 + d * 34;
        b = 52 + d * 30;
      } else if (y > crest1) {
        const d = (y - crest1) / Math.max(1, crest2 - crest1);
        r = 38 + d * 30;
        g = 116 - d * 40;
        b = 96 - d * 30;
      }

      // A foreground silhouette: a lone tree, pure shape against everything.
      const trunkX = width * 0.22;
      const trunkTop = height * 0.52;
      const inTrunk = Math.abs(x - trunkX) < width * 0.012 && y > trunkTop;
      const canopy =
        (x - trunkX) * (x - trunkX) * 1.6 + (y - trunkTop) * (y - trunkTop) <
        width * 0.085 * (width * 0.085);
      if (inTrunk || (canopy && y < trunkTop + height * 0.02)) {
        r = 16;
        g = 22;
        b = 26;
      }

      const o = (y * width + x) * 4;
      data[o] = clamp(r);
      data[o + 1] = clamp(g);
      data[o + 2] = clamp(b);
      data[o + 3] = 255;
    }
  }
  return { width, height, data };
}
