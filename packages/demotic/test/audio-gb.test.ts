/**
 * A Game Boy game's sound, proven against the schedules the demakers made.
 *
 * The battery is `_audio-battery.ts`; this file names the machine. The colour
 * budget rides along here because a `gbc` build is this console's machine code
 * with a second half on the renderer, not a console of its own (doc 14 §Colour).
 */

import { audioBattery, audioSweep, colourBudget, target } from "./_audio-battery.js";

const gb = target("gb");

audioBattery(gb);
audioSweep(gb);
colourBudget();
