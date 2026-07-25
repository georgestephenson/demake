/**
 * The example library, bundled into the page.
 *
 * Imported from `@demake/demotic`'s fixtures rather than copied, so the page,
 * the CLI, the unit suite and the conformance traces are all running the same
 * games. A second copy would drift the first time anyone edited one.
 *
 * Each example is here because it exercises something the others do not — the
 * set is the feature inventory a console runtime has to satisfy (doc 14
 * §Runtime model), not a gallery.
 */

import pongSource from "@demake/demotic/fixtures/pong.dmt?raw";
import pongTests from "@demake/demotic/fixtures/pong.test.dmt?raw";
import breakoutSource from "@demake/demotic/fixtures/games/breakout.dmt?raw";
import breakoutTests from "@demake/demotic/fixtures/games/breakout.test.dmt?raw";
import platformerSource from "@demake/demotic/fixtures/games/platformer.dmt?raw";
import platformerTests from "@demake/demotic/fixtures/games/platformer.test.dmt?raw";
import dodgerSource from "@demake/demotic/fixtures/games/dodger.dmt?raw";
import dodgerTests from "@demake/demotic/fixtures/games/dodger.test.dmt?raw";
import shooterSource from "@demake/demotic/fixtures/games/shooter.dmt?raw";
import shooterTests from "@demake/demotic/fixtures/games/shooter.test.dmt?raw";

import ballUrl from "@demake/demotic/fixtures/ball.svg?url";
import paddleUrl from "@demake/demotic/fixtures/paddle.svg?url";
import brickUrl from "@demake/demotic/fixtures/games/brick.svg?url";
import heroUrl from "@demake/demotic/fixtures/games/hero.svg?url";
import coinUrl from "@demake/demotic/fixtures/games/coin.svg?url";
import ledgeUrl from "@demake/demotic/fixtures/games/ledge.svg?url";
import rockUrl from "@demake/demotic/fixtures/games/rock.svg?url";
import shotUrl from "@demake/demotic/fixtures/games/shot.svg?url";
import alienUrl from "@demake/demotic/fixtures/games/alien.svg?url";

/** One bundled example. */
export interface Example {
  id: string;
  name: string;
  /** What this one exercises that the others do not. */
  covers: string;
  source: string;
  tests: string;
}

export const EXAMPLES: readonly Example[] = [
  {
    id: "pong",
    name: "Pong",
    covers: "two movers, a bounce angle, and proportional opponent steering",
    source: pongSource,
    tests: pongTests,
  },
  {
    id: "breakout",
    name: "Breakout",
    covers: "a grid of objects, removal, and real sprite-budget pressure",
    source: breakoutSource,
    tests: breakoutTests,
  },
  {
    id: "platformer",
    name: "Platformer",
    covers: "gravity, an impulse jump, and resting contact",
    source: platformerSource,
    tests: platformerTests,
  },
  {
    id: "dodger",
    name: "Dodger",
    covers: "many objects at staggered speeds, recycled rather than destroyed",
    source: dodgerSource,
    tests: dodgerTests,
  },
  {
    id: "shooter",
    name: "Shooter",
    covers: "the per-scanline sprite limit's worst case, and a fast projectile",
    source: shooterSource,
    tests: shooterTests,
  },
];

/** Asset name (as written in a `.dmt`) → bundled URL. */
export const DEMO_ASSETS: Readonly<Record<string, string>> = {
  "ball.svg": ballUrl,
  "paddle.svg": paddleUrl,
  "brick.svg": brickUrl,
  "hero.svg": heroUrl,
  "coin.svg": coinUrl,
  "ledge.svg": ledgeUrl,
  "rock.svg": rockUrl,
  "shot.svg": shotUrl,
  "alien.svg": alienUrl,
};

/** The example the section opens with. */
export const DEFAULT_EXAMPLE = EXAMPLES[0] as Example;
