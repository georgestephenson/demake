/**
 * Stereo placement, from the taper up to the audio (docs 16, 17 §Stereo placement).
 *
 * Four things here would each let a wrong placement ship quietly, and none of
 * them is visible in the register diff the rest of the audio suite runs on:
 *
 *   - **Centre has to be byte-identical to no placement at all.** That is what
 *     makes the change reviewable — a part the arranger leaves alone must encode
 *     exactly what it did when `pan` was a pair of booleans — and it is the one
 *     property that a green conformance battery cannot distinguish from a
 *     placement layer that never ran.
 *   - **A level-panning chip has to actually place**, rather than reduce to the
 *     three positions the booleans could say. This is the A5.5 line itself: the
 *     spec has claimed `lr-level` all along and the demaker could not reach it.
 *   - **A switch-panning chip must not be handed a position it cannot take**,
 *     and must never end up with *both* sides cut, which is a channel that plays
 *     to nobody.
 *   - **The arrangement must not be mono.** Every one of these consoles rendered
 *     a stereo file whose two channels were bit-identical before this existed,
 *     which no assertion in the suite was in a position to notice.
 */

import { describe, expect, it } from "vitest";

import { getConsole } from "@demake/core";

import { arrangeScore } from "../src/arrange/index.js";
import { attenuate, panGains, panSides } from "../src/binding/pan.js";
import { audioConsoles, bindingFor } from "../src/binding/registry.js";
import { silentFrames } from "../src/binding/types.js";
import type { ChannelFrame, ChipScript } from "../src/chipscript.js";
import { parseMidi } from "../src/score/midi.js";
import { render } from "../src/render.js";
import { octetFixture } from "./_fixtures.js";

/**
 * The console lists are *derived from the specs*, never written down.
 *
 * Same rule the support matrix runs under (AGENTS.md §Iron rules): a hand-kept
 * list of which consoles pan by level is a list that falls out of step with
 * `audio-specs.ts` the first time a console is added, and the failure mode is
 * a console silently dropping out of coverage rather than a red test.
 */
function channelsPanning(consoleId: string, kind: "lr-level" | "lr-enable" | "none"): number {
  const spec = getConsole(consoleId).audio;
  if (spec === undefined) return 0;
  return spec.channels.filter((channel) => channel.panning === kind).length;
}

/** Consoles with at least one channel that pans by level — something to spend. */
const LEVEL_PANNED = audioConsoles().filter((id) => channelsPanning(id, "lr-level") > 0);

/** Consoles whose hardware has some stereo at all. */
const STEREO = audioConsoles().filter(
  (id) => channelsPanning(id, "lr-level") + channelsPanning(id, "lr-enable") > 0,
);

/**
 * The one stereo console whose *render* cannot be asserted on, and why.
 *
 * `GbaPcm.clockHz` is 32768, which is below the 48 kHz the renderer defaults
 * to — the only model in the set whose clock is under the output rate, because
 * it is a mixer rather than an oscillator. `BoxSink` computes its boundaries as
 * `floor(i × clockHz / sampleRate)`, so consecutive boundaries collide, the
 * integration width is zero and every sample after the first is `0 / 0`. That
 * predates the placement stage — a `demake render -c gba` has always written an
 * all-NaN WAV — and fixing it is a question about what the one renderer does
 * when it has to *upsample*, which is doc 16's rather than this file's.
 *
 * The register schedule is unaffected, so this console is still covered by the
 * placement assertions above and by `audio-gba.test.ts`'s byte-for-byte mixer
 * proof, which compares the driver against the model's integer mix rather than
 * against a float render.
 */
const RENDER_IS_NAN = "gba";

describe("the taper", () => {
  it("leaves both sides at full in the centre", () => {
    // The whole compatibility argument rests on this one line.
    expect(panGains(0)).toEqual({ left: 1, right: 1 });
    expect(panGains(undefined)).toEqual({ left: 1, right: 1 });
    expect(panSides(0)).toEqual({ left: true, right: true });
    expect(panSides(undefined)).toEqual({ left: true, right: true });
  });

  it("reaches silence on the far side only at a hard pan", () => {
    expect(panGains(1)).toEqual({ left: 0, right: 1 });
    expect(panGains(-1)).toEqual({ left: 1, right: 0 });
    // Halfway out is halfway down, and the near side never moves — a balance
    // law rather than a constant-power one.
    expect(panGains(0.5)).toEqual({ left: 0.5, right: 1 });
  });

  it("clamps a position rather than trusting the caller", () => {
    expect(panGains(9)).toEqual({ left: 0, right: 1 });
    expect(panGains(Number.NaN)).toEqual({ left: 1, right: 1 });
  });

  it("never cuts both sides of a switch-panned channel", () => {
    // A channel with neither side is a channel nobody hears, and it would look
    // like a dropped part rather than like a panning bug.
    for (let at = -1; at <= 1; at += 0.05) {
      const sides = panSides(at);
      expect(sides.left || sides.right).toBe(true);
    }
  });

  it("rounds an attenuation rather than truncating it", () => {
    // At fifteen steps the difference between rounding and truncating is most
    // of what a gentle placement was asking for.
    expect(attenuate(15, 0.9)).toBe(14);
    expect(attenuate(15, 1)).toBe(15);
    expect(attenuate(15, 0)).toBe(0);
  });
});

describe("a level-panned chip", () => {
  /**
   * One sounding frame on the first level-panned channel, placed at `pan`.
   *
   * The *first level-panned* one rather than the first, because a console can
   * be both: a Game Boy Advance's channels 0–3 are a Game Boy APU behind
   * `NR51` and only its mixer voices above them take a position. Probing
   * channel 0 there asks the switch-panned half to do something it cannot.
   */
  function encodeAt(consoleId: string, pan: number | undefined) {
    const spec = getConsole(consoleId).audio!;
    const binding = bindingFor(consoleId);
    const index = spec.channels.findIndex((channel) => channel.panning === "lr-level");
    const frames = silentFrames(spec);
    frames[index] = {
      on: true,
      hz: 440,
      level: 1,
      retrigger: true,
      ...(pan === undefined ? {} : { pan }),
    } satisfies ChannelFrame;
    return binding.encode(frames, undefined);
  }

  /** A schedule of one channel holding one note, placed at `pan`. */
  function scriptAt(consoleId: string, pan: number): ChipScript {
    const binding = bindingFor(consoleId);
    const ticks = [];
    for (let tick = 0; tick < 48; tick += 1) {
      const writes = binding.encode(framesAt(consoleId, pan, tick === 0), undefined);
      ticks.push({ writes: tick === 0 ? [...binding.init(), ...writes] : writes });
    }
    return {
      console: consoleId,
      chips: binding.chips,
      driver: { rate: { num: 120, den: 1 }, source: "timer" },
      ticks,
      loopTick: -1,
      channels: [],
      timing: {
        source: "timer",
        requestedBpm: 120,
        achievedBpm: 120,
        ppmError: 0,
        rowsPerBeat: 4,
        maxOnsetDeviationMs: 0,
        accumulates: false,
      },
      budgets: { writes: 0, peakWritesPerTick: 0, writeBudget: 32 },
    };
  }

  function framesAt(consoleId: string, pan: number, retrigger: boolean): ChannelFrame[] {
    const spec = getConsole(consoleId).audio!;
    const index = spec.channels.findIndex((channel) => channel.panning === "lr-level");
    const frames = silentFrames(spec);
    frames[index] = { on: true, hz: 440, level: 1, pan, ...(retrigger ? { retrigger } : {}) };
    return frames;
  }

  /**
   * Placing right must make the *right* side louder, and vice versa.
   *
   * The assertion below this one only says a gentle placement encodes
   * differently from centre and from a hard one — which an encoder with its two
   * sides swapped satisfies completely. The Nintendo DS's did: its register is
   * a single byte with centre at 64, so an inversion is one expression rather
   * than two swapped stores, and it read as a perfectly good placement in the
   * wrong speaker. Nothing else in this suite could see it, because a register
   * diff compares a schedule against itself (AGENTS.md §Gotchas — a mapping
   * that is wrong *and consistent* passes everything).
   */
  it.each(LEVEL_PANNED.filter((id) => id !== RENDER_IS_NAN))(
    "places %s on the side it was asked for",
    (consoleId) => {
      const energy = (pan: number): [number, number] => {
        const pcm = render(scriptAt(consoleId, pan), { tailSeconds: 0 });
        const [left, right] = [pcm.channels[0]!, pcm.channels[1]!];
        let l = 0;
        let r = 0;
        for (let i = 0; i < left.length; i += 1) l += Math.abs(left[i]!);
        for (let i = 0; i < right.length; i += 1) r += Math.abs(right[i]!);
        return [l, r];
      };

      const [leftL, leftR] = energy(-1);
      expect(leftL).toBeGreaterThan(leftR);

      const [rightL, rightR] = energy(1);
      expect(rightR).toBeGreaterThan(rightL);

      // And centre is even, which is what says the taper is symmetric rather
      // than merely ordered.
      const [centreL, centreR] = energy(0);
      expect(centreL).toBeCloseTo(centreR, 5);
    },
  );

  it.each(LEVEL_PANNED)("places %s somewhere the booleans could not reach", (consoleId) => {
    const centre = JSON.stringify(encodeAt(consoleId, 0));
    const hard = JSON.stringify(encodeAt(consoleId, 1));
    const gentle = JSON.stringify(encodeAt(consoleId, 0.35));

    // Absent and centre are the same thing, which is the compatibility claim.
    expect(JSON.stringify(encodeAt(consoleId, undefined))).toBe(centre);
    // A hard pan differs from centre — true of the booleans too.
    expect(hard).not.toBe(centre);
    // And a *gentle* one differs from both, which is the part that is new: it
    // is a position the old representation had no way of expressing.
    expect(gentle).not.toBe(centre);
    expect(gentle).not.toBe(hard);
  });
});

describe("an arrangement", () => {
  const score = parseMidi(octetFixture());

  it.each(audioConsoles())(
    "places %s without moving what carries the piece",
    (consoleId: string) => {
      const script = arrangeScore(score, { console: consoleId }).script;
      const byChannel = new Map(script.channels.map((span) => [span.channelId, span]));

      for (const span of byChannel.values()) {
        expect(span.pan).toBeGreaterThanOrEqual(-1);
        expect(span.pan).toBeLessThanOrEqual(1);
      }

      // Bass, the tune and the kit hold the middle. Checked through the *parts*
      // rather than the channels, because which channel a role lands on is the
      // planner's business and changes per console.
      const parts = new Map(score.parts.map((part) => [part.id, part]));
      const leads = script.channels.filter((s) => parts.get(s.partId)?.role === "lead");
      for (const span of script.channels) {
        const role = parts.get(span.partId)?.role;
        if (role === "bass" || role === "percussion") expect(span.pan).toBe(0);
      }
      // Exactly one lead keeps the centre: the others are counter-lines, and
      // centring all of them is what made a four-channel console mono. Only
      // asked of a console that *can* place, because a mono machine correctly
      // reports every channel at centre and would otherwise fail for having
      // told the truth.
      if (leads.length > 1 && STEREO.includes(consoleId)) {
        expect(leads.filter((span) => span.pan === 0)).toHaveLength(1);
      }
    },
  );

  it.each(STEREO.filter((id) => id !== RENDER_IS_NAN))("is not mono on %s", (consoleId) => {
    const script = arrangeScore(score, { console: consoleId }).script;
    const pcm = render(script);
    expect(pcm.channels).toHaveLength(2);

    const [left, right] = [pcm.channels[0]!, pcm.channels[1]!];
    let apart = 0;
    for (let i = 0; i < left.length; i += 1) apart += Math.abs(left[i]! - right[i]!);
    // Every console rendered exactly 0 here before the placement stage existed,
    // so this is the assertion that would have caught the whole gap.
    expect(apart).toBeGreaterThan(0);
  });

  it.each(audioConsoles().filter((id) => !STEREO.includes(id)))(
    "reports no placement at all on %s, whose hardware has none",
    (consoleId: string) => {
      // The binding would ignore a position on these machines, so a placement
      // here encodes identically and *says* something false — an NES
      // arrangement claiming a stereo image in `--json` and the piano roll.
      const script = arrangeScore(score, { console: consoleId }).script;
      for (const span of script.channels) expect(span.pan).toBe(0);
    },
  );

  it("is deterministic", () => {
    // The placement runs inside a four-candidate tournament, so two runs that
    // placed the image differently would be an output-byte change with no cause.
    const first = arrangeScore(score, { console: "snes" }).script.channels.map((s) => s.pan);
    const second = arrangeScore(score, { console: "snes" }).script.channels.map((s) => s.pan);
    expect(second).toEqual(first);
  });
});
