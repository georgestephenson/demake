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
  SMS_BANK_SIZE,
  SMS_HEADER_OFFSET,
  SMS_ORIGIN,
  SMS_FLAT_ROM_SIZES,
  SMS_HEADER_SIZE,
  SMS_ROM_SIZE,
  SMS_ROM_SIZES,
  smsRomSizeFor,
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
import {
  emitProgram,
  BANK_TILES,
  type HeaderHole,
  type SmsBankPlan,
  type SmsEmitOptions,
} from "./sms/emit.js";
import type { ArtSettings } from "./settings.js";

/** Bytes the smallest flat Sega cartridge holds. */
export const ROM_SIZE = SMS_ROM_SIZE;

/**
 * Bytes a game may use before the cartridge has to grow.
 *
 * The header is sixteen bytes *inside* the image rather than a wrapper around it,
 * so a program that ran past `$7FF0` would have its code overwritten by the
 * stamp. That is what decides the boundary between the two flat sizes: a game
 * that ends below it is the 32 KiB cartridge it always was, and one that does not
 * becomes a 48 KiB cartridge with the sixteen bytes padded across.
 */
export const CODE_SIZE = SMS_HEADER_OFFSET;

/** Bytes the largest *flat* Sega cartridge holds, header hole included. */
export const MAX_FLAT_SIZE = SMS_FLAT_ROM_SIZES[SMS_FLAT_ROM_SIZES.length - 1] as number;

/**
 * Bytes the largest Sega cartridge holds at all.
 *
 * What {@link RomStats.free} is measured against, which is the largest board and
 * never the one that shipped (`backend.ts` §Elastic cartridges) — so a game that
 * crossed from a flat 48 KiB onto a paged 64 does not see its headroom jump.
 */
export const MAX_ROM_SIZE = SMS_ROM_SIZES[SMS_ROM_SIZES.length - 1] as number;

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
  cartridge: "a flat Sega cartridge",

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
    settings?: ArtSettings,
  ): Promise<BoundAssets<SmsEmitOptions>> {
    const art = await bindSmsArt(program, assets, program.profile.id, executor, settings);
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
    const hooks = audio.hooks
      ? {
          driver: audio.hooks.driver,
          music: audio.hooks.music,
          request: audio.hooks.request,
          trace: layout.sound,
          effects: audio.hooks.effects,
        }
      : undefined;

    /**
     * Assemble once, with or without the header hole reserved.
     *
     * A fresh `SmsCtx` each time, because emitting is what pulls a helper into the
     * output — a context that had already been emitted into would emit them twice.
     */
    const assembleWith = (hole?: HeaderHole, plan?: SmsBankPlan, split?: boolean) => {
      const inner = new SmsCtx(
        program,
        analysis,
        layout,
        getProfile(program.profile.id),
        SMS_ORIGIN,
      );
      if (hooks) inner.audio = hooks;
      if (plan) inner.banks = new Map(plan.bankOf);
      try {
        const emitted = emitProgram(inner, {
          ...art,
          ...audio.options,
          ...(hole ? { hole } : {}),
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

    // The small cartridge first, and its bytes are exactly what they always were:
    // below `$7FF0` the header is past the end of the image rather than inside it,
    // so there is no hole to leave and nothing to pad. Only a game that does not
    // fit pays for the second pass — and it pays in assembly, which is
    // milliseconds against the art and audio already demade by now.
    //
    // That first pass is also the measuring tape the second one needs: it emits
    // the same data blocks in the same order with nothing stepped over, so what it
    // reports is how long each of them is (`sms/emit.ts` §Placing the header hole).
    const hole = (blocks: readonly number[]): HeaderHole => ({
      from: SMS_HEADER_OFFSET,
      to: SMS_HEADER_OFFSET + SMS_HEADER_SIZE,
      blocks,
    });
    /** A second pass has to reproduce the first's measurements exactly. */
    const sameBlocks = (a: readonly number[], b: readonly number[]): boolean =>
      a.length === b.length && a.every((bytes, index) => bytes === b[index]);

    const first = assembleWith();
    let { inner, blocks, code } = first;
    let size = SMS_ROM_SIZE;
    let plan: SmsBankPlan | undefined;
    if (code.length > CODE_SIZE) {
      if (code.length <= MAX_FLAT_SIZE - SMS_HEADER_SIZE && first.dataStart <= SMS_HEADER_OFFSET) {
        // Still flat: 48 KiB is three banks already mapped, so this is the same
        // second pass it always was and the same bytes.
        const measured = blocks;
        ({ inner, blocks, code } = assembleWith(hole(measured)));
        if (!sameBlocks(blocks, measured)) {
          throw new BuildError(
            "E_INTERNAL",
            "the data section changed size between the two assembly passes",
          );
        }
        size = MAX_FLAT_SIZE;
      } else {
        // Paged. The units are measured on a pass shaped exactly like the banked
        // one — same routines, same bank writes, laid end to end — because a plan
        // built from the flat build's scenes would be built from instructions
        // that no longer exist (`sms/emit.ts` §{@link SmsBankPlan}).
        const probe = assembleWith(undefined, undefined, true);
        plan = planBanks(probe);
        const built = assembleWith(hole(probe.blocks), plan);
        if (!sameBlocks(built.blocks, probe.blocks) || built.fixed !== probe.fixed) {
          throw new BuildError(
            "E_INTERNAL",
            "the program changed size between the measuring pass and the banked one",
          );
        }
        ({ inner, code } = built);
        const banks = FIXED_BANKS + plan.banks.length;
        const chosen = smsRomSizeFor(banks);
        if (chosen === undefined) {
          throw new BuildError(
            "E_GAME_TOO_LARGE",
            `this game needs ${banks} banks and the largest Sega cartridge holds ` +
              `${String(MAX_ROM_SIZE / SMS_BANK_SIZE)}`,
            "fewer objects in one rule, or a smaller level; past 512 KiB the size " +
              "nibble has no code left to name a board with.",
          );
        }
        size = chosen;
      }
    }

    const image = new Uint8Array(size);
    if (plan) {
      // The emitter puts the paged banks first and the fixed half last, so that
      // the helpers — which are pulled by whatever code calls them — are still
      // the last thing emitted. Undoing that here is a copy per bank, because a
      // bank is a fixed slice of the cartridge rather than a run of bytes that
      // happens to end somewhere.
      for (const [index] of plan.banks.entries()) {
        const at = index * SMS_BANK_SIZE;
        image.set(code.subarray(at, at + SMS_BANK_SIZE), (FIXED_BANKS + index) * SMS_BANK_SIZE);
      }
      const fixed = code.subarray(plan.banks.length * SMS_BANK_SIZE);
      image.set(fixed.subarray(0, Math.min(fixed.length, FIXED_BANKS * SMS_BANK_SIZE)), 0);
    } else {
      image.set(code.subarray(0, Math.min(code.length, size)), 0);
    }
    return {
      bytes: packSegaRom(image, { region: regionFor(program.profile.id) }),
      code: code.length,
      // The *largest* flat cartridge minus the sixteen bytes the header takes out
      // of the middle of it — not the size chosen. What `free` answers is how much
      // room is left before the game stops fitting a flat cartridge at all, which
      // is `backend.ts` §Elastic cartridges' rule: measured against the board that
      // shipped, a game that grew a byte past `$7FF0` would see its headroom jump
      // by sixteen kilobytes.
      capacity: MAX_ROM_SIZE - SMS_HEADER_SIZE,
      symbols: inner.asm.symbols(),
      helpers: inner.helperNames(),
    };
  },
};

/**
 * The banks that never move: slots 0 and 1, which come up holding banks 0 and 1.
 *
 * Thirty-two kilobytes, and what makes this console the easier of the two 8-bit
 * ones to page — a Game Boy's fixed half is sixteen and does not hold what has to
 * be always mapped.
 */
const FIXED_BANKS = 2;

/** Bytes of the fixed half a program may use: both banks, less the header. */
const FIXED_SIZE = FIXED_BANKS * SMS_BANK_SIZE - SMS_HEADER_SIZE;

/**
 * Give every unit a bank, first fit, in the order the emitter walks them.
 *
 * Unlike the Super Nintendo's, bank zero takes *nothing*: the fixed half here is
 * not a bank with room left over, it is the boot, the helpers, the audio driver,
 * the schedules and every table, and what is left of it is measured in hundreds
 * of bytes rather than kilobytes. So every unit is paged and the packing is over
 * whole 16 KiB banks — which also means the plan cannot make the fixed half fit,
 * and a game whose immovable half overruns 32 KiB is refused by name.
 */
function planBanks(measured: { units: ReadonlyMap<string, number>; fixed: number }): SmsBankPlan {
  if (measured.fixed > FIXED_SIZE) {
    throw new BuildError(
      "E_GAME_TOO_LARGE",
      `this game's fixed half is ${measured.fixed} bytes and slots 0 and 1 hold ${FIXED_SIZE}`,
      "smaller levels, shorter music, or fewer objects; paging moves a game's " +
        "scenes, and the boot, the helpers, the audio driver and every table it " +
        "reads have to stay mapped.",
    );
  }
  const banks: string[][] = [];
  const room: number[] = [];
  const bankOf = new Map<string, number>();
  for (const [name, bytes] of measured.units) {
    if (bytes > SMS_BANK_SIZE) {
      throw new BuildError(
        "E_GAME_TOO_LARGE",
        `'${name}' compiles to ${bytes} bytes and slot 2's window holds ${SMS_BANK_SIZE}`,
        "fewer rules or fewer objects in that scene; the window is the unit this " +
          "console pages, so one step of one tick has to fit one window.",
      );
    }
    let slot = room.findIndex((left) => left >= bytes);
    if (slot < 0) {
      slot = room.push(SMS_BANK_SIZE) - 1;
      banks.push([]);
    }
    room[slot] = (room[slot] as number) - bytes;
    (banks[slot] as string[]).push(name);
    bankOf.set(name, FIXED_BANKS + slot);
  }
  return { banks, bankOf };
}

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
