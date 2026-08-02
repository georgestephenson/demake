/**
 * A Mega Duck game's sound: the Game Boy's APU at a different address.
 *
 * Everything the battery compares is stated in Game Boy register numbers and
 * only the cartridge's stores differ, so this passing is the proof that the
 * register map is applied where a register becomes an address and nowhere else —
 * a map that leaked into the schedules would fail here, and one that never
 * reached the ROM would fail on the console.
 */

import { audioBattery, audioSweep, target } from "./_audio-battery.js";

const megaduck = target("megaduck");

audioBattery(megaduck);
audioSweep(megaduck);
