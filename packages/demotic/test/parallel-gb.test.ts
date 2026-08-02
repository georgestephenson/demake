/**
 * The fan-out property on the SM83 backend, mono and colour.
 *
 * Every fixture on the monochrome Game Boy, where a build is a second and the
 * whole library is affordable — and the colour console on the two cases that
 * exercise what differs there. A two-backdrop game is the case the Game Boy and
 * the NES handle differently (this one converts them at once and interns them in
 * scene order), and `caves` is the case where the audio fan-out shares the
 * executor with the art one.
 */

import { GAMES, fanOutBattery } from "./_fanout.js";

fanOutBattery(
  "a Game Boy",
  [
    ...GAMES.map((game) => ({ game, consoleId: "gb" })),
    { game: "shooter", consoleId: "gbc" },
    { game: "caves", consoleId: "gbc" },
  ],
  120_000,
);
