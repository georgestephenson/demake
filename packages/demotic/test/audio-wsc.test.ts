/**
 * A WonderSwan game's sound: a V30MZ player on a clock that is not an interrupt.
 *
 * The battery is `_audio-battery.ts`; this file names the machine. Three things
 * it proves that no other console's pass does.
 *
 * **The clock is a tally.** This cartridge takes no interrupts at all — the main
 * loop watches the beam and the audio driver reads the vertical-blank timer's
 * *counter* — so what keeps the tempo is a subtraction rather than a handler
 * that must not be missed. Every other frame-clocked console in the set counts
 * frames by being told; this one counts them by asking, and a tick lost anywhere
 * in the chain would show up here as a schedule performed at the wrong time.
 *
 * **The waveforms are memory.** A channel plays sixty-four bytes of the
 * console's own RAM, so a driver that copied them to the wrong place, or wrote
 * the base register un-shifted, produces a cartridge whose register stream is
 * perfect and whose sound is a page of whatever the game left there. The
 * register diff cannot see that; `packages/chip/test/ws-sound.test.ts` is where
 * it is caught, and the size sweep below is what keeps the copy in the build.
 *
 * **The shared register carries a mode bit.** `$90` is four channel enables
 * *and* the bit that puts channel four on its shift register, so the fold has to
 * reach a bit four places above the channel it belongs to — which is the one
 * thing about this merge that is not the NES's `$4015` restated.
 */

import { audioBattery, audioSweep, target } from "./_audio-battery.js";

const wsc = target("wsc");

audioBattery(wsc);
audioSweep(wsc);
