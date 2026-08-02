/**
 * The fan-out property on the 68000 backend.
 *
 * It belongs here for the same reason the NES does — its art path shares the tile
 * bank out max-min fair on demands read off a first pass, so a build there demakes
 * some pictures twice, and doing that under a spread executor is where an order
 * dependence would show. `quest` is here and nowhere else: four levels, two of
 * them demade against a shared bank, four tracks and eight effects, all of it
 * settled at once — the biggest fan-out in the library, and this is the one
 * console with the room to hold it.
 *
 * The timeout is this machine's rather than the suite's: a fit's cost is its
 * pixels and this console has the biggest screen in the set (320×224 against a
 * Game Boy's 160×144), so one backdrop through the tournament is around
 * twenty-five seconds here against a handful anywhere else.
 */

import { fanOutBattery } from "./_fanout.js";

fanOutBattery(
  "a Mega Drive",
  [
    { game: "platformer", consoleId: "md" },
    { game: "quest", consoleId: "md" },
  ],
  360_000,
);
