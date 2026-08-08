/**
 * What a built audio cartridge *is*, with no processor attached.
 *
 * Here rather than in `gb.ts` — where these four lived while the Game Boy was
 * the only console that built one — because the dispatch in `index.ts` has to
 * name them without naming a family. Every per-family builder is reached through
 * an `import()` so that a console's driver, and the assembler under it, is a
 * chunk of its own (doc 07 §The web JS budget); a shared type imported from one
 * of those families would drag that family back into the always-loaded bundle
 * and quietly undo the split.
 *
 * `gb.ts` re-exports all four, so every emitter in this directory still imports
 * them from where it always did.
 */

import type { ChipScript } from "../chipscript.js";

/** What a build produced, and what the proof needs to read it back. */
export interface BuiltAudioRom {
  bytes: Uint8Array;
  /** Every label the driver defined — the map the conformance harness reads. */
  symbols: ReadonlyMap<string, number>;
  /**
   * The schedule as the ROM will really perform it (doc 16 §The proof).
   *
   * The same object that went in on most consoles, and *not* the same one on any
   * console whose chip is initialised from a table at boot: those writes are
   * performed once rather than at the head of the stream, so tick 0 is shorter
   * than the one the demaker produced. Stating it is what keeps the proof a
   * comparison against what the driver promises rather than against what the
   * caller happened to hand it — the same field, and the same reason, every
   * game driver in this directory carries.
   */
  performed: ChipScript;
  stats: AudioRomStats;
}

/** Sizes and reductions, reported rather than assumed (doc 17 §Stage 6). */
export interface AudioRomStats {
  /** Driver bytes: the code, plus the vector and header padding the format needs. */
  code: number;
  /** Packed schedule bytes: every block, plus the order list. */
  data: number;
  /** ROM still free. */
  free: number;
  /** Driver ticks the schedule covers. */
  ticks: number;
  /** Distinct blocks after dedup. */
  blocks: number;
  /** Order entries; more than `blocks` means the dedup found repeats. */
  order: number;
  /** Blocks the dedup collapsed. */
  blocksSaved: number;
  /** Driver routines this schedule actually pulled in. */
  helpers: readonly string[];
  /** The tick rate the ROM really runs at, as an exact ratio. */
  rate: { num: number; den: number };
  /** Signed error against the schedule's rate, in parts per million. */
  ratePpmError: number;
}

/** What to stamp on the cartridge. */
export interface AudioRomOptions {
  /** Cartridge title: up to 15 characters, upper-cased ASCII. */
  title?: string;
}

/** Raised when a schedule cannot become a ROM. */
export class AudioRomError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly hint?: string,
  ) {
    super(message);
    this.name = "AudioRomError";
  }
}
