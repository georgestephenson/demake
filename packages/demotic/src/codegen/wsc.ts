/**
 * The `wsc` backend: the WonderSwan Color's answers to {@link Backend}'s six
 * questions.
 *
 * Everything about *what* a build does is `backend.ts`'s and everything about
 * what the game means is `shape.ts`'s; this file is the console — its memory
 * map, its image path, its cartridge.
 *
 * Three of the answers are worth reading for what they say about the hardware:
 *
 *   - **The cartridge cannot move.** Every other console that shipped its games
 *     on more than one board takes the smallest that fits (`backend.ts` §Elastic
 *     cartridges); this one has nothing to choose from, because the header's
 *     size byte has no value below 4 Mbit. A WonderSwan cartridge is 512 KiB the
 *     way a Game Boy ROM-only cartridge is 32 KiB — and only its last 64 KiB is
 *     mapped, so what a build is measured against is the bank rather than the
 *     file.
 *   - **The tile bank is RAM at a fixed address, not video memory behind a
 *     port.** Boot copies it in and nothing streams, so a tile costs cartridge
 *     once — which is why the budget here is the 512 tiles the screen entry's
 *     nine bits can name rather than something smaller chosen to keep two
 *     numbers apart.
 *   - **There is no audio driver yet.** A game that names music and effects
 *     still records what its rules asked for, because the request is a field of
 *     the trace (doc 14 §Conformance) — so a build here traces identically to
 *     one on a console that plays them, and the only difference is that nobody
 *     is listening.
 */

import { buildWscGameAudio } from "@demake/audio";
import { AsmError, packWsRom, WS_CODE_SIZE, type Executor } from "@demake/core";

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
import { WSC_MEMORY, type Layout, type MemoryPlan } from "./layout.js";
import type { ArtSettings } from "./settings.js";
import { ART_TILES, bindWscArt } from "./wsc-art.js";
import { WscCtx } from "./wsc/ctx.js";
import { BANK_TILES, emitProgram, type WscEmitOptions } from "./wsc/emit.js";

/** Bytes a program may occupy: the bank, up to the reset jump. */
export const CODE_SIZE = WS_CODE_SIZE;

/** What this backend's audio binding hands the emitter. */
interface WscAudio extends BoundAudioShape {
  /** What the emitter needs to call the driver, where there is one. */
  options: WscEmitOptions;
  /** The bytes a rule writes to ask for a sound; absent when none can. */
  hooks?: { driver: boolean; music: number; request: number; effects: readonly number[] };
}

/** The WonderSwan Color's implementation of the build. */
export const wscBackend: Backend<WscEmitOptions, WscAudio> = {
  family: "wsc",
  consoles: ["wsc"],
  cartridge: "a WonderSwan cartridge's mapped bank",

  extension(): string {
    return "wsc";
  },

  unsupported(program: Program): string[] {
    const missing: string[] = [];
    if (!wscBackend.consoles.includes(program.profile.id)) {
      missing.push(`a runtime for ${program.profile.name}`);
    }
    return missing;
  },

  memory(): MemoryPlan {
    return WSC_MEMORY;
  },

  async bindArt(
    program: Program,
    assets: AssetBytes,
    executor?: Executor,
    settings?: ArtSettings,
  ): Promise<BoundAssets<WscEmitOptions>> {
    const art = await bindWscArt(program, assets, executor, settings);
    return { emit: art.options, tiles: art.tiles, missing: art.missing };
  },

  checkTiles(program: Program, art: BoundAssets<WscEmitOptions>): void {
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
  ): Promise<BoundAssets<WscAudio>> {
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
            { build: (tracks, effects) => buildWscGameAudio({ tracks, effects, state }) },
            executor,
          );
    const names = program.tracks.length > 0 || program.sounds.length > 0;
    const driver = bound.driver;
    const options: WscEmitOptions = driver
      ? {
          audio: driver,
          effectIndices: effectIndices(program, bound),
          sceneTracks: trackForScene(program, bound),
        }
      : {};
    const emit: WscAudio = {
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
    void title; // a WonderSwan footer carries no title field
    const ctx = new WscCtx(program, analysis, layout, getProfile(program.profile.id), 0);
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
    if (code.length > CODE_SIZE) {
      // Refused here rather than in `packWsRom`, so the message names the game's
      // budget rather than the wrapper's precondition.
      throw new BuildError(
        "E_GAME_TOO_LARGE",
        `this game compiles to ${code.length} bytes and ${wscBackend.cartridge} holds ${CODE_SIZE}`,
        "fewer objects in one rule, or a smaller level; the cartridge's other banks want paging.",
      );
    }
    return {
      bytes: packWsRom(code, { minimumSystem: 1, orientation: 0x05 }),
      code: code.length,
      capacity: CODE_SIZE,
      symbols: ctx.asm.symbols(),
      helpers: ctx.helperNames(),
    };
  },
};

/** What to stamp in the cartridge, and what source bytes to demake. */
export type WscRomOptions = BuildOptions;

/** Language features this backend does not implement. */
export function unsupportedWscFeatures(program: Program): string[] {
  return wscBackend.unsupported(program);
}

/** Compile a program into a bootable `.wsc`. */
export function buildWscRom(program: Program, options: WscRomOptions = {}): Promise<BuiltRom> {
  return buildRom(program, wscBackend, options);
}

export type { Layout, Analysis, WscEmitOptions };
export { ART_TILES };
