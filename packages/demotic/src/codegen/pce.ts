/**
 * The `pce` backend: the PC Engine's answers to {@link Backend}'s six questions.
 *
 * Everything about *what* a build does is `backend.ts`'s and everything about
 * what the game means is `shape.ts`'s; this file is the console — its memory map,
 * its image path, its cartridge. Four of the answers are worth reading for what
 * they say about the hardware rather than about the code:
 *
 *   - **The memory plan is the roomy one with a strange shape.** Eight kilobytes
 *     of work RAM, four times an NROM cartridge's — but the zero page is at
 *     `$2000` and the stack at `$2100`, because that is where the CPU puts them
 *     (`asm/huc6280.ts`). Nothing else in the plan is unusual.
 *   - **A program lives in a 48 KiB window, not in its cartridge.** The mapper
 *     gives eight 8 KiB pages and four things want one: the hardware, work RAM,
 *     and the code and data between them. So `$4000`–`$FFFF` is what a build has,
 *     and a game bigger than that wants paging rather than a bigger board.
 *   - **A cartridge is the smallest board this console shipped, and every game so
 *     far is the same one.** That is the elastic-cartridge rule
 *     (`backend.ts` §Elastic cartridges) coming out flat rather than being
 *     ignored: the smallest HuCard is 128 KiB and the biggest program the window
 *     can hold is 48, so there is nothing to grow into and `free` is measured
 *     against the *window* — which is the number a size regression is about.
 *   - **There is no audio.** This console's PSG has no model in `@demake/chip`,
 *     so `bindAudio` reports every file missing and the cartridge plays nothing.
 *     What it still does is *record* what a rule asked for, in the byte the trace
 *     reads — so a game traces identically here to everywhere else, which is what
 *     makes the conformance suite comparable at all (doc 14 §Conformance). The
 *     gap is doc 13 §Console rollout's to close and `@demake/pce`'s `psgTap` is
 *     already waiting for it.
 */

import { AsmError, PCE_BANK_SIZE, PCE_ROM_SIZES, packHuCard, type Executor } from "@demake/core";

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
import { PCE_MEMORY, type Layout, type MemoryPlan } from "./layout.js";
import { bindPceArt, type BoundPceArt } from "./pce-art.js";
import { PceCtx } from "./pce/ctx.js";
import {
  BANK_TILES,
  BOOT_ORIGIN,
  CODE_ORIGIN,
  SPRITE_PATTERNS,
  WindowOverflow,
  emitProgram,
  type PceEmitOptions,
} from "./pce/emit.js";
import type { ArtSettings } from "./settings.js";

/** Where the code window begins and ends, which is what a program may fill. */
export const WINDOW_SIZE = 0x10000 - CODE_ORIGIN;

/**
 * Bytes of it a game may use.
 *
 * The last ten are the CPU's five vectors, which is what makes a cartridge
 * bootable at all — so they are subtracted from the budget rather than left for a
 * game to overwrite and discover the problem in an emulator.
 */
export const CODE_SIZE = WINDOW_SIZE - 10;

/**
 * What this console's audio binding hands the emitter: nothing, so far.
 *
 * The shape is every other backend's, and it is present rather than absent for
 * the reason `bindAudio` gives — a game with no driver still records what it
 * asked for, and `present: false` is what tells `buildRom` there is no music to
 * cut when a cartridge does not fit.
 */
interface PceAudio extends BoundAudioShape {
  options: Record<string, never>;
}

/** The PC Engine's implementation of the build. */
export const pceBackend: Backend<PceEmitOptions, PceAudio> = {
  family: "pce",
  consoles: ["pce"],
  cartridge: "a HuCard's 48 KiB window",

  extension(): string {
    return "pce";
  },

  unsupported(program: Program): string[] {
    const missing: string[] = [];
    if (!pceBackend.consoles.includes(program.profile.id)) {
      missing.push(`a runtime for ${program.profile.name}`);
    }
    return missing;
  },

  memory(): MemoryPlan {
    return PCE_MEMORY;
  },

  async bindArt(
    program: Program,
    assets: AssetBytes,
    executor?: Executor,
    settings?: ArtSettings,
  ): Promise<BoundAssets<PceEmitOptions>> {
    const art = await bindPceArt(program, assets, executor, settings);
    // The bank and the pattern count travel with the options rather than through
    // a second return value, because `assemble` is the only thing that wants them.
    bound.set(art.options, art);
    return { emit: art.options, tiles: art.tiles, missing: art.missing };
  },

  checkTiles(program: Program, art: BoundAssets<PceEmitOptions>): void {
    const state = bound.get(art.emit);
    if (!state) return;
    const characters = (art.emit.bank?.length ?? 0) / 32;
    if (characters > BANK_TILES) {
      const backdrops = program.scenes.filter((scene) => scene.backdrop !== undefined).length;
      throw new BuildError(
        "E_BACKDROP_TILES",
        `this game needs ${characters} characters and a PC Engine build has ${BANK_TILES}`,
        backdrops > 0
          ? "a backdrop costs one character per distinct 8x8 cell — flatter areas and repeated motifs cost fewer"
          : "fewer objects, or smaller ones; every distinct 8x8 cell of art is a character",
      );
    }
    if (state.patterns > SPRITE_PATTERNS) {
      throw new BuildError(
        "E_SPRITE_TILES",
        `this game needs ${state.patterns} sprite patterns and a PC Engine build has ${SPRITE_PATTERNS}`,
        "objects are 16x16 at their smallest here, so a wide one is fewer patterns than you would expect — but each is 128 bytes",
      );
    }
  },

  async bindAudio(program: Program): Promise<BoundAssets<PceAudio>> {
    // Every file the program names, reported as unsupplied. Not an error: the
    // game plays silently and says why, which is what an honest gap looks like.
    const missing = [...program.tracks, ...program.sounds];
    const emit: PceAudio = {
      present: false,
      options: {},
      tracks: 0,
      effects: 0,
      get code(): number {
        return 0;
      },
      get data(): number {
        return 0;
      },
      get helpers(): readonly string[] {
        return [];
      },
      rateHz: 0,
      writesRestricted: 0,
    };
    return { emit, tiles: 0, missing, notes: [] };
  },

  assemble({ program, analysis, layout, art, title }): Assembled {
    void title; // a HuCard carries no title field

    const state = bound.get(art);
    const ctx = new PceCtx(
      program,
      analysis,
      layout,
      getProfile(program.profile.id),
      CODE_ORIGIN,
      state?.bank,
      state?.patterns ?? 0,
      state?.levelPalette ?? 0,
    );
    // A rule that fires a sound still *records* that it did, in the byte the
    // trace reads — so this cartridge's trace is the one every other console
    // produces and the conformance suite is comparing the same game (doc 14
    // §Conformance). There is no driver to ask for anything, which is what
    // `driver: false` says; the indices are the program's own, because with no
    // driver to renumber against that is what "which sound" means.
    if (layout.sound !== null) {
      ctx.audio = {
        driver: false,
        music: 0,
        request: 0,
        trace: layout.sound,
        effects: program.sounds.map((_, index) => index),
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
      if (error instanceof WindowOverflow) {
        throw new BuildError(
          "E_GAME_TOO_LARGE",
          `this game compiles to ${error.bytes} bytes and ${pceBackend.cartridge} holds ${CODE_SIZE}`,
          "fewer objects in one rule, a smaller level, or less art; bank switching is doc 15 §Not in v1.",
        );
      }
      throw error;
    }

    // The image is the window, rearranged into cartridge banks. Reset maps bank 0
    // at `$E000`, so the *top* 8 KiB of the window is bank 0 and everything below
    // it follows — which is why the boot stub is emitted last and why the halves
    // are swapped here rather than assembled in this order.
    const split = BOOT_ORIGIN - CODE_ORIGIN;
    const banks = new Uint8Array(WINDOW_SIZE);
    banks.set(code.subarray(split, WINDOW_SIZE), 0);
    banks.set(code.subarray(0, split), PCE_BANK_SIZE);

    return {
      bytes: packHuCard(banks, { vectors: vectorsOf(ctx) }),
      // What the *program* came to, which is everything but the padding between
      // its data and its boot stub.
      code: measure(ctx),
      capacity: CODE_SIZE,
      symbols: ctx.asm.symbols(),
      helpers: ctx.helperNames(),
    };
  },
};

/** The five vectors, from the labels the emitter defined. */
function vectorsOf(ctx: PceCtx): Record<string, number> {
  const at = (name: string): number => (ctx.asm.has(name) ? ctx.asm.addressOf(name) : 0);
  return {
    irq2: at("Irq2"),
    irq1: at("Irq1"),
    timer: at("TimerIrq"),
    nmi: at("Nmi"),
    reset: at("Reset"),
  };
}

/**
 * Bytes the program really is, which is not the length of the image.
 *
 * The window is padded to `$E000` so the boot stub lands in the bank reset maps,
 * so the assembled buffer is always 48 KiB and its length says nothing. What is
 * measured instead is the data section's end plus the boot stub's own length —
 * the two things a game can make bigger, and together the number a size
 * regression moves.
 */
function measure(ctx: PceCtx): number {
  const boot = ctx.asm.has("Reset") ? ctx.asm.addressOf("Reset") : BOOT_ORIGIN;
  return ctx.dataEnd - CODE_ORIGIN + (ctx.asm.pc - boot);
}

/**
 * The art each binding produced, keyed by the options it returned.
 *
 * The `Backend` interface deliberately has the art hook return only what the
 * emitter needs, because that is all a *console-independent* build can know
 * about; the built-in character bank and the pattern count are this console's
 * business alone. A side table keyed by identity keeps them out of the shared
 * interface without threading them through one — and it is bounded, because an
 * entry lives exactly as long as the options object one build made.
 */
const bound = new WeakMap<PceEmitOptions, BoundPceArt>();

/** What to stamp in the cartridge, and what source bytes to demake. */
export type PceRomOptions = BuildOptions;

/** Language features this backend does not implement. */
export function unsupportedPceFeatures(program: Program): string[] {
  return pceBackend.unsupported(program);
}

/** Compile a program into a bootable `.pce`. */
export function buildPceRom(program: Program, options: PceRomOptions = {}): Promise<BuiltRom> {
  return buildRom(program, pceBackend, options);
}

export { PCE_ROM_SIZES };
export type { Layout, Analysis, PceEmitOptions };
