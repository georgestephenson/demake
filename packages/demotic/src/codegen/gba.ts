/**
 * The `gba` backend: the Game Boy Advance's answers to {@link Backend}'s six
 * questions.
 *
 * Everything about *what* a build does is `backend.ts`'s and everything about
 * what the game means is `shape.ts`'s; this file is the console — its memory
 * map, its image path, its cartridge — and `gb.ts`, `nes.ts`, `sms.ts`,
 * `snes.ts` and `md.ts` beside it are the other five.
 *
 * Three of the answers are worth reading for what they say about the hardware
 * rather than about the code:
 *
 *   - **The header is inside the program.** A Game Boy Advance starts executing
 *     at the first word of the cartridge, so what is there is a branch over the
 *     188 bytes that follow it — the program and its header interleave, which no
 *     other console in the set does, and which is why the emitter reserves the
 *     header rather than the wrapper prepending one.
 *   - **Nothing here is scarce, and that is the news.** Thirty-two megabytes of
 *     cartridge, 32 KiB of fast internal work RAM, 48 KiB of background
 *     character memory and another 32 for the objects, with 256 colours in each
 *     of two palettes. Every size assertion the 8-bit backends carry is about a
 *     game that nearly did not fit; the interesting decisions here are all in
 *     the art path.
 *   - **The sound is two devices and only one of them is a chip.** The Game
 *     Boy's four channels are stores to a register page; the other six voices
 *     are a mixer the processor runs, so this is the one backend whose audio
 *     driver has to be handed *working memory* as well as a place to keep its
 *     cursors — which is why `GBA_MEMORY.audioBytes` is two kilobytes where
 *     every other console's is a few dozen.
 */

import { buildGbaGameAudio } from "@demake/audio";
import {
  AsmArm,
  AsmError,
  NDS_ARM7_RAM,
  packGbaRom,
  packNdsRom,
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
import { ART_TILES, bindGbaArt, OBJECT_ART_TILES } from "./gba-art.js";
import { GbaCtx } from "./gba/ctx.js";
import { machineFor } from "./gba/machine.js";
import { BANK_TILES, emitProgram, type GbaEmitOptions } from "./gba/emit.js";
import { GBA_MEMORY, NDS_MEMORY, type Layout, type MemoryPlan } from "./layout.js";

/** The largest image the cartridge bus addresses. */
export const ROM_LIMIT = 32 * 1024 * 1024;

/**
 * What this backend's art binding hands the emitter, plus the two budgets.
 *
 * Two, because this is the first console whose objects have character memory of
 * their own: `tiles` is the background bank's and `objectTiles` is the object
 * bank's, and a game can exhaust either without touching the other.
 */
interface GbaArt extends GbaEmitOptions {
  objectTiles: number;
}

/**
 * What this backend's audio binding hands the emitter.
 *
 * The shape the other five have, and it carries the same two things for the same
 * reason: what the emitter needs to *play* the audio, and — separately — what a
 * rule needs to record that it asked for a sound. The second survives a build
 * with the files left out, because that is a field of the trace (doc 14
 * §Conformance): a silent build has to trace identically to a sounding one, or
 * the conformance suite would be comparing two different games.
 */
interface GbaAudio extends BoundAudioShape {
  options: GbaEmitOptions;
  /** The bytes a rule writes to ask for a sound; absent when none can. */
  hooks?: { driver: boolean; music: number; request: number; effects: readonly number[] };
}

/** The Game Boy Advance's implementation of the build — and the Nintendo DS's. */
export const gbaBackend: Backend<GbaArt, GbaAudio> = {
  family: "gba",
  consoles: ["gba", "nds"],
  cartridge: "a Game Boy Advance cartridge",

  extension(program: Program): string {
    return program.profile.id === "nds" ? "nds" : "gba";
  },

  unsupported(program: Program): string[] {
    const missing: string[] = [];
    if (!gbaBackend.consoles.includes(program.profile.id)) {
      missing.push(`a runtime for ${program.profile.name}`);
    }
    return missing;
  },

  memory(program: Program): MemoryPlan {
    return program.profile.id === "nds" ? NDS_MEMORY : GBA_MEMORY;
  },

  async bindArt(
    program: Program,
    assets: AssetBytes,
    executor?: Executor,
  ): Promise<BoundAssets<GbaArt>> {
    const art = await bindGbaArt(program, assets, executor);
    return {
      emit: { ...art.options, objectTiles: art.objectTiles },
      tiles: art.tiles,
      missing: art.missing,
    };
  },

  checkTiles(program: Program, art: BoundAssets<GbaArt>): void {
    const used = art.tiles + BUILTIN_TILES;
    if (used > BANK_TILES) {
      const backdrops = program.scenes.filter((scene) => scene.backdrop !== undefined).length;
      throw new BuildError(
        "E_BACKDROP_TILES",
        `this game needs ${used} background tiles and the bank holds ${BANK_TILES}`,
        backdrops > 0
          ? "a backdrop costs one tile per distinct 8x8 cell — flatter areas and repeated motifs cost fewer"
          : "fewer level tiles, or simpler ones; every distinct 8x8 cell of art is a tile",
      );
    }
    // The object bank is a *second* budget rather than a share of the first, so
    // it is refused separately and with its own message: a game that ran out of
    // room for its sprites has learned nothing from being told about backdrops.
    // The same code, because the failure is the same class — art needing more
    // tiles than the machine has — and a diagnostic code is part of the language
    // surface (AGENTS.md §Iron rules), not a backend's to invent.
    if (art.emit.objectTiles > OBJECT_ART_TILES) {
      throw new BuildError(
        "E_BACKDROP_TILES",
        `this game needs ${art.emit.objectTiles} object tiles and the object bank holds ${OBJECT_ART_TILES}`,
        "fewer objects, or smaller ones; every distinct 8x8 cell of art is a tile",
      );
    }
  },

  async bindAudio(
    program: Program,
    assets: AssetBytes,
    layout: Layout,
    executor?: Executor,
  ): Promise<BoundAssets<GbaAudio>> {
    // The driver's state is work RAM the allocator set aside for it, which it
    // only does for a program that names audio — so a game with none reaches
    // here with nowhere to put a driver and does not need one.
    const state = layout.audio;
    const bound =
      state === null
        ? { driver: undefined, missing: [] as readonly string[], notes: [] as readonly string[] }
        : await bindAudio(
            program,
            assets,
            { build: (tracks, effects) => buildGbaGameAudio({ tracks, effects, state }) },
            executor,
          );
    const names = program.tracks.length > 0 || program.sounds.length > 0;
    const driver = bound.driver;
    const options: GbaEmitOptions = driver
      ? {
          audio: driver,
          effectIndices: effectIndices(program, bound),
          sceneTracks: trackForScene(program, bound),
        }
      : {};
    const emit: GbaAudio = {
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
    const machine = machineFor(program.profile.id);
    if (machine === undefined) {
      throw new BuildError("E_INTERNAL", `this backend does not build for ${program.profile.name}`);
    }
    const ctx = new GbaCtx(program, analysis, layout, getProfile(program.profile.id), machine);
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

    if (ctx.asm.symbols().get("Reset") === undefined) {
      throw new BuildError("E_INTERNAL", "the code generator emitted no entry point");
    }
    if (code.length > machine.codeLimit) {
      throw new BuildError(
        "E_GAME_TOO_LARGE",
        `this game compiles to ${code.length} bytes and ${machine.id === "nds" ? "the space before its own state" : "the cartridge bus"} holds ${machine.codeLimit}`,
        machine.id === "nds"
          ? "a Nintendo DS binary is copied into main RAM, and the heap starts a megabyte along"
          : undefined,
      );
    }
    const stamp = title === undefined ? {} : { title: title.slice(0, 12).toUpperCase() };
    // Rounded up to 32 KiB (or to the next power of two at least 128 KiB) by the
    // wrapper, which is padding for the sake of a predictable artifact rather
    // than a hardware requirement: neither console has a size field a game has
    // to satisfy.
    const bytes =
      machine.id === "nds" ? packNdsRom(code, arm7Stub(), stamp) : packGbaRom(code, stamp);
    return {
      bytes,
      code: code.length,
      capacity: machine.codeLimit,
      symbols: ctx.asm.symbols(),
      helpers: ctx.helperNames(),
    };
  },
};

/**
 * The ARM7's binary, which is four bytes and a branch to itself.
 *
 * A `.nds` carries two programs and the header is the only thing that says which
 * bytes are whose, so the second one has to exist even when it has nothing to do
 * — the display-ROM harness's `arm7.s` is the same four bytes for the same
 * reason. It is *assembled* rather than written down as a word so that the one
 * encoder emits it, which is the same discipline every other instruction in this
 * backend is under.
 *
 * The day this console gets sound it stops being a stub: its sound registers are
 * the ARM7's alone, so a driver for them runs here (doc 13 §D4).
 */
function arm7Stub(): Uint8Array {
  const asm = new AsmArm(NDS_ARM7_RAM);
  asm.label("Arm7Park");
  asm.b("Arm7Park");
  return asm.assemble();
}

/** What to stamp in the cartridge, and what source bytes to demake. */
export type GbaRomOptions = BuildOptions;

/** Language features this backend does not implement. */
export function unsupportedGbaFeatures(program: Program): string[] {
  return gbaBackend.unsupported(program);
}

/** Compile a program into a bootable `.gba`. */
export function buildGbaRom(program: Program, options: GbaRomOptions = {}): Promise<BuiltRom> {
  return buildRom(program, gbaBackend, options);
}

export type { Layout, Analysis, GbaEmitOptions };
export { ART_TILES };
