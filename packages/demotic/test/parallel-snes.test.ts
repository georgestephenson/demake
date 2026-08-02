/**
 * The fan-out property on the 65816 backend.
 *
 * One game, and for a plainer reason than any other console's: a picture here is
 * 256×224 fitted into seven sixteen-colour sub-palettes, which is three times the
 * arithmetic of any other console's screen. One backdrop is what this suite can
 * afford of it, and one backdrop is enough — what varies here is the executor,
 * not the game.
 */

import { fanOutBattery } from "./_fanout.js";

fanOutBattery("a Super Nintendo", [{ game: "caves", consoleId: "snes" }], 120_000);
