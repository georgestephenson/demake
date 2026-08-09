import { fanOutBattery } from "./_fanout.js";

/**
 * `quest` and not the platformer beside it, which is a coverage decision rather
 * than a saving that happened to be available.
 *
 * This console is where `quest` is fanned out at all: three levels, a boss and a
 * secret room compile to around 122 KiB against a mapper-less 32 KiB, so it is
 * the one machine with the room for it and therefore the biggest fan-out in the
 * library (`_fanout.ts` §GAMES). The platformer here was the *second* biggest
 * fan-out on the same console — the same `fairShares` and the same `TilePool`,
 * over fewer scenes — and it is already fanned out on a Game Boy and on an NES,
 * so what its Mega Drive case added over `quest`'s was one more instance of a
 * path `quest` covers more thoroughly.
 *
 * What it cost was the whole suite's critical path. A fit's price is its pixels,
 * this console has the biggest screen in the set, and the adversarial executor is
 * deliberately serial — so each case is around a hundred seconds with no other
 * core able to help, and this was the longest file in the suite by a distance
 * (doc 11 §the unit suite). Dropping it does not make the suite finish sooner by
 * a hundred seconds of arithmetic; it makes it finish sooner because nothing else
 * was waiting on anything but this.
 */
fanOutBattery("a Mega Drive", [{ game: "quest", consoleId: "md" }], 360_000);
