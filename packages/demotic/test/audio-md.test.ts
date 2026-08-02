/**
 * A Mega Drive game's sound: a 68000 player storing a byte to an address, and
 * the only console here whose spec names two chips.
 *
 * No shared register to merge — panning lives in the FM half, which is per-voice
 * rather than one byte two streams both write.
 */

import { audioBattery, audioSweep, target } from "./_audio-battery.js";

const md = target("md");

audioBattery(md);
audioSweep(md);
