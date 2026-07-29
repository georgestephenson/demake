/**
 * The `snes` backend: the Super Nintendo's answers to {@link Backend}'s six
 * questions.
 *
 * Everything about *what* a build does is `backend.ts`'s and everything about
 * what the game means is `shape.ts`'s; this file is the console — its memory map,
 * its image path, its cartridge — and `gb.ts`, `nes.ts` and `sms.ts` beside it
 * are the other three.
 *
 * Three of the answers are worth reading for what they say about the hardware
 * rather than about the code:
 *
 *   - **The cartridge is two banks, and the split is a hardware fact.** Bank zero
 *     is the program, reached by ordinary sixteen-bit absolutes with the data
 *     bank left at zero — which is also where the console's first eight
 *     kilobytes of work RAM are mirrored, so one bank holds everything an
 *     instruction touches. Bank one is the tile art, which never passes through
 *     an instruction at all: it reaches video RAM by a transfer that takes its
 *     source bank as *data*. Sixteen kilobytes of art therefore costs the program
 *     nothing.
 *   - **The tile budget is one budget and it is large.** Five hundred and twelve
 *     tiles shared between the background and the objects, because an object's
 *     tile number is eight bits plus the ninth its attribute byte carries, and the
 *     name-select field puts the second half of the bank exactly where the first
 *     half runs out.
 *   - **The sound is a second computer's, and it is uploaded.** The S-SMP has its
 *     own processor, its own 64 KiB and no access to the cartridge, so this
 *     backend builds *two* programs: 65816 for the game, and — through
 *     `@demake/audio` — an SPC700 driver carrying the demade schedules and the
 *     waveforms they play. `Reset` hands the whole block over four mailbox bytes
 *     at a time and then never calls a driver again; asking for a track or an
 *     effect is three bytes of work RAM and one routine in the main loop. The
 *     block sits at the *top* of bank one, under the tile art, because both are
 *     sized by what the game contains and only one of them can have the low end
 *     without the other having to know how big it got.
 */

import {
  AsmError,
  packSnesRom,
  SNES_BANK_SIZE,
  SNES_TILE_BANK,
  SNES_TILE_BASE,
  SNES_CODE_SIZE,
  SNES_ORIGIN,
  SNES_ROM_SIZE,
  SNES_TILE_CAPACITY,
  SNES_TILE_OFFSET,
  type Executor,
} from "@demake/core";

import { buildSpcGameAudio, type SpcGameAudio } from "@demake/audio";

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
import { SNES_MEMORY, type Layout, type MemoryPlan } from "./layout.js";
import { ART_TILES, bindSnesArt, type BoundSnesArt } from "./snes-art.js";
import { SnesCtx } from "./snes/ctx.js";
import { BANK_TILES, emitProgram, type SnesEmitOptions } from "./snes/emit.js";

/** Bytes a two-bank LoROM cartridge holds. */
export const ROM_SIZE = SNES_ROM_SIZE;

/**
 * Bytes of the program bank a game may use.
 *
 * The header and both vector tables occupy the last sixty-four bytes *inside* the
 * bank, so a program that ran past them would have its code overwritten by the
 * stamp. Subtracting them from the budget here is how that becomes a build error
 * naming the game's size instead of a cartridge that boots into nonsense.
 */
export const CODE_SIZE = SNES_CODE_SIZE;

/**
 * What this backend's audio binding hands the emitter.
 *
 * `gb.ts`'s, `nes.ts`'s and `sms.ts`'s shape: what the emitter needs to *play*
 * the audio, and — separately — the bytes a rule writes to ask for it. The second
 * is set whenever the program *names* audio, driver or no driver, because the
 * request is a field of the trace (doc 14 §Conformance): a build whose files were
 * not supplied has to trace identically to one with them in, or the conformance
 * suite would be comparing two different games.
 */
interface SnesAudio extends BoundAudioShape {
  /** The emitter options the driver contributes: itself, and where it will sit. */
  options: SnesEmitOptions;
  hooks?: { driver: boolean; music: number; request: number; effects: readonly number[] };
}

/** The Super Nintendo's implementation of the build. */
export const snesBackend: Backend<SnesEmitOptions, SnesAudio> = {
  family: "snes",
  consoles: ["snes"],
  cartridge: "a two-bank LoROM cartridge",

  extension(): string {
    return "sfc";
  },

  /**
   * Language features this backend does not implement.
   *
   * Empty: levels, tiles, the camera, scrolling, sound and the whole rule
   * vocabulary compile. It stayed empty through the period when this console had
   * no sound, on the rule `unsupported` states — it names language gaps, not
   * hardware ones, and a game that named music still traced identically to one
   * that played it.
   */
  unsupported(program: Program): string[] {
    const missing: string[] = [];
    if (!snesBackend.consoles.includes(program.profile.id)) {
      missing.push(`a runtime for ${program.profile.name}`);
    }
    return missing;
  },

  memory(): MemoryPlan {
    return SNES_MEMORY;
  },

  async bindArt(
    program: Program,
    assets: AssetBytes,
    executor?: Executor,
  ): Promise<BoundAssets<SnesEmitOptions>> {
    const art = await bindSnesArt(program, assets, executor);
    banks.set(art.options, art);
    return { emit: art.options, tiles: art.tiles, missing: art.missing };
  },

  checkTiles(program: Program, art: BoundAssets<SnesEmitOptions>): void {
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
  ): Promise<BoundAssets<SnesAudio>> {
    // Three bytes of work RAM, which the allocator only reserves for a program
    // that names audio — so a game with none reaches here with nowhere to put a
    // request and does not need one.
    const state = layout.audio;
    const bound =
      state === null
        ? { driver: undefined, missing: [] as readonly string[], notes: [] as readonly string[] }
        : await bindAudio(
            program,
            assets,
            { build: (tracks, effects) => buildSpcGameAudio({ tracks, effects }) },
            executor,
          );
    const names = program.tracks.length > 0 || program.sounds.length > 0;
    const driver: SpcGameAudio | undefined = bound.driver;
    // The image sits at the *top* of the second cartridge bank, under the tile
    // art rather than over it: the art's size is decided by the picture and this
    // one's by the music, and only one of them can be given the low end without
    // the other having to know how big it got.
    const options: SnesEmitOptions = driver
      ? {
          audio: driver,
          audioAt: (SNES_TILE_BANK << 16) | (SNES_TILE_BASE + SNES_BANK_SIZE - driver.image.length),
          effectIndices: effectIndices(program, bound),
          sceneTracks: trackForScene(program, bound),
        }
      : {};
    const emit: SnesAudio = {
      present: driver !== undefined,
      options,
      tracks: driver?.stats.tracks ?? 0,
      effects: driver?.stats.effects ?? 0,
      // Queries, on `BoundAudioShape`'s rule — though this is the one backend
      // whose answer is already final when it is bound: the sound processor's
      // program is assembled *here*, not during `assemble`, because it is a whole
      // second program rather than a routine emitted into the cartridge's own
      // code. Written as queries anyway, so the next reader is not asked to work
      // out which kind of backend they are looking at.
      get code() {
        return driver?.stats.code ?? 0;
      },
      get data() {
        // What the cartridge pays is the whole uploaded block, driver code
        // included — it is data here, however it reads on the other processor.
        return driver === undefined ? 0 : driver.stats.image - driver.stats.code;
      },
      get helpers() {
        return driver?.stats.helpers ?? [];
      },
      rateHz: driver ? driver.stats.rate.num / driver.stats.rate.den : 0,
      writesRestricted: driver?.stats.writesRestricted ?? 0,
      ...(names
        ? {
            hooks: {
              driver: driver !== undefined,
              music: state ?? 0,
              request: (state ?? 0) + 1,
              effects: options.effectIndices ?? program.sounds.map(() => -1),
            },
          }
        : {}),
    };
    return { emit, tiles: 0, missing: bound.missing, notes: bound.notes };
  },

  assemble({ program, analysis, layout, art, audio, title }): Assembled {
    const ctx = new SnesCtx(program, analysis, layout, getProfile(program.profile.id), SNES_ORIGIN);
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

    const bank = banks.get(art)?.options.bank ?? new Uint8Array(0);
    const spc = audio.options.audio?.image ?? new Uint8Array(0);
    const capacity = SNES_TILE_CAPACITY - spc.length;
    if (bank.length > capacity) {
      throw new BuildError(
        "E_BACKDROP_TILES",
        `this game's tile art is ${bank.length} bytes and the art bank holds ${capacity}`,
        spc.length > 0
          ? `the sound processor's program takes ${spc.length} bytes of the same bank; a shorter track leaves more for the picture`
          : undefined,
      );
    }

    const image = new Uint8Array(SNES_ROM_SIZE);
    image.set(code.subarray(0, Math.min(code.length, SNES_ROM_SIZE)), 0);
    image.set(bank, SNES_TILE_OFFSET);
    image.set(spc, SNES_TILE_OFFSET + SNES_BANK_SIZE - spc.length);
    return {
      bytes: packSnesRom(
        image,
        {
          reset: ctx.asm.addressOf("Reset"),
          nmi: ctx.asm.addressOf("Nmi"),
          irq: ctx.asm.addressOf("Irq"),
        },
        { title: title ?? "DEMOTIC" },
      ),
      code: code.length,
      capacity: CODE_SIZE,
      symbols: ctx.asm.symbols(),
      helpers: ctx.helperNames(),
    };
  },
};

/**
 * The tile bank each art binding produced, keyed by the options it returned.
 *
 * The `Backend` interface deliberately has the art hook return only what the
 * emitter needs, because that is all a *console-independent* build can know
 * about; which cartridge bank the art ends up in is this console's business
 * alone. A side table keyed by identity keeps it out of the shared interface
 * without threading it through one — the arrangement `nes.ts` uses for its
 * character bank, and bounded for the same reason: an entry lives exactly as long
 * as the options object one build made.
 */
const banks = new WeakMap<SnesEmitOptions, BoundSnesArt>();

/** What to stamp in the cartridge, and what source bytes to demake. */
export type SnesRomOptions = BuildOptions;

/** Language features this backend does not implement. */
export function unsupportedSnesFeatures(program: Program): string[] {
  return snesBackend.unsupported(program);
}

/** Compile a program into a bootable `.sfc`. */
export function buildSnesRom(program: Program, options: SnesRomOptions = {}): Promise<BuiltRom> {
  return buildRom(program, snesBackend, options);
}

export type { Layout, Analysis, SnesEmitOptions };
export { ART_TILES };
