/**
 * The one thing the SN76489 added to the shared packing layer: a latched channel.
 *
 * `packages/demotic/test/audio.test.ts` proves the driver against real schedules
 * on real hardware, which is the guarantee that matters — but it can only exercise
 * the schedules `binding/psg.ts` actually produces, and those are well-formed by
 * construction. This file is the layer below: what the tag does with a data byte,
 * what the packer does with the tag, and what `buildSmsGameAudio` does with a
 * schedule that breaks the invariant the whole scheme rests on.
 *
 * That last one cannot be reached from a fixture. A malformed schedule is a bug in
 * a future binding, and the point of `E_PSG_LATCH` is to name it at the build
 * rather than let it become a note on the wrong voice several ticks later — so the
 * test constructs one by hand, which is the only way it will ever be constructed.
 */

import { describe, expect, it } from "vitest";

import type { ChipScript, Rational, TickWrites } from "../src/chipscript.js";
import { bindingFor } from "../src/binding/registry.js";
import { packScript, RUN } from "../src/rom/data.js";
import { buildSmsGameAudio, smsChannelTag } from "../src/rom/sms-game.js";

/** A latch byte: `%1cctdddd`. `volume` picks the attenuation register. */
function latch(channel: number, volume: boolean, data = 0): number {
  return 0x80 | (channel << 5) | (volume ? 0x10 : 0) | (data & 0x0f);
}

/** The Master System's own frame rate, which a game's driver is fitted to. */
const FRAME: Rational = { num: 3579545, den: 59736 };

/**
 * A schedule with these ticks and nothing else that matters.
 *
 * Hand-built rather than arranged, because the cases below are about writes the
 * arranger will not produce — a well-formed schedule cannot exercise the check
 * that exists for a malformed one.
 */
function scriptOf(ticks: readonly TickWrites[], rate: Rational = FRAME): ChipScript {
  const writes = ticks.reduce((sum, tick) => sum + tick.writes.length, 0);
  return {
    console: "sms",
    chips: ["sn76489"],
    driver: { rate, source: "vblank" },
    ticks: ticks.map((tick) => ({ writes: [...tick.writes] })),
    loopTick: 0,
    channels: [],
    timing: {
      source: "vblank",
      requestedBpm: 120,
      achievedBpm: 120,
      ppmError: 0,
      rowsPerBeat: 6,
      maxOnsetDeviationMs: 0,
      accumulates: false,
    },
    budgets: { writes, peakWritesPerTick: writes, writeBudget: 32 },
  };
}

describe("the SN76489's latched channel", () => {
  it("gives a data byte the channel the latch before it selected", () => {
    const tag = smsChannelTag();
    // Tone 3's period, which is the only two-byte write this chip has: a latch
    // carrying the low four bits, then a bare data byte carrying the high six.
    expect(tag(0, latch(2, false, 0x0a))).toBe(1 << 2);
    expect(tag(0, 0x1f)).toBe(1 << 2);
    // A volume latch for another channel moves the selection, and the next data
    // byte would follow it.
    expect(tag(0, latch(0, true, 0x03))).toBe(1 << 0);
    expect(tag(0, 0x05)).toBe(1 << 0);
  });

  it("says the stereo latch belongs to no channel, and leaves the selection alone", () => {
    const tag = smsChannelTag();
    expect(tag(0, latch(1, false, 0x07))).toBe(1 << 1);
    // A different device entirely — it must not be read as a latch byte, even
    // though its value has bit 7 set.
    expect(tag(0x06, 0xff)).toBe(0);
    expect(tag(0, 0x22)).toBe(1 << 1);
  });

  it("starts fresh, so one schedule cannot inherit another's selection", () => {
    const first = smsChannelTag();
    first(0, latch(3, true, 0x0f));
    expect(first(0, 0x11)).toBe(1 << 3);
    // A second call to the factory is a second chip, as far as tagging goes.
    expect(smsChannelTag()(0, 0x11)).toBe(1 << 0);
  });
});

describe("packing a stream whose channel is latched", () => {
  /** Two channels' worth of writes in one tick, tone 3 first. */
  const tick = [
    { reg: 0, value: latch(2, false, 0x0a) },
    { reg: 0, value: 0x1f },
    { reg: 0, value: latch(2, true, 0x02) },
    { reg: 0, value: latch(0, true, 0x04) },
  ];

  const script = scriptOf([{ writes: tick }]);

  it("keeps a data byte in the same run as the latch that named it", () => {
    const data = packScript(script, { channelOf: smsChannelTag });
    const block = data.blocks[0] as Uint8Array;
    // First run: three writes on tone 3 — the period pair and its attenuation.
    expect(block[0]).toBe(3);
    expect((block[1] as number) & RUN.channels).toBe(1 << 2);
    expect((block[1] as number) & RUN.more).toBe(RUN.more);
    // Second run: one write on tone 1, and the tick ends.
    expect(block[8]).toBe(1);
    expect((block[9] as number) & RUN.channels).toBe(1 << 0);
    expect((block[9] as number) & RUN.more).toBe(0);
  });

  it("is what makes skipping a run safe: every run opens with a latch byte", () => {
    // The property the driver's preemption depends on, read straight off the
    // packed bytes rather than asserted about the binding. A run whose first
    // write had bit 7 clear would be a run that inherits its channel from writes
    // the music may not have performed.
    const data = packScript(script, { channelOf: smsChannelTag });
    const block = data.blocks[0] as Uint8Array;
    let at = 1; // past the opening run's count
    for (;;) {
      const flags = block[at] as number;
      const count = block[at - 1] as number;
      expect((block[at + 2] as number) & 0x80, "a run opens with a data byte").toBe(0x80);
      if ((flags & RUN.more) === 0) break;
      at += 1 + count * 2 + 1;
    }
  });
});

describe("a schedule that breaks the latch discipline", () => {
  /** The chip's boot writes, which every schedule has to open with. */
  const boot = bindingFor("sms").init();

  function scheduleOpening(writes: readonly { reg: number; value: number }[]): ChipScript {
    // Every schedule opens with the chip initialisation the ROM performs at boot,
    // which `stripBoot` takes back off — so the interesting writes go in tick 1.
    return scriptOf([{ writes: [...boot] }, { writes: [...writes] }]);
  }

  it("is refused by name rather than guessed at", () => {
    const bare = scheduleOpening([{ reg: 0, value: 0x1f }]);
    // The code, not just the throw: a build that failed for some other reason
    // would pass a message match and prove nothing about the check.
    expect(() => buildSmsGameAudio({ tracks: [bare], effects: [], state: 0xc000 })).toThrowError(
      expect.objectContaining({ code: "E_PSG_LATCH" }),
    );
  });

  it("accepts the same writes with their latch in front of them", () => {
    const proper = scheduleOpening([
      { reg: 0, value: latch(1, false, 0x0c) },
      { reg: 0, value: 0x1f },
    ]);
    expect(() => buildSmsGameAudio({ tracks: [proper], effects: [], state: 0xc000 })).not.toThrow();
  });
});
