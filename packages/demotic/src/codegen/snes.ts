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
 *   - **The cartridge is banks, and the split is a hardware fact.** Bank zero
 *     is the program, reached by ordinary sixteen-bit absolutes with the data
 *     bank left at zero — which is also where the console's first eight
 *     kilobytes of work RAM are mirrored, so one bank holds everything an
 *     instruction touches. Bank one is the tile art, which never passes through
 *     an instruction at all: it reaches video RAM by a transfer that takes its
 *     source bank as *data*. Sixteen kilobytes of art therefore costs the program
 *     nothing. Bank two is the sound processor's image, and a silent game has no
 *     such thing — so the cartridge is two banks or four, decided by whether there
 *     is any music to upload (`backend.ts` §Elastic cartridges).
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
 *     block has a bank of its own, because it and the tile art are sized by
 *     different things and neither can be asked to know how big the other got.
 */

import {
  AsmError,
  packSnesRom,
  SNES_SPC_BANK,
  SNES_SPC_BASE,
  SNES_SPC_CAPACITY,
  SNES_SPC_OFFSET,
  SNES_BANK_SIZE,
  SNES_CODE_SIZE,
  SNES_ORIGIN,
  SNES_PROGRAM_CAPACITY,
  SNES_ROM_SIZE,
  SNES_ROM_SIZES,
  SNES_TILE_CAPACITY,
  SNES_TILE_OFFSET,
  snesRomSizeFor,
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
import {
  BANK_TILES,
  emitProgram,
  type EmittedSnesProgram,
  type SnesBankPlan,
  type SnesEmitOptions,
} from "./snes/emit.js";
import type { ArtSettings } from "./settings.js";

/** Bytes the largest LoROM cartridge this backend builds holds. */
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
  cartridge: "a LoROM cartridge's program bank",

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
    settings?: ArtSettings,
  ): Promise<BoundAssets<SnesEmitOptions>> {
    const art = await bindSnesArt(program, assets, executor, settings);
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
    // The image has a cartridge bank of its own: the art's size is decided by the
    // picture and this one's by the music, and neither can be asked to know how
    // big the other got. It is also the bank whose *absence* makes a silent
    // cartridge half the size, which is why `assemble` asks whether there is one.
    const options: SnesEmitOptions = driver
      ? {
          audio: driver,
          audioAt: (SNES_SPC_BANK << 16) | SNES_SPC_BASE,
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
     * Assemble once, near or far, with or without a bank plan.
     *
     * A fresh `SnesCtx` each time, because emitting is what pulls a helper into
     * the output — a context that had already been emitted into would emit them
     * twice.
     */
    const assembleWith = (banked: boolean, plan?: SnesBankPlan) => {
      const inner = new SnesCtx(
        program,
        analysis,
        layout,
        getProfile(program.profile.id),
        SNES_ORIGIN,
      );
      inner.banked = banked;
      if (hooks) inner.audio = hooks;
      try {
        const emitted = emitProgram(inner, {
          ...art,
          ...audio.options,
          ...(plan ? { banks: plan } : {}),
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

    const bank = banks.get(art)?.options.bank ?? new Uint8Array(0);
    const spc = audio.options.audio?.image ?? new Uint8Array(0);
    if (bank.length > SNES_TILE_CAPACITY) {
      throw new BuildError(
        "E_BACKDROP_TILES",
        `this game's tile art is ${bank.length} bytes and the art bank holds ${SNES_TILE_CAPACITY}`,
      );
    }
    // The sound processor's image has a bank of its own, so a long track costs
    // the picture nothing — and the two are refused separately, because "this
    // game has too much art" and "this game has too much music" are different
    // things to be told. The code is the cartridge's rather than a new one: what
    // did not fit is part of the game.
    if (spc.length > SNES_SPC_CAPACITY) {
      throw new BuildError(
        "E_GAME_TOO_LARGE",
        `the sound processor's program is ${spc.length} bytes and its bank holds ${SNES_SPC_CAPACITY}`,
        "shorter tracks, or fewer of them; the upload indexes the bank with a sixteen-bit register, so this is the addressing's limit as well as the bank's.",
      );
    }

    // The first bank an extra *program* bank may take. Bank zero is the program,
    // bank one is the tile art, and bank two onward is the sound processor's
    // image where there is one — as many banks as it needs, which is at most two
    // because that is how far the upload's `long,X` reaches. A silent game's
    // overflow therefore starts one bank lower, and a silent game that never
    // overflows is the two-bank cartridge it always was.
    const reserved = SNES_SPC_BANK + Math.ceil(spc.length / SNES_BANK_SIZE);

    // The small cartridge first, near calls and one section, and its bytes are
    // exactly what they always were. Only a game that does not fit bank zero pays
    // for the second and third passes — and it pays in assembly, which is
    // milliseconds against the art and audio already demade by now.
    let built = assembleWith(false);
    let plan: SnesBankPlan | undefined;
    if (built.shared + total(built.scenes) > CODE_SIZE) {
      // Far calls change every routine's length, so the plan is measured on a
      // pass that already has them: same instructions, same sizes, one section.
      const measured = assembleWith(true);
      plan = planBanks(measured, reserved);
      built = assembleWith(true, plan);
      // The one thing that would make the placement quietly wrong: a pass whose
      // scenes are not the sizes the plan was built from. Nothing a scene emits
      // depends on which bank it landed in, so they cannot differ — and a check
      // is four lines against a bank that silently overran into the next.
      if (
        built.shared !== measured.shared ||
        built.scenes.some((bytes, index) => bytes !== measured.scenes[index])
      ) {
        throw new BuildError("E_INTERNAL", "the program changed size between assembly passes");
      }
    }

    const { inner: ctx, code } = built;
    const content = built.shared + total(built.scenes);
    // Every bank the cartridge needs: the reserved ones, and one per extra
    // program bank the plan opened. The board is the smallest this console
    // shipped that holds them (`backend.ts` §Elastic cartridges) — two banks for
    // a silent game that fits, four once it has music, and up from there in
    // powers of two because the capacity field is a power of two and so was every
    // mask ROM.
    const used = reserved + (plan?.extra.length ?? 0);
    const size = snesRomSizeFor(used);
    if (size === undefined) {
      throw new BuildError(
        "E_GAME_TOO_LARGE",
        `this game needs ${used} banks and the largest LoROM cartridge holds ` +
          `${String(SNES_ROM_SIZES[SNES_ROM_SIZES.length - 1] as number)} bytes`,
        "fewer objects in one rule, or a smaller level; past four megabytes a " +
          "cartridge stops being LoROM.",
      );
    }

    const image = new Uint8Array(size);
    // The emitter puts the extra banks first and bank zero last, so that the
    // helpers — which are pulled by whatever code calls them — are still the last
    // thing emitted (`snes/emit.ts` §Banking a Super Nintendo cartridge). Undoing
    // that here is a copy per bank, because a bank is a fixed slice of the
    // cartridge rather than a run of bytes that happens to end somewhere.
    const extra = plan?.extra ?? [];
    for (const [index, target] of extra.entries()) {
      const at = index * SNES_BANK_SIZE;
      image.set(code.subarray(at, at + SNES_BANK_SIZE), target * SNES_BANK_SIZE);
    }
    const zero = code.subarray(extra.length * SNES_BANK_SIZE);
    image.set(zero.subarray(0, Math.min(zero.length, CODE_SIZE)), 0);
    image.set(bank, SNES_TILE_OFFSET);
    image.set(spc, SNES_SPC_OFFSET);
    return {
      bytes: packSnesRom(
        image,
        {
          reset: ctx.asm.addressOf("Reset") & 0xffff,
          nmi: ctx.asm.addressOf("Nmi") & 0xffff,
          irq: ctx.asm.addressOf("Irq") & 0xffff,
        },
        { title: title ?? "DEMOTIC" },
      ),
      code: content,
      capacity: SNES_PROGRAM_CAPACITY,
      symbols: ctx.asm.symbols(),
      helpers: ctx.helperNames(),
    };
  },
};

/** Sum a list of sizes. */
function total(sizes: readonly number[]): number {
  return sizes.reduce((sum, bytes) => sum + bytes, 0);
}

/**
 * Give every scene a bank, first fit, in the order the scenes are declared.
 *
 * Bank zero goes first and is short by whatever the shared material took, so a
 * game that only just outgrew one bank keeps most of its scenes where they were
 * and opens one more. After that each new bank is a whole one. First fit rather
 * than anything cleverer for two reasons: it is deterministic, which a cartridge
 * has to be, and the thing it would be optimising — a bank of padding — is a
 * quarter of the smallest board this console shipped either way.
 *
 * A scene that does not fit a *whole* bank is refused by name. That is the wall
 * this scheme has, and it is a real one on the 16 KiB-window consoles (doc 13
 * §Banked cartridges); here a bank is thirty-two kilobytes and the largest scene
 * in the example library is twenty.
 */
function planBanks(measured: EmittedSnesProgram, reserved: number): SnesBankPlan {
  // The one thing banking cannot rescue. Every table a game reads is addressed
  // with the data bank register at zero, and so is every helper's entry, so the
  // shared material has to fit bank zero however many banks the scenes take.
  if (measured.shared > CODE_SIZE) {
    throw new BuildError(
      "E_GAME_TOO_LARGE",
      `this game's shared code and tables are ${measured.shared} bytes and bank zero holds ${CODE_SIZE}`,
      "smaller levels or fewer backdrops; banking moves a game's scenes, and " +
        "everything an absolute address reaches has to stay in bank zero.",
    );
  }
  const room = [CODE_SIZE - measured.shared];
  const sceneBank = measured.scenes.map(() => 0);
  for (const [index, bytes] of measured.scenes.entries()) {
    if (bytes > SNES_BANK_SIZE) {
      throw new BuildError(
        "E_GAME_TOO_LARGE",
        `one scene compiles to ${bytes} bytes and a LoROM bank holds ${SNES_BANK_SIZE}`,
        "fewer rules or fewer objects in that scene; a bank is the unit this " +
          "console pages, so one scene has to fit one.",
      );
    }
    let slot = room.findIndex((left) => left >= bytes);
    if (slot < 0) slot = room.push(SNES_BANK_SIZE) - 1;
    room[slot] = (room[slot] as number) - bytes;
    sceneBank[index] = slot === 0 ? 0 : reserved + slot - 1;
  }
  return {
    sceneBank,
    extra: room.slice(1).map((_, index) => reserved + index),
  };
}

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
