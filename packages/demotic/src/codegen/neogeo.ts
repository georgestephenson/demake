/**
 * The `neogeo` backend: this console's answers to {@link Backend}'s six
 * questions.
 *
 * Everything about *what* a build does is `backend.ts`'s and everything about
 * what the game means is `shape.ts`'s; this file is the console — its memory
 * map, its image path, its cartridge. Three of the answers are worth reading for
 * what they say about the hardware.
 *
 *   - **The cartridge is a set of ROMs, not one image.** A P ROM the 68000
 *     executes, an S ROM the fix layer reads and a C ROM pair the sprite
 *     hardware reads, on buses no address space contains all of. `packNeoRom`
 *     writes the `.neo` container so `demake build` still produces one artifact,
 *     and the two graphics encoders are `core`'s because their block orders are
 *     the kind of thing that is wrong *and* consistent when an encoder and a
 *     reader are written together.
 *   - **Room is not a constraint anywhere.** Sixty-four kilobytes of work RAM
 *     against an NROM cartridge's two, and a tile budget that is a cartridge
 *     size rather than a bank because the video hardware reads characters
 *     straight out of the C ROM. There is no elastic-board story here yet: the
 *     `.neo` container has no size vocabulary to choose from.
 *   - **There is no sound.** This console's chip answers a Z80 that
 *     `demake build` emits no program for, so a cartridge is silent and says so
 *     — `bindAudio` returns a binding with no driver, exactly as a game with no
 *     audio files gets on every other console, and the request bytes a rule
 *     writes are still there so the trace is unchanged.
 */

import {
  AsmError,
  NEO_CODE_ORIGIN,
  packNeoCharacters,
  packNeoFix,
  packNeoHeader,
  packNeoRom,
  type Executor,
} from "@demake/core";

import { getProfile } from "../profiles.js";
import type { Program } from "../program.js";

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
import { NEOGEO_MEMORY, type Layout, type MemoryPlan } from "./layout.js";
import { M68kCtx } from "./m68k/ctx.js";
import { ART_TILES, bindNeogeoArt, type NeogeoArtOptions } from "./neogeo-art.js";
import { CODE_ORIGIN, emitProgram, STACK_TOP } from "./neogeo/emit.js";
import type { ArtSettings } from "./settings.js";

/**
 * Bytes a program may use.
 *
 * The P ROM is addressed from `$000000` and a demade game is tens of kilobytes,
 * so this is a ceiling nothing approaches — the megabyte the first cartridge
 * window holds, less the header this build puts in front of the code.
 */
export const CODE_SIZE = 0x100000 - NEO_CODE_ORIGIN;

/** What this backend's audio binding hands the emitter, which is nothing yet. */
interface NeogeoAudio extends BoundAudioShape {
  options: Record<string, never>;
}

/** The Neo Geo's implementation of the build. */
export const neogeoBackend: Backend<NeogeoArtOptions, NeogeoAudio> = {
  family: "neogeo",
  consoles: ["neogeo"],
  cartridge: "a Neo Geo cartridge",

  extension(): string {
    return "neo";
  },

  unsupported(program: Program): string[] {
    const missing: string[] = [];
    if (!neogeoBackend.consoles.includes(program.profile.id)) {
      missing.push(`a runtime for ${program.profile.name}`);
    }
    return missing;
  },

  memory(): MemoryPlan {
    return NEOGEO_MEMORY;
  },

  async bindArt(
    program: Program,
    assets: AssetBytes,
    executor?: Executor,
    settings?: ArtSettings,
  ): Promise<BoundAssets<NeogeoArtOptions>> {
    const art = await bindNeogeoArt(program, assets, executor, settings);
    return { emit: art.options, tiles: art.tiles, missing: art.missing };
  },

  checkTiles(program: Program, art: BoundAssets<NeogeoArtOptions>): void {
    if (art.tiles <= ART_TILES) return;
    throw new BuildError(
      "E_BACKDROP_TILES",
      `this game needs ${art.tiles} tiles and a sprite tile number holds ${ART_TILES}`,
      "every distinct 16x16 block of art is a tile here, because the playfield is built from sprites",
    );
    void program;
  },

  async bindAudio(): Promise<BoundAssets<NeogeoAudio>> {
    // No driver: the sound chip is the Z80's and this build emits no Z80
    // program. A game that names music still compiles and still records what its
    // rules asked for, so its trace is identical to a sounding console's.
    const emit: NeogeoAudio = {
      present: false,
      options: {},
      tracks: 0,
      effects: 0,
      code: 0,
      data: 0,
      helpers: [],
      rateHz: 0,
      writesRestricted: 0,
    };
    return { emit, tiles: 0, missing: [], notes: [] };
  },

  assemble({ program, analysis, layout, art, title }): Assembled {
    const ctx = new M68kCtx(program, analysis, layout, getProfile(program.profile.id), CODE_ORIGIN);
    // No driver, but the *request* a rule makes is still recorded: a trace's
    // `audio` field is what the rules asked for, not what a chip heard, so a
    // silent console has to trace identically to a sounding one (doc 14
    // §Conformance). Without this every game diverges on the tick a sound fires
    // and on nothing else, which is exactly what it did.
    if (program.sounds.length > 0 || program.tracks.length > 0) {
      ctx.audio = {
        driver: false,
        music: 0,
        request: 0,
        trace: layout.sound,
        effects: program.sounds.map(() => -1),
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

    const symbols = ctx.asm.symbols();
    const reset = symbols.get("Reset");
    const vint = symbols.get("Vint");
    if (reset === undefined || vint === undefined) {
      throw new BuildError("E_INTERNAL", "the code generator emitted no entry point");
    }
    if (code.length + NEO_CODE_ORIGIN > CODE_SIZE) {
      throw new BuildError(
        "E_GAME_TOO_LARGE",
        `this game compiles to ${code.length} bytes and the P ROM window holds ${CODE_SIZE}`,
      );
    }

    // The header goes in front of the code rather than being woven into it: this
    // console keeps its vectors and its `NEO-GEO` block in the first 512 bytes
    // and a demade program starts after them.
    const p = new Uint8Array(NEO_CODE_ORIGIN + code.length);
    p.set(
      packNeoHeader(NEO_CODE_ORIGIN + code.length, {
        stack: STACK_TOP,
        user: reset,
        vblank: vint,
        ...(title === undefined ? {} : { name: title }),
      }),
      0,
    );
    p.set(code, NEO_CODE_ORIGIN);

    const characters = packNeoCharacters(art.bank ?? new Uint8Array(0));
    return {
      bytes: packNeoRom(
        {
          p,
          s: packNeoFix(art.fix ?? new Uint8Array(0)),
          c1: characters.c1,
          c2: characters.c2,
        },
        title === undefined ? {} : { name: title },
      ),
      code: code.length,
      capacity: CODE_SIZE,
      symbols,
      helpers: ctx.helperNames(),
    };
  },
};

/** What to stamp in the cartridge, and what source bytes to demake. */
export type NeogeoRomOptions = BuildOptions;

/** Language features this backend does not implement. */
export function unsupportedNeogeoFeatures(program: Program): string[] {
  return neogeoBackend.unsupported(program);
}

/** Compile a program into a bootable `.neo`. */
export function buildNeogeoRom(
  program: Program,
  options: NeogeoRomOptions = {},
): Promise<BuiltRom> {
  return buildRom(program, neogeoBackend, options);
}

export type { Layout, Analysis };
