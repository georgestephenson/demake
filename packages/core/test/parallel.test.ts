/**
 * The executor contract (doc 04 §Running the tournament).
 *
 * A tournament may be spread over cores, and the whole of that being safe rests
 * on one property: the winner and its bytes are decided by the *portfolio's*
 * order, never by the order candidates happen to finish in. So these tests do
 * not check that anything is fast — they check that an executor which runs jobs
 * backwards, resolves them out of order and interleaves two tournaments produces
 * exactly the bytes the sequential path does.
 *
 * A real thread pool is the CLI's test (`packages/cli/test/pool.test.ts`); what
 * a pool can vary that matters is the ordering, and the ordering is testable
 * here without one.
 */

import { describe, expect, it } from "vitest";

import { DemakeError } from "../src/errors.js";
import { encodeRgbaPng } from "../src/image/png/encode.js";
import {
  inlineExecutor,
  jobHandlers,
  runJob,
  type Executor,
  type Job,
  type JobOutcome,
} from "../src/parallel/jobs.js";
import { coreJobKinds, prep } from "../src/pipeline/prep.js";

const handlers = jobHandlers(coreJobKinds);

/** A source with enough variety that the candidates actually disagree. */
function source(width: number, height: number, seed: number): Uint8Array {
  const rgba = new Uint8Array(width * height * 4);
  let state = seed >>> 0;
  const next = (): number => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const o = (y * width + x) * 4;
      rgba[o] = Math.round((x / (width - 1)) * 255);
      rgba[o + 1] = Math.round((y / (height - 1)) * 255);
      rgba[o + 2] = Math.round(next() * 120 + 60);
      rgba[o + 3] = 255;
      if (x > width * 0.55 && x < width * 0.8 && y > height * 0.2 && y < height * 0.45) {
        rgba[o] = 240;
        rgba[o + 1] = 40;
        rgba[o + 2] = 30;
      }
    }
  }
  return encodeRgbaPng(width, height, rgba);
}

/**
 * The most hostile executor that is still correct: run the jobs in reverse,
 * report them finished in reverse, and resolve after a turn of the event loop —
 * everything a pool can vary except which core did the work.
 */
const reversed: Executor = async (jobs, onDone) => {
  const outcomes = new Array<JobOutcome>(jobs.length);
  for (let index = jobs.length - 1; index >= 0; index -= 1) {
    await Promise.resolve();
    outcomes[index] = runJob(handlers, jobs[index]!);
    onDone?.(index);
  }
  return outcomes;
};

/**
 * Two tournaments in flight at once over one lane, which is what a build that
 * converts several backdrops concurrently actually does to a pool.
 */
function interleaving(): Executor {
  const queue: Array<() => void> = [];
  let draining = false;
  const drain = async (): Promise<void> => {
    if (draining) return;
    draining = true;
    while (queue.length > 0) {
      await Promise.resolve();
      // Take from the middle, so neither caller is served in arrival order.
      queue.splice(Math.floor(queue.length / 2), 1)[0]!();
    }
    draining = false;
  };
  return async (jobs, onDone) => {
    const outcomes = new Array<JobOutcome>(jobs.length);
    const waits = jobs.map(
      (job, index) =>
        new Promise<void>((resolve) => {
          queue.push(() => {
            outcomes[index] = runJob(handlers, job);
            onDone?.(index);
            resolve();
          });
        }),
    );
    void drain();
    await Promise.all(waits);
    return outcomes;
  };
}

describe("the executor seam", () => {
  it("runs a job's failure back as the error it was", () => {
    const kind = "test.boom";
    const table = jobHandlers([
      {
        kind,
        erased: () => {
          throw new DemakeError("E_INVALID_SIZE", "no room", { hint: "make it bigger" });
        },
      },
    ]);
    const outcome = runJob(table, { kind, payload: undefined });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("E_INVALID_SIZE");
    expect(outcome.error.message).toBe("no room");
    expect(outcome.error.hint).toBe("make it bigger");
  });

  it("names a job kind nothing handles rather than hanging", () => {
    const outcome = runJob(handlers, { kind: "nobody.knows", payload: undefined } as Job);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("E_INTERNAL");
    expect(outcome.error.message).toContain("nobody.knows");
  });

  it("refuses two handlers for one job kind", () => {
    const one = { kind: "test.same", erased: () => 1 };
    expect(() => jobHandlers([one, one])).toThrow(/two handlers claim/);
  });
});

describe("a fanned-out tournament", () => {
  // One per fitter path: the tiled fit, the mono split, and the TMS row-pair fit.
  const consoles = ["gbc", "nes", "dmg", "sg1000"] as const;

  it.each(consoles)("gives %s the bytes the sequential run gives", async (consoleId) => {
    const input = source(64, 64, 0x51ed);
    const one = await prep(input, { console: consoleId });
    const many = await prep(input, { console: consoleId, executor: reversed });

    expect(many.png).toEqual(one.png);
    expect(many.decisions).toEqual(one.decisions);
    expect(many.stats).toEqual(one.stats);
    expect(many.tournament).toEqual(one.tournament);
  });

  it("is unaffected by two tournaments sharing one executor", async () => {
    const a = source(64, 64, 0x1234);
    const b = source(64, 64, 0x9876);
    const [expectedA, expectedB] = [
      await prep(a, { console: "gbc" }),
      await prep(b, { console: "gbc" }),
    ];

    const executor = interleaving();
    const [gotA, gotB] = await Promise.all([
      prep(a, { console: "gbc", executor }),
      prep(b, { console: "gbc", executor }),
    ]);

    expect(gotA.png).toEqual(expectedA.png);
    expect(gotB.png).toEqual(expectedB.png);
  });

  it("reports one progress step per candidate, monotonically", async () => {
    const seen: number[] = [];
    const result = await prep(source(64, 64, 0x2222), {
      console: "gbc",
      executor: reversed,
      onProgress: (_stage, fraction) => seen.push(fraction),
    });
    expect(seen.length).toBe(result.tournament.candidates.length);
    expect(seen).toEqual([...seen].sort((x, y) => x - y));
    expect(seen.at(-1)).toBe(1);
  });

  it("re-throws a candidate's failure through the executor", async () => {
    const failing: Executor = async (jobs) =>
      jobs.map(() => ({
        ok: false as const,
        error: { name: "DemakeError", code: "E_INVALID_SIZE", message: "lane died" },
      }));
    await expect(prep(source(32, 32, 1), { console: "gbc", executor: failing })).rejects.toThrow(
      /lane died/,
    );
  });

  it("refuses an executor that loses a job", async () => {
    const short: Executor = async (jobs) => jobs.slice(1).map((job) => runJob(handlers, job));
    await expect(prep(source(32, 32, 1), { console: "gbc", executor: short })).rejects.toThrow(
      /answered \d+ of \d+ candidates/,
    );
  });

  it("agrees with the inline executor built from the same table", async () => {
    const input = source(48, 48, 7);
    const explicit = await prep(input, { console: "gbc", executor: inlineExecutor(handlers) });
    const implicit = await prep(input, { console: "gbc" });
    expect(explicit.png).toEqual(implicit.png);
  });
});
