/**
 * The CLI's thread pool — where `demake`'s tournaments actually run (doc 04
 * §Running the tournament).
 *
 * A tournament is a set of candidates that cannot see each other, and on a
 * colour backdrop it is around seventy per cent of a build's wall clock, so the
 * one thing worth spending threads on is the fan-out. `@demake/core` describes
 * that work as jobs and refuses to know where they run; this is the CLI's answer
 * to where.
 *
 * What is *not* here is how jobs are handed out. That is `poolExecutor` in
 * `@demake/core`, shared with the web app's pool, because the ordering rules a
 * fan-out depends on are the same wherever the lanes are and a second copy of
 * them is a second chance to get them wrong. This file owns one thing: a lane is
 * a worker thread, started when first needed and replaced if it dies.
 */

import { existsSync } from "node:fs";
import { availableParallelism } from "node:os";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

import {
  describeFailure,
  poolExecutor,
  type Executor,
  type Job,
  type JobOutcome,
  type Lane,
} from "@demake/core";

import type { LaneRequest, LaneResponse } from "./protocol.js";

/**
 * The compiled lane entry point, or `undefined` when there is not one.
 *
 * A worker thread runs a JavaScript file, so the lane is always the built one:
 * next to this module in `dist`, or — when this module is itself the TypeScript
 * source, which is how the unit suite and `pnpm cli` run it — the built copy
 * beside it. With neither, there is no pool to be had and the caller runs
 * inline, which is the same answer more slowly (§{@link withPool}).
 */
export function laneEntry(): string | undefined {
  const candidates = [
    // Running from `dist`: the lane is its neighbour.
    new URL("./worker.js", import.meta.url),
    // Running from `src`: the same file, in the build beside it.
    new URL("../../dist/parallel/worker.js", import.meta.url),
  ];
  for (const candidate of candidates) {
    const path = fileURLToPath(candidate);
    if (existsSync(path)) return path;
  }
  return undefined;
}

/** How many lanes `--jobs auto` asks for. */
export function defaultLanes(): number {
  // One short of the machine, so a long build leaves something for the shell it
  // was started from — and because the thread running the build is doing real
  // work between fan-outs, so a lane per core measurably loses to a lane per
  // core minus one. Two cores means two lanes: taking one of them would halve
  // the pool to save a fraction of a core.
  const cores = availableParallelism();
  return cores <= 2 ? cores : cores - 1;
}

/**
 * Parse `--jobs`.
 *
 * `auto` is one lane per core; a number is that many. Zero and one both mean
 * "here, on this thread", which is not the same thing as a one-lane pool — it is
 * a thread cheaper, and it is the answer every parallel one is pinned against.
 */
export function parseJobs(value: string | undefined): number {
  if (value === undefined || value === "auto") return defaultLanes();
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new RangeError(`--jobs takes a whole number or 'auto', not '${value}'`);
  }
  return parsed;
}

/**
 * One lane: a worker thread that runs one job at a time.
 *
 * Started on the first job rather than up front, so a `prep` whose portfolio came
 * down to a single candidate does not pay for threads it will not use. A lane
 * that dies takes its outstanding job down as a described failure and forgets the
 * thread; the next job starts a fresh one, which is why a pool survives a worker
 * running out of memory.
 */
class WorkerLane {
  private worker: Worker | undefined;
  private outstanding: ((outcome: JobOutcome) => void) | undefined;
  private nextId = 1;
  private closed = false;

  constructor(private readonly entry: string) {}

  run = (job: Job): Promise<JobOutcome> =>
    new Promise<JobOutcome>((resolve) => {
      if (this.closed) {
        resolve({ ok: false, error: describeFailure(new Error("the job pool is closed")) });
        return;
      }
      const worker = this.ensure();
      const id = this.nextId;
      this.nextId += 1;
      this.outstanding = resolve;
      const request: LaneRequest = { id, job };
      worker.postMessage(request);
    });

  private ensure(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(this.entry);
    // Unreferenced so an idle lane cannot hold the process open: the CLI exits
    // when its work is done, not when its threads decide to stop listening.
    worker.unref();
    worker.on("message", (response: LaneResponse) => this.settle(response.outcome));
    worker.on("error", (error: Error) => {
      this.worker = undefined;
      this.settle({ ok: false, error: describeFailure(error) });
    });
    worker.on("exit", () => {
      if (this.worker === worker) this.worker = undefined;
    });
    this.worker = worker;
    return worker;
  }

  private settle(outcome: JobOutcome): void {
    const resolve = this.outstanding;
    this.outstanding = undefined;
    resolve?.(outcome);
  }

  async close(): Promise<void> {
    this.closed = true;
    this.settle({
      ok: false,
      error: describeFailure(new Error("the job pool was closed before this job ran")),
    });
    const worker = this.worker;
    this.worker = undefined;
    if (worker) await worker.terminate();
  }
}

/** A pool of worker threads that runs jobs and nothing else. */
export class JobPool {
  private readonly workers: WorkerLane[];
  private readonly schedule: Executor;

  constructor(size: number, entry: string | undefined = laneEntry()) {
    if (entry === undefined) {
      throw new Error("the demake job worker was not built; run `pnpm build` first");
    }
    if (size < 1) throw new RangeError("a pool needs at least one lane");
    this.workers = Array.from({ length: size }, () => new WorkerLane(entry));
    this.schedule = poolExecutor(this.workers.map((lane): Lane => lane.run));
  }

  /**
   * This pool as an {@link Executor}.
   *
   * The same one every time, because the scheduler holds which lanes are free:
   * two callers that took an executor each would each think the whole pool was
   * theirs.
   */
  executor(): Executor {
    return this.schedule;
  }

  /** Stop every lane. Safe to call twice, and safe to call with work in flight. */
  async close(): Promise<void> {
    await Promise.all(this.workers.map((lane) => lane.close()));
  }
}

/**
 * Run `body` with an executor, and take the pool down afterwards.
 *
 * `undefined` is how every entry point spells "run it here", and it is handed
 * over in two cases. One lane is the obvious one: a thread and a message hop to
 * do what this thread could have done, when the engine's inline path is already
 * the reference answer. The other is a missing lane entry — `demake` running
 * from TypeScript source with no build beside it — and it is *not* reported as a
 * failure, because the only thing threads change is how long the answer takes. A
 * conversion that refused to run for want of a worker would be trading a correct
 * slow answer for no answer at all.
 */
export async function withPool<T>(
  lanes: number,
  body: (executor: Executor | undefined) => Promise<T>,
): Promise<T> {
  const entry = laneEntry();
  if (lanes <= 1 || entry === undefined) return body(undefined);
  const pool = new JobPool(lanes, entry);
  try {
    return await body(pool.executor());
  } finally {
    await pool.close();
  }
}
