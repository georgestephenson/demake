/**
 * A Neo Geo game's sound: a whole second program, on a bus the game cannot see.
 *
 * The eleventh machine the shared battery is pointed at, and the only one whose
 * driver is not in the cartridge the game runs from — it is the M region, a Z80
 * program with its own ROM, its own two kilobytes and its own clock. So what this
 * pass settles that no other console's does is that a driver **nothing hands a
 * tick to** keeps the schedule: the game's 68000 stores one byte and never waits,
 * and everything after that is the other processor's.
 *
 * There is no merge routine to exercise, for two reasons at once rather than one:
 * the SSG mixer is written once at boot because a note here is silenced by its own
 * level, and the ADPCM key-on is a pulse. This is the sixth console to emit none
 * and the first whose reason is two.
 */

import { audioBattery, target } from "./_audio-battery.js";

const neogeo = target("neogeo");

audioBattery(neogeo);

// No size sweep, on the Game Boy Advance's terms and for the same two reasons.
// A game here is tens of kilobytes of a *megabyte* P region and its sound program
// is a separate 32 KiB of its own, so there is no budget for the assertion to
// catch; and a build with art is the whole `prep` tournament against 320×224 into
// fifteen sixteen-colour sub-palettes, which is minutes rather than seconds. What
// the sweep would still have bought — that a driver's reported sizes are real
// rather than the zero they hold before assembly — is asserted on an art-free
// build in `packages/audio/test/neogeo-driver.test.ts` instead.
