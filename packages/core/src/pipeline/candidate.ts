/**
 * One candidate of the tournament, start to finish (doc 04 §Running the
 * tournament).
 *
 * Split out of `prep.ts` because a candidate is the engine's unit of parallel
 * work: it takes source *bytes* and a candidate description, both of which
 * survive a structured clone, and returns a compliant image and its score, which
 * also do. That is the whole reason the split exists — the same function runs on
 * this thread when nobody supplied an executor and on a worker when somebody
 * did, and there is only one of it, so the two cannot disagree.
 *
 * What it does *not* take is the decoded source. Candidates differ in their scale
 * kernel, so each one resizes from the full-resolution linear image, and shipping
 * a 640×576 source as 4.4 MB of `Float32Array` to every candidate would cost more
 * than the fit does. Instead the prologue — decode, normalize, the reference
 * image the judge scores against — is derived here and memoised by content, so a
 * worker handed nine candidates for one picture rasterises it once. That is a
 * speed optimisation over a pure function and must never become one that changes
 * bytes, which is why a cache hit re-compares the source bytes rather than
 * trusting the digest (§The prologue cache below).
 */

import { DemakeError } from "../errors.js";
import { crc32 } from "../image/png/checksums.js";
import { authorSpaceUsesRaw } from "../image/dac.js";
import { decodeImage } from "../image/decode.js";
import type { RgbaImage } from "../image/rgba.js";
import { getConsole, withMode } from "../consoles/registry.js";
import type { ConsoleSpec, TileLayout } from "../consoles/types.js";
import { makePrng } from "../math/prng.js";
import { defineJob } from "../parallel/jobs.js";
import { checkCompliantImage } from "../inspect/inspect.js";
import { referenceLab, scoreLab, labFromRgba, palettePressure } from "../inspect/judge.js";

import { analyze, type Analysis } from "./analyze.js";
import { enforceBudget } from "./budget.js";
import { renderCompliant } from "./encode-image.js";
import { applyGrade } from "./grade.js";
import { fitTiled, type FitParams } from "./fit-tiled.js";
import { fitTms } from "./fit-tms.js";
import { chooseAutoSize, resize, snapExplicitSize } from "./geometry.js";
import { makeColorSpace, type HwColor, type HwColorSpace } from "./hwcolor.js";
import { fitMono } from "./mono.js";
import { fitMonoTiled } from "./fit-mono-tiled.js";
import { normalize } from "./normalize.js";
import { effortParams, type Candidate } from "./portfolio.js";
import { remap } from "./remap.js";
import type { CandidateScore, CompliantImage, LinImage, PrepOptions, Profile } from "./types.js";

/** The seed every candidate's PRNG starts from when the caller names none. */
export const DEFAULT_SEED = 0x9e3779b9;

/**
 * {@link PrepOptions} without the members that cannot cross a thread.
 *
 * `onProgress` is a closure, `signal` is a live object, and `executor` is the
 * thing doing the carrying — all three belong to the calling thread and none of
 * them means anything on a worker. Everything else about a conversion is data,
 * which is what makes the fan-out possible at all.
 */
export type PortablePrepOptions = Omit<PrepOptions, "onProgress" | "signal" | "executor">;

/** Drop the members a job cannot carry. */
export function portableOptions(options: PrepOptions): PortablePrepOptions {
  const { onProgress, signal, executor, ...portable } = options;
  void onProgress;
  void signal;
  void executor;
  return portable;
}

/** What one candidate needs to know, and all of it structured-cloneable. */
export interface CandidateJob {
  readonly source: Uint8Array;
  readonly options: PortablePrepOptions;
  /**
   * The candidate itself, not its name.
   *
   * A pinned stage flag can synthesize a candidate no portfolio lists, so a name
   * is not enough to find one again — shipping the description avoids a lookup
   * that would work for the nine curated candidates and fail for the tenth.
   */
  readonly candidate: Candidate;
}

/** What one candidate produced: its score, and its image if it was compliant. */
export interface CandidateOutcome {
  readonly score: CandidateScore;
  /** `null` when the candidate was disqualified, which is when nothing scored it. */
  readonly image: CompliantImage | null;
  readonly uniqueTiles: number;
  readonly merges: number;
  readonly budget: number | null;
  readonly rawMeanDeltaE: number;
  readonly rawP95DeltaE: number;
  /**
   * The palette pressure the judge's weights were slid by (doc 04 §The
   * objective).
   *
   * A property of the source and the console rather than of this candidate, so
   * every candidate computes the same number — it is reported from here anyway
   * because deriving it costs a full-resolution normalize and a reference image,
   * and the thread running the tournament has no other reason to build either.
   */
  readonly palettePressure: number;
}

/**
 * What a source means before any candidate is chosen: which console, how big the
 * output is, whether it is authored in raw lattice colors, and what the analysis
 * made of it.
 *
 * The half the tournament reads. Deriving it costs a decode, which for an SVG
 * title screen is a rasterise.
 */
export interface SourceAnalysis {
  readonly spec: ConsoleSpec;
  readonly analysis: Analysis;
  readonly profile: Profile;
  readonly size: { w: number; h: number };
  /** Whether output and judging happen in raw lattice colors (doc 04 §Author space). */
  readonly useRaw: boolean;
}

/**
 * What a candidate is fitted from and judged against.
 *
 * The half only a candidate reads, and much the more expensive: a
 * full-resolution linear image (candidates each resize it with their own kernel,
 * so it cannot be pre-shrunk) plus the reference the judge scores against. Kept
 * apart from {@link SourceAnalysis} precisely so the thread running a fan-out
 * never builds it — every candidate needs it, and every candidate is somewhere
 * else.
 */
export interface JudgeReference {
  readonly srcLin: LinImage;
  readonly refLab: ReturnType<typeof referenceLab>;
  readonly pressure: number;
}

/**
 * The prologue cache.
 *
 * Two entries, because the thing it exists for is a fan-out: one source spread
 * over N candidates, and a build that converts two backdrops concurrently
 * interleaves two of those. An entry that has been asked for its reference holds
 * a full-resolution linear image, so a third would cost several megabytes a
 * worker to serve a case that does not arise.
 *
 * The key is a digest, but a hit is confirmed by comparing the source bytes
 * themselves. A digest collision here would hand a picture somebody else's
 * pixels, and "unlikely" is not the standard an output-byte guarantee is held
 * to — the comparison costs microseconds against a decode's hundreds of
 * milliseconds.
 *
 * The reference is built on first demand rather than with the entry, which is
 * what keeps a tournament's own thread paying only for the decode it genuinely
 * needs.
 */
const PREPARED_CACHE_ENTRIES = 2;

interface CacheEntry {
  readonly key: string;
  readonly source: Uint8Array;
  /** Held so the reference does not re-decode: for an SVG that is a re-rasterise. */
  readonly decoded: RgbaImage;
  readonly analysis: SourceAnalysis;
  reference?: JudgeReference;
}

const preparedCache: CacheEntry[] = [];

/** Whether two sources are the same bytes. */
function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * A stable key for the options a prologue depends on.
 *
 * Everything but the strategy, because the strategy is what varies across a
 * fan-out and nothing in the prologue reads it. Over-keying is safe and
 * under-keying is not, so every other field goes in whether or not it matters —
 * a field that gains prologue significance later must not also need remembering
 * here.
 */
function optionsKey(options: PortablePrepOptions): string {
  const entries = Object.entries(options)
    .filter(([name]) => name !== "strategy")
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify(entries);
}

/** Find (or make) this source's cache entry. */
function entryFor(source: Uint8Array, options: PortablePrepOptions): CacheEntry {
  const key = `${crc32(source)}:${source.length}:${optionsKey(options)}`;
  const hit = preparedCache.find((entry) => entry.key === key && sameBytes(entry.source, source));
  if (hit) return hit;

  const decoded = decodeImage(source);
  const entry: CacheEntry = { key, source, decoded, analysis: deriveAnalysis(decoded, options) };
  preparedCache.unshift(entry);
  if (preparedCache.length > PREPARED_CACHE_ENTRIES) preparedCache.length = PREPARED_CACHE_ENTRIES;
  return entry;
}

/** What the source is, and how big its conversion comes out. */
export function analyzeSource(source: Uint8Array, options: PortablePrepOptions): SourceAnalysis {
  return entryFor(source, options).analysis;
}

/** What a candidate is fitted from and judged against, built on first demand. */
export function judgeReference(source: Uint8Array, options: PortablePrepOptions): JudgeReference {
  const entry = entryFor(source, options);
  entry.reference ??= deriveReference(entry.decoded, options, entry.analysis);
  return entry.reference;
}

function deriveAnalysis(decoded: RgbaImage, options: PortablePrepOptions): SourceAnalysis {
  const spec = withMode(getConsole(options.console), options.mode);
  const analysis = analyze(decoded);
  const profile: Profile =
    options.profile && options.profile !== "auto" ? options.profile : analysis.profile;

  const size = options.size
    ? snapExplicitSize(options.size.w, options.size.h, spec)
    : chooseAutoSize(decoded.width, decoded.height, spec);
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

  return { spec, analysis, profile, size, useRaw };
}

function deriveReference(
  decoded: RgbaImage,
  options: PortablePrepOptions,
  analysed: SourceAnalysis,
): JudgeReference {
  const { spec, profile, size } = analysed;
  const srcLin = normalize(decoded, options.background ?? "#000000");
  const refLab = referenceLab(srcLin, size.w, size.h, profile === "art" ? "art" : "photo");
  // Palette pressure slides judge weights from absolute fidelity toward
  // separation/structure as the console's budget falls short of the source's
  // diversity (doc 04 §The objective).
  const pressure = palettePressure(refLab, size.w * size.h, spec);
  return { srcLin, refLab, pressure };
}

/** Run one candidate to a compliant image + its budget result. */
function fit(
  candidate: Candidate,
  analysed: SourceAnalysis,
  reference: JudgeReference,
  options: PortablePrepOptions,
): { image: CompliantImage; uniqueTiles: number; merges: number; budget: number | null } {
  const { spec, size, profile } = analysed;
  const seed = (options.seed ?? DEFAULT_SEED) >>> 0;
  const prng = makePrng(seed);
  let work = resize(reference.srcLin, size.w, size.h, candidate.scale);
  // Graded candidates exaggerate tone/chroma before fitting (doc 04 §The
  // tournament); the judge still scores them against the ungraded reference.
  if (candidate.grade) {
    work = applyGrade(work, candidate.grade);
  }
  const strict = options.strict === true;

  if (candidate.kind === "mono" || candidate.kind === "mono-tiled" || candidate.kind === "tms") {
    const image =
      candidate.kind === "mono"
        ? fitMono(work, spec, candidate.dither.alg, candidate.dither.strength)
        : candidate.kind === "mono-tiled"
          ? // The one fit that chooses its own shades as well as what indexes
            // them, so `maxSubPalettes` reaches it the way it reaches the tiled
            // fitter — a game keeps one palette back for its font.
            fitMonoTiled(
              work,
              spec,
              candidate.dither.alg,
              candidate.dither.strength,
              options.maxSubPalettes,
            )
          : fitTms(work, spec, candidate.dither.alg, candidate.dither.strength);
    const budget = enforceBudget(image, spec, strict, options.maxTiles);
    return {
      image: budget.image,
      uniqueTiles: budget.uniqueTiles,
      merges: budget.merges,
      budget: budget.budget,
    };
  }

  const eff = effortParams(options.effort ?? "default");
  const params: FitParams = {
    restarts: eff.restarts,
    kmeansIters: eff.kmeansIters,
    refineRounds: eff.refineRounds,
    lWeight: profile === "art" ? 1.2 : 1,
    denoise: candidate.clean === true,
    collapse: candidate.clean === true,
    ...(options.maxSubPalettes === undefined ? {} : { maxPalettes: options.maxSubPalettes }),
    ...(options.maxColors === undefined ? {} : { maxColors: options.maxColors }),
  };
  const space = makeColorSpace(spec);
  const layout = spec.layout as TileLayout;
  const reserved = layout.subPalettes.sharedIndex0 ? computeBackdrop(work, space) : null;
  const fitted = fitTiled(work, spec, space, prng, params, reserved);
  const image = remap(
    fitted,
    spec,
    size.w,
    size.h,
    candidate.dither.alg,
    candidate.dither.strength,
    params.lWeight,
  );
  const budget = enforceBudget(image, spec, strict, options.maxTiles);
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
function computeBackdrop(work: LinImage, space: HwColorSpace): HwColor {
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

/**
 * Convert one candidate and judge it.
 *
 * The compliance check comes first and is absolute: a candidate the hardware
 * could not display is disqualified with the violation codes that say why, and is
 * never scored — a number would imply it was in the running.
 */
export function runCandidate(input: CandidateJob): CandidateOutcome {
  const { candidate, options } = input;
  const analysed = analyzeSource(input.source, options);
  const reference = judgeReference(input.source, options);
  const { spec, size, profile, useRaw } = analysed;
  const { refLab, pressure } = reference;

  const run = fit(candidate, analysed, reference, options);
  const violations = checkCompliantImage(run.image, spec);
  if (violations.length > 0) {
    return {
      score: {
        strategy: candidate.id,
        aggregate: 0,
        metrics: {},
        disqualified: { reason: violations.map((v) => v.code).join(",") },
      },
      image: null,
      uniqueTiles: run.uniqueTiles,
      merges: run.merges,
      budget: run.budget,
      rawMeanDeltaE: 0,
      rawP95DeltaE: 0,
      palettePressure: pressure,
    };
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

  return {
    score: { strategy: candidate.id, aggregate: judged.aggregate, metrics: judged.metrics },
    image: run.image,
    uniqueTiles: run.uniqueTiles,
    merges: run.merges,
    budget: run.budget,
    rawMeanDeltaE: judged.rawMeanDeltaE,
    rawP95DeltaE: judged.rawP95DeltaE,
    palettePressure: pressure,
  };
}

/** The candidate job, as an executor sees it. */
export const candidateJob = defineJob<CandidateJob, CandidateOutcome>(
  "core.prep.candidate",
  runCandidate,
);
