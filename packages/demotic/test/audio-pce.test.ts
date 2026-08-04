/**
 * A PC Engine game's sound: a 6502 player on the *CPU's own timer* at 120 Hz,
 * with the channel in a register rather than in an address, and no shared
 * register to merge at all.
 *
 * The battery is `_audio-battery.ts`; this file names the machine. It is the
 * second console to run `mos-player.ts` — the same instructions the NES's driver
 * is made of — so what this proves that `audio-nes.test.ts` does not is that the
 * *console* around them is right: a different register base, a different clock,
 * and a selection that has to survive a run being skipped.
 */

import { audioBattery, audioSweep, target } from "./_audio-battery.js";

const pce = target("pce");

audioBattery(pce);
audioSweep(pce);
