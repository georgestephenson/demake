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
 *   - **There is no sound.** The S-SMP is a second processor with its own memory
 *     and its own program, and the audio engine has no S-DSP model to build a
 *     driver against (doc 16 §Still to come). That is a gap and it is named as
 *     one: a game with `music` or `sound` still builds and still traces
 *     identically, because the request a rule records is a field of the trace and
 *     not a fact about a chip — what it does not do is make a noise.
 */

import {
  AsmError,
  packSnesRom,
  SNES_CODE_SIZE,
  SNES_ORIGIN,
  SNES_ROM_SIZE,
  SNES_TILE_CAPACITY,
  SNES_TILE_OFFSET,
  type Executor,
} from "@demake/core";

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
 * Present and silent. There is no driver, so nothing here plays anything — but
 * the bytes a rule writes to *record* what it asked for are set whenever the
 * program names audio, because that is a field of the trace (doc 14
 * §Conformance): a build for this console has to trace identically to one for a
 * console that really plays it, or the conformance suite would be comparing two
 * different games.
 */
interface SnesAudio extends BoundAudioShape {
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
   * Empty: levels, tiles, the camera, scrolling and the whole rule vocabulary
   * compile. Sound is not in the list *deliberately* — a game that names it
   * builds and traces correctly, and what is missing is a chip model rather than
   * a language feature, so refusing the build would refuse games this console
   * plays perfectly well in every respect a trace can see.
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

  async bindAudio(program: Program): Promise<BoundAssets<SnesAudio>> {
    const names = program.tracks.length > 0 || program.sounds.length > 0;
    const emit: SnesAudio = {
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
    // Files the program names are not reported missing: this console asks for
    // none of them, so a build with no audio bytes supplied is not a build with
    // anything absent.
    return { emit, tiles: 0, missing: [] };
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

    const bank = banks.get(art)?.options.bank ?? new Uint8Array(0);
    if (bank.length > SNES_TILE_CAPACITY) {
      throw new BuildError(
        "E_BACKDROP_TILES",
        `this game's tile art is ${bank.length} bytes and the art bank holds ${SNES_TILE_CAPACITY}`,
      );
    }

    const image = new Uint8Array(SNES_ROM_SIZE);
    image.set(code.subarray(0, Math.min(code.length, SNES_ROM_SIZE)), 0);
    image.set(bank, SNES_TILE_OFFSET);
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
