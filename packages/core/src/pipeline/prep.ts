/**
 * `prep` — the conversion pipeline orchestrator (doc 04, doc 09).
 *
 * Ties the stage library into the tournament: decode → analyze → (per candidate)
 * geometry → fit → dither → budget → DAC-render → judge → winner → encode. Every
 * stage is deterministic and the candidate set is a pure function of (analysis,
 * console, options), so the whole run is reproducible. The tournament is
 * invisible by default — one image in, one image out — with the full scoreboard
 * available in the result for `--json`/`-v` and for pinning `--strategy`.
 *
 * What lives here is only the tournament: derive the shared prologue, ask for
 * every candidate at once, and reduce the answers. Running a candidate is
 * `candidate.ts`, because that is the unit an {@link Executor} spreads across
 * cores — the CLI's over `worker_threads`, the page's over Web Workers, and the
 * default right here in order. The reduce is deliberately written over the
 * candidate list rather than over arrival order: the winner is the first strict
 * improvement in portfolio order, so a machine with more cores must not be able
 * to break a tie differently (doc 04 §Running the tournament).
 */

import { DemakeError } from "../errors.js";
import { inlineExecutor, jobHandlers, unwrap, type Executor } from "../parallel/jobs.js";

import {
  analyzeSource,
  candidateJob,
  portableOptions,
  type CandidateOutcome,
} from "./candidate.js";
import { encodeCompliantPng } from "./encode-image.js";
import { buildPortfolio, effortParams, type Candidate } from "./portfolio.js";
import type { AutoDecisions, CandidateScore, PrepOptions, PrepResult } from "./types.js";

/** The engine's own job kinds, for an edge assembling a worker's dispatch table. */
export const coreJobKinds = [candidateJob];

/** Run candidates here, in order — the default, and the reference answer. */
const inline: Executor = inlineExecutor(jobHandlers(coreJobKinds));

/**
 * Convert an arbitrary source image into a hardware-compliant image (doc 09).
 *
 * `prep` is the entry point almost everything uses. It is `async` because the
 * tournament may be spread over other threads, not because the conversion
 * suspends — with no `executor` in the options nothing leaves this one, and the
 * result is the same bytes either way. That equality is the contract the whole
 * fan-out rests on, and `parallel.test.ts` pins it.
 */
export async function prep(input: Uint8Array, options: PrepOptions): Promise<PrepResult> {
  const portable = portableOptions(options);
  // Only the half of the prologue this thread reads: the console, the analysis
  // the portfolio is ordered by, and the size the result reports. The other half
  // — a full-resolution linear source and the judge's reference — is built by
  // whichever thread runs a candidate, and recalled from `candidate.ts`'s
  // content-keyed memo by the rest, so no thread derives it twice and this one
  // never derives it at all.
  const analysed = analyzeSource(input, portable);
  const candidates = buildPortfolio(analysed.spec, analysed.analysis, options);
  if (candidates.length === 0) {
    throw new DemakeError(
      "E_INVALID_OPTION",
      `no candidate matches strategy '${options.strategy}'`,
      {
        hint: "run with --strategy list to see available candidates.",
      },
    );
  }

  if (options.signal?.aborted) {
    throw new DemakeError("E_INTERNAL", "prep aborted");
  }

  const executor = options.executor ?? inline;
  const jobs = candidates.map((candidate) =>
    candidateJob.job({ source: input, options: portable, candidate }),
  );

  // Progress counts finished candidates rather than tracking a position in the
  // list: a fan-out finishes them in whatever order the lanes free up, and a
  // fraction derived from the last index to arrive would jump backwards.
  let done = 0;
  const outcomes = await executor(jobs, (index) => {
    done += 1;
    options.onProgress?.(`candidate:${candidates[index]!.id}`, done / candidates.length);
  });
  if (outcomes.length !== jobs.length) {
    throw new DemakeError(
      "E_INTERNAL",
      `the executor answered ${outcomes.length} of ${jobs.length} candidates`,
      { hint: "an Executor must resolve one outcome per job, in the order given." },
    );
  }

  if (options.signal?.aborted) {
    throw new DemakeError("E_INTERNAL", "prep aborted");
  }

  const scores: CandidateScore[] = [];
  let winner: { candidate: Candidate; outcome: CandidateOutcome } | null = null;

  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index]!;
    const outcome = unwrap<CandidateOutcome>(outcomes[index]!);
    scores.push(outcome.score);
    if (outcome.image === null) continue;
    if (!winner || outcome.score.aggregate > winner.outcome.score.aggregate) {
      winner = { candidate, outcome };
    }
  }

  if (!winner) {
    throw new DemakeError("E_NO_VALID_CANDIDATE", "every candidate was disqualified", {
      hint: "this is an internal invariant failure; please file a bug with the input.",
    });
  }

  const image = winner.outcome.image!;
  const png = encodeCompliantPng(image, analysed.useRaw);
  const decisions: AutoDecisions = {
    profile: analysed.profile === "art" ? "art" : "photo",
    size: analysed.size,
    scale: winner.candidate.scale,
    dither: winner.candidate.dither,
    strategy: winner.candidate.id,
  };
  const warnings =
    winner.outcome.merges > 0
      ? [
          {
            code: "W_TILE_MERGE",
            message: `${winner.outcome.merges} tiles merged to fit the VRAM budget`,
          },
        ]
      : [];

  return {
    png,
    image,
    source: analysed.source,
    decisions,
    stats: {
      meanDeltaE: winner.outcome.rawMeanDeltaE,
      p95DeltaE: winner.outcome.rawP95DeltaE,
      palettePressure: winner.outcome.palettePressure,
      uniqueTiles: winner.outcome.uniqueTiles,
      tileBudget: winner.outcome.budget,
      tileMerges: winner.outcome.merges,
      restarts: effortParams(options.effort ?? "default").restarts,
    },
    warnings,
    tournament: { winner: winner.candidate.id, candidates: scores },
  };
}
