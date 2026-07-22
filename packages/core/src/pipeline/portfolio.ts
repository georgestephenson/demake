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
import type { DitherAlg, Effort, PrepOptions, Profile, ScaleKernel } from "./types.js";

/** A concrete candidate strategy. */
export interface Candidate {
  id: string;
  kind: "tiled" | "mono";
  scale: ScaleKernel;
  dither: { alg: DitherAlg; strength: number };
  affinity: Profile;
  description: string;
}

const TILED_PORTFOLIO: readonly Candidate[] = [
  {
    id: "art-majority-flat",
    kind: "tiled",
    scale: "majority",
    dither: { alg: "none", strength: 0 },
    affinity: "art",
    description: "Majority downscale, hard palette fit, no dither (the predecessor recipe).",
  },
  {
    id: "art-majority-bayer2",
    kind: "tiled",
    scale: "majority",
    dither: { alg: "bayer2", strength: 60 },
    affinity: "art",
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

/** The full candidate list for a console (for `--strategy list` / introspection). */
export function portfolioFor(spec: ConsoleSpec): readonly Candidate[] {
  return spec.color.model === "mono" ? MONO_PORTFOLIO : TILED_PORTFOLIO;
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
        kind: spec.color.model === "mono" ? "mono" : "tiled",
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
