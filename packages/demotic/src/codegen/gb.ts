/**
 * The `gb` backend: the Game Boy's answers to {@link Backend}'s six questions.
 *
 * There is no fixed engine and no blob to patch. A game is compiled to SM83
 * machine code specialised to it — its entities at constant addresses, its
 * rules unrolled into the scenes they can fire in, and only the runtime
 * routines something actually called. The assembler is ours (`core`'s `Asm`,
 * shared with the audio driver backend), so this runs in a browser with nothing
 * installed and produces the same bytes the CLI does.
 *
 * What is *not* here is the shape of the build: which step happens when, what
 * each failure is called, and what a `RomStats` contains all live in
 * `backend.ts`, because they are the same on every console. This file is the
 * Game Boy's part — its memory map, its image path, its driver, its cartridge —
 * and `nes.ts` beside it is the NES's.
 *
 * The Nintendo logo area is left as zeros, exactly as the NDS builder leaves
 * its logo area (doc 06): we ship no copyrighted data. Emulators that direct
 * boot — including `@demake/dmg` and the libretro cores — do not look at it;
 * original hardware does, so `demake build --boot-logo` runs `rgbfix` when
 * RGBDS happens to be installed, and says so when it is not.
 */

import { buildGameAudio } from "@demake/audio";
import { AsmError, GB_HEADER_OFFSETS, GB_ROM_SIZE, stampGbHeader } from "@demake/core";

import { getProfile } from "../profiles.js";
import type { Program } from "../program.js";
import { BUILTIN_TILES } from "../rom/graphics.js";

import { type Analysis } from "./analyze.js";
import { bindArt } from "./art.js";
import { bindAudio, effectIndices, trackForScene } from "./audio.js";
import {
  buildRom,
  BuildError,
  type Assembled,
  type AssetBytes,
  type Backend,
  type BoundAssets,
  type BoundAudioShape,
  type BuildOptions,
  type BuiltRom,
  type RomStats,
} from "./backend.js";
import { Ctx } from "./ctx.js";
import { emitProgram, type EmitOptions, type SpriteArt } from "./emit.js";
import { GB_MEMORY, GBC_MEMORY, type Layout, type MemoryPlan } from "./layout.js";

/**
 * The cartridge wrapper, re-exported from `core`.
 *
 * The header and both checksums are `core`'s (`asm/gb-cart.ts`) because the
 * audio driver builds Game Boy ROMs too, and a header implemented twice is a
 * header that disagrees in one byte in one of them.
 */
export const ROM_SIZE = GB_ROM_SIZE;
export const HEADER_OFFSETS = GB_HEADER_OFFSETS;

/**
 * Tiles the video hardware addresses at once, shared by background and objects.
 *
 * Not a cartridge fact and so not `core`'s: it is what the PPU can reach, and
 * it is the budget a scene's backdrop competes with the game's own art for. A
 * Game Boy Color has two VRAM banks and therefore twice the room, which is what
 * makes a colour backdrop affordable at all: colour art deduplicates less than
 * monochrome art does, because two cells that differ only in tone are one tile
 * on a DMG and two here.
 */
export const TILE_SLOTS = 256;

/** The same, on colour hardware: both banks. */
export const TILE_SLOTS_COLOR = 512;

/** Tiles this program's console can hold. */
function tileSlots(program: Program): number {
  return program.profile.id === "gbc" ? TILE_SLOTS_COLOR : TILE_SLOTS;
}

/**
 * The first high-RAM byte the audio driver may use.
 *
 * After the OAM DMA kernel at `$FF80` and the VBlank flag the main loop waits
 * on. High RAM because the driver runs on an interrupt and `ldh` is a byte
 * shorter and a cycle faster than a full load.
 */
const HRAM_AUDIO = 0xff8b;

/** What the Game Boy's audio binding hands the emitter. */
interface GbAudio extends BoundAudioShape {
  /** The emitter options the driver contributes: itself, and its index tables. */
  options: EmitOptions;
  /** The bytes a rule writes to ask for a sound; absent when none can. */
  hooks?: { driver: boolean; music: number; request: number; effects: readonly number[] };
}

/** The Game Boy's implementation of the build. */
export const gbBackend: Backend<EmitOptions, GbAudio> = {
  family: "gb",
  consoles: ["gb", "gbc"],
  cartridge: "a mapper-less cartridge",

  extension(program: Program): string {
    return program.profile.id === "gbc" ? "gbc" : "gb";
  },

  /**
   * Language features this backend does not implement.
   *
   * Empty, now: levels, tiles, the camera and scrolling all compile. It stays as
   * the place a future gap is *named*, because a runtime that silently ignored a
   * feature would produce a ROM that plays a different game from the preview,
   * and the trace oracle would report the divergence three layers from its cause.
   */
  unsupported(program: Program): string[] {
    const missing: string[] = [];
    if (!gbBackend.consoles.includes(program.profile.id)) {
      missing.push(`a runtime for ${program.profile.name}`);
    }
    return missing;
  },

  memory(program: Program): MemoryPlan {
    return program.profile.id === "gbc" ? GBC_MEMORY : GB_MEMORY;
  },

  bindArt(program: Program, assets: AssetBytes): BoundAssets<EmitOptions> {
    const art = bindArt(program, assets);
    return { emit: art, tiles: art.tiles8, missing: art.missing };
  },

  checkTiles(program: Program, art: BoundAssets<EmitOptions>): void {
    // The bank is one 256-entry table shared by the background and the objects,
    // so a title screen's tiles are what is left after the game's own art. Art
    // that does not fit is named here rather than drawn with holes in it.
    const tiles = BUILTIN_TILES + art.tiles;
    const slots = tileSlots(program);
    if (tiles <= slots) return;
    const backdrops = program.scenes.filter((scene) => scene.backdrop !== undefined).length;
    throw new BuildError(
      "E_BACKDROP_TILES",
      `this game needs ${tiles} tiles and the ${program.profile.name} has ${slots}`,
      backdrops > 0
        ? "a backdrop costs one tile per distinct 8x8 cell — flatter areas and repeated motifs cost fewer"
        : "fewer objects, or smaller ones; every distinct 8x8 cell of art is a tile",
    );
  },

  bindAudio(program: Program, assets: AssetBytes): BoundAssets<GbAudio> {
    const bound = bindAudio(program, assets, {
      build: (tracks, effects) => buildGameAudio({ tracks, effects, hram: HRAM_AUDIO }),
    });
    const names = program.tracks.length > 0 || program.sounds.length > 0;
    const driver = bound.driver;
    const options: EmitOptions = driver
      ? {
          audio: driver,
          effectIndices: effectIndices(program, bound),
          sceneTracks: trackForScene(program, bound),
        }
      : {};
    const emit: GbAudio = {
      present: driver !== undefined,
      options,
      tracks: driver?.stats.tracks ?? 0,
      effects: driver?.stats.effects ?? 0,
      code: driver?.stats.code ?? 0,
      data: driver?.stats.data ?? 0,
      helpers: driver?.stats.helpers ?? [],
      rateHz: driver ? driver.stats.rate.num / driver.stats.rate.den : 0,
      writesRestricted: driver?.stats.writesRestricted ?? 0,
      // Set whenever the program *names* audio, driver or no driver: a rule still
      // records the sound it asked for, so a build with the files left out traces
      // identically to one with them in.
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
    const emitOptions: EmitOptions = { ...art, ...audio.options };
    const ctx = new Ctx(program, analysis, layout, getProfile(program.profile.id), 0);
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
      emitProgram(ctx, emitOptions);
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

    const rom = new Uint8Array(ROM_SIZE);
    rom.set(code.subarray(0, Math.min(code.length, ROM_SIZE)), 0);
    // A colour build declares itself CGB-only, because it programs palette RAM
    // and a second VRAM bank from its first instruction: a DMG asked to run it
    // would show the game in whatever BGP happened to hold, and a cartridge that
    // refuses is a better answer than one that runs wrong.
    stampGbHeader(rom, title ?? "DEMOTIC", { cgb: program.profile.id === "gbc" });
    return {
      bytes: rom,
      code: code.length,
      capacity: ROM_SIZE,
      symbols: ctx.asm.symbols(),
      helpers: ctx.helperNames(),
    };
  },
};

/**
 * What to stamp in the cartridge header, and what source bytes to demake.
 *
 * Nothing here is pre-converted art: the build takes the files the game named and
 * demakes them itself, which is the rule that keeps the browser's cartridge and
 * the CLI's identical byte for byte.
 */
export type RomOptions = BuildOptions;

/** Language features this backend does not implement. */
export function unsupportedFeatures(program: Program): string[] {
  return gbBackend.unsupported(program);
}

/** Compile a program into a bootable `.gb`. */
export function buildGbRom(program: Program, options: RomOptions = {}): BuiltRom {
  return buildRom(program, gbBackend, options);
}

export { BuildError };
export type { SpriteArt, EmitOptions, Layout, Analysis, RomStats, BuiltRom };
