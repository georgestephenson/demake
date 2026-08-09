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

import { buildNeogeoGameAudio, NEOGEO_SFX_BASE, type NeogeoGameAudio } from "@demake/audio";

import { getProfile } from "../profiles.js";
import type { Program } from "../program.js";

import { type Analysis } from "./analyze.js";
import { bindAudio, effectIndices, trackForScene } from "./audio.js";
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
import { CODE_ORIGIN, emitProgram, STACK_TOP, type NeogeoEmitOptions } from "./neogeo/emit.js";
import type { ArtSettings } from "./settings.js";

/**
 * Bytes a program may use.
 *
 * The P ROM is addressed from `$000000` and a demade game is tens of kilobytes,
 * so this is a ceiling nothing approaches — the megabyte the first cartridge
 * window holds, less the header this build puts in front of the code.
 */
export const CODE_SIZE = 0x100000 - NEO_CODE_ORIGIN;

/**
 * What this backend's audio binding hands the emitter.
 *
 * Unlike every other console's, the driver is not routines the game's own image
 * carries: it is a whole second program with its own ROM, so what the binding
 * hands over is a *region* rather than an emitter option. `options` therefore
 * carries only the scene-track table, which is the game side's whole share of
 * the audio.
 */
interface NeogeoAudio extends BoundAudioShape {
  options: NeogeoEmitOptions;
  /** The built sound program, or absent for a game with nothing to play. */
  rom?: NeogeoGameAudio;
  /** The bytes a rule writes to ask for a sound; absent when none can. */
  hooks?: { driver: boolean; music: number; request: number; effects: readonly number[] };
}

/**
 * Where the 68000 asks for a sound, which is not memory.
 *
 * `$320000` is one byte into a whole second computer: the hardware latches it and
 * pulls that processor's non-maskable line, so a store is the entire request
 * protocol. Stated here rather than imported from `@demake/neogeo` because a
 * backend may not depend on a core, exactly as every other backend states its own
 * hardware addresses.
 */
const REG_SOUND = 0x320000;

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

  async bindAudio(
    program: Program,
    assets: AssetBytes,
    _layout: Layout,
    executor?: Executor,
  ): Promise<BoundAssets<NeogeoAudio>> {
    // The layout is unused, which is this console alone: every other backend
    // gates on `layout.audio` because its driver lives in the game's own work
    // RAM. Here the driver is a whole program on a processor of its own with its
    // own two kilobytes, so there is nothing for this machine's allocator to set
    // aside and nothing for it to refuse.
    const names = program.tracks.length > 0 || program.sounds.length > 0;
    const bound = names
      ? await bindAudio(
          program,
          assets,
          { build: (tracks, effects) => buildNeogeoGameAudio({ tracks, effects }) },
          executor,
        )
      : { driver: undefined, missing: [] as readonly string[], notes: [] as readonly string[] };
    const driver = bound.driver;
    const options: NeogeoEmitOptions = driver ? { sceneTracks: trackForScene(program, bound) } : {};
    const emit: NeogeoAudio = {
      present: driver !== undefined,
      options,
      tracks: driver?.stats.tracks ?? 0,
      effects: driver?.stats.effects ?? 0,
      // Not queries here, unlike every other console: this driver is a *separate
      // image* and is assembled by `buildNeogeoGameAudio` before it returns, so
      // its sizes are real the moment the binding has one.
      code: driver?.stats.code ?? 0,
      data: driver?.stats.data ?? 0,
      helpers: driver?.stats.helpers ?? [],
      rateHz: driver ? driver.stats.rate.num / driver.stats.rate.den : 0,
      writesRestricted: driver?.stats.writesRestricted ?? 0,
      ...(driver ? { rom: driver } : {}),
      ...(names
        ? {
            hooks: {
              driver: driver !== undefined,
              // Both requests are the same address, because on this console a
              // request is not a variable at all: `REG_SOUND` is one byte into a
              // second computer, and which of the two things it means is in the
              // *value*.
              music: REG_SOUND,
              request: REG_SOUND,
              effects: driver
                ? effectIndices(program, bound).map((index) =>
                    // The shared 68000 rule emitter stores `index + 1`, and this
                    // console's effect commands start at `SFX_BASE` — so the
                    // table is offset rather than the emitter being branched.
                    index < 0 ? -1 : NEOGEO_SFX_BASE + index - 1,
                  )
                : program.sounds.map(() => -1),
            },
          }
        : {}),
    };
    return { emit, tiles: 0, missing: bound.missing, notes: bound.notes };
  },

  assemble({ program, analysis, layout, art, audio, title }): Assembled {
    const ctx = new M68kCtx(program, analysis, layout, getProfile(program.profile.id), CODE_ORIGIN);
    // No driver, but the *request* a rule makes is still recorded: a trace's
    // `audio` field is what the rules asked for, not what a chip heard, so a
    // silent console has to trace identically to a sounding one (doc 14
    // §Conformance). Without this every game diverges on the tick a sound fires
    // and on nothing else, which is exactly what it did.
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
      emitProgram(ctx, { ...art, ...audio.options });
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
    const sound = audio.rom;
    return {
      bytes: packNeoRom(
        {
          p,
          s: packNeoFix(art.fix ?? new Uint8Array(0)),
          c1: characters.c1,
          c2: characters.c2,
          // The three sound regions, which are three different things on three
          // different buses: a Z80 program and the two sample ROMs its chip's two
          // ADPCM sections read in two different codecs.
          ...(sound ? { m: sound.rom, v1: sound.samplesA, v2: sound.samplesB } : {}),
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
