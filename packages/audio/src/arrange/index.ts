/**
 * `arrange` — the music demaker's entry point (doc 17 §The pipeline).
 *
 * The same tournament the image path runs: a curated portfolio of candidates,
 * each a complete assignment of stage choices, all scored by one judge, only the
 * winner emitted. Explicit options constrain the portfolio rather than disabling
 * it — pinning every dimension degenerates to a single candidate naturally — and
 * the scoreboard is reported rather than printed, so the CLI contract stays one
 * track in, one artifact out.
 */

import { getConsole, type AudioSpec } from "@demake/core";

import { analyze, type AnalyzeOptions } from "../analysis.js";
import { bindingFor } from "../binding/registry.js";
import type { ChipScript, Dropped, TimingReport } from "../chipscript.js";
import { encodeVgm } from "../encode/vgm.js";
import { inspectScript, type AudioViolation } from "../inspect.js";
import { judgeArrangement, type JudgeResult } from "../judge.js";
import { dominantBpm, type PartRole, type Score } from "../score/types.js";
import { planTiming, verifyNonAccumulating } from "../timing.js";
import { compileScript, type CompileOptions } from "./compile.js";
import { planArrangement, type ArrangementPlan, type PlanOptions } from "./plan.js";

/** One named, complete assignment of stage choices. */
export interface Candidate {
  id: string;
  summary: string;
  plan: PlanOptions;
  compile: CompileOptions;
  rowsPerBeat: number;
}

export interface ArrangeOptions {
  console: string;
  /** `auto` runs the tournament; a name pins one candidate; `list` enumerates. */
  strategy?: string;
  bpm?: number;
  tempo?: "exact" | "snap";
  roles?: Record<string, PartRole>;
  drop?: readonly string[];
  channels?: number;
  reserve?: readonly string[];
  effort?: "fast" | "default" | "max";
  /** Fail rather than degrade: any dropped part becomes an error. */
  strict?: boolean;
  /** Metadata for the artifact's tags. */
  title?: string;
}

export interface CandidateScore {
  id: string;
  summary: string;
  aggregate: number;
  metrics: JudgeResult["metrics"];
  disqualified?: { reason: string; violations: AudioViolation[] };
}

export interface ArrangeResult {
  script: ChipScript;
  /** The primary artifact: a `.vgm`, playable in existing chip-music players. */
  artifact: Uint8Array;
  score: Score;
  plan: ArrangementPlan;
  timing: TimingReport;
  dropped: Dropped[];
  diagnostics: Diagnostic[];
  tournament: { winner: string; candidates: CandidateScore[] };
}

/** Something worth telling the user about, located where it happens. */
export interface Diagnostic {
  code: string;
  severity: "error" | "warning" | "info";
  message: string;
}

/** Thrown when nothing playable can be produced. */
export class ArrangeError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ArrangeError";
  }
}

/** The candidate portfolio for a console (doc 17 §The pipeline). */
export function candidates(spec: AudioSpec): Candidate[] {
  const melodic = spec.channels.filter((channel) => channel.kind !== "noise").length;
  const base: Candidate[] = [
    {
      id: "full-band",
      summary: "every channel independent, drums on the noise channel",
      plan: { allowArpeggio: false, percussion: true },
      compile: { arpeggioTicks: 1, expression: "envelopes", duty: 2 },
      rowsPerBeat: 6,
    },
    {
      id: "arp-harmony",
      summary: "chords collapsed onto one arpeggiating channel",
      plan: { allowArpeggio: true, percussion: true },
      compile: { arpeggioTicks: 1, expression: "envelopes", duty: 2 },
      rowsPerBeat: 12,
    },
    {
      id: "melody-first",
      summary: "no drums; every channel spent on pitched material",
      plan: { allowArpeggio: false, percussion: false },
      compile: { arpeggioTicks: 1, expression: "envelopes", duty: 1 },
      rowsPerBeat: 6,
    },
    {
      id: "flat-thin",
      summary: "no per-note decay, thin duty — cheap and bright",
      plan: { allowArpeggio: false, percussion: true },
      compile: { arpeggioTicks: 2, expression: "flat", duty: 0 },
      rowsPerBeat: 4,
    },
  ];
  // A chip with one melodic channel has nothing to arrange *between*, so the
  // portfolio collapses rather than running four near-identical candidates.
  return melodic <= 1 ? base.filter((candidate) => candidate.id !== "melody-first") : base;
}

/** Demake a score into chip music. */
export function arrangeScore(input: Score, options: ArrangeOptions): ArrangeResult {
  const consoleSpec = getConsole(options.console);
  const binding = bindingFor(options.console);
  const spec: AudioSpec = consoleSpec.audio!;

  const analyzeOptions: AnalyzeOptions = {
    ...(options.roles ? { roles: options.roles } : {}),
    ...(options.drop ? { drop: options.drop } : {}),
  };
  const analysed = analyze(input, analyzeOptions);
  const bpm = options.bpm ?? dominantBpm(analysed);
  const diagnostics: Diagnostic[] = [];

  let portfolio = candidates(spec);
  if (options.strategy && options.strategy !== "auto") {
    const pinned = portfolio.filter((candidate) => candidate.id === options.strategy);
    if (pinned.length === 0) {
      throw new ArrangeError(
        "E_UNKNOWN_STRATEGY",
        `no candidate named '${options.strategy}'; try one of ${portfolio.map((c) => c.id).join(", ")}`,
      );
    }
    portfolio = pinned;
  } else if ((options.effort ?? "default") === "fast") {
    portfolio = portfolio.slice(0, 1);
  }

  const scored: CandidateScore[] = [];
  let best: { candidate: Candidate; script: ChipScript; plan: ArrangementPlan } | undefined;
  let bestAggregate = -Infinity;

  for (const candidate of portfolio) {
    const plan = planArrangement(analysed, spec, {
      ...candidate.plan,
      ...(options.channels === undefined ? {} : { channels: options.channels }),
      ...(options.reserve ? { reserve: options.reserve } : {}),
    });
    const timing = planTiming(binding, {
      bpm,
      ppq: analysed.ppq,
      durationScoreTicks: analysed.durationTicks,
      rowsPerBeat: candidate.rowsPerBeat,
      ...(options.tempo ? { tempo: options.tempo } : {}),
    });
    const script = compileScript(analysed, spec, binding, plan, timing, candidate.compile);

    const inspection = inspectScript(script);
    if (!inspection.compliant) {
      scored.push({
        id: candidate.id,
        summary: candidate.summary,
        aggregate: 0,
        metrics: [],
        disqualified: {
          reason: inspection.violations[0]?.message ?? "not compliant",
          violations: inspection.violations,
        },
      });
      continue;
    }

    const verdict = judgeArrangement(analysed, spec, plan, script);
    scored.push({
      id: candidate.id,
      summary: candidate.summary,
      aggregate: verdict.aggregate,
      metrics: verdict.metrics,
    });
    // Ties break by candidate order, which is fixed — so the winner is stable.
    if (verdict.aggregate > bestAggregate) {
      bestAggregate = verdict.aggregate;
      best = { candidate, script, plan };
    }
  }

  if (!best) {
    throw new ArrangeError(
      "E_NO_VALID_CANDIDATE",
      `every candidate was disqualified for ${options.console}: ${scored[0]?.disqualified?.reason ?? "unknown"}`,
    );
  }

  const { script, plan, candidate } = best;
  collectDiagnostics(diagnostics, script, plan, spec, bpm);

  if (options.strict && plan.dropped.length > 0) {
    const first = plan.dropped[0]!;
    throw new ArrangeError(
      "E_DROPPED",
      `--strict: ${plan.dropped.length} part(s) could not be kept, starting with ${first.partId} (${first.reason})`,
    );
  }

  const artifact = encodeVgm(script, {
    ...(options.title ? { title: options.title } : {}),
    system: consoleSpec.name,
  });
  return {
    script,
    artifact,
    score: analysed,
    plan,
    timing: script.timing,
    dropped: plan.dropped,
    diagnostics,
    tournament: { winner: candidate.id, candidates: scored },
  };
}

function collectDiagnostics(
  diagnostics: Diagnostic[],
  script: ChipScript,
  plan: ArrangementPlan,
  spec: AudioSpec,
  bpm: number,
): void {
  for (const dropped of plan.dropped) {
    diagnostics.push({
      code: dropped.kind === "part" ? "dropped-part" : "merged-voice",
      severity: dropped.kind === "part" ? "warning" : "info",
      message: `${dropped.partId}: ${dropped.reason} (${dropped.count} notes, mean salience ${dropped.salience.toFixed(2)})`,
    });
  }
  for (const assignment of plan.assignments) {
    if (assignment.octaveShift !== 0) {
      diagnostics.push({
        code: "octave-folded",
        severity: "info",
        message: `${assignment.channel.id} plays ${assignment.parts.map((p) => p.id).join(", ")} shifted ${assignment.octaveShift > 0 ? "up" : "down"} ${Math.abs(assignment.octaveShift)} octave(s) to fit its range`,
      });
    }
  }
  const used = new Set(plan.assignments.map((assignment) => assignment.channel.id));
  for (const channel of spec.channels) {
    if (!used.has(channel.id)) {
      diagnostics.push({
        code: "channel-never-used",
        severity: "info",
        message: `${channel.id} is never used — usually a role-classification result worth checking`,
      });
    }
  }
  const ppm = Math.abs(script.timing.ppmError);
  diagnostics.push({
    code: "tempo",
    severity: ppm > 5000 ? "warning" : "info",
    message: `requested ${bpm.toFixed(2)} BPM, achieved ${script.timing.achievedBpm.toFixed(2)} (${ppm.toFixed(0)} ppm, ${script.timing.source}), error does not accumulate`,
  });
}

export { planArrangement, verifyNonAccumulating };
