/**
 * A Virtual Boy game's sound: a V810 player whose tick is a call.
 *
 * The battery is `_audio-battery.ts`; this file names the machine. Three things
 * it proves that no other console's pass does.
 *
 * **The tick is not a handler.** Every other frame-clocked driver in the set is
 * entered by an interrupt and counts what it is owed; this cartridge takes
 * exactly one interrupt — the video processor's — and the main loop is already
 * waiting on it, so `AudioTick` is a call at the bottom of that loop. What that
 * buys is that a tick cannot arrive in the middle of the game's own state, and
 * what it costs is that the driver rate *is* the frame rate with nothing to
 * negotiate (`audio` §resolveVbClock). A pass here is the whole claim.
 *
 * **The frame is 50.2 Hz**, the slowest in the matrix, so every window this
 * battery states in Game Boy ticks is scaled by less than half. A console
 * whose seconds are shorter than everyone assumed is exactly what the
 * WonderSwan's pass found one machine ago, in the other direction.
 *
 * **There is no shared register.** Panning is two nibbles of the channel's own
 * byte, enabling is its own bit 7, and the one global register is a panic
 * button no stream writes — so this build emits no merge routine at all, and
 * the borrowed-channel case is the only thing that can tell a replay from a
 * fold. It is the sixth console in the set with none and the fourth whose
 * reason is that the hardware shares *less* rather than more.
 */

import { audioBattery, audioSweep, target } from "./_audio-battery.js";

const vb = target("vb");

audioBattery(vb);
audioSweep(vb);
