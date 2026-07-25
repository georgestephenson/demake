import { findConsole, type ConsoleSpec } from "@demake/core";
import { describe, expect, it } from "vitest";

import { profiles } from "../src/profiles.js";

/**
 * The profile table restates a handful of numbers that already live in
 * `@demake/core`'s `ConsoleSpec`s. It restates them rather than importing them
 * so the simulator has no dependencies and the browser preview needs no
 * bundler — which is only safe if something stops the two copies drifting.
 * This is that something.
 */
describe("console profiles", () => {
  it("names a console the engine actually knows", () => {
    for (const profile of profiles) {
      expect(findConsole(profile.id), profile.id).toBeDefined();
    }
  });

  it("matches each ConsoleSpec's raw display size", () => {
    for (const profile of profiles) {
      const spec = findConsole(profile.id) as ConsoleSpec;
      expect([profile.id, profile.rawWidth, profile.rawHeight]).toEqual([
        profile.id,
        spec.display.width,
        spec.display.height,
      ]);
    }
  });

  it("derives the cell grid from the overscan-safe rect, not the raw frame", () => {
    for (const profile of profiles) {
      const spec = findConsole(profile.id) as ConsoleSpec;
      const safe = spec.display.overscanSafe ?? {
        x: 0,
        y: 0,
        width: spec.display.width,
        height: spec.display.height,
      };
      expect([profile.id, profile.screenWidth, profile.screenHeight]).toEqual([
        profile.id,
        Math.floor(safe.width / profile.cellSize),
        Math.floor(safe.height / profile.cellSize),
      ]);
    }
  });

  it("keeps the NES cell grid two rows shorter than its raw frame", () => {
    // The single most load-bearing consequence of using the safe rect: a game
    // that places something at `screenheight - 1` must not land in overscan.
    const nes = profiles.find((profile) => profile.id === "nes");
    expect(nes?.rawHeight).toBe(240);
    expect(nes?.screenHeight).toBe(28);
  });

  it("excludes the SG-1000, whose sprite hardware would distort the language", () => {
    expect(profiles.map((profile) => profile.id)).not.toContain("sg1000");
  });

  it("records a per-line sprite limit no larger than the total", () => {
    for (const profile of profiles) {
      expect(profile.sprites.perLine, profile.id).toBeLessThanOrEqual(profile.sprites.total);
      expect(profile.sprites.perLine, profile.id).toBeGreaterThan(0);
    }
  });
});
