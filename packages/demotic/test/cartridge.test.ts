/**
 * The two things every console's build shares about its cartridge.
 *
 * `backend.ts` owns the shape of a build, and two of its steps are about the
 * *artifact* rather than about any one machine — so they are tested here, once,
 * against a stub backend rather than seven times against real ones:
 *
 *   - **Elastic sizing's bookkeeping.** Which boards a console has is its own
 *     answer and each backend's own test checks that it picked the right one
 *     (`nes-rom.test.ts`, `md-rom.test.ts`, `snes-rom.test.ts`). What is shared is
 *     what the numbers *mean*: `free` measured against the largest board and
 *     `cartridge` against what was written.
 *   - **Cutting the music.** A game too big for the biggest board its console
 *     came on loses its music and effects rather than failing to build (doc 14
 *     §When it does not fit, the music goes first). Reaching that with a real
 *     backend needs a game that overflows a real console *with* its audio and fits
 *     without — which is a fixture built to the last hundred bytes, and would stop
 *     testing this the first time a code generator got better. A stub backend that
 *     refuses exactly when the audio is present is the property itself.
 */

import { describe, expect, it } from "vitest";

import { compile } from "../src/compile.js";
import { getProfile } from "../src/profiles.js";
import {
  buildRom,
  type Assembled,
  type Backend,
  type BoundAssets,
  type BoundAudioShape,
} from "../src/codegen/backend.js";
import { GB_MEMORY, type MemoryPlan } from "../src/codegen/layout.js";

/** A game that names a track, which is what gives the build something to cut. */
const SOURCE = [
  "start play",
  "",
  "scene play",
  "music theme.mid",
  "",
  "create object block (width 1 cell, height 1 cell)",
  "create block wall in play (x 1, y 1)",
  "",
].join("\n");

function program() {
  return compile(SOURCE, { profile: getProfile("gb"), files: ["theme.mid"] });
}

interface StubAudio extends BoundAudioShape {
  options: Record<string, never>;
}

/**
 * A backend that is nothing but the two answers this file is about.
 *
 * `boards` is what its cartridge comes in and `codeFor` is how big the program
 * compiles to with and without its audio — so a test states the situation it wants
 * as two numbers rather than as a game somebody has to keep just-too-big.
 */
function stub(options: {
  boards: readonly number[];
  withAudio: number;
  withoutAudio: number;
}): Backend<Record<string, never>, StubAudio> {
  const largest = options.boards[options.boards.length - 1] as number;
  return {
    family: "stub",
    consoles: ["gb"],
    cartridge: "a stub cartridge",
    extension: () => "bin",
    unsupported: () => [],
    memory: (): MemoryPlan => GB_MEMORY,
    bindArt: async () => ({ emit: {}, tiles: 0, missing: [] }),
    // Present exactly when asset bytes were supplied, which is what the fallback
    // takes away: it binds again with an empty map.
    bindAudio: async (_program, assets): Promise<BoundAssets<StubAudio>> => ({
      emit: {
        options: {},
        present: assets.size > 0,
        tracks: assets.size > 0 ? 1 : 0,
        effects: 0,
        code: assets.size > 0 ? 100 : 0,
        data: assets.size > 0 ? 200 : 0,
        helpers: [],
        rateHz: 120,
        writesRestricted: 0,
      },
      tiles: 0,
      missing: assets.size > 0 ? [] : ["theme.mid"],
      notes: assets.size > 0 ? ["theme.mid: a note about the arrangement"] : [],
    }),
    checkTiles: () => {},
    assemble: ({ audio }): Assembled => {
      const code = audio.present ? options.withAudio : options.withoutAudio;
      const board = options.boards.find((bytes) => bytes >= code) ?? largest;
      return {
        bytes: new Uint8Array(board),
        code,
        // The largest board, always — which is the rule this file exists to pin.
        capacity: largest,
        symbols: new Map(),
        helpers: [],
      };
    },
  };
}

const ASSETS = new Map([["theme.mid", new Uint8Array([1, 2, 3])]]);

describe("what a build reports about the board it chose", () => {
  it("measures free against the largest board and cartridge against the one written", async () => {
    const built = await buildRom(
      program(),
      stub({ boards: [0x4000, 0x8000], withAudio: 1000, withoutAudio: 900 }),
      {
        assets: ASSETS,
      },
    );
    expect(built.stats.bytes).toBe(1000);
    expect(built.stats.cartridge).toBe(0x4000);
    expect(built.stats.free).toBe(0x8000 - 1000);
    expect(built.stats.cut).toEqual([]);
  });

  it("does not let headroom jump when a game crosses onto a bigger board", async () => {
    // The reason `free` is not measured against the board that shipped. These two
    // games differ by two bytes and land on different boards; if headroom followed
    // the board, the bigger one would report sixteen kilobytes more of it.
    const under = await buildRom(
      program(),
      stub({ boards: [0x4000, 0x8000], withAudio: 0x4000, withoutAudio: 0 }),
      {
        assets: ASSETS,
      },
    );
    const over = await buildRom(
      program(),
      stub({ boards: [0x4000, 0x8000], withAudio: 0x4002, withoutAudio: 0 }),
      {
        assets: ASSETS,
      },
    );
    expect(under.stats.cartridge).toBe(0x4000);
    expect(over.stats.cartridge).toBe(0x8000);
    expect(under.stats.free - over.stats.free).toBe(2);
  });
});

describe("a game that does not fit loses its music first", () => {
  it("builds silently, says what it cut, and keeps the game", async () => {
    const built = await buildRom(
      program(),
      stub({ boards: [0x8000], withAudio: 0x8001, withoutAudio: 0x7000 }),
      { assets: ASSETS },
    );
    expect(built.stats.bytes).toBe(0x7000);
    expect(built.stats.cut).toHaveLength(1);
    expect(built.stats.cut[0]).toMatch(/music and effects were cut/);
    // No audio in the cartridge, and the arrangement's notes go with it: they
    // describe a schedule that is not in there.
    expect(built.stats.audio).toBeUndefined();
    // And *not* reported as a missing file. What was not supplied and what was
    // dropped to fit are different things to be told, and only the second
    // happened here.
    expect(built.stats.missingAudio).toEqual([]);
  });

  it("says the music was already gone when even the silent build does not fit", async () => {
    await expect(
      buildRom(program(), stub({ boards: [0x8000], withAudio: 0x9000, withoutAudio: 0x8800 }), {
        assets: ASSETS,
      }),
    ).rejects.toMatchObject({
      code: "E_GAME_TOO_LARGE",
      message: expect.stringContaining("34816"),
      hint: expect.stringContaining("already"),
    });
  });

  it("leaves a game with no audio to fail as it always did", async () => {
    // Nothing to cut, so nothing is tried twice: the error is the plain one.
    await expect(
      buildRom(program(), stub({ boards: [0x8000], withAudio: 0x9000, withoutAudio: 0x9000 }), {}),
    ).rejects.toMatchObject({
      code: "E_GAME_TOO_LARGE",
      hint: expect.not.stringContaining("already"),
    });
  });
});
