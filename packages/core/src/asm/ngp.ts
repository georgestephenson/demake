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

// --- the processor's own 8-bit timers -----------------------------------------
//
// Four independent 8-bit interval timers fed from a shared 9-bit prescaler.
// Nothing in this repository programs one — a demade *game* rides the picture,
// and the standalone audio cartridge this block exists for is doc 13 §A5's open
// item — but the numbers belong here rather than in whichever file first wants
// them, on the rule every register page in this directory runs under: a machine
// description has one home and more than one reader.
//
// **`NGP_TRUN` and {@link NGP_SOUND_RIGHT} are the same address, and both are
// cited.** Toshiba's datasheet puts the timer run-control byte at I/O `$20`;
// MAME's own Neo Geo Pocket driver puts the T6W28's right-hand write port
// there. They cannot both be plain bytes of one 128-byte page, and nothing this
// project could reach says which reading is wrong for the part SNK actually
// used — so `@demake/ngp` routes the page to the *sound* chip, which is what
// every demade cartridge depends on, and models the timers without wiring them
// in (`packages/ngp/src/timer.ts`). Do not program one from a cartridge until
// that is settled: it is the wrong-and-consistent hazard with the consistency
// removed, and it presents as a cartridge that boots, unlocks the chip and then
// plays nothing at all.
//
// Source: Toshiba TMP95C061 datasheet §3.8 (8-bit timers), Figures 3.8 (4) and
// 3.8 (7) and the up-counter section.

/** Timer operation control: which timers and the prescaler are counting. */
export const NGP_TRUN = 0x000020;

/**
 * Bits of {@link NGP_TRUN}. Set runs the counter, clear stops *and clears* it.
 *
 * Bit 6 is not a timer — the four 8-bit timers are bits 0 to 3 and the two
 * 16-bit ones are bits 4 and 5, so the gap is between them and the prescaler.
 */
export const NGP_TRUN_BITS = {
  timer0: 0,
  timer1: 1,
  timer2: 2,
  timer3: 3,
  timer4: 4,
  timer5: 5,
  prescaler: 7,
} as const;

/** The 8-bit timers' compare registers. Write-only, and a match clears the counter. */
export const NGP_TREG0 = 0x000022;
export const NGP_TREG1 = 0x000023;
export const NGP_TREG2 = 0x000026;
export const NGP_TREG3 = 0x000027;

/** Timer 0/1 mode: each timer's input clock, the PWM cycle and the pair's mode. */
export const NGP_T01MOD = 0x000024;

/**
 * What a timer counts, as the two-bit field in {@link NGP_T01MOD}.
 *
 * **The two timers of a pair do not offer the same clocks**, which is the one
 * thing about this block that reaches as far as the music demaker: the *lower*
 * timer takes the external pin or φT1/φT4/φT16, and the *upper* one takes the
 * comparator output of its partner or φT1/φT16/φT256. So no single timer can be
 * given all four internal clocks, and `@demake/audio`'s `binding/t6w28.ts`
 * offers the upper timer's three because φT256 is the only one that reaches the
 * bottom of a driver's useful band.
 *
 * φT1 is `fc/8`, φT4 `fc/32`, φT16 `fc/128` and φT256 `fc/2048`, where `fc` is
 * this console's 6.144 MHz crystal — so against the *system* clock, which is
 * the crystal halved and is also what the sound chip runs at, they divide by 4,
 * 16, 64 and 1024.
 */
export const NGP_T0CLK = { external: 0, t1: 1, t4: 2, t16: 3 } as const;
export const NGP_T1CLK = { cascade: 0, t1: 1, t16: 2, t256: 3 } as const;

/**
 * What each selection divides the **system** clock by, indexed by the field.
 *
 * The system clock rather than the crystal, because that is the number every
 * caller actually wants: it is the crystal halved, it is what one processor
 * state is, and it is what the sound chip runs at — so a driver's reload and a
 * schedule's rate are stated against the same thing. Entry 0 of each is `0`,
 * because selection 0 is not a division at all: it is the external pin on the
 * lower timer and the partner's comparator output on the upper one.
 */
export const NGP_T0CLK_DIVISORS: readonly number[] = [0, 4, 16, 64];
export const NGP_T1CLK_DIVISORS: readonly number[] = [0, 4, 64, 1024];

/** Bit positions of those two fields within {@link NGP_T01MOD}. */
export const NGP_T0CLK_SHIFT = 0;
export const NGP_T1CLK_SHIFT = 2;

/** The pair's operating mode, in bits 7-6 of {@link NGP_T01MOD}. */
export const NGP_T01M = { two8Bit: 0, cascade16Bit: 1, ppg: 2, pwm: 3 } as const;
export const NGP_T01M_SHIFT = 6;

/**
 * Interrupt enable and priority for timers 1 and 0, a nibble each.
 *
 * The low nibble is timer 0 and the high one timer 1; timers 3 and 2 are the
 * next byte up, in the same order. Within a nibble the low three bits are a
 * **priority** and the top bit is the request flag — reading it says whether a
 * request is pending and writing zero to it clears one.
 *
 * The priority is what enables the interrupt: 1 to 6 accept it, and **both 0
 * and 7 refuse it**, which is the trap in this field. So a driver arms its
 * timer by writing a level rather than a bit, and a level of seven is off
 * rather than most urgent.
 */
export const NGP_INTET01 = 0x000073;
export const NGP_INTET23 = 0x000074;

/** Where each timer's nibble sits in its enable byte. */
export const NGP_INTET_SHIFT = { even: 0, odd: 4 } as const;

/** The highest priority that still *accepts* the interrupt (7 refuses it). */
export const NGP_INT_PRIORITY_MAX = 6;

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

// --- sound --------------------------------------------------------------------

/**
 * The two ports the main CPU writes the sound chip through.
 *
 * A Neo Geo Pocket has a **Z80 sound processor** beside its main one, and on the
 * board the chip's own bus belongs to that Z80. A demade cartridge has no use
 * for a second program, so it takes the other route the hardware provides: the
 * main CPU's own I/O page carries the same two write addresses, gated by
 * {@link NGP_SOUND_ENABLE} below.
 *
 * They carry *different registers*, which is the thing about this chip most
 * likely to be got backwards: the left port carries the three tone periods and
 * the right port carries the noise's own divisor and its mode, and each carries
 * its own side's four attenuators. A driver with the two swapped produces
 * silence rather than a wrong note.
 *
 * Source: MAME — `src/mame/snk/ngp.cpp`, `case 0x20: // t6w28 "right"` /
 * `case 0x21: // t6w28 "left"`.
 */
export const NGP_SOUND_RIGHT = 0x000020;
export const NGP_SOUND_LEFT = 0x000021;

/**
 * The two bytes that hand the sound chip to the main CPU.
 *
 * `$55` at `$38` and `$AA` at `$39`; until both are written the chip ignores
 * anything the main CPU sends it, because the Z80 is meant to own it. Two bytes
 * at boot is the whole of what a cartridge with no sound program has to do.
 */
export const NGP_SOUND_ENABLE = 0x000038;
export const NGP_SOUND_ENABLE_HIGH = 0x000039;
export const NGP_SOUND_ENABLE_VALUE = 0x55;
export const NGP_SOUND_ENABLE_HIGH_VALUE = 0xaa;

/** The eight-bit D/A converters, one a side. Nothing here drives them. */
export const NGP_DAC_RIGHT = 0x000022;
export const NGP_DAC_LEFT = 0x000023;

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
