/**
 * A Master System game's sound: a Z80 player writing an I/O port, on the VDP's
 * frame interrupt, with the channel latched in the data byte and no shared
 * register to merge at all.
 *
 * The battery is `_audio-battery.ts`; this file names the machine. The Game
 * Gear's stereo latch — the one place this chip grows a shared register — is
 * `audio-gg.test.ts`, because it is a difference rather than a fourth pass.
 */

import { audioBattery, audioSweep, target } from "./_audio-battery.js";

const sms = target("sms");

audioBattery(sms);
audioSweep(sms);
