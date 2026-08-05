/**
 * The tiled-mono path (doc 04 §Special cases → Mono ramps, doc 13 §Phase 5).
 *
 * One console needs this and it is the WonderSwan, whose palette system has a
 * level of indirection nothing else in the matrix has. A tile is 2bpp, so a cell
 * shows four of something. Those four are a *palette*, of which the hardware has
 * sixteen. And each palette entry is a three-bit index into a **shared pool of
 * eight shades**, itself chosen from the sixteen levels the panel can show.
 *
 * So a fit chooses four things where `mono.ts` chooses none:
 *
 *   1. **the pool** — which eight of the sixteen levels are loaded at all,
 *   2. **the backdrop** — the one level entry zero holds in *every* palette,
 *   3. **each palette** — which three more of the pool it names,
 *   4. **each cell** — which palette it uses.
 *
 * The backdrop is there because colour zero is transparent on both of this
 * console's background layers, so a pixel of value 0 shows the backdrop register
 * wherever it appears — the NES's shared-index-0 rule reached by different
 * hardware, and the spec says so with `subPalettes.sharedIndex0`.
 *
 * ### Why this is not `fit-tiled.ts` in one dimension
 *
 * That fitter's problem is continuous and enormous: a sub-palette is any point
 * in a colour lattice with thousands of members, so it runs weighted k-means
 * with restarts and hopes. This one is **small and discrete**. Once the pool is
 * chosen there are exactly `C(8,4) = 70` palettes a cell could be given, so the
 * per-cell question is answered by *evaluating all seventy* rather than by
 * clustering toward one — which is exact rather than nearly right, and cheaper
 * than a single k-means restart.
 *
 * That is what makes the two-stage split honest rather than a shortcut. The pool
 * is global, so it has to be fitted against the whole picture's luminance; and
 * once it exists, nothing about stages 2 and 3 is approximate. The one thing the
 * split gives up is choosing a pool that suits the *palettes* rather than the
 * pixels — and with sixteen palettes of four against eight levels, every level a
 * cell wants is reachable by some palette, so there is nothing for that to buy.
 *
 * ### Choosing the sixteen
 *
 * Seventy candidate palettes and sixteen slots is a facility-location problem,
 * and at this size the greedy answer is the interesting one: take the palette
 * that most reduces the picture's total error, then the next, until the slots
 * run out — then swap each chosen palette against every unchosen one while that
 * helps. Deterministic, no PRNG, and it converges in a handful of passes because
 * the candidate set is tiny.
 *
 * The backdrop rides on top of that as an outer sweep: a chosen backdrop is
 * simply a restriction of the same seventy to the thirty-five that contain it,
 * so the eight candidates are each solved exactly and the best total wins.
 * Picking the backdrop first — by frequency, say — is how a fit comes to hold
 * three usable colours on hardware that has four (AGENTS.md §Gotchas).
 *
 * ### What a `codes` entry holds
 *
 * The **level**, 0–15, not the pool index. The pool is then the distinct levels
 * the fit used, and "at most eight of them" is the compliance rule `inspect`
 * checks — which is the constraint the hardware actually imposes, stated where
 * it can be verified rather than baked into an encoding nobody can inspect. The
 * emitter derives the register values by collecting those levels; a fit that
 * used nine would be caught rather than silently truncated.
 *
 * Sources: WSdev wiki — Display/Palette, Display/IO Ports.
 */

import { linearToOklab } from "../color/oklab.js";
import type { ConsoleSpec, RGB8, TileLayout } from "../consoles/types.js";
import { dacDecodeShade } from "../image/dac.js";

import type { CompliantImage, DitherAlg, LinImage, Palette, PaletteColor } from "./types.js";

/** Entries a palette holds, which is what 2bpp means. */
const ENTRIES = 4;

/** What the fit produces beyond the compliant image itself. */
export interface MonoTiledFit extends CompliantImage {
  /** The levels the pool holds, ascending — what ports `$1C`–`$1F` are set to. */
  pool: readonly number[];
}

/**
 * Fit a picture to a two-level mono palette with per-cell selection.
 *
 * `dither` and `strength` reach the *pixel* assignment only: which of its cell's
 * four entries a pixel takes. The pool and the palettes are chosen against the
 * undithered image, because dithering is a way of spending a palette rather than
 * a thing to choose one for.
 */
export function fitMonoTiled(
  img: LinImage,
  spec: ConsoleSpec,
  dither: DitherAlg,
  strength: number,
  maxPalettes?: number,
): MonoTiledFit {
  const layout = spec.layout as TileLayout;
  const levels = spec.color.levels ?? spec.color.shades ?? 4;
  const poolSize = Math.min(spec.color.shades ?? 4, levels);
  const cellW = layout.attribute.w;
  const cellH = layout.attribute.h;
  const cellsX = Math.floor(img.width / cellW);
  const cellsY = Math.floor(img.height / cellH);
  const cellCount = cellsX * cellsY;
  const palettesAllowed = Math.max(
    1,
    Math.min(layout.subPalettes.count, maxPalettes ?? layout.subPalettes.count),
  );

  // Auto-contrast, exactly as `mono.ts` does it: the fit is adaptive, so what
  // matters is the *spacing* of an image's tones rather than their absolute
  // lightness (AGENTS.md §Drawing art).
  const lum = luminance(img);
  const lo = percentile(lum, 0.02);
  const hi = percentile(lum, 0.98);
  const span = hi - lo > 1e-6 ? hi - lo : 1;
  const level = new Float32Array(lum.length);
  for (let i = 0; i < lum.length; i += 1) level[i] = clamp01((lum[i]! - lo) / span);

  // Importance, on `fit-tiled.ts`'s terms: a pixel at an edge or an extreme is
  // worth more than one in a flat area, because frequency is not importance.
  const weight = weightsOf(level, img.width, img.height);

  const pool = fitPool(level, weight, poolSize, levels);
  const poolValue = pool.map((shade) => 1 - shade / (levels - 1));

  // --- stage 2: what every possible palette costs every cell ------------------
  const subsets = combinations(pool.length, ENTRIES);
  const cost = new Float64Array(cellCount * subsets.length);
  for (let cy = 0; cy < cellsY; cy += 1) {
    for (let cx = 0; cx < cellsX; cx += 1) {
      const cell = cy * cellsX + cx;
      for (let s = 0; s < subsets.length; s += 1) {
        cost[cell * subsets.length + s] = cellCost(
          level,
          weight,
          img.width,
          cx * cellW,
          cy * cellH,
          cellW,
          cellH,
          subsets[s] as readonly number[],
          poolValue,
        );
      }
    }
  }

  // --- stage 3: the backdrop, the sixteen, and which cell takes which ---------
  const shared = layout.subPalettes.sharedIndex0 !== undefined;
  let chosen: number[] = [];
  let backdrop = -1;
  if (shared) {
    let bestTotal = Infinity;
    for (let entry = 0; entry < pool.length; entry += 1) {
      const allowed = subsets.map((s, i) => (s.includes(entry) ? i : -1)).filter((i) => i >= 0);
      const picked = choosePalettes(cost, cellCount, subsets.length, palettesAllowed, allowed);
      const total = totalWith(cost, cellCount, subsets.length, picked);
      if (total < bestTotal - 1e-9) {
        bestTotal = total;
        chosen = picked;
        backdrop = entry;
      }
    }
  } else {
    chosen = choosePalettes(cost, cellCount, subsets.length, palettesAllowed);
  }

  // Entry zero is the backdrop and the rest ascend, so a palette's *order* is
  // fixed rather than incidental — which is what makes the emitter's register
  // values readable off `palettes` without a second decision.
  const entries = chosen.map((s) => {
    const set = subsets[s] as readonly number[];
    return backdrop >= 0 ? [backdrop, ...set.filter((i) => i !== backdrop)] : [...set];
  });

  const cellPalette = new Uint16Array(cellCount);
  for (let cell = 0; cell < cellCount; cell += 1) {
    let best = 0;
    let bestCost = Infinity;
    for (let p = 0; p < chosen.length; p += 1) {
      const value = cost[cell * subsets.length + (chosen[p] as number)] as number;
      if (value < bestCost) {
        bestCost = value;
        best = p;
      }
    }
    cellPalette[cell] = best;
  }

  const palettes: Palette[] = entries.map((set) => ({
    colors: set.map((index) => colorOf(spec, pool[index] as number, levels)),
  }));

  const pixelIndex = assignPixels(
    level,
    img.width,
    img.height,
    cellW,
    cellH,
    cellsX,
    cellsY,
    cellPalette,
    entries.map((set) => set.map((i) => poolValue[i] as number)),
    dither,
    strength,
  );

  return {
    consoleId: spec.id,
    width: img.width,
    height: img.height,
    grid: { cellsX, cellsY, attributeW: cellW, attributeH: cellH },
    palettes,
    cellPalette,
    pixelIndex,
    pool: [...pool].sort((a, b) => a - b),
  };
}

/**
 * The pool: which `size` of the console's `levels` are loaded.
 *
 * Weighted 1-D k-means, snapped to the level lattice every iteration and topped
 * up when two centroids collide — the same discipline `latticeKmeans` runs under
 * for colour, and it matters here for the same reason: sixteen levels is a
 * *coarse* lattice, so two centroids landing on one is routine and a pool that
 * came back short would leave the hardware unspent (AGENTS.md §Gotchas).
 */
function fitPool(
  level: Float32Array,
  weight: Float32Array,
  size: number,
  levels: number,
): number[] {
  // Seeded by even spacing rather than by a draw: this is one dimension with
  // sixteen possible values, so there is nothing a random restart could find
  // that a sweep does not — and a deterministic seed means no PRNG has to be
  // threaded through a path that has no other use for one.
  let centres = Array.from({ length: size }, (_, i) => i / Math.max(1, size - 1));
  for (let iteration = 0; iteration < 24; iteration += 1) {
    const sum = new Float64Array(size);
    const mass = new Float64Array(size);
    for (let i = 0; i < level.length; i += 1) {
      let best = 0;
      let bestDelta = Infinity;
      for (let c = 0; c < size; c += 1) {
        const delta = Math.abs((level[i] as number) - (centres[c] as number));
        if (delta < bestDelta) {
          bestDelta = delta;
          best = c;
        }
      }
      sum[best] = (sum[best] as number) + (level[i] as number) * (weight[i] as number);
      mass[best] = (mass[best] as number) + (weight[i] as number);
    }
    for (let c = 0; c < size; c += 1) {
      if ((mass[c] as number) > 0) centres[c] = (sum[c] as number) / (mass[c] as number);
    }
    centres = centres.map((v) => snapLevel(v, levels)).sort((a, b) => a - b);
    centres = topUp(centres, level, weight, size, levels).map((v) => snapLevel(v, levels));
  }
  // Shades, not values: the register counts *down* from white, so a level of 1.0
  // is shade 0 and a level of 0.0 is shade `levels - 1`.
  const shades = centres.map((v) => Math.round((1 - v) * (levels - 1)));
  return [...new Set(shades)].sort((a, b) => a - b);
}

/** Nearest displayable level to a working value in [0, 1]. */
function snapLevel(value: number, levels: number): number {
  const shade = Math.round((1 - clamp01(value)) * (levels - 1));
  return 1 - shade / (levels - 1);
}

/**
 * Replace collapsed centroids with the levels the fit serves worst.
 *
 * Two centroids can converge on the same level — routine on a lattice this
 * coarse — and a pool that came back short is hardware left unspent that no
 * number in the report would show, because the fit is internally consistent
 * either way. The same top-up `latticeKmeans` performs for colour.
 */
function topUp(
  centres: readonly number[],
  level: Float32Array,
  weight: Float32Array,
  size: number,
  levels: number,
): number[] {
  const kept = [...new Set(centres.map((v) => snapLevel(v, levels)))];
  while (kept.length < size) {
    let worst = -1;
    let worstError = -1;
    for (let candidate = 0; candidate < levels; candidate += 1) {
      const value = 1 - candidate / (levels - 1);
      if (kept.some((v) => Math.abs(v - value) < 1e-9)) continue;
      // How much taking this level would relieve: the weighted error of every
      // pixel it would serve better than anything already in the pool.
      let relief = 0;
      for (let i = 0; i < level.length; i += 1) {
        const current = nearest(kept, level[i] as number);
        const offered = Math.abs((level[i] as number) - value);
        if (offered < current) relief += (current - offered) * (weight[i] as number);
      }
      if (relief > worstError) {
        worstError = relief;
        worst = value;
      }
    }
    if (worst < 0) break;
    kept.push(worst);
  }
  return kept.sort((a, b) => b - a);
}

function nearest(values: readonly number[], target: number): number {
  let best = Infinity;
  for (const value of values) best = Math.min(best, Math.abs(value - target));
  return best;
}

/** Every `k`-subset of `0..n-1`, ascending — seventy of them at 8 choose 4. */
function combinations(n: number, k: number): number[][] {
  const out: number[][] = [];
  const build = (start: number, picked: number[]): void => {
    if (picked.length === k) {
      out.push([...picked]);
      return;
    }
    for (let i = start; i < n; i += 1) {
      picked.push(i);
      build(i + 1, picked);
      picked.pop();
    }
  };
  // A palette shorter than four is expressible — the hardware simply repeats an
  // entry — but never better, so the search is over full ones only.
  if (k <= n) build(0, []);
  else out.push(Array.from({ length: n }, (_, i) => i));
  return out;
}

/** Weighted error of one cell under one candidate palette. */
function cellCost(
  level: Float32Array,
  weight: Float32Array,
  width: number,
  x0: number,
  y0: number,
  cellW: number,
  cellH: number,
  subset: readonly number[],
  poolValue: readonly number[],
): number {
  let total = 0;
  for (let y = 0; y < cellH; y += 1) {
    for (let x = 0; x < cellW; x += 1) {
      const i = (y0 + y) * width + (x0 + x);
      const value = level[i] as number;
      let best = Infinity;
      for (const entry of subset) {
        const delta = Math.abs(value - (poolValue[entry] as number));
        if (delta < best) best = delta;
      }
      total += best * best * (weight[i] as number);
    }
  }
  return total;
}

/**
 * Which `count` of the candidate palettes the picture is given.
 *
 * Greedy, then swapped: take the palette that most reduces the total, repeat
 * until the slots are full, then try replacing each chosen palette with each
 * unchosen one while that helps. With seventy candidates the whole thing is a
 * few thousand passes over the cell list and it is deterministic, so a fit does
 * not vary with a seed the way a k-means one does.
 *
 * `allowed` narrows the candidate set — which is how a shared backdrop is
 * imposed without a second algorithm: fixing entry zero leaves exactly the
 * subsets that contain it, and this is still the same exact search over them.
 */
function choosePalettes(
  cost: Float64Array,
  cells: number,
  candidates: number,
  count: number,
  allowed?: readonly number[],
): number[] {
  const pool = allowed ?? Array.from({ length: candidates }, (_, i) => i);
  const best = new Float64Array(cells).fill(Infinity);
  const chosen: number[] = [];
  for (let slot = 0; slot < count && slot < pool.length; slot += 1) {
    let pick = -1;
    let pickTotal = Infinity;
    for (const c of pool) {
      if (chosen.includes(c)) continue;
      let total = 0;
      for (let cell = 0; cell < cells; cell += 1) {
        const value = cost[cell * candidates + c] as number;
        total += Math.min(best[cell] as number, value);
      }
      if (total < pickTotal) {
        pickTotal = total;
        pick = c;
      }
    }
    if (pick < 0) break;
    chosen.push(pick);
    for (let cell = 0; cell < cells; cell += 1) {
      const value = cost[cell * candidates + pick] as number;
      if (value < (best[cell] as number)) best[cell] = value;
    }
  }

  // Swap while it helps. Bounded rather than run to convergence, because the
  // gain after the first pass or two is under a part in a thousand and a fit is
  // on the tournament's clock.
  for (let round = 0; round < 4; round += 1) {
    let improved = false;
    for (let slot = 0; slot < chosen.length; slot += 1) {
      const without = chosen.filter((_, i) => i !== slot);
      let bestCandidate = chosen[slot] as number;
      let bestTotal = totalWith(cost, cells, candidates, [...without, bestCandidate]);
      for (const c of pool) {
        if (chosen.includes(c)) continue;
        const total = totalWith(cost, cells, candidates, [...without, c]);
        if (total < bestTotal - 1e-9) {
          bestTotal = total;
          bestCandidate = c;
          improved = true;
        }
      }
      chosen[slot] = bestCandidate;
    }
    if (!improved) break;
  }
  return chosen;
}

function totalWith(
  cost: Float64Array,
  cells: number,
  candidates: number,
  set: readonly number[],
): number {
  let total = 0;
  for (let cell = 0; cell < cells; cell += 1) {
    let best = Infinity;
    for (const c of set) {
      const value = cost[cell * candidates + c] as number;
      if (value < best) best = value;
    }
    total += best;
  }
  return total;
}

/**
 * Which of its cell's four entries each pixel takes.
 *
 * The one place `dither` reaches: a palette is already chosen, so this is the
 * ordinary quantiser with the cell's own four values as its targets. Error
 * diffusion crosses cell boundaries, which is right — the error is the picture's
 * and not the cell's, and a diffusion that reset at every eighth pixel would put
 * a visible grid on a gradient.
 */
function assignPixels(
  level: Float32Array,
  width: number,
  height: number,
  cellW: number,
  cellH: number,
  cellsX: number,
  cellsY: number,
  cellPalette: Uint16Array,
  values: readonly (readonly number[])[],
  dither: DitherAlg,
  strength: number,
): Uint8Array {
  const out = new Uint8Array(width * height);
  const amp = strength / 100;
  // A picture whose height is not a whole number of cells has rows below the
  // last one, and they are drawn with that row's palettes rather than skipped:
  // the grid stops at `cellsY`, the *image* does not.
  const paletteAt = (x: number, y: number): readonly number[] => {
    const col = Math.min(cellsX - 1, Math.floor(x / cellW));
    const row = Math.min(cellsY - 1, Math.floor(y / cellH));
    return values[cellPalette[row * cellsX + col] as number] ?? (values[0] as readonly number[]);
  };
  const pick = (palette: readonly number[], value: number): number => {
    let best = 0;
    let bestDelta = Infinity;
    for (let i = 0; i < palette.length; i += 1) {
      const delta = Math.abs(value - (palette[i] as number));
      if (delta < bestDelta) {
        bestDelta = delta;
        best = i;
      }
    }
    return best;
  };

  if (dither === "floyd-steinberg" || dither === "atkinson" || dither === "riemersma") {
    const work = Float32Array.from(level);
    for (let y = 0; y < height; y += 1) {
      const ltr = y % 2 === 0;
      const xs = ltr ? 0 : width - 1;
      const xe = ltr ? width : -1;
      const step = ltr ? 1 : -1;
      for (let x = xs; x !== xe; x += step) {
        const i = y * width + x;
        const palette = paletteAt(x, y);
        const value = clamp01(work[i] as number);
        const index = pick(palette, value);
        out[i] = index;
        diffuse(work, width, height, x, y, step, (value - (palette[index] as number)) * amp);
      }
    }
    return out;
  }

  if (dither === "bayer2" || dither === "bayer4" || dither === "bayer8") {
    const size = dither === "bayer2" ? 2 : dither === "bayer4" ? 4 : 8;
    const matrix = bayerMatrix(size);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const i = y * width + x;
        const threshold =
          ((matrix[(y % size) * size + (x % size)] as number) + 0.5) / (size * size);
        const value = clamp01((level[i] as number) + (threshold - 0.5) * amp * 0.4);
        out[i] = pick(paletteAt(x, y), value);
      }
    }
    return out;
  }

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = y * width + x;
      out[i] = pick(paletteAt(x, y), clamp01(level[i] as number));
    }
  }
  return out;
}

/** One pool level, as the palette entry the hardware holds. */
function colorOf(spec: ConsoleSpec, shade: number, levels: number): PaletteColor {
  const display: RGB8 = dacDecodeShade(spec.color.dac, shade);
  const grey = Math.round(255 * (1 - shade / (levels - 1)));
  return { codes: [shade], display, raw: { r: grey, g: grey, b: grey } };
}

/** Perceptual lightness per pixel, on Oklab's L rather than a luma formula. */
function luminance(img: LinImage): Float32Array {
  const n = img.width * img.height;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    const o = i * 3;
    out[i] = linearToOklab(
      img.data[o] as number,
      img.data[o + 1] as number,
      img.data[o + 2] as number,
    ).L;
  }
  return out;
}

/** `fit-tiled.ts`'s weighting in one dimension: contrast plus extremeness. */
function weightsOf(level: Float32Array, width: number, height: number): Float32Array {
  const out = new Float32Array(level.length);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = y * width + x;
      const value = level[i] as number;
      let contrast = 0;
      let count = 0;
      if (x > 0) {
        contrast += Math.abs(value - (level[i - 1] as number));
        count += 1;
      }
      if (x + 1 < width) {
        contrast += Math.abs(value - (level[i + 1] as number));
        count += 1;
      }
      if (y > 0) {
        contrast += Math.abs(value - (level[i - width] as number));
        count += 1;
      }
      if (y + 1 < height) {
        contrast += Math.abs(value - (level[i + width] as number));
        count += 1;
      }
      const local = count > 0 ? contrast / count : 0;
      const extreme = Math.abs(value - 0.5) * 2;
      out[i] = 1 + 6 * local + 0.5 * extreme;
    }
  }
  return out;
}

function percentile(values: Float32Array, p: number): number {
  const sorted = Float32Array.from(values).sort();
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))));
  return sorted[index] as number;
}

function diffuse(
  work: Float32Array,
  width: number,
  height: number,
  x: number,
  y: number,
  step: number,
  err: number,
): void {
  const add = (nx: number, ny: number, w: number): void => {
    if (nx < 0 || nx >= width || ny < 0 || ny >= height) return;
    work[ny * width + nx] = (work[ny * width + nx] as number) + err * w;
  };
  add(x + step, y, 7 / 16);
  add(x - step, y + 1, 3 / 16);
  add(x, y + 1, 5 / 16);
  add(x + step, y + 1, 1 / 16);
}

function bayerMatrix(size: 2 | 4 | 8): number[] {
  if (size === 2) return [0, 2, 3, 1];
  const b4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
  if (size === 4) return b4;
  const out = new Array<number>(64);
  for (let y = 0; y < 8; y += 1) {
    for (let x = 0; x < 8; x += 1) {
      const q = b4[(y % 4) * 4 + (x % 4)] as number;
      const sub = ((y >> 2) << 1) | (x >> 2);
      out[y * 8 + x] = q * 4 + sub;
    }
  }
  return out;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
