/**
 * The `nes` backend: the NES's answers to {@link Backend}'s six questions.
 *
 * Everything about *what* a build does is `backend.ts`'s and everything about what
 * the game means is `shape.ts`'s; this file is the console — its memory map, its
 * image path, its cartridge — and `gb.ts` beside it is the Game Boy's.
 *
 * Three of the answers are worth reading for what they say about the hardware
 * rather than about the code:
 *
 *   - **The memory plan is the tight one.** An NROM cartridge adds no RAM, so a
 *     game's whole state lives in the console's 2 KiB, of which page zero, the
 *     stack and the object shadow are already spoken for. That is the constraint
 *     `NES_MEMORY` encodes, and it is why the queue and the erase list are a
 *     quarter of the Game Boy's.
 *   - **The tile budget is two budgets.** Characters are ROM in two tables the PPU
 *     addresses separately, so backgrounds and objects do not compete: 195 patterns
 *     each after the built-in bank, against a Game Boy's 195 between them.
 *   - **Mirroring is a wiring decision.** A cartridge asks for it in its header,
 *     before a line of its code runs, so a game that scrolls sideways has to be
 *     packed for it — which is why this builder always asks for vertical mirroring
 *     rather than deciding per game: the map arithmetic in the renderer is written
 *     for one answer, and making it depend on whether *this* game scrolls would put
 *     two layouts in the ROM for no gain.
 */

import { AsmError, NES_CHR_SIZE, NES_PRG_ORIGIN, NES_PRG_SIZE, packInesRom } from "@demake/core";

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
import { NES_MEMORY, type Layout, type MemoryPlan } from "./layout.js";
import { ART_PATTERNS, bindNesArt, type BoundNesArt } from "./nes-art.js";
import { NesCtx } from "./nes/ctx.js";
import { emitProgram, type NesEmitOptions } from "./nes/emit.js";

/** Bytes of program an NROM cartridge holds. */
export const ROM_SIZE = NES_PRG_SIZE;

/**
 * Bytes of it a game may use.
 *
 * The last six are the CPU's three vectors, which is what makes a cartridge
 * bootable at all — so they are subtracted from the budget rather than left for a
 * game to overwrite and discover the problem in an emulator.
 */
export const CODE_SIZE = NES_PRG_SIZE - 6;

/** Where the vectors sit, as offsets into the program image. */
const VECTOR_OFFSET = { nmi: NES_PRG_SIZE - 6, reset: NES_PRG_SIZE - 4, irq: NES_PRG_SIZE - 2 };

/**
 * What the NES's audio binding hands the emitter.
 *
 * A 2A03 driver is doc 13 §A5's work and does not exist yet, so this reports no
 * driver — and a game that *names* music and effects still builds, plays silently,
 * and says which files went unused. What it must also do is record the request a
 * rule made, because that is a field of the trace (doc 14 §Conformance): a build
 * with no driver has to trace identically to one with a driver, or the conformance
 * suite would be comparing two different games.
 */
interface NesAudio extends BoundAudioShape {
  /** Set whenever the program names audio, driver or no driver. */
  names: boolean;
}

/** The NES's implementation of the build. */
export const nesBackend: Backend<NesEmitOptions, NesAudio> = {
  family: "nes",
  consoles: ["nes"],
  cartridge: "an NROM cartridge",

  /**
   * Language features this backend does not implement.
   *
   * Sound is the one gap, and it is named rather than ignored: a cartridge that
   * silently dropped a `sound` would still trace correctly, so nothing downstream
   * would catch it, and a player would hear the difference. The music and effects a
   * game names are still demade by nothing and reported as unsupplied.
   */
  unsupported(program: Program): string[] {
    const missing: string[] = [];
    if (!nesBackend.consoles.includes(program.profile.id)) {
      missing.push(`a runtime for ${program.profile.name}`);
    }
    return missing;
  },

  memory(): MemoryPlan {
    return NES_MEMORY;
  },

  bindArt(program: Program, assets: AssetBytes): BoundAssets<NesEmitOptions> {
    const art = bindNesArt(program, assets);
    // The character bank travels with the options rather than through a second
    // return value, because `assemble` is the only thing that wants it.
    banks.set(art.options, art);
    return { emit: art.options, tiles: art.tiles, missing: art.missing };
  },

  checkTiles(program: Program, art: BoundAssets<NesEmitOptions>): void {
    const bound = banks.get(art.emit);
    if (!bound) return;
    const over = (kind: string, used: number): void => {
      if (used <= ART_PATTERNS) return;
      const backdrops = program.scenes.filter((scene) => scene.backdrop !== undefined).length;
      throw new BuildError(
        "E_BACKDROP_TILES",
        `this game needs ${used + BUILTIN_TILES} ${kind} patterns and the NES has ${ART_PATTERNS + BUILTIN_TILES}`,
        backdrops > 0
          ? "a backdrop costs one pattern per distinct 8x8 cell — flatter areas and repeated motifs cost fewer"
          : "fewer objects, or smaller ones; every distinct 8x8 cell of art is a pattern",
      );
    };
    over("background", bound.backgroundPatterns);
    over("object", bound.objectPatterns);
  },

  bindAudio(program: Program): BoundAssets<NesAudio> {
    const names = program.tracks.length > 0 || program.sounds.length > 0;
    const missing = names ? [...program.tracks, ...program.sounds] : [];
    return {
      emit: {
        present: false,
        names,
        tracks: 0,
        effects: 0,
        code: 0,
        data: 0,
        helpers: [],
        rateHz: 0,
        writesRestricted: 0,
      },
      tiles: 0,
      missing,
      notes: names ? ["the nes backend has no sound driver yet; the game plays silently"] : [],
    };
  },

  assemble({ program, analysis, layout, art, audio, title }): Assembled {
    void title; // an iNES header carries no title field
    const ctx = new NesCtx(
      program,
      analysis,
      layout,
      getProfile(program.profile.id),
      NES_PRG_ORIGIN,
    );
    if (audio.names) {
      // No driver, so no request byte for one to read — but the trace's record of
      // what a rule asked for is still written, which is what keeps a silent build
      // and a sounding one the same game.
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

    const prg = new Uint8Array(NES_PRG_SIZE);
    prg.set(code.subarray(0, Math.min(code.length, NES_PRG_SIZE)), 0);
    // The three vectors. There is no fixed entry point on this CPU — it takes the
    // address from `$FFFC` — so these six bytes are what makes the cartridge boot.
    const vector = (name: string): number => ctx.asm.addressOf(name);
    for (const [key, offset] of Object.entries(VECTOR_OFFSET)) {
      const target = vector(key === "nmi" ? "Nmi" : key === "reset" ? "Reset" : "Irq");
      prg[offset] = target & 0xff;
      prg[offset + 1] = (target >> 8) & 0xff;
    }
    const chr = banks.get(art)?.chr ?? new Uint8Array(NES_CHR_SIZE);
    return {
      // Vertical mirroring puts the two nametables side by side, which is what the
      // renderer's map arithmetic is written for.
      bytes: packInesRom(prg, chr, { mirroring: "vertical" }),
      code: code.length,
      capacity: CODE_SIZE,
      symbols: ctx.asm.symbols(),
      helpers: ctx.helperNames(),
    };
  },
};

/**
 * The character bank each art binding produced, keyed by the options it returned.
 *
 * The `Backend` interface deliberately has the art hook return only what the
 * emitter needs, because that is all a *console-independent* build can know about;
 * the cartridge's character ROM is this console's business alone. A side table
 * keyed by identity keeps it out of the shared interface without threading it
 * through one — and it is bounded, because an entry lives exactly as long as the
 * options object one build made.
 */
const banks = new WeakMap<NesEmitOptions, BoundNesArt>();

/** What to stamp in the cartridge, and what source bytes to demake. */
export type NesRomOptions = BuildOptions;

/** Language features this backend does not implement. */
export function unsupportedNesFeatures(program: Program): string[] {
  return nesBackend.unsupported(program);
}

/** Compile a program into a bootable `.nes`. */
export function buildNesRom(program: Program, options: NesRomOptions = {}): BuiltRom {
  return buildRom(program, nesBackend, options);
}

export type { Layout, Analysis, NesEmitOptions };
