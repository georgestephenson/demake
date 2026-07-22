/**
 * Codegen family registry (doc 06 §Per-family backends).
 *
 * Consoles declare a `codegen.family`; this maps that string to the backend that
 * knows the family's data formats. Phase 2 ships the `gb` family (DMG + GBC);
 * later tiers register `nes`, `snes`, `md`, … here — a file each, not a schema
 * change (doc 02 §Extensibility model).
 */

import { gbBackend } from "./gb.js";
import { nesBackend } from "./nes.js";
import type { CodegenBackend } from "./types.js";

const BACKENDS = new Map<string, CodegenBackend>([
  [gbBackend.family, gbBackend],
  [nesBackend.family, nesBackend],
]);

/** The backend for a family, or `undefined` if none is registered yet. */
export function backendFor(family: string): CodegenBackend | undefined {
  return BACKENDS.get(family);
}

/** Every registered codegen family id. */
export function codegenFamilies(): string[] {
  return [...BACKENDS.keys()];
}
