/**
 * Building a `gb` ROM: compile, assemble, stamp the header.
 *
 * There is no fixed engine and no blob to patch. A game is compiled to SM83
 * machine code specialised to it — its entities at constant addresses, its
 * rules unrolled into the scenes they can fire in, and only the runtime
 * routines something actually called. The assembler is ours (`core`'s
 * {@link Asm}, shared with the audio driver backend), so this runs in a browser
 * with nothing installed and produces the same bytes the CLI does.
 *
 * The Nintendo logo area is left as zeros, exactly as the NDS builder leaves
 * its logo area (doc 06): we ship no copyrighted data. Emulators that direct
 * boot — including `@demake/dmg` and the libretro cores — do not look at it;
 * original hardware does, so `demake build --boot-logo` runs `rgbfix` when
 * RGBDS happens to be installed, and says so when it is not.
 */

import { AsmError, GB_HEADER_OFFSETS, GB_ROM_SIZE, stampGbHeader } from "@demake/core";

import { getProfile } from "../profiles.js";
import type { Program } from "../program.js";

import { analyze, type Analysis } from "./analyze.js";
import { bindArt } from "./art.js";
import { bindAudio, effectIndices, trackForScene, type BoundAudio } from "./audio.js";
import { Ctx } from "./ctx.js";
import { emitProgram, type EmitOptions, type SpriteArt } from "./emit.js";
import { BUILTIN_TILES } from "../rom/graphics.js";
import { LayoutError, planLayout, type Layout } from "./layout.js";

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
 * it is the budget a scene's backdrop competes with the game's own art for.
 */
export const TILE_SLOTS = 256;

/**
 * The first high-RAM byte the audio driver may use.
 *
 * After the OAM DMA kernel at `$FF80` and the VBlank flag the main loop waits
 * on. High RAM because the driver runs on an interrupt and `ldh` is a byte
 * shorter and a cycle faster than a full load.
 */
const HRAM_AUDIO = 0xff8b;

/** What to stamp in the cartridge header, and what art to bind. */
export interface RomOptions extends EmitOptions {
  /** Cartridge title: up to 15 characters, upper-cased ASCII. */
  title?: string;
  /**
   * Raw bytes of the art the program names, keyed by the file name it wrote.
   *
   * Converting here rather than at the edges is what makes the browser and the
   * CLI produce identical cartridges: both hand over the same source bytes, and
   * every decision from rasterising to tile dedup happens in one place. An
   * asset that is not supplied is simply not bound — the object falls back to
   * the built-in block, and `stats.missingArt` says which ones did.
   */
  assets?: ReadonlyMap<string, Uint8Array>;
}

/** What the build produced. */
export interface RomStats {
  /** Bytes of code and data emitted, before padding. */
  bytes: number;
  /** ROM still free. */
  free: number;
  /** Work RAM in use. */
  ram: number;
  scenes: number;
  instances: number;
  rules: number;
  /** Runtime helpers the program actually pulled in. */
  helpers: readonly string[];
  /** Tiles the art conversion added to the built-in bank. */
  artTiles: number;
  /** Art the program names that no bytes were supplied for. */
  missingArt: readonly string[];
  /** Tracks and effects the game plays, and what they cost. */
  audio?: {
    tracks: number;
    effects: number;
    /** Driver code bytes. */
    code: number;
    /** Packed schedule bytes. */
    data: number;
    /** Driver routines this game pulled in. */
    helpers: readonly string[];
    /** The tick rate the ROM's audio really runs at, in Hz. */
    rateHz: number;
    /** Writes an effect could not keep, because it borrows one channel. */
    writesRestricted: number;
    /** What the demakers reported: dropped parts, gestures, channels. */
    notes: readonly string[];
  };
  /** Music and sound files the program names that no bytes were supplied for. */
  missingAudio: readonly string[];
}

/** A built ROM, with the map a harness needs to read its state. */
export interface BuiltRom {
  bytes: Uint8Array;
  layout: Layout;
  analysis: Analysis;
  symbols: ReadonlyMap<string, number>;
  stats: RomStats;
}

/** Raised when a game cannot be built for this console. */
export class BuildError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly hint?: string,
  ) {
    super(message);
    this.name = "BuildError";
  }
}

/**
 * Language features this backend does not implement.
 *
 * Empty, now: levels, tiles, the camera and scrolling all compile. It stays as
 * the place a future gap is *named*, because a runtime that silently ignored a
 * feature would produce a ROM that plays a different game from the preview, and
 * the trace oracle would report the divergence three layers from its cause.
 */
export function unsupportedFeatures(program: Program): string[] {
  const missing: string[] = [];
  if (program.profile.id !== "gb" && program.profile.id !== "gbc") {
    missing.push(`a runtime for ${program.profile.name}`);
  }
  return missing;
}

/** Compile a program into a bootable `.gb`. */
export function buildGbRom(program: Program, options: RomOptions = {}): BuiltRom {
  const missing = unsupportedFeatures(program);
  if (missing.length > 0) {
    throw new BuildError(
      "E_RUNTIME_UNSUPPORTED",
      `the gb backend cannot build ${missing.join(" or ")}`,
      "the preview runs it; the ROM would play a different game, so the build stops here",
    );
  }

  const analysis = analyze(program);
  let layout: Layout;
  try {
    layout = planLayout(program, analysis);
  } catch (error) {
    if (error instanceof LayoutError) throw new BuildError(error.code, error.message, error.hint);
    throw error;
  }

  // Explicit options win over converted art, so a caller can hand over a bank
  // it built itself; anything it left out comes from the conversion.
  const art = bindArt(program, options.assets ?? new Map());
  // The bank is one 256-entry table shared by the background and the objects,
  // so a title screen's tiles are what is left after the game's own art. Art
  // that does not fit is named here rather than drawn with holes in it.
  const tiles = BUILTIN_TILES + art.tiles8;
  if (tiles > TILE_SLOTS) {
    const backdrops = program.scenes.filter((scene) => scene.backdrop !== undefined).length;
    throw new BuildError(
      "E_BACKDROP_TILES",
      `this game needs ${tiles} tiles and the Game Boy has ${TILE_SLOTS}`,
      backdrops > 0
        ? "a backdrop costs one tile per distinct 8x8 cell — flatter areas and repeated motifs cost fewer"
        : "fewer objects, or smaller ones; every distinct 8x8 cell of art is a tile",
    );
  }
  // Audio is demade here for the same reason art is: the browser and the CLI
  // hand over the same source bytes, and every decision from arrangement to
  // register encoding then happens in one place (doc 16 §Working on audio).
  let bound: BoundAudio;
  try {
    bound = bindAudio(program, options.assets ?? new Map(), HRAM_AUDIO);
  } catch (error) {
    throw new BuildError(
      "E_AUDIO",
      `this game's audio could not be demade: ${(error as Error).message}`,
      "the track or the effect is what to look at; `demake arrange` and `demake sfx` report the same failure on their own",
    );
  }
  const audioOptions: EmitOptions = bound.driver
    ? {
        audio: bound.driver,
        effectIndices: effectIndices(program, bound),
        sceneTracks: trackForScene(program, bound),
      }
    : {};
  const emitOptions: EmitOptions = { ...art, ...audioOptions, ...stripUndefined(options) };

  const ctx = new Ctx(program, analysis, layout, getProfile(program.profile.id), 0);
  // Set whenever the program *names* audio, driver or no driver: a rule still
  // records the sound it asked for, so a build with the files left out traces
  // identically to one with them in.
  if (program.tracks.length > 0 || program.sounds.length > 0) {
    ctx.audio = {
      driver: bound.driver !== undefined,
      music: bound.driver?.request.music ?? 0,
      request: bound.driver?.request.sfx ?? 0,
      trace: layout.sound,
      effects: emitOptions.effectIndices ?? program.sounds.map(() => -1),
    };
  }
  let code: Uint8Array;
  try {
    emitProgram(ctx, emitOptions);
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

  if (code.length > ROM_SIZE) {
    throw new BuildError(
      "E_GAME_TOO_LARGE",
      `this game compiles to ${code.length} bytes and a mapper-less cartridge holds ${ROM_SIZE}`,
      "fewer objects in one rule, or a smaller level; bank switching is doc 15 §Not in v1.",
    );
  }

  const rom = new Uint8Array(ROM_SIZE);
  rom.set(code, 0);
  stampGbHeader(rom, options.title ?? "DEMOTIC");

  return {
    bytes: rom,
    layout,
    analysis,
    symbols: ctx.asm.symbols(),
    stats: {
      bytes: code.length,
      free: ROM_SIZE - code.length,
      ram: layout.used,
      scenes: program.scenes.length,
      instances: program.instances.length,
      rules: program.rules.length,
      helpers: ctx.helperNames(),
      artTiles: art.tiles8,
      missingArt: art.missing,
      ...(bound.driver === undefined
        ? {}
        : {
            audio: {
              tracks: bound.driver.stats.tracks,
              effects: bound.driver.stats.effects,
              code: bound.driver.stats.code,
              data: bound.driver.stats.data,
              helpers: bound.driver.stats.helpers,
              rateHz: bound.driver.stats.rate.num / bound.driver.stats.rate.den,
              writesRestricted: bound.driver.stats.writesRestricted,
              notes: bound.notes,
            },
          }),
      missingAudio: bound.missing,
    },
  };
}

/** Drop absent keys so a spread cannot overwrite a value with `undefined`. */
function stripUndefined(options: RomOptions): EmitOptions {
  const out: Record<string, unknown> = {};
  for (const key of ["sprites", "tiles", "extraTiles", "objectPalette"] as const) {
    if (options[key] !== undefined) out[key] = options[key];
  }
  return out as EmitOptions;
}

export type { SpriteArt, EmitOptions, Layout, Analysis };
