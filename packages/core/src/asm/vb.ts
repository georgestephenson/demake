/**
 * The Virtual Boy's memory map and its video processor's register page.
 *
 * Here for `megaduck.ts`'s and `ngp.ts`'s reason: three things will read these
 * addresses — the self-hosted core, the Demotic game backend and the display-ROM
 * builder — and three copies of a register number cancel each other's errors
 * out. A machine description that is wrong *and consistent* passes every test
 * there is (AGENTS.md §Gotchas), so it is written once and pinned against the
 * hardware reference rather than against itself.
 *
 * Four things about this machine are unlike anything else in the matrix, and
 * each decides something above:
 *
 *   - **There are two of every picture.** The display is a pair of scanning
 *     LED arrays, one an eye, and the video processor draws the scene *twice* —
 *     once per eye, offset by a parallax the scene itself declares. That offset
 *     is the whole of this console's 3D: {@link VB_WORLD_GP} is a signed pixel
 *     shift applied one way for the left eye and the other for the right, so a
 *     layer with a larger parallax reads as nearer. Nothing else in this project
 *     has a depth axis at all.
 *   - **A framebuffer is columns, not rows.** 384 columns of 256 pixels, two
 *     bits each, so a column is 64 bytes and the pixel at (x, y) is bits
 *     `(y & 3) * 2` of byte `x * 64 + (y >> 2)`. A runtime never touches one —
 *     the drawing processor fills them from worlds and objects — but a *test*
 *     reads one, and reading it row-major produces a picture that looks like
 *     noise rather than like a wrong picture.
 *   - **Character memory is four blocks with the framebuffers between them**,
 *     and it is *also* mirrored contiguously at {@link VB_CHR_MIRROR}. Uploading
 *     a tile bank through the mirror is one loop; through the four blocks it is
 *     four, with two of them landing in the middle of a framebuffer if the
 *     arithmetic is a byte out.
 *   - **A world is a display list entry, not a layer.** Thirty-two of them at
 *     {@link VB_WORLDS}, processed from 31 down to 0, each naming a rectangle of
 *     a BGMap, where on the screen it goes, and how far apart its two eyes are.
 *     The one that says {@link VB_WORLD_END} stops the processor, so a scene is
 *     as expensive as the worlds it actually uses.
 *
 * Sources: the Virtual Boy *Sacred Tech Scroll* (`vbtech`, David Tucker) — memory
 * map, VIP register list, world attribute and object formats; Planet Virtual Boy
 * — *VIP* and *Memory map* wiki pages; `libgccvb`'s register headers for the
 * control-bit names, which are the ones homebrew uses.
 */

// --- the address space --------------------------------------------------------

/** The video processor: framebuffers, characters, BGMaps, worlds, objects. */
export const VB_VIP = 0x00000000;

/** The sound processor's register page. */
export const VB_VSU = 0x01000000;

/** Hardware control: the pads, the link port and the timer. */
export const VB_HARDWARE = 0x02000000;

/** Work RAM — 64 KiB, and all a game gets. */
export const VB_WRAM = 0x05000000;

/** Bytes of work RAM. */
export const VB_WRAM_SIZE = 0x10000;

/** Cartridge RAM, if the board carries any. */
export const VB_SRAM = 0x06000000;

/** Where the cartridge answers the address bus. */
export const VB_ROM = 0x07000000;

/**
 * The address bus is 27 bits wide, so every address is taken modulo this.
 *
 * That is not a curiosity: the reset vector is at `$FFFFFFF0`, which is this
 * mask applied to it — `$07FFFFF0`, the top of the cartridge region. A program
 * assembled at {@link VB_ROM} is therefore running somewhere it was not
 * assembled for by the time the first instruction retires, which is why the
 * reset stub jumps *absolutely* rather than relatively (`vb-cart.ts`).
 */
export const VB_ADDRESS_MASK = 0x07ffffff;

// --- the video processor's memory ---------------------------------------------

/** Left eye, framebuffer 0. Each framebuffer is 384 columns of 64 bytes. */
export const VB_FB_L0 = 0x00000000;
/** Left eye, framebuffer 1. */
export const VB_FB_L1 = 0x00008000;
/** Right eye, framebuffer 0. */
export const VB_FB_R0 = 0x00010000;
/** Right eye, framebuffer 1. */
export const VB_FB_R1 = 0x00018000;

/** Bytes in one framebuffer column: 256 pixels at two bits each. */
export const VB_FB_COLUMN = 64;

/** Columns in a framebuffer, which is also the display's width. */
export const VB_SCREEN_W = 384;

/** Rows the display actually shows, of the 256 a framebuffer holds. */
export const VB_SCREEN_H = 224;

/**
 * Character memory, seen as one contiguous 8 KiB block.
 *
 * The four blocks the drawing processor reads are interleaved with the
 * framebuffers at `$6000`, `$E000`, `$16000` and `$1E000`; this mirror is the
 * same 2048 characters end to end, and it is what an upload loop should use.
 */
export const VB_CHR_MIRROR = 0x00078000;

/** Bytes per character: eight rows of one little-endian halfword. */
export const VB_CHR_BYTES = 16;

/** Characters the hardware holds. */
export const VB_CHR_COUNT = 2048;

/** BGMap memory. Each map is 64×64 entries of one halfword. */
export const VB_BGMAP = 0x00020000;

/** Bytes in one BGMap. */
export const VB_BGMAP_BYTES = 0x2000;

/** BGMaps a program may use before it runs into the world attributes. */
export const VB_BGMAP_COUNT = 14;

/** Entries across and down one BGMap. */
export const VB_BGMAP_W = 64;
export const VB_BGMAP_H = 64;

/** The world attribute table: 32 entries of 32 bytes, processed 31 down to 0. */
export const VB_WORLDS = 0x0003d800;

/** Bytes in one world attribute entry. */
export const VB_WORLD_BYTES = 32;

/** Worlds the hardware holds. */
export const VB_WORLD_COUNT = 32;

/** The column tables, one an eye — the LED timing this project never changes. */
export const VB_COLUMN_TABLE_L = 0x0003dc00;
export const VB_COLUMN_TABLE_R = 0x0003de00;

/** The object attribute table: 1024 entries of eight bytes. */
export const VB_OAM = 0x0003e000;

/** Bytes in one object attribute entry. */
export const VB_OBJ_BYTES = 8;

/** Objects the hardware holds. */
export const VB_OBJ_COUNT = 1024;

// --- a world attribute entry --------------------------------------------------

/** Halfword 0: the flags, the BGMap size and the base map number. */
export const VB_WORLD_HEAD = 0;
/** Halfword 1: where on the screen the left eye's copy goes. */
export const VB_WORLD_GX = 2;
/** Halfword 2: **the depth** — how far the two eyes' copies are pulled apart. */
export const VB_WORLD_GP = 4;
/** Halfword 3: the vertical position, which no parallax applies to. */
export const VB_WORLD_GY = 6;
/** Halfword 4: where in the BGMap the rectangle is taken from. */
export const VB_WORLD_MX = 8;
/** Halfword 5: a parallax applied to the *source*, which shears the layer. */
export const VB_WORLD_MP = 10;
/** Halfword 6: the source's vertical origin. */
export const VB_WORLD_MY = 12;
/** Halfword 7: the rectangle's width, less one. */
export const VB_WORLD_W = 14;
/** Halfword 8: the rectangle's height, less one. */
export const VB_WORLD_H = 16;
/** Halfword 9: where an affine or h-bias world reads its per-line parameters. */
export const VB_WORLD_PARAM = 18;
/** Halfword 10: the character drawn outside the map when `OVR` is set. */
export const VB_WORLD_OVERPLANE = 20;

/** Draw this world into the left eye. */
export const VB_WORLD_LON = 0x8000;
/** Draw this world into the right eye. */
export const VB_WORLD_RON = 0x4000;
/** A plain BGMap world — the only mode a demade cartridge uses for scenery. */
export const VB_WORLD_BGM_NORMAL = 0x0000;
/** An h-bias world: one horizontal offset per line, from `PARAM`. */
export const VB_WORLD_BGM_HBIAS = 0x1000;
/** An affine world. */
export const VB_WORLD_BGM_AFFINE = 0x2000;
/** An object world: draws a run of the object table rather than a map. */
export const VB_WORLD_BGM_OBJ = 0x3000;
/** Repeat the map outside its bounds rather than showing `OVERPLANE`. */
export const VB_WORLD_OVR = 0x0080;
/** Stop the drawing processor here. Every scene's last world sets it. */
export const VB_WORLD_END = 0x0040;

/** How many BGMaps wide this world's map is, as a power of two, in bits 11–10. */
export function vbWorldScx(power: number): number {
  return (power & 3) << 10;
}

/** How many BGMaps tall this world's map is, as a power of two, in bits 9–8. */
export function vbWorldScy(power: number): number {
  return (power & 3) << 8;
}

// --- an object attribute entry ------------------------------------------------

/** Halfword 0: horizontal position, signed. */
export const VB_OBJ_JX = 0;
/**
 * Halfword 1: the eye flags in bits 15–14 and **the depth** in bits 13–0.
 *
 * An object carries its own parallax, which is what lets a sprite sit in front
 * of the scenery it is drawn over without the scenery moving — the whole reason
 * this console can put the player nearer than the background.
 */
export const VB_OBJ_JP = 2;
/** Halfword 2: vertical position, signed, in the low byte. */
export const VB_OBJ_JY = 4;
/** Halfword 3: the palette, the flips and the character number. */
export const VB_OBJ_ATTR = 6;

/** Draw this object into the right eye. */
export const VB_OBJ_JRON = 0x8000;
/** Draw this object into the left eye. */
export const VB_OBJ_JLON = 0x4000;
/** Which of the four object palettes this object reads, in bits 15–14. */
export function vbObjPalette(index: number): number {
  return (index & 3) << 14;
}
/** Mirror this object horizontally. */
export const VB_OBJ_HFLIP = 0x2000;
/** Mirror it vertically. */
export const VB_OBJ_VFLIP = 0x1000;

// --- the video processor's registers ------------------------------------------

/** The register page. */
export const VB_VIP_REGS = 0x0005f800;

/** Which interrupts are pending. */
export const VB_INTPND = 0x0005f800;
/** Which are enabled. */
export const VB_INTENB = 0x0005f802;
/** Writing a bit here acknowledges it. */
export const VB_INTCLR = 0x0005f804;

/** Display status: which framebuffer is being shown, and whether it is safe. */
export const VB_DPSTTS = 0x0005f820;
/** Display control. */
export const VB_DPCTRL = 0x0005f822;
/** LED brightness, in three overlapping steps. */
export const VB_BRTA = 0x0005f824;
export const VB_BRTB = 0x0005f826;
export const VB_BRTC = 0x0005f828;
/** The rest period between the two eyes' scans. */
export const VB_REST = 0x0005f82a;
/** Display frames per game frame, less one. Zero is every frame. */
export const VB_FRMCYC = 0x0005f82e;
/** Where the column tables are. */
export const VB_CTA = 0x0005f830;

/** Drawing status. */
export const VB_XPSTTS = 0x0005f840;
/** Drawing control. */
export const VB_XPCTRL = 0x0005f842;
/** The hardware's own version number. */
export const VB_VER = 0x0005f844;

/** Where each of the four object groups ends, as an index into the object table. */
export const VB_SPT0 = 0x0005f848;
export const VB_SPT1 = 0x0005f84a;
export const VB_SPT2 = 0x0005f84c;
export const VB_SPT3 = 0x0005f84e;

/** The four BGMap palettes: two bits a colour, colour 0 being transparent. */
export const VB_GPLT0 = 0x0005f860;
export const VB_GPLT1 = 0x0005f862;
export const VB_GPLT2 = 0x0005f864;
export const VB_GPLT3 = 0x0005f866;

/** The four object palettes, in the same shape. */
export const VB_JPLT0 = 0x0005f868;
export const VB_JPLT1 = 0x0005f86a;
export const VB_JPLT2 = 0x0005f86c;
export const VB_JPLT3 = 0x0005f86e;

/** The colour every transparent pixel shows. */
export const VB_BKCOL = 0x0005f870;

// --- the bits in those registers ----------------------------------------------

/** A scan of the display went wrong. */
export const VB_INT_SCANERR = 0x8000;
/** The left eye's frame finished displaying. */
export const VB_INT_LFBEND = 0x4000;
/** The right eye's did. */
export const VB_INT_RFBEND = 0x2000;
/** A new game frame began — the interrupt a runtime's clock rides. */
export const VB_INT_GAMESTART = 0x0020;
/** A new display frame began. */
export const VB_INT_FRAMESTART = 0x0010;
/** The drawing processor reached a set `SBOUT` block. */
export const VB_INT_SBHIT = 0x0008;
/** The drawing processor finished the frame — when it is safe to rewrite worlds. */
export const VB_INT_XPEND = 0x0002;
/** Drawing overran its frame. */
export const VB_INT_TIMEERR = 0x0001;

/** Reset the display. */
export const VB_DP_DPRST = 0x0001;
/** Turn the LEDs on. */
export const VB_DP_DISP = 0x0002;
/** The display is busy with one of the four framebuffers, in bits 5–2. */
export const VB_DP_DPBSY = 0x003c;
/** The scanning servos are ready. */
export const VB_DP_SCANRDY = 0x0040;
/** Which of the two framebuffer pairs is being shown. */
export const VB_DP_FCLK = 0x0080;
/** Enable the display's memory refresh. */
export const VB_DP_RE = 0x0100;
/** Enable the frame sync. */
export const VB_DP_SYNCE = 0x0200;
/** Lock the column table against writes. */
export const VB_DP_LOCK = 0x0400;

/** Reset the drawing processor. */
export const VB_XP_XPRST = 0x0001;
/** Let it draw. */
export const VB_XP_XPEN = 0x0002;
/** Which framebuffer pair it is drawing into, in bits 3–2. */
export const VB_XP_XPBSY = 0x000c;
/** Drawing overran. */
export const VB_XP_OVERTIME = 0x0010;

/** What a runtime writes to `DPCTRL` to bring the display up. */
export const VB_DPCTRL_ON = VB_DP_SYNCE | VB_DP_RE | VB_DP_DISP;

/**
 * The LED intensities every initialisation on this console writes.
 *
 * One definition with two readers — the display-ROM builder and the game
 * backend — because the console spec's shade ramp is a *measured* artifact of
 * exactly these three numbers (`consoles/vb.ts`). A cartridge that programmed
 * different ones would put a picture on the screen that the pixel-perfect E2E's
 * reference was never taken from, and the mismatch would look like a fitter
 * fault rather than a brightness one.
 */
export const VB_BRIGHTNESS = { a: 32, b: 64, c: 32 } as const;

// --- the pads and the timer ---------------------------------------------------

/** Hardware register: the low half of the last pad read. */
export const VB_SDLR = 0x02000010;
/** Hardware register: the high half. */
export const VB_SDHR = 0x02000014;
/** Hardware register: control — writing `$04` starts a pad read. */
export const VB_SCR = 0x02000028;

/** Start a hardware pad read. */
export const VB_SCR_HW_READ = 0x04;
/** Set while a hardware pad read is still going. */
export const VB_SCR_STAT = 0x02;

/**
 * The pad, as the two halves report it.
 *
 * Sixteen bits, low half in `SDLR` and high half in `SDHR`. Bit 1 is always set
 * and bit 0 carries the low-battery signal, so neither is a button — a runtime
 * that treated the word as sixteen buttons would find one of them permanently
 * pressed.
 */
export const VB_KEY_PWR = 0x0001;
export const VB_KEY_SGN = 0x0002;
export const VB_KEY_A = 0x0004;
export const VB_KEY_B = 0x0008;
export const VB_KEY_RT = 0x0010;
export const VB_KEY_LT = 0x0020;
export const VB_KEY_RU = 0x0040;
export const VB_KEY_RR = 0x0080;
export const VB_KEY_LR = 0x0100;
export const VB_KEY_LL = 0x0200;
export const VB_KEY_LD = 0x0400;
export const VB_KEY_LU = 0x0800;
export const VB_KEY_STA = 0x1000;
export const VB_KEY_SEL = 0x2000;
export const VB_KEY_RL = 0x4000;
export const VB_KEY_RD = 0x8000;

/**
 * How often the display starts a new game frame, in hertz.
 *
 * 50.2, which is the *slowest* clock in the whole matrix and the one place this
 * console's tick differs from every other. A rule that adds a constant every
 * tick is a fifth slower here than on a Game Boy and a third slower than on a
 * WonderSwan, which is exactly the trap AGENTS.md §Working on Demotic states:
 * write a delta against `fps` or the game is a different game here.
 */
export const VB_FRAME_HZ = 50.2;

/**
 * How far in front of the display plane each layer of a demade scene sits, in
 * pixels of parallax.
 *
 * This is the whole of demake's use of the third axis, and it is written down
 * once rather than chosen per emitter, because depth is a thing a reader has to
 * be able to check against the *rest* of the scene: a caption that sits behind
 * the object it labels is not a wrong number anywhere, it is a wrong number
 * relative to another one.
 *
 * The ladder is deliberately shallow. A Virtual Boy's two eyes are about
 * 60 pixels apart at the screen, and disparity beyond a few pixels asks the eyes
 * to converge harder than they comfortably will for a whole session — the
 * hardware's own manual is emphatic about it, and every commercial game on this
 * console keeps its foreground within a handful of pixels of the plane. So:
 *
 *   - **Scenery is at the screen.** A backdrop has nothing in front of it to be
 *     behind, and putting it there gives the layers above it room to be nearer
 *     without any of them leaving comfortable range.
 *   - **Objects are in front of it**, which is what makes a demade game read as
 *     3D at all: the player, the ball, the coins stand off the scenery they are
 *     drawn over, and the scenery does not move to allow it.
 *   - **Captions are nearest.** A HUD is not in the world, so it reads best in
 *     front of everything in it — and this console can say that where every
 *     other one in the matrix can only draw text on top.
 *
 * A parallax is this multiplied by {@link VB_NEARER_SIGN}: the left eye's copy
 * of a layer is drawn at `X − P` and the right eye's at `X + P`, so *negative*
 * parallax crosses the eyes and reads as nearer.
 * `packages/cli/test/vb.e2e.test.ts` is where that is settled against a
 * third-party emulator rather than against this comment.
 */
export const VB_DEPTH = {
  /** Scenery, and anything a scene is a picture of. */
  background: 0,
  /** Objects the game moves — the player, and everything it touches. */
  object: 4,
  /** Text and counters, which are not in the world. */
  hud: 7,
} as const;

/**
 * The sign a parallax takes to put a layer **in front of** the display plane.
 *
 * The left eye's copy is drawn at `X − P` and the right eye's at `X + P`, so a
 * negative parallax puts the left eye's copy to the *right* of the right eye's —
 * crossed disparity, which is what the eyes do converging on something nearer
 * than the screen. One definition, because a project with two would have its
 * scenery in front of its sprites on whichever of them was wrong.
 */
export const VB_NEARER_SIGN = -1;

/** The parallax value a layer at this depth is given. */
export function vbParallax(depth: number): number {
  // Coerced to an integer so that a depth of zero is zero rather than *negative*
  // zero, which is the same number to the hardware and a different one to
  // `Object.is` — and a display plane that compares unequal to itself is a
  // confusing way to find out nothing is wrong.
  return (VB_NEARER_SIGN * depth) | 0;
}

/**
 * The hardware shade a demake palette index means.
 *
 * A reversal, not an identity, and it is the one piece of arithmetic on this
 * console that is invisible until a picture is looked at. A fit's index 0 is its
 * *lightest* colour — that is where every mono console in this project puts it,
 * and where this console's spec puts the brightest red — while shade 0 on this
 * display is the LEDs being **off**. So a cartridge that wrote a fit's indices
 * into `GPLT` straight through shows a photographic negative, which is exactly
 * what the pixel-perfect E2E caught the first time it ran.
 *
 * One definition with three readers — the `vb` codegen family, `@demake/vb`'s
 * renderer and the game backend's palette emitter — because a copy in any one of
 * them is a cartridge whose picture is inverted against the other two.
 */
export function vbShade(index: number, shades = 4): number {
  return shades - 1 - (index & (shades - 1));
}

/**
 * Byte offset of a pixel in a framebuffer, and the shift that selects it.
 *
 * One definition with two readers — the core's renderer and the E2E's
 * framebuffer reader — because a column-major picture read row-major is not a
 * wrong picture, it is noise, and two copies of this arithmetic is one of them
 * being noise.
 */
export function vbFramebufferBit(x: number, y: number): { byte: number; shift: number } {
  return { byte: x * VB_FB_COLUMN + (y >> 2), shift: (y & 3) * 2 };
}
