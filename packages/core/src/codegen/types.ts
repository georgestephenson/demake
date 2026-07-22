/**
 * Codegen types (doc 06 §Per-family backends).
 *
 * `gen` turns a {@link CompliantImage} into artifacts a retro developer (or our
 * ROM harness) can use directly: raw `bin` blobs, idiomatic `asm`, or C arrays.
 * Backends live in `codegen/<family>.ts` and share this uniform, tested
 * contract; consoles map onto a family through `spec.codegen.family`.
 *
 * Everything here is platform-pure: emitters return `Uint8Array` bytes and never
 * touch the filesystem. Writing artifacts (and running an assembler for the
 * `rom` format) is the CLI/web edge's job (doc 02 §Dependency rules).
 */

import type { ConsoleSpec } from "../consoles/types.js";
import type { CompliantImage } from "../pipeline/types.js";

/** One emitted file: bytes plus the suffix that names it under a stem. */
export interface GenArtifact {
  /** Filename suffix appended to the output stem, e.g. `.asm`, `.tiles.bin`. */
  suffix: string;
  /** Logical artifact kind (drives file-vs-render handling at the edge). */
  kind: "asm" | "c" | "header" | "bin" | "rom";
  /** The artifact bytes. */
  bytes: Uint8Array;
}

/** Emitter options resolved by {@link gen} before a backend runs. */
export interface EmitOptions {
  /** Identifier / label prefix for `asm`/`c` (e.g. `portrait`). */
  symbol: string;
  /**
   * Provenance header lines (tool+version, source hash, options, regenerate-with)
   * — already assembled, no timestamps (doc 06 §Output hygiene). The backend
   * wraps them in its language's comment syntax.
   */
  header: readonly string[];
  /** Value added to every emitted tile index in the map (`--map-base`). */
  mapBase: number;
  /** Base index the tileset is uploaded at (`--tile-base`). */
  tileBase: number;
}

/**
 * The uniform, tested backend contract (doc 06). `rom` is not part of this
 * surface: building a ROM needs an assembler, which lives at the toolchain edge
 * (doc 06 §ROM building), not in the platform-pure core.
 */
export interface CodegenBackend {
  family: string;
  emitBin(img: CompliantImage, spec: ConsoleSpec, opts: EmitOptions): GenArtifact[];
  emitAsm(img: CompliantImage, spec: ConsoleSpec, opts: EmitOptions): GenArtifact[];
  emitC(img: CompliantImage, spec: ConsoleSpec, opts: EmitOptions): GenArtifact[];
}
