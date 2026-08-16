/**
 * The `vb` backend: the Virtual Boy's answers to {@link Backend}'s six
 * questions.
 *
 * Everything about *what* a build does is `backend.ts`'s and everything about
 * what the game means is `shape.ts`'s; this file is the console — its memory
 * map, its image path, its cartridge.
 *
 * Three of the answers are worth reading for what they say about the hardware:
 *
 *   - **The cartridge is a power of two and is decoded by masking.** So the
 *     reset fetch at `$FFFFFFF0` lands in the board's *own* last sixteen bytes
 *     whatever size it is, which is why the smallest board that holds the game
 *     is asked for before the header is stamped rather than after
 *     (`vbRomSize`) — where the header goes depends on how big the answer was.
 *   - **The scarce resource is the palette, not the bank.** Two thousand and
 *     forty-eight characters is more than any demade screen can want, and four
 *     colours in four palettes per layer is the narrowest budget in the whole
 *     matrix. So `checkTiles` almost never fires here, and what actually decides
 *     how a picture looks is the fit's four shades.
 *   - **The audio driver has no interrupt of its own.** The video processor's
 *     frame interrupt is the only one this cartridge takes, and the main loop is
 *     already waiting on it — so `AudioTick` is a call from that loop rather than
 *     a handler, and this console's driver rate *is* its frame rate
 *     (`audio` §resolveVbClock). That is why `VbGameAudio` needs no counter and
 *     no cap: a frame the game overran is a frame that has not happened yet.
 */

import { buildVbGameAudio } from "@demake/audio";
import { AsmError, packVbRom, vbRomSize, VB_ROM, type Executor } from "@demake/core";

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
import { VB_MEMORY, type Layout, type MemoryPlan } from "./layout.js";
import type { ArtSettings } from "./settings.js";
import { ART_TILES, bindVbArt } from "./vb-art.js";
import { VbCtx } from "./vb/ctx.js";
import { BANK_TILES, emitProgram, type VbEmitOptions } from "./vb/emit.js";

/** What this backend's audio binding hands the emitter. */
interface VbAudio extends BoundAudioShape {
  /** What the emitter needs: the driver itself and its two tables. */
  options: VbEmitOptions;
  /** The bytes a rule writes to ask for a sound; absent when none can. */
  hooks?: { driver: boolean; music: number; request: number; effects: readonly number[] };
}

/** The Virtual Boy's implementation of the build. */
export const vbBackend: Backend<VbEmitOptions, VbAudio> = {
  family: "vb",
  consoles: ["vb"],
  cartridge: "a Virtual Boy cartridge",

  extension(): string {
    return "vb";
  },

  unsupported(program: Program): string[] {
    const missing: string[] = [];
    if (!vbBackend.consoles.includes(program.profile.id)) {
      missing.push(`a runtime for ${program.profile.name}`);
    }
    return missing;
  },

  memory(): MemoryPlan {
    return VB_MEMORY;
  },

  async bindArt(
    program: Program,
    assets: AssetBytes,
    executor?: Executor,
    settings?: ArtSettings,
  ): Promise<BoundAssets<VbEmitOptions>> {
    const art = await bindVbArt(program, assets, executor, settings);
    return { emit: art.options, tiles: art.tiles, missing: art.missing };
  },

  checkTiles(program: Program, art: BoundAssets<VbEmitOptions>): void {
    const used = art.tiles + BUILTIN_TILES;
    if (used <= BANK_TILES) return;
    const backdrops = program.scenes.filter((scene) => scene.backdrop !== undefined).length;
    throw new BuildError(
      "E_BACKDROP_TILES",
      `this game needs ${used} characters and the bank holds ${BANK_TILES}`,
      backdrops > 0
        ? "a backdrop costs one character per distinct 8x8 cell — flatter areas and repeated motifs cost fewer"
        : "fewer objects, or smaller ones; every distinct 8x8 cell of art is a character",
    );
  },

  async bindAudio(
    program: Program,
    assets: AssetBytes,
    layout: Layout,
    executor?: Executor,
  ): Promise<BoundAssets<VbAudio>> {
    // The driver's state is RAM the allocator set aside for it, which it only
    // does for a program that names audio — so a game with none reaches here
    // with nowhere to put a driver and does not need one.
    const state = layout.audio;
    const bound =
      state === null
        ? { driver: undefined, missing: [] as readonly string[], notes: [] as readonly string[] }
        : await bindAudio(
            program,
            assets,
            { build: (tracks, effects) => buildVbGameAudio({ tracks, effects, state }) },
            executor,
          );
    const names = program.tracks.length > 0 || program.sounds.length > 0;
    const driver = bound.driver;
    const options: VbEmitOptions = driver
      ? {
          audio: driver,
          effectIndices: effectIndices(program, bound),
          sceneTracks: trackForScene(program, bound),
        }
      : {};
    const emit: VbAudio = {
      present: driver !== undefined,
      options,
      tracks: driver?.stats.tracks ?? 0,
      effects: driver?.stats.effects ?? 0,
      // Queries, not copies: the driver is emitted during `assemble`, which has
      // not run yet, so its sizes are still zero here (`backend.ts`
      // §BoundAudioShape).
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
    const ctx = new VbCtx(program, analysis, layout, getProfile(program.profile.id), VB_ROM);
    if (audio.hooks) {
      ctx.audio = {
        driver: audio.hooks.driver,
        music: audio.hooks.music,
        request: audio.hooks.request,
        trace: layout.sound,
        effects: audio.hooks.effects,
      };
    }
    try {
      emitProgram(ctx, { ...art, ...audio.options });
    } catch (error) {
      if (error instanceof AsmError) {
        throw new BuildError(
          "E_INTERNAL",
          `the code generator produced invalid code: ${error.message}`,
        );
      }
      throw error;
    }
    const code = ctx.asm.assemble();
    let size: number;
    try {
      size = vbRomSize(code.length);
    } catch {
      throw new BuildError(
        "E_GAME_TOO_LARGE",
        `this game compiles to ${code.length} bytes and the largest ${vbBackend.cartridge} holds less`,
        "fewer objects in one rule, or a smaller level.",
      );
    }
    return {
      bytes: packVbRom(code, { title: title ?? "", size, entry: VB_ROM }),
      code: code.length,
      // Measured against the largest board rather than the one that shipped, so a
      // game getting bigger never looks like a game with more room (AGENTS.md
      // §`free` is measured against the largest board).
      capacity: CODE_SIZE,
      symbols: ctx.asm.symbols(),
      helpers: ctx.helperNames(),
    };
  },
};

/**
 * Program bytes the largest board holds, below its header and vectors.
 *
 * What `free` is measured against, always — never the board a given game
 * actually took (AGENTS.md §`free` is measured against the largest board), or a
 * game that grew a hundred bytes and crossed onto a bigger cartridge would look
 * like a game with a megabyte more room.
 */
export const CODE_SIZE = 0x200000 - 0x220;

/** What to stamp in the cartridge, and what source bytes to demake. */
export type VbRomOptions = BuildOptions;

/** Language features this backend does not implement. */
export function unsupportedVbFeatures(program: Program): string[] {
  return vbBackend.unsupported(program);
}

/** Compile a program into a bootable `.vb`. */
export function buildVbRom(program: Program, options: VbRomOptions = {}): Promise<BuiltRom> {
  return buildRom(program, vbBackend, options);
}

export type { Layout, Analysis, VbEmitOptions };
export { ART_TILES };
