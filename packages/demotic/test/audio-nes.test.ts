/**
 * An NES game's sound: a 6502 player on the picture's own interrupt at 60 Hz,
 * and `$4015` — whose four enable bits *are* the four channel bits — merged.
 *
 * The battery is `_audio-battery.ts`; this file names the machine.
 */

import { audioBattery, audioSweep, target } from "./_audio-battery.js";

const nes = target("nes");

audioBattery(nes);
audioSweep(nes);
