/**
 * Building a `gb` ROM: compile, assemble, stamp the header.
 *
 * There is no fixed engine and no blob to patch. A game is compiled to SM83
 * machine code specialised to it — its entities at constant addresses, its
 * rules unrolled into the scenes they can fire in, and only the runtime
 * routines something actually called. The assembler is ours
 * ({@link module:codegen/asm}), so this runs in a browser with nothing
 * installed and produces the same bytes the CLI does.
 *
 * The Nintendo logo area is left as zeros, exactly as the NDS builder leaves
 * its logo area (doc 06): we ship no copyrighted data. Emulators that direct
 * boot — including `@demake/dmg` and the libretro cores — do not look at it;
 * original hardware does, so `demake build --boot-logo` runs `rgbfix` when
 * RGBDS happens to be installed, and says so when it is not.
 */

import { getProfile } from "../profiles.js";
import type { Program } from "../program.js";

import { analyze, type Analysis } from "./analyze.js";
import { AsmError } from "./asm.js";
import { Ctx } from "./ctx.js";
import { emitProgram, type EmitOptions, type SpriteArt } from "./emit.js";
import { LayoutError, planLayout, type Layout } from "./layout.js";

/** Bytes in a mapper-less Game Boy cartridge. */
export const ROM_SIZE = 0x8000;

/** Header field offsets, for callers that read a built ROM back. */
export const HEADER_OFFSETS = {
  logo: 0x0104,
  title: 0x0134,
  cgb: 0x0143,
  cartridgeType: 0x0147,
  romSize: 0x0148,
  ramSize: 0x0149,
  headerChecksum: 0x014d,
  globalChecksum: 0x014e,
} as const;

/** What to stamp in the cartridge header, and what art to bind. */
export interface RomOptions extends EmitOptions {
  /** Cartridge title: up to 15 characters, upper-cased ASCII. */
  title?: string;
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

  const ctx = new Ctx(program, analysis, layout, getProfile(program.profile.id), 0);
  let code: Uint8Array;
  try {
    emitProgram(ctx, options);
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
  writeHeader(rom, options.title ?? "DEMOTIC");

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
    },
  };
}

/**
 * Stamp the cartridge header and both checksums.
 *
 * Checksums are computed and never authored — the same rule doc 15 §header
 * states for every family, and the reason a Demakefile cannot produce an
 * invalid header by omission.
 */
function writeHeader(rom: Uint8Array, title: string): void {
  const clean = title
    .toUpperCase()
    .replace(/[^\x20-\x5f]/g, " ")
    .slice(0, 15);
  for (let index = 0; index < 16; index += 1) {
    rom[HEADER_OFFSETS.title + index] = index < clean.length ? clean.charCodeAt(index) : 0;
  }
  rom[HEADER_OFFSETS.cgb] = 0x00;
  rom[0x0144] = 0x00;
  rom[0x0145] = 0x00;
  rom[0x0146] = 0x00; // no Super Game Boy functions
  rom[HEADER_OFFSETS.cartridgeType] = 0x00; // ROM only: 32 KiB, no mapper
  rom[HEADER_OFFSETS.romSize] = 0x00;
  rom[HEADER_OFFSETS.ramSize] = 0x00;
  rom[0x014a] = 0x01; // non-Japanese
  rom[0x014b] = 0x33; // "see the new licensee code"
  rom[0x014c] = 0x00; // version

  let header = 0;
  for (let at = 0x0134; at <= 0x014c; at += 1) header = (header - (rom[at] as number) - 1) & 0xff;
  rom[HEADER_OFFSETS.headerChecksum] = header;

  rom[HEADER_OFFSETS.globalChecksum] = 0;
  rom[HEADER_OFFSETS.globalChecksum + 1] = 0;
  let global = 0;
  for (const byte of rom) global = (global + byte) & 0xffff;
  rom[HEADER_OFFSETS.globalChecksum] = (global >> 8) & 0xff;
  rom[HEADER_OFFSETS.globalChecksum + 1] = global & 0xff;
}

export type { SpriteArt, EmitOptions, Layout, Analysis };
