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
 *   - **NROM is two boards, and which one a game gets is its own size.** A program
 *     that fits sixteen kilobytes ships on an NROM-128, where the image is mapped
 *     at `$C000` *and* mirrored at `$8000` — so the only difference in the build is
 *     the origin it is assembled at, and the vectors land at the top of the image
 *     either way. Half the file for a game that was never going to use the other
 *     half (`backend.ts` §Elastic cartridges).
 */

import { buildNesGameAudio } from "@demake/audio";
import {
  AsmError,
  NES_BANK_SIZE,
  NES_CHR_SIZE,
  NES_FIXED_WINDOW,
  NES_MAPPER_MMC1,
  NES_MMC1_PRG_SIZES,
  NES_PRG_SIZE,
  NES_PRG_SIZES,
  nesPrgOrigin,
  packInesRom,
  type Executor,
} from "@demake/core";

import { getProfile } from "../profiles.js";
import type { Program } from "../program.js";

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
import { NES_MEMORY, type Layout, type MemoryPlan } from "./layout.js";
import { bindNesArt, PATTERNS_PER_TABLE, type BoundNesArt } from "./nes-art.js";
import { NesCtx } from "./nes/ctx.js";
import { emitProgram, type NesBankPlan, type NesEmitOptions } from "./nes/emit.js";
import type { ArtSettings } from "./settings.js";

/** Bytes of program the largest NROM cartridge holds. */
export const ROM_SIZE = NES_PRG_SIZE;

/**
 * Bytes of it a game may use.
 *
 * The last six are the CPU's three vectors, which is what makes a cartridge
 * bootable at all — so they are subtracted from the budget rather than left for a
 * game to overwrite and discover the problem in an emulator.
 *
 * Measured against the *big* board even when the small one ships, which is
 * `backend.ts` §Elastic cartridges' rule: what this answers is how much room is
 * left before the game stops fitting an NROM cartridge at all.
 */
export const CODE_SIZE = NES_PRG_SIZE - 6;

/** Bytes the three vectors occupy at the top of whichever image was chosen. */
const VECTOR_BYTES = 6;

/** Banks that never move: the sixteen kilobytes MMC1 leaves at `$C000`. */
const FIXED_BANKS = 1;

/**
 * Give every unit a bank, first fit, in the order the emitter walks them.
 *
 * The Game Boy's shape with the halves the other way up. The fixed half is the
 * *top* sixteen kilobytes here, because that is where the vectors are and where
 * MMC1 mode 3 leaves the last bank — so what stays below is the boot, the
 * interrupt handler, the shared helpers, the audio driver's *code*, the level
 * tables and the dispatches that page everything else. A game whose immovable
 * half overruns it is refused by name.
 */
function planBanks(measured: { units: ReadonlyMap<string, number>; fixed: number }): NesBankPlan {
  if (measured.fixed > NES_BANK_SIZE) {
    throw new BuildError(
      "E_GAME_TOO_LARGE",
      `this game's fixed bank is ${measured.fixed} bytes and $C000 holds ${NES_BANK_SIZE}`,
      "smaller levels, shorter music, or fewer objects; paging moves a game's " +
        "scenes, and the boot, the helpers, the audio driver and every table it " +
        "reads have to stay mapped.",
    );
  }
  const banks: string[][] = [];
  const room: number[] = [];
  const bankOf = new Map<string, number>();
  for (const [name, bytes] of measured.units) {
    if (bytes > NES_BANK_SIZE) {
      throw new BuildError(
        "E_GAME_TOO_LARGE",
        `'${name}' compiles to ${bytes} bytes and the window holds ${NES_BANK_SIZE}`,
        "fewer rules or fewer objects in that scene; the window is the unit this " +
          "console pages, so one step of one tick has to fit one window.",
      );
    }
    let slot = room.findIndex((left) => left >= bytes);
    if (slot < 0) {
      slot = room.push(NES_BANK_SIZE) - 1;
      banks.push([]);
    }
    room[slot] = (room[slot] as number) - bytes;
    (banks[slot] as string[]).push(name);
    bankOf.set(name, slot);
  }
  return { banks, bankOf };
}

/**
 * What the NES's audio binding hands the emitter.
 *
 * The same shape the Game Boy's has, and it carries the same two things for the
 * same reason: what the emitter needs to *play* the audio, and — separately —
 * what a rule needs to record that it asked for a sound. The second survives a
 * build with the files left out, because that is a field of the trace (doc 14
 * §Conformance): a silent build has to trace identically to a sounding one, or
 * the conformance suite would be comparing two different games.
 */
interface NesAudio extends BoundAudioShape {
  /** The emitter options the driver contributes: itself, and its index tables. */
  options: NesEmitOptions;
  /** The bytes a rule writes to ask for a sound; absent when none can. */
  hooks?: { driver: boolean; music: number; request: number; effects: readonly number[] };
}

/** The NES's implementation of the build. */
export const nesBackend: Backend<NesEmitOptions, NesAudio> = {
  family: "nes",
  consoles: ["nes"],
  cartridge: "an NROM cartridge",

  extension(): string {
    return "nes";
  },

  /**
   * Language features this backend does not implement.
   *
   * Empty, now that the 2A03 has a driver: levels, tiles, the camera, scrolling,
   * music and effects all compile. It stays as the place a future gap is *named*,
   * because a cartridge that silently dropped one would still trace correctly —
   * nothing downstream would catch it, and a player would see or hear the
   * difference.
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

  async bindArt(
    program: Program,
    assets: AssetBytes,
    executor?: Executor,
    settings?: ArtSettings,
  ): Promise<BoundAssets<NesEmitOptions>> {
    const art = await bindNesArt(program, assets, executor, settings);
    // The character bank travels with the options rather than through a second
    // return value, because `assemble` is the only thing that wants it.
    banks.set(art.options, art);
    return { emit: art.options, tiles: art.tiles, missing: art.missing };
  },

  checkTiles(program: Program, art: BoundAssets<NesEmitOptions>): void {
    const bound = banks.get(art.emit);
    if (!bound) return;
    const room = PATTERNS_PER_TABLE - bound.bankPatterns;
    const over = (kind: string, used: number): void => {
      if (used <= room) return;
      const backdrops = program.scenes.filter((scene) => scene.backdrop !== undefined).length;
      throw new BuildError(
        "E_BACKDROP_TILES",
        `this game needs ${used + bound.bankPatterns} ${kind} patterns and the NES has ${PATTERNS_PER_TABLE}`,
        backdrops > 0
          ? "a backdrop costs one pattern per distinct 8x8 cell — flatter areas and repeated motifs cost fewer"
          : "fewer objects, or smaller ones; every distinct 8x8 cell of art is a pattern",
      );
    };
    over("background", bound.backgroundPatterns);
    over("object", bound.objectPatterns);
  },

  async bindAudio(
    program: Program,
    assets: AssetBytes,
    layout: Layout,
    executor?: Executor,
  ): Promise<BoundAssets<NesAudio>> {
    // The driver's state is page zero the allocator set aside for it, which it
    // only does for a program that names audio — so a game with none reaches
    // `bindAudio` with nowhere to put a driver and does not need one.
    const state = layout.audio;
    const bound =
      state === null
        ? { driver: undefined, missing: [] as readonly string[], notes: [] as readonly string[] }
        : await bindAudio(
            program,
            assets,
            { build: (tracks, effects) => buildNesGameAudio({ tracks, effects, state }) },
            executor,
          );
    const names = program.tracks.length > 0 || program.sounds.length > 0;
    const driver = bound.driver;
    const options: NesEmitOptions = driver
      ? {
          audio: driver,
          effectIndices: effectIndices(program, bound),
          sceneTracks: trackForScene(program, bound),
        }
      : {};
    const emit: NesAudio = {
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
    void title; // an iNES header carries no title field

    /**
     * Compile the whole program with its image ending at `$FFFF`.
     *
     * A fresh `NesCtx` each time, because emitting is what pulls a helper into the
     * output — a context that had already been emitted into would emit them twice.
     */
    const assembleAt = (
      origin: number,
      plan?: NesBankPlan,
      split?: boolean,
    ): { ctx: NesCtx; code: Uint8Array; units: ReadonlyMap<string, number>; fixed: number } => {
      const ctx = new NesCtx(
        program,
        analysis,
        layout,
        getProfile(program.profile.id),
        origin,
        art.bank,
      );
      if (audio.hooks) {
        ctx.audio = {
          driver: audio.hooks.driver,
          music: audio.hooks.music,
          request: audio.hooks.request,
          trace: layout.sound,
          effects: audio.hooks.effects,
        };
      }
      if (plan) ctx.banks = new Map(plan.bankOf);
      try {
        const emitted = emitProgram(ctx, {
          ...art,
          ...audio.options,
          ...(plan ? { banks: plan } : {}),
          ...(split ? { split: true } : {}),
        });
        return { ctx, ...emitted, code: ctx.asm.assemble() };
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

    // The big board first, and its bytes are exactly what they always were. Not
    // because it is the likely answer — the whole point is that it often is not —
    // but because a program that does *not* fit the small one would be assembled
    // past `$FFFF` there, and this assembler truncates an address rather than
    // refusing it: a wasted pass that produced garbage would be measured, not
    // caught. Every 6502 addressing mode is a fixed width, so the length this
    // hands back is the length at either origin, and it decides the board.
    let attempt = assembleAt(nesPrgOrigin(NES_PRG_SIZE));
    let size = NES_PRG_SIZE;
    let plan: NesBankPlan | undefined;
    let mapper = 0;
    if (attempt.code.length > NES_PRG_SIZE - VECTOR_BYTES || layout.spilled) {
      // A game that will not fit a mapper-less board takes an MMC1, and so does
      // one whose *state* would not fit the console's own two kilobytes — the
      // board that brings the second sixteen kilobytes is the board that brings
      // the RAM, so those are one decision (doc 13 §Banked cartridges).
      //
      // The units are measured on a pass shaped exactly like the banked one —
      // same routines, same mapper writes, laid end to end — because a plan built
      // from the flat build's scenes would be built from instructions that no
      // longer exist.
      const probe = assembleAt(NES_FIXED_WINDOW, undefined, true);
      plan = planBanks(probe);
      attempt = assembleAt(NES_FIXED_WINDOW, plan);
      if (attempt.fixed !== probe.fixed) {
        throw new BuildError(
          "E_INTERNAL",
          "the program changed size between the measuring pass and the banked one",
        );
      }
      const banks = plan.banks.length + FIXED_BANKS;
      const chosen = NES_MMC1_PRG_SIZES.find((bytes) => bytes >= banks * NES_BANK_SIZE);
      if (chosen === undefined) {
        throw new BuildError(
          "E_GAME_TOO_LARGE",
          `this game needs ${banks} banks and the largest MMC1 cartridge holds 16`,
          "fewer objects in one rule, or a smaller level.",
        );
      }
      size = chosen;
      mapper = NES_MAPPER_MMC1;
    } else {
      const board = NES_PRG_SIZES.find((bytes) => attempt.code.length <= bytes - VECTOR_BYTES);
      if (board !== undefined && board < size) {
        const smaller = assembleAt(nesPrgOrigin(board));
        // Belt and braces: the length is the same at both origins by
        // construction, and if it ever were not, the big board is still right
        // rather than a cartridge whose last instructions are its own vectors.
        if (smaller.code.length <= board - VECTOR_BYTES) {
          attempt = smaller;
          size = board;
        }
      }
    }
    const { ctx, code } = attempt;

    const prg = new Uint8Array(size);
    if (plan) {
      // The emitter puts the paged banks first and the fixed half last, so that
      // the helpers — pulled by whatever code calls them — are still the last
      // thing emitted. Undoing that here is a copy per bank, and the fixed half
      // goes at the *top* of the image because that is the sixteen kilobytes
      // MMC1 leaves at `$C000` and where the vectors have to be.
      for (const [index] of plan.banks.entries()) {
        prg.set(
          code.subarray(index * NES_BANK_SIZE, (index + 1) * NES_BANK_SIZE),
          index * NES_BANK_SIZE,
        );
      }
      const fixed = code.subarray(plan.banks.length * NES_BANK_SIZE);
      prg.set(fixed.subarray(0, Math.min(fixed.length, NES_BANK_SIZE)), size - NES_BANK_SIZE);
    } else {
      prg.set(code.subarray(0, Math.min(code.length, size)), 0);
    }
    // The three vectors. There is no fixed entry point on this CPU — it takes the
    // address from `$FFFC` — so these six bytes are what makes the cartridge boot.
    // They are the last six of the *image*, which on an NROM-128 the CPU reads
    // through the mirror at `$FFFA`.
    const vectors = { nmi: "Nmi", reset: "Reset", irq: "Irq" } as const;
    for (const [index, name] of Object.values(vectors).entries()) {
      // The top of the image either way: on a mapper-less board that is the
      // whole program, and on an MMC1 one it is the fixed half that answers
      // `$C000` — which is why the fixed half was copied there.
      const offset = size - VECTOR_BYTES + index * 2;
      const target = ctx.asm.addressOf(name);
      prg[offset] = target & 0xff;
      prg[offset + 1] = (target >> 8) & 0xff;
    }
    const chr = banks.get(art)?.chr ?? new Uint8Array(NES_CHR_SIZE);
    return {
      // Vertical mirroring puts the two nametables side by side, which is what the
      // renderer's map arithmetic is written for.
      bytes: packInesRom(prg, chr, { mirroring: "vertical", mapper }),
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
export function buildNesRom(program: Program, options: NesRomOptions = {}): Promise<BuiltRom> {
  return buildRom(program, nesBackend, options);
}

export type { Layout, Analysis, NesEmitOptions };
