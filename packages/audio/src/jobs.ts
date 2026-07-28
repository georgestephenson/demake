/**
 * What this package contributes to a worker (doc 16 §Running the tournaments).
 *
 * The audio demakers have the same shape as the image one — a portfolio of
 * candidates that cannot see each other — so they reach for the same seam:
 * `@demake/core`'s job contract, an executor supplied by the edge, and the
 * inline runner as the answer every other executor has to reproduce.
 *
 * Composed with core's rather than replacing them. A worker that answers for
 * both engines is what lets `demake build` spread a game's art and its sound
 * effects over one set of lanes instead of two pools taking turns.
 */

import { gestureJob } from "./sfx/index.js";

/** This package's job kinds, for an edge assembling a worker's dispatch table. */
export const audioJobKinds = [gestureJob];
