/**
 * The fan-out property on the 6502 backend.
 *
 * A two-backdrop game because this console converts its backdrops one at a time
 * — what a picture may spend is what the ones before it left — which is the case
 * the Game Boy's concurrent path does not cover. `platformer` rather than the
 * `shooter` the colour build uses: the shooter is the tightest cartridge in the
 * library and does not fit here now that it has a sound driver, which
 * `audio-nes.test.ts` records in its own over-budget list. And `caves`, where the
 * audio fan-out shares the executor with the art one.
 */

import { fanOutBattery } from "./_fanout.js";

fanOutBattery(
  "an NES",
  [
    { game: "platformer", consoleId: "nes" },
    { game: "caves", consoleId: "nes" },
  ],
  120_000,
);
