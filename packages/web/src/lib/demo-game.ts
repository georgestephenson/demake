/**
 * The demo game the Demotic section opens with.
 *
 * Imported from `@demake/demotic`'s fixtures rather than copied, so the page,
 * the CLI, the terminal runner and the conformance traces are all playing the
 * same Pong. A second copy would drift the first time anyone edited one.
 */

import pongSource from "@demake/demotic/fixtures/pong.dmt?raw";
import pongTests from "@demake/demotic/fixtures/pong.test.dmt?raw";
import ballUrl from "@demake/demotic/fixtures/ball.svg?url";
import paddleUrl from "@demake/demotic/fixtures/paddle.svg?url";

/** Source of the bundled demo game. */
export const DEMO_GAME = pongSource;

/** Its `.test.dmt` suite, shown alongside it. */
export const DEMO_TESTS = pongTests;

/** Asset name (as written in the `.dmt`) → bundled URL. */
export const DEMO_ASSETS: Readonly<Record<string, string>> = {
  "ball.svg": ballUrl,
  "paddle.svg": paddleUrl,
};
