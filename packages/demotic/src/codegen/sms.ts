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

import {
  AsmError,
  packSegaRom,
  regionFor,
  SMS_HEADER_OFFSET,
  SMS_ORIGIN,
  SMS_ROM_SIZE,
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
 * An SN76489 driver is doc 13's work and does not exist yet, so this reports no
 * driver — and a game that *names* music and effects still builds, plays
 * silently, and says which files went unused. What it must also do is record the
 * request a rule made, because that is a field of the trace (doc 14
 * §Conformance): a build with no driver has to trace identically to one with a
 * driver, or the conformance suite would be comparing two different games.
 */
interface SmsAudio extends BoundAudioShape {
  /** Set whenever the program names audio, driver or no driver. */
  names: boolean;
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

  bindArt(program: Program, assets: AssetBytes): BoundAssets<SmsEmitOptions> {
    const art = bindSmsArt(program, assets, program.profile.id);
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

  bindAudio(program: Program): BoundAssets<SmsAudio> {
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
      notes: names ? ["the sms backend has no sound driver yet; the game plays silently"] : [],
    };
  },

  assemble({ program, analysis, layout, art, audio, title }): Assembled {
    void title; // a Sega header carries no title field, only a product code
    const ctx = new SmsCtx(program, analysis, layout, getProfile(program.profile.id), SMS_ORIGIN);
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
export function buildSmsRom(program: Program, options: SmsRomOptions = {}): BuiltRom {
  return buildRom(program, smsBackend, options);
}

export type { Layout, Analysis, SmsEmitOptions };
export { ART_TILES };
