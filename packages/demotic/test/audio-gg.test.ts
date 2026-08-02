/**
 * The Game Gear: the same chip and the same driver, plus one shared register.
 *
 * A whole fourth pass over the battery would prove the Z80 player twice, so this
 * is the difference alone — the stereo latch, which is the handheld's `NR51`. One
 * byte carries every channel's left and right enables in the same two-nibble
 * layout, so two streams that stored it would erase each other and the driver
 * merges instead. That path exists on no other Sega machine, and nothing in the
 * Master System's own pass would run it.
 */

import { describe, expect, it } from "vitest";

import type { ChipScript, GameEffect } from "@demake/audio";
import { buildSmsGameAudio } from "@demake/audio";

import { compile } from "../src/compile.js";
import { getProfile } from "../src/profiles.js";
import { bindAudio } from "../src/codegen/audio.js";
import { buildSmsRom } from "../src/codegen/sms.js";

import {
  MUSIC_ONLY,
  WITH_EFFECT,
  build,
  capture,
  channelOfEffect,
  firstDivergence,
  target,
  type Driver,
  type Target,
} from "./_audio-battery.js";
import { exampleProject } from "./_projects.js";

describe("a Game Gear's stereo latch, which two streams share", async () => {
  /** The stereo latch, as `@demake/chip` and a `ChipScript` number it. */
  const STEREO = 0x06;

  async function buildGg(source: string, project = "pong") {
    // The project supplies the file list as well as the bytes, exactly as every
    // other target's build does: a source that says `music rally.mid` resolves
    // against the folder, and without the list the reference stands as written
    // and the binding finds no track at all (doc 19 §The rule).
    const { files, levels, assets } = exampleProject(project);
    const program = compile(source, { profile: getProfile("gg"), files, levels });
    const built = await buildSmsRom(program, { assets });
    const state = built.layout.audio as number;
    const bound = await bindAudio(program, assets, {
      build: (tracks, effects) =>
        buildSmsGameAudio({ tracks, effects: effects as GameEffect[], state }),
    });
    return { built, bound };
  }

  const gg: Target = {
    ...target("sms"),
    id: "gg",
    name: "Game Gear",
    mergeReg: STEREO,
    build: (source, project) => buildGg(source, project),
  };

  it("performs the music tick for tick, merge writes and all", async () => {
    const { built, bound } = await buildGg(MUSIC_ONLY);
    const script = bound.driver?.performed.tracks[0] as ChipScript;
    const address = built.symbols.get("AudioTick") as number;
    const ticks = 300;
    const expected = script.ticks.slice(0, ticks).map((tick) => [...tick.writes]);
    expect(firstDivergence(expected, capture(gg, built.bytes, address, ticks))).toBeNull();
  });

  it("leaves the music's own bits alone in the latch they share", async () => {
    const { built, bound } = await buildGg(WITH_EFFECT);
    const effect = (bound.driver as Driver).performed.effects[0] as ChipScript;
    const owned = channelOfEffect(gg, effect);
    const address = built.symbols.get("AudioTick") as number;
    const press = Math.round(120 * gg.ratio);
    const groups = capture(gg, built.bytes, address, Math.round(400 * gg.ratio), press);

    const shared = groups
      .slice(press + 10)
      .flat()
      .filter((write) => write.reg === STEREO);
    expect(shared.length).toBeGreaterThan(0);
    // The byte carries each channel twice, left and right, four bits apart — so
    // masking with both is what asks whether anything but the effect survived.
    const musical = (owned | (owned << 4)) ^ 0xff;
    expect(shared.some((write) => (write.value & musical) !== 0)).toBe(true);
  });

  it("emits the merge on the handheld and not on the Master System", async () => {
    expect((await buildGg(WITH_EFFECT)).built.stats.audio?.helpers ?? []).toContain("stereo-merge");
    // A Master System has no register two streams both write, so there is
    // nothing to fold and no routine to fold it with.
    const sms = target("sms");
    const helpers = (await build(sms, WITH_EFFECT)).built.stats.audio?.helpers ?? [];
    expect(helpers.some((name) => name.includes("merge"))).toBe(false);
    // The preemption machinery is still there: sharing the chip is what needs it,
    // and a shared *register* is a separate question the two machines answer
    // differently.
    expect(helpers).toContain("music-preemptible-runs");
  });
});
