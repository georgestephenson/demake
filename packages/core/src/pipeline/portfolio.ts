/**
 * The candidate portfolio (doc 04 §The tournament).
 *
 * A candidate is a named, complete assignment of stage choices (scale kernel ×
 * dither × …). The portfolio is curated — each entry exists because it wins
 * somewhere: `art-majority-flat` is the predecessor recipe (majority scale, no
 * dither); `photo-lanczos-fs` is Lanczos + serpentine Floyd–Steinberg; and so
 * on. Source analysis orders the portfolio and, under `--effort fast`, picks the
 * single candidate. Explicit stage flags don't disable the tournament — they
 * *constrain* the portfolio to matching candidates (pinning every dimension
 * degenerates to one candidate).
 */

import type { ConsoleSpec } from "../consoles/types.js";

import type { Analysis } from "./analyze.js";
import type { GradeId } from "./grade.js";
import type { DitherAlg, Effort, PrepOptions, Profile, ScaleKernel } from "./types.js";

/** A concrete candidate strategy. */
export interface Candidate {
  id: string;
  kind: "tiled" | "mono" | "tms";
  scale: ScaleKernel;
  dither: { alg: DitherAlg; strength: number };
  affinity: Profile;
  /**
   * Flat-art recovery: denoise to a master palette before the constrained fit
   * and collapse k-means centroids to real member colors (doc 04 §Stage 3/4).
   * On by the `art` candidates; photos keep the smoother mean centroids.
   */
  clean?: boolean;
  /**
   * Bounded pre-quantization grade (doc 04 §The tournament): tonal stretch +
   * chroma boost applied before fitting. The judge scores graded candidates
   * against the *ungraded* reference via grade-aligned metrics, so a grade
   * wins only when spending the palette on an exaggerated range actually
   * reads better — typically under high palette pressure.
   */
  grade?: GradeId;
  description: string;
}

/** Whether a spec uses the TMS9918 Graphics II ("row-pair") fit path. */
export function isTms(spec: ConsoleSpec): boolean {
  return spec.layout.kind === "scanline" && spec.layout.strategy === "tms-rowpair";
}

const TILED_PORTFOLIO: readonly Candidate[] = [
  {
    id: "art-majority-flat",
    kind: "tiled",
    scale: "majority",
    dither: { alg: "none", strength: 0 },
    affinity: "art",
    clean: true,
    description: "Majority downscale, hard palette fit, no dither (the predecessor recipe).",
  },
  {
    id: "art-majority-bayer2",
    kind: "tiled",
    scale: "majority",
    dither: { alg: "bayer2", strength: 60 },
    affinity: "art",
    clean: true,
    description: "Majority downscale with a light ordered dither for subtle shading.",
  },
  {
    id: "photo-lanczos-fs",
    kind: "tiled",
    scale: "lanczos3",
    dither: { alg: "floyd-steinberg", strength: 90 },
    affinity: "photo",
    description: "Lanczos3 downscale, serpentine Floyd–Steinberg diffusion.",
  },
  {
    id: "photo-box-bayer4",
    kind: "tiled",
    scale: "box",
    dither: { alg: "bayer4", strength: 80 },
    affinity: "photo",
    description: "Box downscale, ordered Bayer 4×4 (CRT-era look).",
  },
  {
    id: "photo-lanczos-atkinson",
    kind: "tiled",
    scale: "lanczos3",
    dither: { alg: "atkinson", strength: 100 },
    affinity: "photo",
    description: "Lanczos3 downscale, Atkinson diffusion (crisper, lighter).",
  },
  {
    id: "art-majority-flat-expand",
    kind: "tiled",
    scale: "majority",
    dither: { alg: "none", strength: 0 },
    affinity: "art",
    clean: true,
    grade: "expand",
    description: "The flat-art recipe with a bounded tonal/chroma expansion first.",
  },
  {
    id: "photo-lanczos-fs-expand",
    kind: "tiled",
    scale: "lanczos3",
    dither: { alg: "floyd-steinberg", strength: 90 },
    affinity: "photo",
    grade: "expand",
    description: "Lanczos3 + Floyd–Steinberg over a bounded tonal/chroma expansion.",
  },
  {
    id: "photo-lanczos-fs-punchy",
    kind: "tiled",
    scale: "lanczos3",
    dither: { alg: "floyd-steinberg", strength: 90 },
    affinity: "photo",
    grade: "punchy",
    description: "Lanczos3 + Floyd–Steinberg over a strong artist-style grade.",
  },
  {
    id: "photo-lanczos-atkinson-punchy",
    kind: "tiled",
    scale: "lanczos3",
    dither: { alg: "atkinson", strength: 100 },
    affinity: "photo",
    grade: "punchy",
    description: "Lanczos3 + Atkinson over a strong artist-style grade.",
  },
];

const MONO_PORTFOLIO: readonly Candidate[] = [
  {
    id: "mono-flat",
    kind: "mono",
    scale: "majority",
    dither: { alg: "none", strength: 0 },
    affinity: "art",
    description: "Luminance split, no dither — flat cel shading.",
  },
  {
    id: "mono-fs",
    kind: "mono",
    scale: "lanczos3",
    dither: { alg: "floyd-steinberg", strength: 90 },
    affinity: "photo",
    description: "Luminance split with Floyd–Steinberg diffusion.",
  },
  {
    id: "mono-bayer4",
    kind: "mono",
    scale: "box",
    dither: { alg: "bayer4", strength: 80 },
    affinity: "photo",
    description: "Luminance split with ordered Bayer 4×4.",
  },
];

const TMS_PORTFOLIO: readonly Candidate[] = [
  {
    id: "tms-flat",
    kind: "tms",
    scale: "majority",
    dither: { alg: "none", strength: 0 },
    affinity: "art",
    description: "Per-row two-color fit, no dither — flat cel shading.",
  },
  {
    id: "tms-fs",
    kind: "tms",
    scale: "lanczos3",
    dither: { alg: "floyd-steinberg", strength: 90 },
    affinity: "photo",
    description: "Per-row two-color fit with Floyd–Steinberg diffusion.",
  },
  {
    id: "tms-bayer4",
    kind: "tms",
    scale: "box",
    dither: { alg: "bayer4", strength: 80 },
    affinity: "photo",
    description: "Per-row two-color fit with ordered Bayer 4×4.",
  },
];

/** The full candidate list for a console (for `--strategy list` / introspection). */
export function portfolioFor(spec: ConsoleSpec): readonly Candidate[] {
  if (spec.color.model === "mono") return MONO_PORTFOLIO;
  if (isTms(spec)) return TMS_PORTFOLIO;
  return TILED_PORTFOLIO;
}

/** Optimizer knobs derived from `--effort`. */
export function effortParams(effort: Effort): {
  restarts: number;
  kmeansIters: number;
  refineRounds: number;
} {
  switch (effort) {
    case "fast":
      return { restarts: 1, kmeansIters: 6, refineRounds: 3 };
    case "max":
      return { restarts: 10, kmeansIters: 16, refineRounds: 10 };
    case "default":
    default:
      return { restarts: 4, kmeansIters: 10, refineRounds: 6 };
  }
}

/**
 * Select and order the candidates to run for this (console, source, options).
 *
 * `fast` returns a single analysis-picked candidate; explicit `--scale` /
 * `--dither` filter the list; `--strategy <name>` pins exactly one.
 */
export function buildPortfolio(
  spec: ConsoleSpec,
  analysis: Analysis,
  opts: PrepOptions,
): Candidate[] {
  const all = portfolioFor(spec);

  if (opts.strategy && opts.strategy !== "auto" && opts.strategy !== "list") {
    const pinned = all.find((c) => c.id === opts.strategy);
    return pinned ? [pinned] : [];
  }

  const profile: Profile =
    opts.profile && opts.profile !== "auto" ? opts.profile : analysis.profile;

  let candidates = all.filter((c) => {
    if (opts.scale && opts.scale !== "auto" && c.scale !== opts.scale) return false;
    if (opts.dither && c.dither.alg !== opts.dither.alg) return false;
    return true;
  });
  if (candidates.length === 0) {
    // A pinned stage flag that no curated candidate matches: synthesize one.
    candidates = [
      {
        id: `custom-${opts.scale ?? "auto"}-${opts.dither?.alg ?? "none"}`,
        kind: spec.color.model === "mono" ? "mono" : isTms(spec) ? "tms" : "tiled",
        scale:
          opts.scale && opts.scale !== "auto"
            ? opts.scale
            : profile === "art"
              ? "majority"
              : "lanczos3",
        dither: opts.dither
          ? { alg: opts.dither.alg, strength: opts.dither.strength ?? 80 }
          : { alg: "none", strength: 0 },
        affinity: profile,
        clean: profile === "art",
        description: "Custom candidate from pinned stage flags.",
      },
    ];
  }

  // Order by profile affinity (matching first), then by id for determinism.
  candidates = [...candidates].sort((a, b) => {
    const am = a.affinity === profile ? 0 : 1;
    const bm = b.affinity === profile ? 0 : 1;
    return am - bm || a.id.localeCompare(b.id);
  });

  const effort = opts.effort ?? "default";
  if (effort === "fast") {
    return candidates.slice(0, 1);
  }
  return candidates;
}
