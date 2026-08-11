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
import {
  AsmError,
  GB_BANK_SIZE,
  GB_HEADER_OFFSETS,
  GB_ROM_SIZE,
  GB_ROM_SIZES,
  megaduckRegister,
  stampGbHeader,
  type Executor,
} from "@demake/core";

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
import { emitProgram, type EmitOptions, type GbBankPlan, type SpriteArt } from "./emit.js";
import { GB_MEMORY, GBC_MEMORY, MEGADUCK_MEMORY, type Layout, type MemoryPlan } from "./layout.js";
import type { ArtSettings } from "./settings.js";

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
  consoles: ["gb", "gbc", "megaduck"],
  cartridge: "a mapper-less cartridge",

  extension(program: Program): string {
    if (program.profile.id === "gbc") return "gbc";
    // The Mega Duck's own extension in every emulator that knows the console.
    if (program.profile.id === "megaduck") return "duck";
    return "gb";
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
    if (program.profile.id === "gbc") return GBC_MEMORY;
    if (program.profile.id === "megaduck") return MEGADUCK_MEMORY;
    return GB_MEMORY;
  },

  async bindArt(
    program: Program,
    assets: AssetBytes,
    executor?: Executor,
    settings?: ArtSettings,
  ): Promise<BoundAssets<EmitOptions>> {
    const art = await bindArt(program, assets, executor, settings);
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

  async bindAudio(
    program: Program,
    assets: AssetBytes,
    _layout: Layout,
    executor?: Executor,
  ): Promise<BoundAssets<GbAudio>> {
    const bound = await bindAudio(
      program,
      assets,
      {
        build: (tracks, effects) =>
          buildGameAudio({
            tracks,
            effects,
            hram: HRAM_AUDIO,
            // The chip is the Game Boy's; only where it answers on the bus
            // differs, so the schedules, the channel map and the proof are all
            // untouched and the driver simply stores to a different byte.
            ...(program.profile.id === "megaduck" ? { port: megaduckRegister } : {}),
          }),
      },
      executor,
    );
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
    const hooks = audio.hooks
      ? {
          driver: audio.hooks.driver,
          music: audio.hooks.music,
          request: audio.hooks.request,
          trace: layout.sound,
          effects: audio.hooks.effects,
        }
      : undefined;

    /** Assemble once, flat or split, with or without a bank plan. */
    const assembleWith = (plan?: GbBankPlan, split?: boolean) => {
      const inner = new Ctx(program, analysis, layout, getProfile(program.profile.id), 0);
      if (hooks) inner.audio = hooks;
      if (plan) inner.banks = new Map(plan.bankOf);
      if (plan || split) inner.bankShadow = layout.bank;
      try {
        const emitted = emitProgram(inner, {
          ...emitOptions,
          ...(plan ? { banks: plan } : {}),
          ...(split ? { split: true } : {}),
        });
        return { inner, ...emitted, code: inner.asm.assemble() };
      } catch (error) {
        if (error instanceof AsmError) {
          throw new BuildError(
            "E_INTERNAL",
            `the code generator produced invalid code: ${error.message}`,
          );
        }
        throw error;
      }
    };

    // The 32 KiB cartridge first, and its bytes are exactly what they always
    // were: no controller, no bank writes, one section. Only a game that does not
    // fit pays for the passes below.
    let built = assembleWith();
    let plan: GbBankPlan | undefined;
    let size = ROM_SIZE;
    if (built.code.length > ROM_SIZE) {
      // The units are measured on a pass shaped exactly like the banked one —
      // same routines, same bank writes, laid end to end — because a plan built
      // from the flat build's scenes would be built from instructions that no
      // longer exist.
      const probe = assembleWith(undefined, true);
      plan = planBanks(probe);
      built = assembleWith(plan);
      if (built.fixed !== probe.fixed) {
        throw new BuildError(
          "E_INTERNAL",
          "the program changed size between the measuring pass and the banked one",
        );
      }
      const banks = FIXED_BANKS + plan.banks.length;
      const chosen = GB_ROM_SIZES.find((bytes) => bytes >= banks * GB_BANK_SIZE);
      if (chosen === undefined) {
        throw new BuildError(
          "E_GAME_TOO_LARGE",
          `this game needs ${banks} banks and the largest MBC5 cartridge holds 512`,
          "fewer objects in one rule, or a smaller level.",
        );
      }
      size = chosen;
    }

    const { inner: ctx, code } = built;
    const rom = new Uint8Array(size);
    if (plan) {
      // The emitter puts the paged banks first and bank zero last, so that the
      // helpers — pulled by whatever code calls them — are still the last thing
      // emitted. Undoing that here is a copy per bank.
      for (const [index] of plan.banks.entries()) {
        const at = index * GB_BANK_SIZE;
        rom.set(code.subarray(at, at + GB_BANK_SIZE), (FIXED_BANKS + index) * GB_BANK_SIZE);
      }
      const fixed = code.subarray(plan.banks.length * GB_BANK_SIZE);
      rom.set(fixed.subarray(0, Math.min(fixed.length, GB_BANK_SIZE)), 0);
    } else {
      rom.set(code.subarray(0, Math.min(code.length, size)), 0);
    }
    // A Mega Duck cartridge has no header at all — no logo, no title, no type
    // byte, no checksums — because the console has no boot ROM to check one.
    // Stamping the Game Boy's would overwrite this cartridge's own code, which
    // begins at $0000 and runs straight through where a header would sit.
    if (program.profile.id !== "megaduck") {
      // A colour build declares itself CGB-only, because it programs palette RAM
      // and a second VRAM bank from its first instruction: a DMG asked to run it
      // would show the game in whatever BGP happened to hold, and a cartridge that
      // refuses is a better answer than one that runs wrong.
      stampGbHeader(rom, title ?? "DEMOTIC", { cgb: program.profile.id === "gbc" });
    }
    return {
      bytes: rom,
      code: code.length,
      // The largest cartridge this backend can build, never the one that shipped
      // (`backend.ts` §Elastic cartridges): bank zero is short by nothing here,
      // and every bank above it is the window's own sixteen kilobytes.
      capacity: GB_ROM_SIZES[GB_ROM_SIZES.length - 1] as number,
      symbols: ctx.asm.symbols(),
      helpers: ctx.helperNames(),
    };
  },
};

/** Banks that never move: bank zero, wired to `$0000`. */
const FIXED_BANKS = 1;

/**
 * Give every unit a bank, first fit, in the order the emitter walks them.
 *
 * The Sega's shape with a smaller fixed half. Bank zero takes *nothing*: sixteen
 * kilobytes is the boot, the helpers, the audio driver, the level tables and the
 * dispatches that page everything else, and what is left of it is measured in
 * hundreds of bytes. So the plan cannot make bank zero fit, and a game whose
 * immovable half overruns it is refused by name — which is this console's real
 * wall, and the reason three blocks of *data* are paged units rather than
 * cartridge tables (doc 13 §Banked cartridges).
 */
function planBanks(measured: { units: ReadonlyMap<string, number>; fixed: number }): GbBankPlan {
  if (measured.fixed > GB_BANK_SIZE) {
    throw new BuildError(
      "E_GAME_TOO_LARGE",
      `this game's fixed bank is ${measured.fixed} bytes and bank zero holds ${GB_BANK_SIZE}`,
      "smaller levels, shorter music, or fewer objects; paging moves a game's " +
        "scenes, and the boot, the helpers, the audio driver and every table it " +
        "reads have to stay mapped.",
    );
  }
  const banks: string[][] = [];
  const room: number[] = [];
  const bankOf = new Map<string, number>();
  for (const [name, bytes] of measured.units) {
    if (bytes > GB_BANK_SIZE) {
      throw new BuildError(
        "E_GAME_TOO_LARGE",
        `'${name}' compiles to ${bytes} bytes and the window holds ${GB_BANK_SIZE}`,
        "fewer rules or fewer objects in that scene; the window is the unit this " +
          "console pages, so one step of one tick has to fit one window.",
      );
    }
    let slot = room.findIndex((left) => left >= bytes);
    if (slot < 0) {
      slot = room.push(GB_BANK_SIZE) - 1;
      banks.push([]);
    }
    room[slot] = (room[slot] as number) - bytes;
    (banks[slot] as string[]).push(name);
    bankOf.set(name, FIXED_BANKS + slot);
  }
  return { banks, bankOf };
}

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
export function buildGbRom(program: Program, options: RomOptions = {}): Promise<BuiltRom> {
  return buildRom(program, gbBackend, options);
}

export { BuildError };
export type { SpriteArt, EmitOptions, Layout, Analysis, RomStats, BuiltRom };
