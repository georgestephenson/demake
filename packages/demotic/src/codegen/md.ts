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
 *   - **Both sound chips are driven, because the board has two.** A YM2612 at
 *     `$A04000` and an SN76489 at `$C00011` — six four-operator FM voices and
 *     four tone channels, all ten of them arranged as one instrument by
 *     `@demake/audio` and played by one 68000 driver (`md-game.ts`). The PSG
 *     half is a Master System's chip at a Master System's clock, so it is the
 *     Sega 8-bits' binding rather than a second one. What this build emits no
 *     code for is the *Z80* that would normally carry the driver; the 68000 owns
 *     the FM bus outright instead, which is what a 68000-only program does after
 *     taking that bus.
 */

import { buildMdGameAudio } from "@demake/audio";
import { AsmError, MD_ROM_SIZE, MD_ROM_SIZES, packMdRom, type Executor } from "@demake/core";

import { getProfile } from "../profiles.js";
import type { Program } from "../program.js";
import { BUILTIN_TILES } from "../rom/graphics.js";

import { type Analysis } from "./analyze.js";
import type { AssetBytes } from "./art.js";
import { bindAudio, effectIndices, trackForScene } from "./audio.js";
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
import { BANK_TILES, CODE_ORIGIN, emitProgram, STACK_TOP, type MdEmitOptions } from "./md/emit.js";

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
 * The other three backends' shape exactly: what the emitter needs to *play* the
 * audio, and — separately — the bytes a rule writes to ask for it. The second is
 * set whenever the program *names* audio, driver or no driver, because the
 * request is a field of the trace (doc 14 §Conformance): a build whose files were
 * not supplied has to trace identically to one with them in, or the conformance
 * suite would be comparing two different games.
 */
interface MdAudio extends BoundAudioShape {
  /** The emitter options the driver contributes: itself, and its index tables. */
  options: MdEmitOptions;
  /** The bytes a rule writes to ask for a sound; absent when none can. */
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

  async bindAudio(
    program: Program,
    assets: AssetBytes,
    layout: Layout,
    executor?: Executor,
  ): Promise<BoundAssets<MdAudio>> {
    // The driver's state is work RAM the allocator set aside for it, which it only
    // does for a program that names audio — so a game with none reaches here with
    // nowhere to put a driver and does not need one.
    const state = layout.audio;
    const bound =
      state === null
        ? { driver: undefined, missing: [] as readonly string[], notes: [] as readonly string[] }
        : await bindAudio(
            program,
            assets,
            { build: (tracks, effects) => buildMdGameAudio({ tracks, effects, state }) },
            executor,
          );
    const names = program.tracks.length > 0 || program.sounds.length > 0;
    const driver = bound.driver;
    const options: MdEmitOptions = driver
      ? {
          audio: driver,
          effectIndices: effectIndices(program, bound),
          sceneTracks: trackForScene(program, bound),
        }
      : {};
    const emit: MdAudio = {
      present: driver !== undefined,
      options,
      tracks: driver?.stats.tracks ?? 0,
      effects: driver?.stats.effects ?? 0,
      // Queries, not copies: the driver is emitted during `assemble`, which has
      // not run yet, so its sizes are still zero here (`backend.ts`
      // §BoundAudioShape). `helpers` would survive being copied and is a query
      // anyway, so the three read alike and none of them is a special case.
      get code(): number {
        return driver?.stats.code ?? 0;
      },
      get data(): number {
        return driver?.stats.data ?? 0;
      },
      get helpers(): readonly string[] {
        return driver?.stats.helpers ?? [];
      },
      rateHz: driver ? driver.stats.rate.num / driver.stats.rate.den : 0,
      writesRestricted: driver?.stats.writesRestricted ?? 0,
      ...(names
        ? {
            hooks: {
              driver: driver !== undefined,
              music: driver?.request.music ?? 0,
              request: driver?.request.sfx ?? 0,
              effects: options.effectIndices ?? program.sounds.map(() => -1),
            },
          }
        : {}),
    };
    return { emit, tiles: 0, missing: bound.missing, notes: bound.notes };
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
    // The smallest board that holds it. Half a megabyte is the floor rather than
    // the only option, so every cartridge built before this is byte-identical and
    // a game that outgrows it pads to the next power of two instead of failing.
    // There is no mapper involved: the console maps the whole cartridge from
    // `$000000` and the header says where it ends.
    const size = MD_ROM_SIZES.find((bytes) => bytes >= code.length + CODE_ORIGIN);
    if (size === undefined) {
      const largest = MD_ROM_SIZES[MD_ROM_SIZES.length - 1] as number;
      throw new BuildError(
        "E_GAME_TOO_LARGE",
        `this game compiles to ${code.length} bytes and a flat Mega Drive cartridge holds ` +
          `${largest - CODE_ORIGIN}`,
        "past 4 MiB a cartridge has to page through $A130F1 (doc 13 §Banked cartridges).",
      );
    }
    return {
      bytes: packMdRom(code, reset, STACK_TOP, {
        ...(title === undefined ? {} : { title }),
        vint,
        size,
      }),
      code: code.length,
      capacity: size - CODE_ORIGIN,
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
