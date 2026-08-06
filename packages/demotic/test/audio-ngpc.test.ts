/**
 * A Neo Geo Pocket game's sound: a TLCS-900/H player, and a chip it has to ask
 * for.
 *
 * The battery is `_audio-battery.ts`; this file names the machine. Three things
 * it proves that no other console's pass does.
 *
 * **The chip belongs to something else until the driver takes it.** On the board
 * the T6W28's own bus is the Z80 sound processor's, and `demake build` emits no
 * Z80 program — so `AudioInit` writes `$55` and `$AA` to two bytes of the main
 * CPU's I/O page before anything else, and `@demake/ngp` refuses every port
 * write until both have arrived. A driver that skipped them would be perfect and
 * silent, and this whole pass would see an empty register stream rather than a
 * wrong one. That is the only console in the set where the *first* assertion
 * below is really about permission.
 *
 * **Two ports carry different registers.** A byte's meaning depends on which of
 * the chip's two addresses it went to, so the write comparison names the port as
 * well as the value and the borrowed-channel check keys its map on both
 * (`_audio-battery.ts` §`t6w28Register`). A driver with the two swapped writes a
 * period into an attenuator, which is silence rather than a wrong note — and a
 * diff that saw only the byte would call it identical.
 *
 * **There is nothing to merge.** The fourth console here with no shared
 * register, and the first to have none because its hardware pans *more*: stereo
 * is a four-bit level inside each channel's own attenuator rather than one byte
 * of enables two streams both write. So the battery's merge case is skipped by
 * `mergeReg: null` — the same way the Master System skips it, reached from the
 * opposite direction — and what replaces it is that handing a borrowed channel
 * back replays *six* bytes rather than three, because both of a voice's levels
 * are things the music stated and the effect overwrote.
 */

import { audioBattery, audioSweep, target } from "./_audio-battery.js";

const ngpc = target("ngpc");

audioBattery(ngpc);
audioSweep(ngpc);
