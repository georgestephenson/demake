/**
 * A Super Nintendo game's sound, which runs on a second computer.
 *
 * The driver is an SPC700 program uploaded through four mailbox bytes at boot,
 * keeping its own 125 Hz off the sound processor's timer — so its tick label is
 * in *its* symbol table and not the cartridge's, and `KON` is masked rather than
 * merged because it is a pulse rather than a state.
 */

import { audioBattery, audioSweep, target } from "./_audio-battery.js";

const snes = target("snes");

audioBattery(snes);
audioSweep(snes);
