/**
 * What crosses between the pool and a lane.
 *
 * One job out, one outcome back, correlated by an id — the smallest protocol
 * that lets a lane take its next job before the pool has read the last answer.
 * Both halves are structured-cloneable because that is the only kind of thing a
 * `worker_threads` message can be, which is the same constraint the job contract
 * is written under (`@demake/core`'s `parallel/jobs.ts`).
 */

import type { Job, JobOutcome } from "@demake/core";

/** A job handed to a lane. */
export interface LaneRequest {
  readonly id: number;
  readonly job: Job;
}

/** What the lane made of it — never a rejection; a failure is data. */
export interface LaneResponse {
  readonly id: number;
  readonly outcome: JobOutcome;
}
