/**
 * The `gba` backend: the Game Boy Advance's answers to {@link Backend}'s six
 * questions.
 *
 * Everything about *what* a build does is `backend.ts`'s and everything about
 * what the game means is `shape.ts`'s; this file is the console — its memory
 * map, its image path, its cartridge — and `gb.ts`, `nes.ts`, `sms.ts`,
 * `snes.ts` and `md.ts` beside it are the other five.
 *
 * Three of the answers are worth reading for what they say about the hardware
 * rather than about the code:
 *
 *   - **The header is inside the program.** A Game Boy Advance starts executing
 *     at the first word of the cartridge, so what is there is a branch over the
 *     188 bytes that follow it — the program and its header interleave, which no
 *     other console in the set does, and which is why the emitter reserves the
 *     header rather than the wrapper prepending one.
 *   - **Nothing here is scarce, and that is the news.** Thirty-two megabytes of
 *     cartridge, 32 KiB of fast internal work RAM, 48 KiB of background
 *     character memory and another 32 for the objects, with 256 colours in each
 *     of two palettes. Every size assertion the 8-bit backends carry is about a
 *     game that nearly did not fit; the interesting decisions here are all in
 *     the art path.
 *   - **There is no sound yet, and that is a gap rather than a decision.** The
 *     hardware has the Game Boy's four channels *and* two sample channels fed by
 *     DMA (`@demake/chip`'s `GbApu` and `GbaPcm` both model it), but the ARM
 *     driver that would play a demade schedule does not exist — so a `.dmt` that
 *     names music compiles, records the request its rules make, and traces
 *     identically to a build that played it. Doc 13 §D4 is where that is tracked.
 */

import { AsmError, packGbaRom, type Executor } from "@demake/core";

import { getProfile } from "../profiles.js";
import type { Program } from "../program.js";
import { BUILTIN_TILES } from "../rom/graphics.js";

import { type Analysis } from "./analyze.js";
import type { AssetBytes } from "./art.js";
import {
  buildRom,
  BuildError,
  type Assembled,
  type Backend,
  type BoundAssets,
  type BoundAudioShape,
  type BuildOptions,
  type BuiltRom,
} from "./backend.js";
import { ART_TILES, bindGbaArt, OBJECT_ART_TILES } from "./gba-art.js";
import { GbaCtx } from "./gba/ctx.js";
import { BANK_TILES, CODE_ORIGIN, emitProgram, type GbaEmitOptions } from "./gba/emit.js";
import { GBA_MEMORY, type Layout, type MemoryPlan } from "./layout.js";

/** The largest image the cartridge bus addresses. */
export const ROM_LIMIT = 32 * 1024 * 1024;

/**
 * What this backend's art binding hands the emitter, plus the two budgets.
 *
 * Two, because this is the first console whose objects have character memory of
 * their own: `tiles` is the background bank's and `objectTiles` is the object
 * bank's, and a game can exhaust either without touching the other.
 */
interface GbaArt extends GbaEmitOptions {
  objectTiles: number;
}

/**
 * What this backend's audio binding hands the emitter.
 *
 * The shape the other five have, with the driver half empty: there is no ARM
 * driver yet, so `present` is always false and nothing is emitted that plays a
 * note. What *is* here is `hooks`, and it matters — a rule with a `sound` still
 * records which effect it asked for, because that byte is a field of the trace
 * (doc 14 §Conformance). A build whose audio cannot be played has to trace
 * identically to one that can, or the conformance suite would be comparing two
 * different games.
 */
interface GbaAudio extends BoundAudioShape {
  options: GbaEmitOptions;
  /** The bytes a rule writes to ask for a sound; absent when none can. */
  hooks?: { driver: boolean; music: number; request: number; effects: readonly number[] };
}

/** The Game Boy Advance's implementation of the build. */
export const gbaBackend: Backend<GbaArt, GbaAudio> = {
  family: "gba",
  consoles: ["gba"],
  cartridge: "a Game Boy Advance cartridge",

  extension(): string {
    return "gba";
  },

  unsupported(program: Program): string[] {
    const missing: string[] = [];
    if (!gbaBackend.consoles.includes(program.profile.id)) {
      missing.push(`a runtime for ${program.profile.name}`);
    }
    return missing;
  },

  memory(): MemoryPlan {
    return GBA_MEMORY;
  },

  async bindArt(
    program: Program,
    assets: AssetBytes,
    executor?: Executor,
  ): Promise<BoundAssets<GbaArt>> {
    const art = await bindGbaArt(program, assets, executor);
    return {
      emit: { ...art.options, objectTiles: art.objectTiles },
      tiles: art.tiles,
      missing: art.missing,
    };
  },

  checkTiles(program: Program, art: BoundAssets<GbaArt>): void {
    const used = art.tiles + BUILTIN_TILES;
    if (used > BANK_TILES) {
      const backdrops = program.scenes.filter((scene) => scene.backdrop !== undefined).length;
      throw new BuildError(
        "E_BACKDROP_TILES",
        `this game needs ${used} background tiles and the bank holds ${BANK_TILES}`,
        backdrops > 0
          ? "a backdrop costs one tile per distinct 8x8 cell — flatter areas and repeated motifs cost fewer"
          : "fewer level tiles, or simpler ones; every distinct 8x8 cell of art is a tile",
      );
    }
    // The object bank is a *second* budget rather than a share of the first, so
    // it is refused separately and with its own message: a game that ran out of
    // room for its sprites has learned nothing from being told about backdrops.
    // The same code, because the failure is the same class — art needing more
    // tiles than the machine has — and a diagnostic code is part of the language
    // surface (AGENTS.md §Iron rules), not a backend's to invent.
    if (art.emit.objectTiles > OBJECT_ART_TILES) {
      throw new BuildError(
        "E_BACKDROP_TILES",
        `this game needs ${art.emit.objectTiles} object tiles and the object bank holds ${OBJECT_ART_TILES}`,
        "fewer objects, or smaller ones; every distinct 8x8 cell of art is a tile",
      );
    }
  },

  async bindAudio(program: Program): Promise<BoundAssets<GbaAudio>> {
    const names = program.tracks.length > 0 || program.sounds.length > 0;
    const emit: GbaAudio = {
      present: false,
      options: {},
      tracks: 0,
      effects: 0,
      code: 0,
      data: 0,
      helpers: [],
      rateHz: 0,
      writesRestricted: 0,
      ...(names
        ? {
            hooks: {
              driver: false,
              music: 0,
              request: 0,
              effects: program.sounds.map(() => -1),
            },
          }
        : {}),
    };
    return { emit, tiles: 0, missing: [] };
  },

  assemble({ program, analysis, layout, art, audio, title }): Assembled {
    const ctx = new GbaCtx(program, analysis, layout, getProfile(program.profile.id), CODE_ORIGIN);
    if (audio.hooks) {
      ctx.audio = {
        driver: audio.hooks.driver,
        music: audio.hooks.music,
        request: audio.hooks.request,
        trace: layout.sound,
        effects: audio.hooks.effects,
      };
    }
    let code: Uint8Array;
    try {
      emitProgram(ctx, art);
      code = ctx.asm.assemble();
    } catch (error) {
      if (error instanceof AsmError) {
        throw new BuildError(
          "E_INTERNAL",
          `the code generator produced invalid code: ${error.message}`,
        );
      }
      throw error;
    }

    if (ctx.asm.symbols().get("Reset") === undefined) {
      throw new BuildError("E_INTERNAL", "the code generator emitted no entry point");
    }
    if (code.length > ROM_LIMIT) {
      throw new BuildError(
        "E_GAME_TOO_LARGE",
        `this game compiles to ${code.length} bytes and the cartridge bus reaches ${ROM_LIMIT}`,
      );
    }
    // Rounded up to 32 KiB by the wrapper, which is padding for the sake of a
    // predictable artifact rather than a hardware requirement: this console has
    // no size field and no mirroring rule to satisfy.
    const bytes = packGbaRom(code, {
      ...(title === undefined ? {} : { title: title.slice(0, 12).toUpperCase() }),
    });
    return {
      bytes,
      code: code.length,
      capacity: ROM_LIMIT,
      symbols: ctx.asm.symbols(),
      helpers: ctx.helperNames(),
    };
  },
};

/** What to stamp in the cartridge, and what source bytes to demake. */
export type GbaRomOptions = BuildOptions;

/** Language features this backend does not implement. */
export function unsupportedGbaFeatures(program: Program): string[] {
  return gbaBackend.unsupported(program);
}

/** Compile a program into a bootable `.gba`. */
export function buildGbaRom(program: Program, options: GbaRomOptions = {}): Promise<BuiltRom> {
  return buildRom(program, gbaBackend, options);
}

export type { Layout, Analysis, GbaEmitOptions };
export { ART_TILES };
