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
 * The games the Game Boy sweep below can build.
 *
 * `quest` is not one of them, and the exclusion is a fact about the cartridge
 * rather than about this file: three levels, a boss and a secret room compile to
 * around 122 KiB of SM83 against a mapper-less 32 KiB (doc 13 §Banked
 * cartridges). It is covered on the Mega Drive instead, below, which is the one
 * console with the room — and that is the better case anyway, because it is the
 * biggest fan-out in the library.
 */
const OVER_BUDGET_ON_GB = new Set(["quest"]);

const GAMES = EXAMPLES.filter((name) => !OVER_BUDGET_ON_GB.has(name));

/**
 * Which builds to compare.
 *
 * Every fixture on the monochrome Game Boy, where a build is a second and the
 * whole library is affordable — and the colour consoles on the fixtures that
 * exercise what differs there. A two-backdrop game is the case the two handle
 * differently (the Game Boy converts them at once and interns them in scene
 * order; the NES converts them one at a time because each one's tile budget is
 * what the last one left), and `caves` is the case where the audio fan-out shares
 * the executor with the art one.
 *
 * The two-backdrop game is not the same on both: `shooter` is the tightest
 * cartridge in the library and does not fit on an NES at all now that it has a
 * sound driver, which `audio.test.ts` records in its own over-budget list. The
 * NES gets `platformer`, which has two backdrops and room.
 *
 * The Super Nintendo gets `caves` and nothing else, and for a plainer reason: a
 * picture there is 256×224 fitted into seven sixteen-colour sub-palettes, which
 * is three times the arithmetic of any other console's screen. One backdrop is
 * what this file can afford of it, and one backdrop is enough — what varies here
 * is the executor, not the game.
 *
 * A colour build is around ten seconds, so the full matrix would put this file
 * minutes over the suite's budget to re-cover ground `rom.test.ts` already holds.
 */
const CASES = [
  ...GAMES.map((game) => ({ game, consoleId: "gb" })),
  { game: "shooter", consoleId: "gbc" },
  { game: "platformer", consoleId: "nes" },
  ...["gbc", "nes", "snes"].map((consoleId) => ({ game: "caves", consoleId })),
];

/**
 * And the Mega Drive, which is the same case with a different clock.
 *
 * It belongs in the matrix above for the same reason the NES does — its art path
 * shares the bank out max-min fair on demands read off a first pass, so a build
 * there demakes some pictures twice, and doing that under a spread executor is
 * where an order dependence would show. It is written out separately only for
 * its timeout: a fit's cost is its pixels and this console has the biggest
 * screen in the set (320x224 against a Game Boy's 160x144), so one backdrop
 * through the tournament is around twenty-five seconds here against a handful
 * anywhere else. Folding that ceiling into `it.each` would raise it for every
 * fast case too, and a six-minute limit on a ten-second build is a guard that
 * catches nothing.
 */
const SLOW = [
  { game: "platformer", consoleId: "md" },
  // And the biggest fan-out there is: four levels, two of them demade against a
  // shared bank, four tracks and eight effects, all of it settled at once.
  { game: "quest", consoleId: "md" },
];

/** One executor for the whole file, so the job count means something at the end. */
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

describe("a fanned-out build", () => {
  it.each(CASES)(
    "builds $game for $consoleId to the bytes one thread builds",
    ({ game, consoleId }) => compareBuilds(game, consoleId),
    120_000,
  );

  it.each(SLOW)(
    "builds $game for $consoleId to the bytes one thread builds",
    ({ game, consoleId }) => compareBuilds(game, consoleId),
    360_000,
  );

  it("actually ran the candidates it was given", () => {
    // The guard on the test above: `bindArt` and the sfx prologue both memoise by
    // content, so a suite that warmed them first would compare two cache hits and
    // report success. One tournament is nine candidates, so the real figure is in
    // the hundreds; anything near zero means the fan-out was skipped.
    expect(fanOut.ran()).toBeGreaterThan(50);
  });
});
