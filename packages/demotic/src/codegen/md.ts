/**
 * The `md` backend: the Mega Drive's answers to {@link Backend}'s six questions.
 *
 * Everything about *what* a build does is `backend.ts`'s and everything about
 * what the game means is `shape.ts`'s; this file is the console — its memory
 * map, its image path, its cartridge — and `gb.ts`, `nes.ts` and `sms.ts` beside
 * it are the other three.
 *
 * Three of the answers are worth reading for what they say about the hardware
 * rather than about the code:
 *
 *   - **The cartridge is a wrapper, not an overlay.** The 68000 takes its stack
 *     pointer and its reset vector from the first eight bytes of the image and
 *     the console's boot ROM reads a header at `$0100`, so the program starts at
 *     `$0200` and never has to know where either lives. That is the iNES
 *     arrangement rather than the Master System's, where sixteen bytes of header
 *     sit *inside* the program's own address space.
 *   - **Room is not the constraint here, and that is the news.** Half a megabyte
 *     of cartridge against thirty-two kilobytes on the other three consoles, and
 *     sixty-four kilobytes of work RAM against two on an NROM cartridge. Every
 *     size assertion the other backends carry is about a game that nearly did
 *     not fit; this one has no such story, which is why the interesting numbers
 *     here are the tile bank's and the palette's.
 *   - **There is no audio driver yet, and the build says so honestly.** This
 *     console's sound is a second processor with an FM chip beside it (doc 16
 *     §Still to come). A game that names music and effects still *records* what
 *     it asked for, so its trace is the trace a sounding build would produce and
 *     the conformance suite compares like with like.
 */

import { AsmError, MD_ROM_SIZE, packMdRom, type Executor } from "@demake/core";

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
import { MD_MEMORY, type Layout, type MemoryPlan } from "./layout.js";
import { ART_TILES, bindMdArt } from "./md-art.js";
import { MdCtx } from "./md/ctx.js";
import {
  BANK_TILES,
  CODE_ORIGIN,
  emitProgram,
  STACK_TOP,
  type MdEmitOptions,
} from "./md/emit.js";

/** Bytes a Demotic Mega Drive cartridge holds. */
export const ROM_SIZE = MD_ROM_SIZE;

/**
 * Bytes of it a game may use.
 *
 * The whole cartridge less the vectors and the header, which this console keeps
 * *outside* the program rather than inside it — so unlike the Sega 8-bits there
 * is no region the emitter has to avoid running into.
 */
export const CODE_SIZE = MD_ROM_SIZE - CODE_ORIGIN;

/**
 * What this backend's audio binding hands the emitter.
 *
 * The same shape the other three carry, with the driver half permanently absent:
 * `present` is false, so the build report has no audio section, and `hooks`
 * carries only the byte a rule writes for a trace to read. That byte is set
 * whenever the program *names* audio, driver or no driver, because the request is
 * a field of the trace (doc 14 §Conformance).
 */
interface MdAudio extends BoundAudioShape {
  hooks?: { driver: boolean; music: number; request: number; effects: readonly number[] };
}

/** The Mega Drive's implementation of the build. */
export const mdBackend: Backend<MdEmitOptions, MdAudio> = {
  family: "md",
  consoles: ["md"],
  cartridge: "a Mega Drive cartridge",

  extension(): string {
    return "md";
  },

  unsupported(program: Program): string[] {
    const missing: string[] = [];
    if (!mdBackend.consoles.includes(program.profile.id)) {
      missing.push(`a runtime for ${program.profile.name}`);
    }
    return missing;
  },

  memory(): MemoryPlan {
    return MD_MEMORY;
  },

  async bindArt(
    program: Program,
    assets: AssetBytes,
    executor?: Executor,
  ): Promise<BoundAssets<MdEmitOptions>> {
    const art = await bindMdArt(program, assets, executor);
    return { emit: art.options, tiles: art.tiles, missing: art.missing };
  },

  checkTiles(program: Program, art: BoundAssets<MdEmitOptions>): void {
    const used = art.tiles + BUILTIN_TILES;
    if (used <= BANK_TILES) return;
    const backdrops = program.scenes.filter((scene) => scene.backdrop !== undefined).length;
    throw new BuildError(
      "E_BACKDROP_TILES",
      `this game needs ${used} tiles and the bank holds ${BANK_TILES}`,
      backdrops > 0
        ? "a backdrop costs one tile per distinct 8x8 cell — flatter areas and repeated motifs cost fewer"
        : "fewer objects, or smaller ones; every distinct 8x8 cell of art is a tile",
    );
  },

  // eslint-disable-next-line @typescript-eslint/require-await -- the contract is
  // asynchronous because two consoles run a gesture tournament here; this one has
  // no driver to run it for.
  async bindAudio(program: Program): Promise<BoundAssets<MdAudio>> {
    const names = program.tracks.length > 0 || program.sounds.length > 0;
    const emit: MdAudio = {
      present: false,
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
    // The files are named but nothing was demade from them, so they are not
    // *missing* in the sense the report means: `demake build -c md` on a game
    // with music is a silent cartridge, not a broken one.
    return { emit, tiles: 0, missing: [] };
  },

  assemble({ program, analysis, layout, art, audio, title }): Assembled {
    const ctx = new MdCtx(program, analysis, layout, getProfile(program.profile.id), CODE_ORIGIN);
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

    const symbols = ctx.asm.symbols();
    const reset = symbols.get("Reset");
    const vint = symbols.get("Vint");
    if (reset === undefined || vint === undefined) {
      throw new BuildError("E_INTERNAL", "the code generator emitted no entry point");
    }
    return {
      bytes: packMdRom(code, reset, STACK_TOP, {
        ...(title === undefined ? {} : { title }),
        vint,
      }),
      code: code.length,
      capacity: CODE_SIZE,
      symbols,
      helpers: ctx.helperNames(),
    };
  },
};

/** What to stamp in the cartridge, and what source bytes to demake. */
export type MdRomOptions = BuildOptions;

/** Language features this backend does not implement. */
export function unsupportedMdFeatures(program: Program): string[] {
  return mdBackend.unsupported(program);
}

/** Compile a program into a bootable `.md`. */
export function buildMdRom(program: Program, options: MdRomOptions = {}): Promise<BuiltRom> {
  return buildRom(program, mdBackend, options);
}

export type { Layout, Analysis, MdEmitOptions };
export { ART_TILES };
