/**
 * The `ngpc` backend: the Neo Geo Pocket Color's answers to {@link Backend}'s
 * six questions.
 *
 * Everything about *what* a build does is `backend.ts`'s and everything about
 * what the game means is `shape.ts`'s; this file is the console — its memory
 * map, its image path, its cartridge.
 *
 * Three of the answers are worth reading for what they say about the hardware:
 *
 *   - **The program is not addressed where it was assembled from.** The
 *     cartridge answers the bus at `$200000` and the header is a region in front
 *     of the image rather than bytes woven into it, so a build assembles at
 *     `$200040` and `packNgpRom` stamps the sixty-four bytes ahead of it. There
 *     is no reset vector to chase: the boot ROM reads the entry address out of
 *     the header and jumps to it, which is the Nintendo DS's arrangement reached
 *     by different hardware.
 *   - **A cartridge is the smallest board this console shipped on**, which is
 *     four megabits — and it grows to eight and sixteen, where sixteen is also
 *     the whole address space rather than an arbitrary ceiling. Every example
 *     game is a fraction of the floor, so there is no cartridge-budget story
 *     here and the scarce resource is the character bank.
 *   - **The character bank is one bank.** Five hundred and twelve tiles shared
 *     between the two scroll planes and the objects, because there is no second
 *     one — the Master System's arrangement rather than the Game Boy Advance's —
 *     so {@link ngpcBackend.checkTiles} refuses a single budget and a picture
 *     that fills it is a picture whose game has no sprites left.
 */

import { AsmError, ngpRomSize, NGP_HEADER_SIZE, packNgpRom, type Executor } from "@demake/core";

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
import { type Layout, type MemoryPlan, NGPC_MEMORY } from "./layout.js";
import { ART_TILES, bindNgpcArt } from "./ngpc-art.js";
import { NgpcCtx } from "./ngpc/ctx.js";
import { BANK_TILES, CODE_ORIGIN, emitProgram, type NgpcEmitOptions } from "./ngpc/emit.js";
import type { ArtSettings } from "./settings.js";

/**
 * Bytes a program may occupy.
 *
 * The largest board minus its header, because this console maps its whole
 * cartridge from `$200000` and the header sits in front of the image — so what a
 * build is measured against is the address space rather than the board it will
 * actually ship on. `free` is therefore the headroom against sixteen megabits
 * however small the cartridge turns out to be, which is the rule every elastic
 * console here runs under (AGENTS.md §Iron rules).
 */
export const CODE_SIZE = 0x200000 - NGP_HEADER_SIZE;

/** What this backend's audio binding hands the emitter. */
interface NgpcAudio extends BoundAudioShape {
  /** What the emitter needs to call the driver, where there is one. */
  options: NgpcEmitOptions;
}

/** The Neo Geo Pocket Color's implementation of the build. */
export const ngpcBackend: Backend<NgpcEmitOptions, NgpcAudio> = {
  family: "ngpc",
  consoles: ["ngpc"],
  cartridge: "a Neo Geo Pocket cartridge",

  extension(): string {
    return "ngc";
  },

  unsupported(program: Program): string[] {
    const missing: string[] = [];
    if (!ngpcBackend.consoles.includes(program.profile.id)) {
      missing.push(`a runtime for ${program.profile.name}`);
    }
    return missing;
  },

  memory(): MemoryPlan {
    return NGPC_MEMORY;
  },

  async bindArt(
    program: Program,
    assets: AssetBytes,
    executor?: Executor,
    settings?: ArtSettings,
  ): Promise<BoundAssets<NgpcEmitOptions>> {
    const art = await bindNgpcArt(program, assets, executor, settings);
    return { emit: art.options, tiles: art.tiles, missing: art.missing };
  },

  checkTiles(program: Program, art: BoundAssets<NgpcEmitOptions>): void {
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

  async bindAudio(program: Program): Promise<BoundAssets<NgpcAudio>> {
    // No driver on this console yet (doc 13 §D4). A game that names music and
    // effects still records what its rules asked for, because the request is a
    // field of the trace (doc 14 §Conformance) — so a build here traces
    // identically to one on a console that plays them, and the only difference
    // is that nobody is listening.
    const names = program.tracks.length > 0 || program.sounds.length > 0;
    return {
      emit: {
        present: false,
        options: {},
        tracks: 0,
        effects: 0,
        code: 0,
        data: 0,
        helpers: [],
        rateHz: 0,
        writesRestricted: 0,
      },
      tiles: 0,
      missing: [],
      notes: names ? ["this console has no audio driver yet, so the cartridge is silent"] : [],
    };
  },

  assemble({ program, analysis, layout, art, audio, title }): Assembled {
    const ctx = new NgpcCtx(program, analysis, layout, getProfile(program.profile.id), CODE_ORIGIN);
    // The trace field is set even with no driver, so a rule that asks for a
    // sound still says so where the conformance oracle can see it.
    if (layout.sound !== null) {
      ctx.audio = {
        driver: false,
        music: 0,
        request: 0,
        trace: layout.sound,
        effects: program.sounds.map(() => -1),
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
      // Refused here rather than in `packNgpRom`, so the message names the
      // game's budget rather than the wrapper's precondition.
      throw new BuildError(
        "E_GAME_TOO_LARGE",
        `this game compiles to ${code.length} bytes and ${ngpcBackend.cartridge} holds ${CODE_SIZE}`,
        "fewer objects in one rule, or a smaller level.",
      );
    }
    return {
      bytes: packNgpRom(code, {
        title: title ?? "",
        color: true,
        size: ngpRomSize(NGP_HEADER_SIZE + code.length),
      }),
      code: code.length,
      capacity: CODE_SIZE,
      symbols: ctx.asm.symbols(),
      helpers: ctx.helperNames(),
    };
  },
};

/** What to stamp in the cartridge, and what source bytes to demake. */
export type NgpcRomOptions = BuildOptions;

/** Language features this backend does not implement. */
export function unsupportedNgpcFeatures(program: Program): string[] {
  return ngpcBackend.unsupported(program);
}

/** Compile a program into a bootable `.ngc`. */
export function buildNgpcRom(program: Program, options: NgpcRomOptions = {}): Promise<BuiltRom> {
  return buildRom(program, ngpcBackend, options);
}

export type { Layout, Analysis, NgpcEmitOptions };
export { ART_TILES };
