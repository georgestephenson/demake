/**
 * The Neo Geo Pocket's memory map and its display controller's register page.
 *
 * Here for `megaduck.ts`'s reason: three things will read these addresses — the
 * self-hosted core, the Demotic game backend and the audio driver — and three
 * copies of a register number cancel each other's errors out. A machine
 * description that is wrong *and consistent* passes every test there is
 * (AGENTS.md §Gotchas), so it is written once and pinned against the hardware
 * reference rather than against itself.
 *
 * Three things about this machine's map are worth knowing before reading any of
 * it.
 *
 *   - **The interrupt vectors are in RAM, and they are not the processor's.**
 *     A TLCS-900/H vectors through its own table, but on this console the boot
 *     ROM owns that and dispatches through a table of its own at `$6FB8` — so a
 *     cartridge installs a handler by *writing a pointer into RAM*, and the four
 *     bytes at {@link NGP_VECTOR_VBLANK} are the whole of what a frame-clocked
 *     runtime needs.
 *   - **Video memory is memory.** The scroll planes, the character bank, the
 *     sprite table and the palettes are ordinary addresses in the same space the
 *     variables are in, so nothing is uploaded through a port — the WonderSwan's
 *     arrangement, reached by different hardware, and the reason this console's
 *     renderer will have no upload path at all.
 *   - **The two machines are one register page with two palette schemes.** A
 *     mono Neo Geo Pocket reads the eight-entry lookup tables at
 *     {@link NGP_K1GE_PALETTE}; a Color reads the RGB444 palettes at
 *     {@link NGP_PALETTE}, unless {@link NGP_MODE} puts it back in the mono
 *     machine's mode to run a mono cartridge. Everything else — the scroll
 *     registers, the sprite table, the character bank — is shared.
 *
 * Sources: the Neo Geo Pocket Color technical reference (`ngpcspec.txt`,
 * devrs.com) — memory map, video register list and palette layout.
 */

/** The processor's own on-chip registers: timers, ports and the serial unit. */
export const NGP_INTERNAL_IO = 0x000000;

/** Work RAM, twelve kilobytes of it. */
export const NGP_RAM = 0x004000;

/** Bytes of work RAM, before the boot ROM's own reservation at the top. */
export const NGP_RAM_SIZE = 0x3000;

/**
 * Where the boot ROM's reserved area begins.
 *
 * A cartridge may not use `$6C00`–`$6FFF` for anything but the vectors below:
 * the boot ROM keeps its own state there and a runtime that allocated over it
 * would corrupt the machine that is dispatching its interrupts.
 */
export const NGP_RAM_RESERVED = 0x006c00;

/** RAM a cartridge may allocate: `$4000` up to the reserved area. */
export const NGP_RAM_USABLE = NGP_RAM_RESERVED - NGP_RAM;

/** The sound processor's four kilobytes, which the main CPU can also address. */
export const NGP_Z80_RAM = 0x007000;

/** The display controller's register page. */
export const NGP_VIDEO = 0x008000;

// --- the vectors the boot ROM dispatches through ------------------------------

/** The vertical blank vector, which is the one a frame-clocked runtime wants. */
export const NGP_VECTOR_VBLANK = 0x006fcc;

/** The interrupt raised by the sound processor. */
export const NGP_VECTOR_Z80 = 0x006fd0;

/** The four on-chip 8-bit timers, in order. */
export const NGP_VECTOR_TIMER0 = 0x006fd4;
export const NGP_VECTOR_TIMER1 = 0x006fd8;
export const NGP_VECTOR_TIMER2 = 0x006fdc;
export const NGP_VECTOR_TIMER3 = 0x006fe0;

// --- the display controller ---------------------------------------------------

/** Window origin and size: the rectangle outside which the background colour shows. */
export const NGP_WBA_H = 0x008002;
export const NGP_WBA_V = 0x008003;
export const NGP_WSI_H = 0x008004;
export const NGP_WSI_V = 0x008005;

/** The frame-rate register, which the hardware locks after boot. */
export const NGP_REF = 0x008006;

/** Where the beam is: horizontal in pixels, vertical in scanlines. */
export const NGP_RAS_H = 0x008008;
export const NGP_RAS_V = 0x008009;

/**
 * Status: bit 7 says a scanline overflowed its sprite budget, bit 6 says the
 * display is blanking.
 *
 * Reading bit 6 is how a cartridge that takes no interrupt waits for a frame,
 * which is the WonderSwan's tally one console along.
 */
export const NGP_STATUS = 0x008010;

/** Control: bit 7 inverts the whole picture, bits 2–0 pick the out-of-window colour. */
export const NGP_CONTROL = 0x008012;

/** A whole-layer offset applied to every sprite, which is how the object layer scrolls. */
export const NGP_PO_H = 0x008020;
export const NGP_PO_V = 0x008021;

/** Which scroll plane draws in front, in bit 7. */
export const NGP_PLANE_PRIORITY = 0x008030;

/** Scroll offsets, one pair per plane. */
export const NGP_S1SO_H = 0x008032;
export const NGP_S1SO_V = 0x008033;
export const NGP_S2SO_H = 0x008034;
export const NGP_S2SO_V = 0x008035;

/**
 * The mono machine's palette: three eight-entry lookup tables of shade numbers.
 *
 * Sprites at `$8100`, scroll plane 1 at `$8108`, scroll plane 2 at `$8110`. A
 * Color running a mono cartridge reads these too, which is what
 * {@link NGP_MODE} decides.
 */
export const NGP_K1GE_PALETTE = 0x008100;

/** Whether the backdrop is on, and which colour it is. */
export const NGP_BGC = 0x008118;

/**
 * The Color's palettes: RGB444 entries, four to a palette, two bytes each.
 *
 * Sixteen sprite palettes at `$8200`, sixteen for scroll plane 1 at `$8280` and
 * sixteen for scroll plane 2 at `$8300` — which is a palette per *layer* rather
 * than a shared pool, so an object and a background cell cannot compete for one.
 */
export const NGP_PALETTE = 0x008200;

/** Bytes one layer's sixteen four-entry palettes occupy. */
export const NGP_PALETTE_STRIDE = 0x80;

/**
 * The eight-entry palette the backdrop and the out-of-window colour come from.
 *
 * One definition with two readers, because {@link NGP_BGC} and
 * {@link NGP_CONTROL} both index it — the backdrop inside the window and the
 * colour outside it are two selections from the same eight colours.
 */
export const NGP_BACKGROUND_PALETTE = 0x0083e0;

/** Which display controller the machine behaves as: bit 7 clear is the Color's. */
export const NGP_MODE = 0x0087e2;

/** The object table: sixty-four entries of four bytes. */
export const NGP_SPRITES = 0x008800;

/** How many objects the hardware will draw. */
export const NGP_SPRITE_COUNT = 64;

/** The Color's per-object palette numbers, one byte an object. */
export const NGP_SPRITE_PALETTES = 0x008c00;

/** Scroll plane 1's map: 32×32 entries of two bytes. */
export const NGP_PLANE1 = 0x009000;

/** Scroll plane 2's map. */
export const NGP_PLANE2 = 0x009800;

/** Cells across and down a scroll plane's map. */
export const NGP_PLANE_COLUMNS = 32;
export const NGP_PLANE_ROWS = 32;

/**
 * The character bank: 512 tiles of 8×8 at 2bpp, sixteen bytes apiece.
 *
 * Shared between the scroll planes and the objects — there is no second bank —
 * so a picture and its sprites come out of one budget, which is the Master
 * System's arrangement rather than the Game Boy Advance's.
 */
export const NGP_CHARACTERS = 0x00a000;

/** Tiles the character bank holds. */
export const NGP_CHARACTER_COUNT = 512;

/** Bytes one 8×8 tile at 2bpp occupies. */
export const NGP_CHARACTER_BYTES = 16;

// --- input --------------------------------------------------------------------

/**
 * The controller byte, which the console keeps in the boot ROM's reserved page.
 *
 * SNK's own documentation calls it the "system lever", and every reference this
 * project could reach agrees about *where* it is.
 */
export const NGP_BUTTONS = 0x006f82;

/**
 * Which bit of {@link NGP_BUTTONS} each direction and button is.
 *
 * **Unverified, and deliberately declared rather than hidden.** Four independent
 * sources place the byte at `$6F82` and none of them gives its bit order, so
 * this is the natural reading — the directions in the order a d-pad is usually
 * numbered, then the two buttons, then Option — and not something read off a
 * datasheet. A machine description that is wrong *and consistent* passes every
 * test there is (AGENTS.md §Gotchas), so the risk here is real and it is exactly
 * the kind this project refuses to leave implicit: the `@demake/ngp` core writes
 * this byte through these same constants, so a demade cartridge and the core
 * would agree with each other while disagreeing with the hardware.
 *
 * What would settle it: SNK's own development documentation, a hardware
 * capture, or a homebrew SDK header. Until then this is the one place to change,
 * and changing it is a one-line edit that both readers pick up.
 */
export const NGP_BUTTON_BITS: Readonly<Record<string, number>> = {
  up: 0,
  down: 1,
  left: 2,
  right: 3,
  a: 4,
  b: 5,
  option: 6,
};

/** The visible screen, in pixels. */
export const NGP_SCREEN_WIDTH = 160;
export const NGP_SCREEN_HEIGHT = 152;
