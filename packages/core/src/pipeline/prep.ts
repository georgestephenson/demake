/**
 * `prep` — the conversion pipeline orchestrator (doc 04, doc 09).
 *
 * Ties the stage library into the tournament: decode → analyze → (per candidate)
 * geometry → fit → dither → budget → DAC-render → judge → winner → encode. Every
 * stage is deterministic and the candidate set is a pure function of (analysis,
 * console, options), so the whole run is reproducible. The tournament is
 * invisible by default — one image in, one image out — with the full scoreboard
 * available in the result for `--json`/`-v` and for pinning `--strategy`.
 */

import { DemakeError } from "../errors.js";
import { makePrng } from "../math/prng.js";
import { authorSpaceUsesRaw } from "../image/dac.js";
import { decodeImage } from "../image/decode.js";
import { getConsole } from "../consoles/registry.js";
import type { ConsoleSpec, TileLayout } from "../consoles/types.js";
import { checkCompliantImage } from "../inspect/inspect.js";
import { referenceLab, scoreLab, labFromRgba, palettePressure } from "../inspect/judge.js";

import { analyze } from "./analyze.js";
import { enforceBudget } from "./budget.js";
import { encodeCompliantPng, renderCompliant } from "./encode-image.js";
import { applyGrade } from "./grade.js";
import { fitTiled, type FitParams } from "./fit-tiled.js";
import { fitTms } from "./fit-tms.js";
import { chooseAutoSize, resize, snapExplicitSize } from "./geometry.js";
import { makeColorSpace, type HwColor, type HwColorSpace } from "./hwcolor.js";
import { fitMono } from "./mono.js";
import { normalize } from "./normalize.js";
import { buildPortfolio, effortParams, type Candidate } from "./portfolio.js";
import { remap } from "./remap.js";
import type {
  AutoDecisions,
  CandidateScore,
  CompliantImage,
  PrepOptions,
  PrepResult,
  Profile,
} from "./types.js";

const DEFAULT_SEED = 0x9e3779b9;

/** Run one candidate to a compliant image + its budget result. */
function runCandidate(
  candidate: Candidate,
  srcLin: ReturnType<typeof normalize>,
  spec: ConsoleSpec,
  size: { w: number; h: number },
  profile: Profile,
  opts: PrepOptions,
): { image: CompliantImage; uniqueTiles: number; merges: number; budget: number | null } {
  const seed = (opts.seed ?? DEFAULT_SEED) >>> 0;
  const prng = makePrng(seed);
  let work = resize(srcLin, size.w, size.h, candidate.scale);
  // Graded candidates exaggerate tone/chroma before fitting (doc 04 §The
  // tournament); the judge still scores them against the ungraded reference.
  if (candidate.grade) {
    work = applyGrade(work, candidate.grade);
  }
  const strict = opts.strict === true;

  if (candidate.kind === "mono" || candidate.kind === "tms") {
    const image =
      candidate.kind === "mono"
        ? fitMono(work, spec, candidate.dither.alg, candidate.dither.strength)
        : fitTms(work, spec, candidate.dither.alg, candidate.dither.strength);
    const budget = enforceBudget(image, spec, strict);
    return {
      image: budget.image,
      uniqueTiles: budget.uniqueTiles,
      merges: budget.merges,
      budget: budget.budget,
    };
  }

  const eff = effortParams(opts.effort ?? "default");
  const params: FitParams = {
    restarts: eff.restarts,
    kmeansIters: eff.kmeansIters,
    refineRounds: eff.refineRounds,
    lWeight: profile === "art" ? 1.2 : 1,
    denoise: candidate.clean === true,
    collapse: candidate.clean === true,
  };
  const space = makeColorSpace(spec);
  const layout = spec.layout as TileLayout;
  const reserved = layout.subPalettes.sharedIndex0 ? computeBackdrop(work, space) : null;
  const fit = fitTiled(work, spec, space, prng, params, reserved);
  const image = remap(
    fit,
    spec,
    size.w,
    size.h,
    candidate.dither.alg,
    candidate.dither.strength,
    params.lWeight,
  );
  const budget = enforceBudget(image, spec, strict);
  return {
    image: budget.image,
    uniqueTiles: budget.uniqueTiles,
    merges: budget.merges,
    budget: budget.budget,
  };
}

/**
 * The shared backdrop for a `sharedIndex0` console: the single displayable color
 * the most pixels snap to (deterministic mode, lowest-code tiebreak). Forced into
 * index 0 of every sub-palette so the whole frame shares one universal backdrop.
 */
function computeBackdrop(work: ReturnType<typeof normalize>, space: HwColorSpace): HwColor {
  const counts = new Map<string, { color: HwColor; n: number }>();
  const n = work.width * work.height;
  for (let i = 0; i < n; i += 1) {
    const o = i * 3;
    const c = space.snapLinear(work.data[o]!, work.data[o + 1]!, work.data[o + 2]!);
    const k = c.codes.join(",");
    const e = counts.get(k);
    if (e) e.n += 1;
    else counts.set(k, { color: c, n: 1 });
  }
  let best: HwColor | null = null;
  let bestN = -1;
  let bestKey = "";
  for (const [k, v] of counts) {
    if (v.n > bestN || (v.n === bestN && k < bestKey)) {
      bestN = v.n;
      best = v.color;
      bestKey = k;
    }
  }
  return best ?? space.snapLinear(0, 0, 0);
}

/** Convert an arbitrary source image into a hardware-compliant image (doc 09). */
export async function prep(input: Uint8Array, options: PrepOptions): Promise<PrepResult> {
  const spec = getConsole(options.console);
  const source = decodeImage(input);
  const analysis = analyze(source);
  const profile: Profile =
    options.profile && options.profile !== "auto" ? options.profile : analysis.profile;

  const size = options.size
    ? snapExplicitSize(options.size.w, options.size.h, spec)
    : chooseAutoSize(source.width, source.height, spec);
  if (size.w <= 0 || size.h <= 0) {
    throw new DemakeError("E_INVALID_SIZE", `computed an empty output size for ${spec.id}`, {
      hint: "pass an explicit --size WxH that is a positive multiple of the tile size.",
    });
  }

  // Output/judging color space: raw lattice expansion in the console's author
  // space (panel-filter DACs like the CGB LCD are simulation-only), DAC-decoded
  // otherwise; `--raw-colors` / `--dac-colors` force one or the other.
  const useRaw =
    options.dacColors === true
      ? false
      : options.rawColors === true || authorSpaceUsesRaw(spec.color.dac);

  const srcLin = normalize(source, options.background ?? "#000000");
  const candidates = buildPortfolio(spec, analysis, options);
  if (candidates.length === 0) {
    throw new DemakeError(
      "E_INVALID_OPTION",
      `no candidate matches strategy '${options.strategy}'`,
      {
        hint: "run with --strategy list to see available candidates.",
      },
    );
  }

  const refLab = referenceLab(srcLin, size.w, size.h, profile === "art" ? "art" : "photo");
  // Palette pressure slides judge weights from absolute fidelity toward
  // separation/structure as the console's budget falls short of the source's
  // diversity (doc 04 §The objective).
  const pressure = palettePressure(refLab, size.w * size.h, spec);
  const scores: CandidateScore[] = [];
  let winner: {
    candidate: Candidate;
    image: CompliantImage;
    aggregate: number;
    uniqueTiles: number;
    merges: number;
    budget: number | null;
    rawMean: number;
    rawP95: number;
  } | null = null;

  for (let ci = 0; ci < candidates.length; ci += 1) {
    const candidate = candidates[ci]!;
    options.onProgress?.(`candidate:${candidate.id}`, (ci + 1) / candidates.length);
    if (options.signal?.aborted) {
      throw new DemakeError("E_INTERNAL", "prep aborted");
    }

    const run = runCandidate(candidate, srcLin, spec, size, profile, options);
    const violations = checkCompliantImage(run.image, spec);
    if (violations.length > 0) {
      scores.push({
        strategy: candidate.id,
        aggregate: 0,
        metrics: {},
        disqualified: { reason: violations.map((v) => v.code).join(",") },
      });
      continue;
    }

    const rendered = renderCompliant(run.image, useRaw);
    const resLab = labFromRgba(rendered);
    const judged = scoreLab(
      refLab,
      resLab,
      size.w,
      size.h,
      profile === "art" ? "art" : "photo",
      pressure,
    );
    scores.push({ strategy: candidate.id, aggregate: judged.aggregate, metrics: judged.metrics });

    if (!winner || judged.aggregate > winner.aggregate) {
      winner = {
        candidate,
        image: run.image,
        aggregate: judged.aggregate,
        uniqueTiles: run.uniqueTiles,
        merges: run.merges,
        budget: run.budget,
        rawMean: judged.rawMeanDeltaE,
        rawP95: judged.rawP95DeltaE,
      };
    }
  }

  if (!winner) {
    throw new DemakeError("E_NO_VALID_CANDIDATE", "every candidate was disqualified", {
      hint: "this is an internal invariant failure; please file a bug with the input.",
    });
  }

  const png = encodeCompliantPng(winner.image, useRaw);
  const decisions: AutoDecisions = {
    profile: profile === "art" ? "art" : "photo",
    size,
    scale: winner.candidate.scale,
    dither: winner.candidate.dither,
    strategy: winner.candidate.id,
  };
  const warnings =
    winner.merges > 0
      ? [{ code: "W_TILE_MERGE", message: `${winner.merges} tiles merged to fit the VRAM budget` }]
      : [];

  return {
    png,
    image: winner.image,
    decisions,
    stats: {
      meanDeltaE: winner.rawMean,
      p95DeltaE: winner.rawP95,
      palettePressure: pressure,
      uniqueTiles: winner.uniqueTiles,
      tileBudget: winner.budget,
      tileMerges: winner.merges,
      restarts: effortParams(options.effort ?? "default").restarts,
    },
    warnings,
    tournament: { winner: winner.candidate.id, candidates: scores },
  };
}
