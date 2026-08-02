/**
 * A cartridge does not depend on how many cores built it (doc 04 §Running the
 * tournament).
 *
 * This is the property the whole fan-out rests on, checked where it matters most
 * — at the end, on the artifact. A build is mostly tournaments: the art's
 * candidates, the sound's gesture families, and on a game with two backdrops two
 * of the first running at once. Every one of those is spread over an executor,
 * and every one of them has an ordering the answer must not be able to see.
 *
 * So the executor here is deliberately hostile: it runs jobs in reverse, reports
 * them finished in reverse, resolves after a turn of the event loop, and serves
 * every concurrent caller from one queue that it takes from the middle of. If a
 * cartridge came out the same under that, arrival order cannot reach it.
 *
 * `packages/cli/test/pool.test.ts` does the same over real threads and
 * `packages/web/test/e2e/determinism.spec.ts` over real Web Workers, on one game
 * each. What this one adds is breadth — the whole example library, and both
 * colour consoles on the cases where their art paths differ — which those two are
 * too slow to cover.
 *
 * **Why this is a battery rather than a test file.** It is pointed at each
 * backend from a file of its own — `parallel-gb.test.ts`, `parallel-md.test.ts`
 * and the rest — because a test file is the unit Vitest schedules, and written as
 * one file this was seven and a half minutes that no other core could help with.
 * Each file gets an executor of its own, which is also why the candidate-count
 * guard below is per-battery: the number only means something about the builds
 * that ran beside it.
 */

import { describe, expect, it } from "vitest";

import { audioJobKinds } from "@demake/audio";
import { coreJobKinds, jobHandlers, runJob, type Executor, type JobOutcome } from "@demake/core";

import { compile } from "../src/compile.js";
import { getProfile } from "../src/profiles.js";
import { buildGame } from "../src/codegen/registry.js";
import { EXAMPLES, exampleProject } from "./_projects.js";

const handlers = jobHandlers([...coreJobKinds, ...audioJobKinds]);

/**
 * One queue for every caller, drained from the middle, backwards, a turn at a
 * time.
 *
 * Every degree of freedom a real pool has, turned up: nothing runs in the order
 * it was asked for, and the art and audio tournaments — which a build now runs at
 * the same time — are interleaved rather than served one after the other.
 */
function adversarial(): Executor & { ran: () => number } {
  const queue: (() => void)[] = [];
  let count = 0;
  let draining = false;
  const drain = async (): Promise<void> => {
    if (draining) return;
    draining = true;
    while (queue.length > 0) {
      await Promise.resolve();
      queue.splice(Math.floor(queue.length / 2), 1)[0]?.();
    }
    draining = false;
  };
  const executor: Executor = async (jobs, onDone) => {
    const outcomes = new Array<JobOutcome>(jobs.length);
    const waits: Promise<void>[] = [];
    for (let index = jobs.length - 1; index >= 0; index -= 1) {
      const at = index;
      waits.push(
        new Promise<void>((resolve) => {
          queue.push(() => {
            count += 1;
            outcomes[at] = runJob(handlers, jobs[at]!);
            onDone?.(at);
            resolve();
          });
        }),
      );
    }
    void drain();
    await Promise.all(waits);
    return outcomes;
  };
  return Object.assign(executor, { ran: () => count });
}

/**
 * The games a mapper-less 32 KiB cartridge can hold.
 *
 * `quest` is not one of them, and the exclusion is a fact about the cartridge
 * rather than about this file: three levels, a boss and a secret room compile to
 * around 122 KiB of SM83 against a mapper-less 32 KiB (doc 13 §Banked
 * cartridges). It is covered on the Mega Drive instead, which is the one console
 * with the room — and that is the better case anyway, because it is the biggest
 * fan-out in the library.
 */
export const GAMES = EXAMPLES.filter((name) => name !== "quest");

/** One build to compare: a game, on a console. */
export interface FanOutCase {
  game: string;
  consoleId: string;
}

/**
 * Declare the fan-out battery for one backend.
 *
 * `timeout` is stated per battery rather than per case because what it guards
 * against is a hang, and the ceiling a Mega Drive build needs — a fit's cost is
 * its pixels and this console has the biggest screen in the set, so one backdrop
 * through the tournament is around twenty-five seconds against a handful
 * anywhere else — is a guard that catches nothing on a ten-second build.
 */
export function fanOutBattery(label: string, cases: readonly FanOutCase[], timeout: number): void {
  /** One executor per battery, so the job count means something at the end. */
  const fanOut = adversarial();

  /** Build one game twice — spread, then alone — and compare everything. */
  async function compareBuilds(game: string, consoleId: string): Promise<void> {
    const { source, files, levels, assets } = exampleProject(game);
    const program = compile(source, { profile: getProfile(consoleId), files, levels });

    // Spread first, on a cold conversion cache. The other order would let the
    // second build recall every backdrop the first one demade and hand back the
    // right bytes without a candidate ever reaching the executor — a test that
    // passed by not running the thing it is about.
    const spread = await buildGame(program, { title: game, assets, executor: fanOut });
    const alone = await buildGame(program, { title: game, assets });

    expect(spread.bytes).toEqual(alone.bytes);
    // The stats too, not just the cartridge: a build that reported a different
    // tile count while emitting the same bytes would mean the two paths
    // disagreed somewhere the ROM happens not to show.
    expect(spread.stats).toEqual(alone.stats);
  }

  describe(`a fanned-out build, on ${label}`, () => {
    it.each(cases)(
      "builds $game for $consoleId to the bytes one thread builds",
      ({ game, consoleId }) => compareBuilds(game, consoleId),
      timeout,
    );

    it("actually ran the candidates it was given", () => {
      // The guard on the test above: `bindArt` and the sfx prologue both memoise by
      // content, so a suite that warmed them first would compare two cache hits and
      // report success — anything near zero means the fan-out was skipped.
      //
      // Ten per case rather than one figure for the file, because the executor is
      // now per battery and the count is therefore a fact about how many builds ran
      // beside it. Ten is a floor and not an estimate: the smallest battery here is
      // one build of a one-backdrop game, which is 23.
      expect(fanOut.ran()).toBeGreaterThan(cases.length * 10);
    });
  });
}
