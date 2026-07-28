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

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { audioJobKinds } from "@demake/audio";
import { coreJobKinds, jobHandlers, runJob, type Executor, type JobOutcome } from "@demake/core";

import { compile } from "../src/compile.js";
import { getProfile } from "../src/profiles.js";
import { buildGame } from "../src/codegen/registry.js";

const fixtures = join(import.meta.dirname, "..", "fixtures");
const games = join(fixtures, "games");
const handlers = jobHandlers([...coreJobKinds, ...audioJobKinds]);

function assetsIn(dir: string): Map<string, Uint8Array> {
  const assets = new Map<string, Uint8Array>();
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    assets.set(entry.name, new Uint8Array(readFileSync(join(dir, entry.name))));
  }
  return assets;
}

function levelsIn(dir: string): Record<string, string> {
  const levels: Record<string, string> = {};
  for (const name of readdirSync(dir)) {
    if (name.endsWith(".dmtl")) levels[name] = readFileSync(join(dir, name), "utf8");
  }
  return levels;
}

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

const GAMES = readdirSync(games)
  .filter((name) => name.endsWith(".dmt") && !name.endsWith(".test.dmt"))
  .sort();

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
  { game: "shooter.dmt", consoleId: "gbc" },
  { game: "platformer.dmt", consoleId: "nes" },
  ...["gbc", "nes", "snes"].map((consoleId) => ({ game: "caves.dmt", consoleId })),
];

/** One executor for the whole file, so the job count means something at the end. */
const fanOut = adversarial();

describe("a fanned-out build", () => {
  it.each(CASES)(
    "builds $game for $consoleId to the bytes one thread builds",
    async ({ game, consoleId }) => {
      const source = readFileSync(join(games, game), "utf8");
      const program = compile(source, {
        profile: getProfile(consoleId),
        levels: levelsIn(games),
      });
      const assets = assetsIn(games);

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
    },
    120_000,
  );

  it("actually ran the candidates it was given", () => {
    // The guard on the test above: `bindArt` and the sfx prologue both memoise by
    // content, so a suite that warmed them first would compare two cache hits and
    // report success. One tournament is nine candidates, so the real figure is in
    // the hundreds; anything near zero means the fan-out was skipped.
    expect(fanOut.ran()).toBeGreaterThan(50);
  });
});
