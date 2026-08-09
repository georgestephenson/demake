/**
 * The Neo Geo binding: fourteen voices in four sections, and the seams between.
 *
 * Every case here is one the console's *shape* makes possible and no previous
 * binding could reach — a second FM console, a chip with no shared register for
 * two different reasons at once, and the first percussion in the matrix that is a
 * recording rather than a shift register with an envelope on it.
 */

import { getConsole } from "@demake/core";
import { describe, expect, it } from "vitest";

import { adpcmABank, adpcmBBank, drumFor } from "../src/binding/neogeo-bank.js";
import { FM_SLOT, neogeoBinding } from "../src/binding/neogeo.js";
import { bindingFor } from "../src/binding/registry.js";
import { silentFrames } from "../src/binding/types.js";
import type { ChannelFrame } from "../src/chipscript.js";

const spec = getConsole("neogeo").audio!;

/** Frames with one channel sounding and everything else silent. */
function only(index: number, frame: Partial<ChannelFrame>): ChannelFrame[] {
  const frames = silentFrames(spec);
  frames[index] = { on: true, hz: 440, level: 1, ...frame };
  return frames;
}

/** Pair a run of bus writes back into `(port, register, value)` triples. */
function registers(writes: readonly { reg: number; value: number }[]): [number, number, number][] {
  const latched = [0, 0];
  const out: [number, number, number][] = [];
  for (const write of writes) {
    const half = (write.reg >> 1) & 1;
    if ((write.reg & 1) === 0) latched[half] = write.value;
    else out.push([half, latched[half] as number, write.value]);
  }
  return out;
}

describe("the FM half", () => {
  it("keys the four channels the hardware documents, and no others", () => {
    // `001`, `010`, `101`, `110`. These are not codes this project chose: they
    // fall out of the OPN channel map once `FM_SLOT` says which four of the six
    // this part wires out, which is the check that the map is the hardware's.
    expect(FM_SLOT).toEqual([1, 2, 4, 5]);
    const keys = registers(neogeoBinding("neogeo", spec).init())
      .filter(([half, reg]) => half === 0 && reg === 0x28)
      .map(([, , value]) => value & 7);
    expect(keys).toEqual([0b001, 0b010, 0b101, 0b110]);
  });

  it("never writes the timer register, which belongs to the driver", () => {
    // The one clock this console's sound processor has. A schedule that stated it
    // would switch the driver's own tick off between two ticks of itself.
    const all = [
      ...registers(neogeoBinding("neogeo", spec).init()),
      ...registers(neogeoBinding("neogeo", spec).encode(only(3, {}), undefined)),
    ];
    expect(all.some(([half, reg]) => half === 0 && reg >= 0x24 && reg <= 0x27)).toBe(false);
  });

  it("puts channels 3 and 4 on the second port pair", () => {
    const binding = neogeoBinding("neogeo", spec);
    binding.init();
    // The F-number registers, which only a sounding channel writes — every
    // channel installs a patch on the first tick whether it plays or not.
    const halves = new Set(
      registers(binding.encode(only(6, {}), undefined))
        .filter(([, reg]) => reg === 0xa0 + 2 || reg === 0xa4 + 2)
        .map(([half]) => half),
    );
    expect([...halves]).toEqual([1]);
  });
});

describe("the tone generator", () => {
  it("puts A4 on period $238, which is Yamaha's own worked example", () => {
    const binding = neogeoBinding("neogeo", spec);
    binding.init();
    const writes = registers(binding.encode(only(0, { hz: 440 }), undefined));
    const fine = writes.find(([half, reg]) => half === 0 && reg === 0x00)?.[2];
    const coarse = writes.find(([half, reg]) => half === 0 && reg === 0x01)?.[2];
    expect(((coarse ?? 0) << 8) | (fine ?? 0)).toBe(0x238);
  });

  it("treats volume as a level, which is the SN76489's inverted", () => {
    const binding = neogeoBinding("neogeo", spec);
    binding.init();
    const levelAt = (level: number): number | undefined =>
      registers(binding.encode(only(0, { level }), undefined)).find(
        ([half, reg]) => half === 0 && reg === 0x08,
      )?.[2];
    expect(levelAt(1)).toBe(15);
    expect(levelAt(0.001)).toBe(0);
  });

  it("writes the mixer once, at boot, and never again", () => {
    // Which is why this console emits no merge routine: `$07` is the one byte
    // three channels share and nothing in a schedule touches it. A note is
    // silenced by its own level instead.
    const binding = neogeoBinding("neogeo", spec);
    expect(
      registers(binding.init()).filter(([half, reg]) => half === 0 && reg === 0x07),
    ).toHaveLength(1);
    const playing = only(0, {});
    const silent = silentFrames(spec);
    const later = [
      ...registers(binding.encode(playing, undefined)),
      ...registers(binding.encode(silent, playing)),
    ];
    expect(later.some(([half, reg]) => half === 0 && reg === 0x07)).toBe(false);
  });
});

describe("the six drum voices", () => {
  it("picks a recording from the pitch the arranger gives a hit", () => {
    // `compile.ts` hands a non-noise channel carrying percussion the drum's own
    // pitch out of its map, so this reads that back rather than inventing a
    // convention the arranger does not know about.
    expect(drumFor(65)).toBe("kick");
    expect(drumFor(110)).toBe("tom");
    expect(drumFor(293)).toBe("snare");
    expect(drumFor(1758)).toBe("hat");
  });

  it("starts a voice with a pulse, never a shared byte", () => {
    const binding = neogeoBinding("neogeo", spec);
    binding.init();
    const writes = registers(
      binding.encode(only(7, { hz: 65, retrigger: true }), undefined),
    ).filter(([half]) => half === 1);
    // The address pair for voice 0, and a key-on naming that voice alone: `$00`
    // acts on the voices its mask names and leaves the rest exactly as they were,
    // which is the Super Nintendo's `KON` on completely different hardware.
    const key = writes.filter(([, reg]) => reg === 0x00);
    expect(key).toHaveLength(1);
    expect(key[0]![2]).toBe(0x01);
    const region = adpcmABank().regions.kick;
    expect(writes.find(([, reg]) => reg === 0x10)?.[2]).toBe(region.startBlock & 0xff);
    expect(writes.find(([, reg]) => reg === 0x20)?.[2]).toBe(region.endBlock & 0xff);
  });

  it("says nothing on a tick that is neither a hit nor a release", () => {
    // A sample voice plays its recording to the end and stops itself, so holding
    // a drum costs no writes at all — which is what makes percussion here about
    // three writes a *hit* where a Game Boy's costs three a tick.
    const binding = neogeoBinding("neogeo", spec);
    binding.init();
    const hit = only(7, { hz: 65, retrigger: true });
    binding.encode(hit, undefined);
    const held = only(7, { hz: 65, retrigger: false });
    expect(binding.encode(held, hit)).toEqual([]);
  });

  it("starts several at once without disturbing the others", () => {
    const binding = neogeoBinding("neogeo", spec);
    binding.init();
    const frames = silentFrames(spec);
    frames[7] = { on: true, hz: 65, level: 1, retrigger: true };
    frames[9] = { on: true, hz: 1758, level: 1, retrigger: true };
    const key = registers(binding.encode(frames, undefined)).filter(
      ([half, reg]) => half === 1 && reg === 0x00,
    );
    expect(key).toHaveLength(1);
    expect(key[0]![2]).toBe(0b000101);
  });
});

describe("the one sample voice with a pitch", () => {
  it("is a phase increment, so its lattice is uniform in frequency", () => {
    const binding = neogeoBinding("neogeo", spec);
    binding.init();
    const deltaAt = (hz: number): number => {
      const writes = registers(binding.encode(only(13, { hz, retrigger: true }), undefined));
      const low = writes.find(([half, reg]) => half === 0 && reg === 0x19)?.[2] ?? 0;
      const high = writes.find(([half, reg]) => half === 0 && reg === 0x1a)?.[2] ?? 0;
      return (high << 8) | low;
    };
    // Doubling the note doubles the register, which no divider-based channel in
    // the set can say.
    expect(deltaAt(880)).toBeCloseTo(deltaAt(440) * 2, -0.5);
  });

  it("points at a waveform the bank really holds", () => {
    const binding = neogeoBinding("neogeo", spec);
    binding.init();
    const writes = registers(binding.encode(only(13, { duty: 2, retrigger: true }), undefined));
    const region = adpcmBBank().regions.pulse50;
    expect(writes.find(([half, reg]) => half === 0 && reg === 0x12)?.[2]).toBe(
      region.startBlock & 0xff,
    );
    // Start with repeat, last of all, so the voice already knows what it plays.
    expect(writes.filter(([half, reg]) => half === 0 && reg === 0x10).at(-1)?.[2]).toBe(0x90);
  });
});

describe("the clock", () => {
  it("offers a timer and nothing else, because there is nothing else", () => {
    // The only console in the matrix whose sound processor cannot see the picture,
    // so unlike every other `fitRate` in the set there is no frame to beat.
    const fit = neogeoBinding("neogeo", spec).fitRate(120);
    expect(fit.source).toBe("timer");
    expect(fit.rate.num / fit.rate.den).toBeCloseTo(120, 1);
    expect(1024 - (fit.divisor ?? 0)).toBe(463);
  });
});

describe("the registry", () => {
  it("resolves the console, and carries fitted patches through", () => {
    // The arranger used to name `mdBinding` outright for any console with FM, so
    // the moment a second one arrived it was encoded as six FM voices and an
    // SN76489. Which binding a console gets is this registry's answer alone.
    const binding = bindingFor("neogeo");
    expect(binding.chips).toEqual(["ym2610"]);
    expect(binding.spec.channels).toHaveLength(14);
    expect(bindingFor("neogeo", { patches: [] }).console).toBe("neogeo");
  });

  it("emits no write outside a byte, on any channel", () => {
    const binding = bindingFor("neogeo");
    const all = [...binding.init()];
    for (const level of [0, 0.001, 0.2, 1]) {
      for (const hz of [30, 65, 293, 1758, 8000]) {
        const frames = silentFrames(spec).map(() => ({
          on: true,
          hz,
          level,
          retrigger: true,
          duty: 0,
        }));
        all.push(...binding.encode(frames, undefined));
      }
    }
    for (const write of all) {
      expect(Number.isInteger(write.value) && write.value >= 0 && write.value <= 255).toBe(true);
      expect(write.reg).toBeGreaterThanOrEqual(0);
      expect(write.reg).toBeLessThanOrEqual(3);
    }
  });
});
