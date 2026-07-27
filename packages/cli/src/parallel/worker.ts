/**
 * A pool lane: one thread that answers job messages (doc 04 §Running the
 * tournament).
 *
 * It knows nothing about tournaments. It holds the dispatch table both engines
 * contribute to — `@demake/core`'s image candidates and `@demake/audio`'s sound
 * gestures — and runs whatever it is handed. That is what lets one pool serve a
 * `demake build`, whose art and audio are demade at the same time: two engines,
 * one set of lanes.
 *
 * A job's failure comes back as data rather than as an uncaught exception, which
 * is `runJob`'s whole job, so a lane never dies of a bad input and the error the
 * caller re-throws is the error the engine threw.
 */

import { parentPort } from "node:worker_threads";

import { audioJobKinds } from "@demake/audio";
import { coreJobKinds, jobHandlers, runJob, type Job } from "@demake/core";

import type { LaneRequest, LaneResponse } from "./protocol.js";

const handlers = jobHandlers([...coreJobKinds, ...audioJobKinds]);

const port = parentPort;
if (port === null) throw new Error("the demake job worker must be started as a worker thread");

port.on("message", (request: LaneRequest) => {
  const response: LaneResponse = {
    id: request.id,
    outcome: runJob(handlers, request.job as Job),
  };
  port.postMessage(response);
});
