/**
 * Scheduling a fan-out over a fixed set of lanes (doc 04 §Running the
 * tournament).
 *
 * The CLI runs its lanes on `worker_threads` and the web app runs its on
 * `MessagePort`s, but *how* jobs are handed out is the same problem in both, and
 * it is the half where the correctness lives: an outcome has to land in the slot
 * its job came from, a lane has to be free the instant it answers, and two
 * callers sharing a pool have to interleave rather than take turns. So the
 * scheduling is here, platform-pure and tested once, and an edge supplies only
 * the thing core cannot have — somewhere else to run.
 *
 * A {@link Lane} is deliberately the smallest possible interface. Anything to do
 * with starting a thread, keeping it alive or replacing a dead one belongs to
 * whoever implements one; from here a lane is a function that answers.
 */

import { describeFailure, type Executor, type Job, type JobOutcome } from "./jobs.js";

/**
 * Somewhere one job can run.
 *
 * Resolves an outcome and never rejects, because a failure is data on this side
 * of the boundary (see `jobs.ts`). A lane that rejects anyway is caught and
 * described, so a broken transport cannot leave a tournament waiting forever.
 */
export type Lane = (job: Job) => Promise<JobOutcome>;

/**
 * An executor over `lanes`, keeping each of them busy with one job at a time.
 *
 * Call this once per pool, not once per fan-out: the returned executor closes
 * over which lanes are free, which is what lets a build's art and audio
 * tournaments — two concurrent calls — share the machine instead of queueing
 * behind each other.
 *
 * Outcomes are written to the index their job came from and never appended.
 * The whole safety argument for running a tournament in parallel is that its
 * winner is decided in portfolio order, so arrival order must not be able to
 * reach the caller at all.
 */
export function poolExecutor(lanes: readonly Lane[]): Executor {
  if (lanes.length === 0) throw new Error("a pool needs at least one lane");

  const free: Lane[] = [...lanes];
  const waiting: ((lane: Lane) => void)[] = [];

  const acquire = (): Promise<Lane> => {
    const lane = free.pop();
    if (lane) return Promise.resolve(lane);
    return new Promise<Lane>((resolve) => waiting.push(resolve));
  };

  const release = (lane: Lane): void => {
    // Handed straight to the next waiter rather than parked and re-taken: a lane
    // that went back on the free list would let a job submitted later jump ahead
    // of one that has been waiting.
    const next = waiting.shift();
    if (next) next(lane);
    else free.push(lane);
  };

  return async (jobs, onDone) => {
    const outcomes = new Array<JobOutcome>(jobs.length);
    await Promise.all(
      jobs.map(async (job, index) => {
        const lane = await acquire();
        try {
          outcomes[index] = await lane(job);
        } catch (error) {
          // A lane is not supposed to reject. If one does, the transport is
          // broken rather than the job, and saying so beats hanging.
          outcomes[index] = { ok: false, error: describeFailure(error) };
        } finally {
          release(lane);
        }
        onDone?.(index);
      }),
    );
    return outcomes;
  };
}
