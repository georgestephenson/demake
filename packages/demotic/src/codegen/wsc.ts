/**
 * The `wsc` backend: the WonderSwan Color's answers to {@link Backend}'s six
 * questions.
 *
 * Everything about *what* a build does is `backend.ts`'s and everything about
 * what the game means is `shape.ts`'s; this file is the console — its memory
 * map, its image path, its cartridge.
 *
 * Three of the answers are worth reading for what they say about the hardware:
 *
 *   - **The cartridge cannot move.** Every other console that shipped its games
 *     on more than one board takes the smallest that fits (`backend.ts` §Elastic
 *     cartridges); this one has nothing to choose from, because the header's
 *     size byte has no value below 4 Mbit. A WonderSwan cartridge is 512 KiB the
 *     way a Game Boy ROM-only cartridge is 32 KiB — and only its last 64 KiB is
 *     mapped, so what a build is measured against is the bank rather than the
 *     file.
 *   - **The tile bank is RAM at a fixed address, not video memory behind a
 *     port.** Boot copies it in and nothing streams, so a tile costs cartridge
 *     once — which is why the budget here is the 512 tiles the screen entry's
 *     nine bits can name rather than something smaller chosen to keep two
 *     numbers apart.
 *   - **The mono machine's board can bring RAM, and only that one's.** This is
 *     the one console in the set whose wall is work RAM rather than cartridge —
 *     sixteen kilobytes with the tile bank in the top half leaves 2 KiB of heap —
 *     so a game the console's own memory cannot hold takes its heap to the
 *     cartridge's save RAM at segment `$1` (`memoryUpgrade` below). The colour
 *     machine has sixty-four kilobytes and is offered nothing, because an upgrade
 *     nobody needs is a second memory map nobody is checking.
 */

import { buildWscGameAudio } from "@demake/audio";
import {
  AsmError,
  packWsRom,
  WS_CODE_SEGMENT,
  WS_CODE_SIZE,
  WS_ROM_SIZE,
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
import { WS_MEMORY, WS_SAVE_MEMORY, type Layout, type MemoryPlan } from "./layout.js";
import type { ArtSettings } from "./settings.js";
import { ART_TILES, bindWscArt } from "./wsc-art.js";
import { WscCtx } from "./wsc/ctx.js";
import { machineFor, WSC_MACHINE } from "./wsc/machine.js";
import {
  BANK_TILES,
  emitProgram,
  WS_SEGMENT_SIZE,
  type EmittedWsProgram,
  type WsSegmentPlan,
  type WscEmitOptions,
} from "./wsc/emit.js";

/** Bytes a program may occupy: the bank, up to the reset jump. */
export const CODE_SIZE = WS_CODE_SIZE;

/** What this backend's audio binding hands the emitter. */
interface WscAudio extends BoundAudioShape {
  /** What the emitter needs to call the driver, where there is one. */
  options: WscEmitOptions;
  /** The bytes a rule writes to ask for a sound; absent when none can. */
  hooks?: { driver: boolean; music: number; request: number; effects: readonly number[] };
}

/** The WonderSwan Color's implementation of the build. */
export const wscBackend: Backend<WscEmitOptions, WscAudio> = {
  family: "wsc",
  consoles: ["wsc", "ws"],
  cartridge: "a WonderSwan cartridge's mapped bank",

  extension(program: Program): string {
    return program.profile.id === "ws" ? "ws" : "wsc";
  },

  unsupported(program: Program): string[] {
    const missing: string[] = [];
    if (!wscBackend.consoles.includes(program.profile.id)) {
      missing.push(`a runtime for ${program.profile.name}`);
    }
    return missing;
  },

  memory(program: Program): MemoryPlan {
    // The mono machine's map is the same shape a quarter of the size, and it is
    // the machine's answer rather than this file's (`wsc/machine.ts`).
    return (machineFor(program.profile.id) ?? WSC_MACHINE).memory;
  },

  /**
   * The mono machine's board brings RAM when the console's own will not do.
   *
   * The colour machine has sixty-four kilobytes and no game in the library comes
   * near filling it, so it is offered nothing: an upgrade nobody needs is a
   * second memory map nobody is checking. What the mono machine gets is its heap
   * in the cartridge's save RAM at segment `$1` (`layout.ts` §WS_SAVE_MEMORY),
   * and only after the 2 KiB it has has been refused.
   */
  memoryUpgrade(program: Program, memory: MemoryPlan): MemoryPlan | undefined {
    return memory === WS_MEMORY && program.profile.id === "ws" ? WS_SAVE_MEMORY : undefined;
  },

  async bindArt(
    program: Program,
    assets: AssetBytes,
    executor?: Executor,
    settings?: ArtSettings,
  ): Promise<BoundAssets<WscEmitOptions>> {
    const art = await bindWscArt(
      program,
      assets,
      executor,
      settings,
      machineFor(program.profile.id) ?? WSC_MACHINE,
    );
    return { emit: art.options, tiles: art.tiles, missing: art.missing };
  },

  checkTiles(program: Program, art: BoundAssets<WscEmitOptions>): void {
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
  ): Promise<BoundAssets<WscAudio>> {
    // The driver's state is RAM the allocator set aside for it, which it only
    // does for a program that names audio — so a game with none reaches here
    // with nowhere to put a driver and does not need one.
    const state = layout.audio;
    const bound =
      state === null
        ? { driver: undefined, missing: [] as readonly string[], notes: [] as readonly string[] }
        : await bindAudio(
            program,
            assets,
            {
              build: (tracks, effects) =>
                buildWscGameAudio({
                  tracks,
                  effects,
                  state,
                  // Where this game's heap is, which the driver needs for exactly
                  // one address: the waveform page is the console's memory and
                  // its state is not (`audio` §WscGameAudioInput.heapSegment).
                  ...(layout.memory.heapSegment !== undefined
                    ? { heapSegment: layout.memory.heapSegment }
                    : {}),
                }),
            },
            executor,
          );
    const names = program.tracks.length > 0 || program.sounds.length > 0;
    const driver = bound.driver;
    const options: WscEmitOptions = driver
      ? {
          audio: driver,
          effectIndices: effectIndices(program, bound),
          sceneTracks: trackForScene(program, bound),
        }
      : {};
    const emit: WscAudio = {
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
    void title; // a WonderSwan footer carries no title field
    const machine = machineFor(program.profile.id);
    /**
     * Save RAM the cartridge declares: none unless the game's heap is in it.
     *
     * The bytes the allocator actually handed out rather than the region it was
     * offered, because what the footer names is a chip and the wrapper rounds up
     * to the smallest one that holds them (`asm/ws-cart.ts` §WS_SAVE_SIZES). The
     * elastic-cartridge rule reaching the RAM: a board brings what the game
     * needs, not the largest thing the header can say.
     */
    const saveBytes = layout.memory.heapSegment === undefined ? 0 : layout.used;
    if (machine === undefined) {
      throw new BuildError("E_INTERNAL", `no WonderSwan machine for ${program.profile.id}`);
    }
    /** A fresh context, because emitting is what *pulls* a helper into the output. */
    const fresh = (): WscCtx => {
      const made = new WscCtx(program, analysis, layout, getProfile(program.profile.id), machine);
      made.homeSegment = WS_CODE_SEGMENT;
      if (audio.hooks) {
        made.audio = {
          driver: audio.hooks.driver,
          music: audio.hooks.music,
          request: audio.hooks.request,
          trace: layout.sound,
          effects: audio.hooks.effects,
        };
      }
      return made;
    };

    /** Assemble once, flat or split, with or without a segment plan. */
    const assembleWith = (plan?: WsSegmentPlan, split?: boolean) => {
      const inner = fresh();
      inner.banked = split === true || plan !== undefined;
      try {
        const emitted = emitProgram(inner, {
          ...art,
          ...audio.options,
          ...(plan ? { segments: plan } : {}),
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

    // The flat cartridge first, and its bytes are exactly what they always were:
    // one segment, near calls, no copies. Only a game that does not fit pays for
    // the passes below.
    let built = assembleWith();
    let plan: WsSegmentPlan | undefined;
    if (built.code.length > CODE_SIZE) {
      // The scenes are measured on a pass shaped exactly like the segmented one —
      // same routines, same far calls, laid end to end — because a plan built
      // from the flat build's scenes would be built from instructions that no
      // longer exist.
      const probe = assembleWith(undefined, true);
      plan = planSegments(probe);
      built = assembleWith(plan);
      if (built.fixed !== probe.fixed) {
        throw new BuildError(
          "E_INTERNAL",
          "the program changed size between the measuring pass and the segmented one",
        );
      }
    }
    const { inner: ctx, code } = built;
    const paged = (plan?.segments.length ?? 0) * WS_SEGMENT_SIZE;
    if (code.length - paged > CODE_SIZE) {
      // Refused here rather than in `packWsRom`, so the message names the game's
      // budget rather than the wrapper's precondition.
      throw new BuildError(
        "E_GAME_TOO_LARGE",
        `this game's fixed segment is ${code.length - paged} bytes and it holds ${CODE_SIZE}`,
        "fewer objects in one rule, or a smaller level; spreading a game across " +
          "segments moves its scenes, and the boot, the helpers, the audio driver " +
          "and the tile bank have to stay where the cartridge resets to.",
      );
    }
    if (paged > 0) {
      // Segment $F is the cartridge's last 64 KiB and each paged segment is the
      // one *below* it, so the groups go into the image back to front: the
      // emitter walks them from $E downwards and the file is addressed upwards.
      // Handed over unpadded, because the last bank's own budget stops at the
      // entry jump and the wrapper is what checks that.
      const banks = plan?.segments.length ?? 0;
      const image = new Uint8Array(code.length).fill(0xff);
      for (let at = 0; at < banks; at += 1) {
        const from = at * WS_SEGMENT_SIZE;
        image.set(code.subarray(from, from + WS_SEGMENT_SIZE), (banks - 1 - at) * WS_SEGMENT_SIZE);
      }
      image.set(code.subarray(paged), paged);
      return {
        bytes: packWsRom(image, {
          minimumSystem: machine.minimumSystem,
          orientation: 0x05,
          saveBytes,
          segments: plan ? plan.segments.length + 1 : 1,
        }),
        code: code.length,
        capacity: CARTRIDGE_SIZE,
        symbols: ctx.asm.symbols(),
        helpers: ctx.helperNames(),
      };
    }
    return {
      bytes: packWsRom(code, {
        minimumSystem: machine.minimumSystem,
        orientation: 0x05,
        saveBytes,
      }),
      code: code.length,
      capacity: CARTRIDGE_SIZE,
      symbols: ctx.asm.symbols(),
      helpers: ctx.helperNames(),
    };
  },
};

/**
 * Bytes of cartridge a game may use, which is not the same as a segment's.
 *
 * Measured against the **whole cartridge** rather than the 64 KiB the processor
 * resets into, which is `backend.ts` §Elastic cartridges' rule and used not to
 * bite here: a game bigger than one segment now spreads across the ones below it
 * rather than being refused (doc 13 §Banked cartridges). The last sixteen bytes
 * are the entry jump and the footer, which is what makes a cartridge bootable.
 * What refuses a game now is the *fixed* segment, and it says so separately.
 */
export const CARTRIDGE_SIZE = WS_ROM_SIZE - 16;

/**
 * Give every scene a segment, first fit, in the order the emitter walks them.
 *
 * The Super Nintendo's shape: a segment here is sixty-four kilobytes and the
 * library's largest scene is twenty-two, so a scene never has to be cut and the
 * tick-step seam three other consoles need is absent. What each segment pays is
 * a copy of the tables its own code reads (`wsc/emit.ts` §emitSegmentData), so
 * that is charged before a scene is placed rather than after.
 */
function planSegments(measured: EmittedWsProgram): WsSegmentPlan {
  const segments: number[][] = [];
  const room: number[] = [];
  const segmentOf = new Map<number, number>();
  for (const [index, bytes] of measured.scenes.entries()) {
    if (bytes + measured.data > WS_SEGMENT_SIZE) {
      throw new BuildError(
        "E_GAME_TOO_LARGE",
        `scene ${index} compiles to ${bytes} bytes and a segment holds ${WS_SEGMENT_SIZE}`,
        "fewer rules or fewer objects in that scene; a segment is the unit this " +
          "console spreads a program over, and it shares one with a copy of the " +
          "tables its code reads.",
      );
    }
    let slot = room.findIndex((left) => left >= bytes);
    if (slot < 0) {
      // A new segment starts by paying for its own copy of the shared tables.
      slot = room.push(WS_SEGMENT_SIZE - measured.data) - 1;
      segments.push([]);
    }
    room[slot] = (room[slot] as number) - bytes;
    (segments[slot] as number[]).push(index);
    segmentOf.set(index, slot);
  }
  return { segments, segmentOf };
}

/** What to stamp in the cartridge, and what source bytes to demake. */
export type WscRomOptions = BuildOptions;

/** Language features this backend does not implement. */
export function unsupportedWscFeatures(program: Program): string[] {
  return wscBackend.unsupported(program);
}

/** Compile a program into a bootable `.wsc`. */
export function buildWscRom(program: Program, options: WscRomOptions = {}): Promise<BuiltRom> {
  return buildRom(program, wscBackend, options);
}

export type { Layout, Analysis, WscEmitOptions };
export { ART_TILES };
