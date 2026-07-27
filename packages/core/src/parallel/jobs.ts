/**
 * The executor seam (doc 04 §Running the tournament).
 *
 * A tournament is a set of candidates that cannot see each other: each one is a
 * complete conversion of the same source under a different set of stage choices,
 * seeded from the same number, scored against the same reference. That makes it
 * the one place in the engine where work spreads across cores for free.
 *
 * Core cannot spread it itself. It has no threads and must never learn about any
 * (doc 02 §Platform purity), so instead it *describes* the work as jobs and takes
 * an {@link Executor} from whichever edge is calling: `worker_threads` in the
 * CLI, Web Workers in the page, and — when nobody supplies one —
 * {@link inlineExecutor}, which runs the jobs right here, in order. That default
 * is not a fallback so much as the specification: it is the answer every other
 * executor has to reproduce byte for byte, and `parallel.test.ts` says so.
 *
 * A job crosses a thread boundary, so both halves of one must survive a
 * structured clone: plain objects and typed arrays, never a closure, a class
 * instance, or a callback. Errors do not survive it either, which is why a job
 * resolves to a {@link JobOutcome} rather than rejecting — the failure is
 * described as data and rebuilt as the same `DemakeError`, with the same code and
 * the same hint, on the far side.
 */

import { DemakeError, type DemakeErrorCode } from "../errors.js";

/** A unit of independent work: which handler runs it, and what it runs on. */
export interface Job<P = unknown> {
  readonly kind: string;
  readonly payload: P;
}

/**
 * A thrown error, as data.
 *
 * A class does not survive a structured clone, so what crosses is the name, the
 * message, and the `code` every error in this project carries. `DemakeError`
 * comes back as itself; anything else — `SfxError`, `ArrangeError` — comes back
 * as an `Error` with its name and code restored as own properties. Code checks
 * therefore keep working across the boundary and `instanceof` does not, which is
 * why nothing downstream of a job may branch on the class.
 */
export interface JobFailure {
  readonly name: string;
  readonly message: string;
  readonly code?: string;
  readonly hint?: string;
  readonly docs?: string;
}

/** What running one job produced: a value, or a failure to re-throw. */
export type JobOutcome<R = unknown> =
  { readonly ok: true; readonly value: R } | { readonly ok: false; readonly error: JobFailure };

/**
 * Runs jobs somewhere, and resolves outcomes *in the order the jobs were given*.
 *
 * The ordering requirement is the whole contract. A tournament picks its winner
 * by walking candidates in portfolio order and keeping the first strict
 * improvement, so an executor that returned results in completion order would
 * pick a different winner on a machine with a different number of cores.
 */
export type Executor = (
  jobs: readonly Job[],
  /**
   * Called with a job's index as it finishes, for progress that is honest about
   * a fan-out. Optional on both sides: an executor need not report, and a caller
   * need not listen.
   */
  onDone?: (index: number) => void,
) => Promise<readonly JobOutcome[]>;

/** One kind of job: how to describe one, and how to run one. */
export interface JobKind<P, R> {
  readonly kind: string;
  /** Describe a unit of work for an executor. */
  job(payload: P): Job<P>;
  /** Run one here and now, with its types intact. */
  run(payload: P): R;
  /** `run` with its types erased — what a worker's dispatch table holds. */
  readonly erased: (payload: unknown) => unknown;
}

/** A job kind with its payload and result types erased. */
export type AnyJobKind = Pick<JobKind<unknown, unknown>, "kind" | "erased">;

/** A worker's dispatch table: job kind to the function that runs it. */
export type JobHandlers = ReadonlyMap<string, (payload: unknown) => unknown>;

/**
 * Define a kind of job.
 *
 * The single cast in `erased` is the only place the payload's type is asserted,
 * and it is sound because `job()` is the only way to make one.
 */
export function defineJob<P, R>(kind: string, run: (payload: P) => R): JobKind<P, R> {
  return {
    kind,
    job: (payload) => ({ kind, payload }),
    run,
    erased: (payload) => run(payload as P),
  };
}

/**
 * Collect job kinds into a dispatch table.
 *
 * An edge composes the tables of every package its workers can be asked about —
 * `jobHandlers(...coreJobKinds, ...audioJobKinds)` — which is why no package
 * needs to know that another one exists. Two kinds claiming one name is a
 * programming error and says so immediately, rather than letting whichever
 * package happened to load second silently win.
 */
export function jobHandlers(kinds: readonly AnyJobKind[]): JobHandlers {
  const table = new Map<string, (payload: unknown) => unknown>();
  for (const kind of kinds) {
    if (table.has(kind.kind)) {
      throw new DemakeError("E_INTERNAL", `two handlers claim the job kind '${kind.kind}'`, {
        hint: "job kinds are namespaced by package; rename one of them.",
      });
    }
    table.set(kind.kind, kind.erased);
  }
  return table;
}

/** Describe a thrown value so it can cross a thread boundary. */
export function describeFailure(error: unknown): JobFailure {
  if (error instanceof DemakeError) {
    return {
      name: error.name,
      message: error.message,
      code: error.code,
      ...(error.hint === undefined ? {} : { hint: error.hint }),
      ...(error.docs === undefined ? {} : { docs: error.docs }),
    };
  }
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return {
      name: error.name,
      message: error.message,
      ...(typeof code === "string" ? { code } : {}),
    };
  }
  return { name: "Error", message: String(error) };
}

/** Rebuild a described failure and throw it, as the near side would have. */
export function throwFailure(failure: JobFailure): never {
  if (failure.name === "DemakeError" && failure.code !== undefined) {
    throw new DemakeError(failure.code as DemakeErrorCode, failure.message, {
      ...(failure.hint === undefined ? {} : { hint: failure.hint }),
      ...(failure.docs === undefined ? {} : { docs: failure.docs }),
    });
  }
  const error = new Error(failure.message);
  error.name = failure.name;
  if (failure.code !== undefined) (error as { code?: string }).code = failure.code;
  throw error;
}

/**
 * The value a job produced, or the failure it produced, thrown.
 *
 * The one cast in the seam: an outcome comes back from an executor with its type
 * erased by the boundary it crossed, and the caller that made the job is the only
 * thing that knows what shape it asked for.
 */
export function unwrap<R>(outcome: JobOutcome): R {
  if (outcome.ok) return outcome.value as R;
  return throwFailure(outcome.error);
}

/**
 * Run one job against a dispatch table, catching whatever it throws.
 *
 * This is what a worker calls once it has a job in hand, and what
 * {@link inlineExecutor} calls when there is no worker at all — one function, so
 * the two paths cannot disagree about what running a job means.
 */
export function runJob(handlers: JobHandlers, job: Job): JobOutcome {
  const handler = handlers.get(job.kind);
  if (handler === undefined) {
    return {
      ok: false,
      error: {
        name: "DemakeError",
        code: "E_INTERNAL",
        message: `no handler is registered for the job kind '${job.kind}'`,
        hint: "the worker was built without this package's job table.",
      },
    };
  }
  try {
    return { ok: true, value: handler(job.payload) };
  } catch (error) {
    return { ok: false, error: describeFailure(error) };
  }
}

/**
 * The executor that does not go anywhere: run every job here, in order.
 *
 * The default for every entry point, so nothing in the engine *needs* an edge to
 * supply threads, and the reference the parallel executors are pinned against.
 */
export function inlineExecutor(handlers: JobHandlers): Executor {
  return (jobs, onDone) =>
    Promise.resolve(
      jobs.map((job, index) => {
        const outcome = runJob(handlers, job);
        onDone?.(index);
        return outcome;
      }),
    );
}
