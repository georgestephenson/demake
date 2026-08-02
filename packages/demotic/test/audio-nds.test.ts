/**
 * A Nintendo DS game's sound: a driver on the other processor.
 *
 * The seventh machine this battery is pointed at, and the second whose driver is
 * not on the console's own processor — but for a different reason from the Super
 * Nintendo's, and the difference is what this file is here to hold. There is no
 * upload and no handshake: the sound channels answer the ARM7 alone, so the
 * cartridge simply *carries two programs*, the loader copies both into the four
 * megabytes they share, and the game asks for a track by storing a byte the other
 * processor reads. What has to hold is the same thing it has to hold everywhere —
 * on tick N the driver performs exactly the writes `ChipScript.ticks[N]` lists.
 *
 * Three of this console's answers are new and all three are checked by running
 * the same battery: nothing on this chip is shared, so no merge is emitted and
 * `mergeReg` is null; sixteen channels means an effect borrows one and *fourteen*
 * others play straight through it; and the clock is a pair of chained timers the
 * driver reads rather than an interrupt it catches, so a tick cannot be missed by
 * a driver that was busy.
 *
 * **The size sweep is not run here**, for the Game Boy Advance's reason stated
 * one console over: a `.nds` is sized by rounding up to a power of two and the
 * limit is the megabyte before the game's own heap, so there is no budget for a
 * sweep to decide. What it would still have bought — that the driver's reported
 * sizes are real — is asserted below on an art-free build, and it is worth more
 * here than there, because on this machine those numbers describe a whole second
 * binary rather than routines inside the first.
 */

import { describe, expect, it } from "vitest";

import { audioBattery, build, MUSIC_ONLY, target } from "./_audio-battery.js";

const nds = target("nds");

audioBattery(nds);

describe("a Nintendo DS game's second binary", () => {
  it("reports the size of a driver that is a program of its own", async () => {
    const { bound } = await build(nds, MUSIC_ONLY);
    const stats = (bound.driver as { stats: { code: number; data: number; image: number } }).stats;
    // Real numbers rather than the zero a driver holds before it is assembled
    // (`backend.ts` §BoundAudioShape). On this console they can only be real —
    // the builder assembles the whole binary before it returns — which is what
    // makes the assertion cheap and the failure unambiguous.
    expect(stats.code).toBeGreaterThan(256);
    expect(stats.data).toBeGreaterThan(64);
    expect(stats.image).toBe(stats.code + stats.data);
  });
});
