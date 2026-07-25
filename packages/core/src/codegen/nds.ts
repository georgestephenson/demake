/**
 * The `nds` codegen family — Nintendo DS 2D engine A (doc 06).
 *
 * The DS's 2D engines are the GBA's, extended: text backgrounds use the identical
 * 4bpp tile packing, screen-entry word and BGR555 palette layout. So the family
 * *is* the `gba` emitter under a different id — what differs is the ROM harness
 * (cartridge header, ARM9 binary, VRAM bank mapping), which lives at the
 * toolchain edge. Extended palettes and the 16-bit framebuffer mode are later
 * additions (doc 03).
 */

import { makeAgbStyleBackend } from "./gba.js";
import type { CodegenBackend } from "./types.js";

/** The `nds` family backend (Nintendo DS, engine A text BG). */
export const ndsBackend: CodegenBackend = makeAgbStyleBackend("nds");
