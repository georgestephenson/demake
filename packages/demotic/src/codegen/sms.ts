/**
 * The `sms` backend: the Sega 8-bits' answers to {@link Backend}'s six questions.
 *
 * Everything about *what* a build does is `backend.ts`'s and everything about
 * what the game means is `shape.ts`'s; this file is the console — its memory
 * map, its image path, its cartridge — and `gb.ts` and `nes.ts` beside it are
 * the other two.
 *
 * Three of the answers are worth reading for what they say about the hardware
 * rather than about the code:
 *
 *   - **Two consoles, one backend, and the difference is a window.** A Game Gear
 *     is a Master System with a smaller screen and wider colour entries. The
 *     machine code is byte-for-byte the same; what differs is how many cells the
 *     renderer treats as visible and how many bytes a palette upload writes. That
 *     is the arrangement the Game Boy Color build already runs under, and the
 *     conformance suite runs the whole example library on both to keep it true.
 *   - **The cartridge is the image, header and all.** The `TMR SEGA` header sits
 *     at `$7FF0` *inside* the 32 KiB the CPU can see, not in a wrapper around it
 *     — so the sixteen bytes it occupies come out of the game's budget, and the
 *     size check has to know that before the emitter runs into them.
 *   - **The tile bank is uploaded, so it costs cartridge twice.** Every tile is
 *     thirty-two bytes of ROM *and* thirty-two of video RAM, where an NES
 *     character is addressed in place. That is why the bank is the first thing
 *     `checkTiles` looks at and why the budget is 256 rather than the 448 the
 *     VDP would hold.
 */

import { buildSmsGameAudio } from "@demake/audio";
import {
  AsmError,
  packSegaRom,
  regionFor,
  SMS_HEADER_OFFSET,
  SMS_ORIGIN,
  SMS_ROM_SIZE,
  type Executor,
} from "@demake/core";

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
import { GG_MEMORY, SMS_MEMORY, type Layout, type MemoryPlan } from "./layout.js";
import { ART_TILES, bindSmsArt } from "./sms-art.js";
import { SmsCtx } from "./sms/ctx.js";
import { emitProgram, BANK_TILES, type SmsEmitOptions } from "./sms/emit.js";

/** Bytes a mapper-less Sega cartridge holds. */
export const ROM_SIZE = SMS_ROM_SIZE;

/**
 * Bytes of it a game may use.
 *
 * The header is sixteen bytes *inside* the image rather than a wrapper around
 * it, so a program that ran past `$7FF0` would have its code overwritten by the
 * stamp. Subtracting it from the budget here is how that becomes a build error
 * naming the game's size instead of a cartridge that boots into nonsense.
 */
export const CODE_SIZE = SMS_HEADER_OFFSET;

/**
 * What this backend's audio binding hands the emitter.
 *
 * `gb.ts`'s and `nes.ts`'s shape: what the emitter needs to *play* the audio, and
 * — separately — the bytes a rule writes to ask for it. The second is set
 * whenever the program *names* audio, driver or no driver, because the request is
 * a field of the trace (doc 14 §Conformance): a build whose files were not
 * supplied has to trace identically to one with them in, or the conformance suite
 * would be comparing two different games.
 */
interface SmsAudio extends BoundAudioShape {
  /** The emitter options the driver contributes: itself, and its index tables. */
  options: SmsEmitOptions;
  /** The bytes a rule writes to ask for a sound; absent when none can. */
  hooks?: { driver: boolean; music: number; request: number; effects: readonly number[] };
}

/** The Sega 8-bits' implementation of the build. */
export const smsBackend: Backend<SmsEmitOptions, SmsAudio> = {
  family: "sms",
  consoles: ["sms", "gg"],
  cartridge: "a mapper-less Sega cartridge",

  extension(program: Program): string {
    return program.profile.id === "gg" ? "gg" : "sms";
  },

  unsupported(program: Program): string[] {
    const missing: string[] = [];
    if (!smsBackend.consoles.includes(program.profile.id)) {
      missing.push(`a runtime for ${program.profile.name}`);
    }
    return missing;
  },

  memory(program: Program): MemoryPlan {
    return program.profile.id === "gg" ? GG_MEMORY : SMS_MEMORY;
  },

  async bindArt(
    program: Program,
    assets: AssetBytes,
    executor?: Executor,
  ): Promise<BoundAssets<SmsEmitOptions>> {
    const art = await bindSmsArt(program, assets, program.profile.id, executor);
    return { emit: art.options, tiles: art.tiles, missing: art.missing };
  },

  checkTiles(program: Program, art: BoundAssets<SmsEmitOptions>): void {
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
  ): Promise<BoundAssets<SmsAudio>> {
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
            { build: (tracks, effects) => buildSmsGameAudio({ tracks, effects, state }) },
            executor,
          );
    const names = program.tracks.length > 0 || program.sounds.length > 0;
    const driver = bound.driver;
    const options: SmsEmitOptions = driver
      ? {
          audio: driver,
          effectIndices: effectIndices(program, bound),
          sceneTracks: trackForScene(program, bound),
        }
      : {};
    const emit: SmsAudio = {
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
    void title; // a Sega header carries no title field, only a product code
    const ctx = new SmsCtx(program, analysis, layout, getProfile(program.profile.id), SMS_ORIGIN);
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

    const image = new Uint8Array(SMS_ROM_SIZE);
    image.set(code.subarray(0, Math.min(code.length, SMS_ROM_SIZE)), 0);
    return {
      bytes: packSegaRom(image, { region: regionFor(program.profile.id) }),
      code: code.length,
      capacity: CODE_SIZE,
      symbols: ctx.asm.symbols(),
      helpers: ctx.helperNames(),
    };
  },
};

/** What to stamp in the cartridge, and what source bytes to demake. */
export type SmsRomOptions = BuildOptions;

/** Language features this backend does not implement. */
export function unsupportedSmsFeatures(program: Program): string[] {
  return smsBackend.unsupported(program);
}

/** Compile a program into a bootable `.sms` or `.gg`. */
export function buildSmsRom(program: Program, options: SmsRomOptions = {}): Promise<BuiltRom> {
  return buildRom(program, smsBackend, options);
}

export type { Layout, Analysis, SmsEmitOptions };
export { ART_TILES };
