/**
 * The K1GE/K2GE display controller — the Neo Geo Pocket's picture.
 *
 * Handed the console's video memory rather than owning an array of its own, for
 * `@demake/wsc`'s reason: on this machine the registers, the palettes, the two
 * scroll maps, the object table and the character bank are one contiguous region
 * of the same address space the variables are in, so nothing is ever uploaded
 * through a port and the display reads exactly what the processor wrote.
 *
 * Four things about this controller are worth knowing before reading it.
 *
 *   - **It is two machines, and the difference is only the palette.** A mono Neo
 *     Geo Pocket looks colour indices up in three-entry tables of grey *shades*;
 *     a Color looks them up in sixteen four-entry palettes of RGB444 per layer.
 *     The maps, the character bank, the object table, the scrolling and the
 *     priority are identical, which is why {@link NgpModel} is a constructor
 *     argument and not a second renderer.
 *   - **An object is one tile, and a big one is a chain.** There is no 8×16 and
 *     no size field: a sprite is 8×8, and the two chain bits say "my position is
 *     an offset from the previous object's" — so a 16×16 character is four
 *     entries whose last three are relative. That makes an object's absolute
 *     position depend on every object before it, which is why
 *     {@link Display.positionSprites} walks the whole table once a frame rather
 *     than resolving one object at a time.
 *   - **Three sprite priorities interleave with two planes.** Back to front:
 *     backdrop, the objects that chose "furthest", the back plane, the objects
 *     that chose "middle", the front plane, and the objects that chose "front" —
 *     with one register deciding which plane is which. So an object can be
 *     *between* two background layers, which no other 8-bit console in this
 *     project offers.
 *   - **Colour zero is transparent everywhere.** In both planes and in the
 *     objects, so the backdrop is a register rather than a layer and a scene
 *     with nothing drawn is the background colour rather than black.
 *
 * What is absent is absent rather than half-implemented: the negative-display
 * switch, the per-line character overflow flag, and the window colour palette at
 * `$83F0` — which the reference says nothing writes to, because the
 * out-of-window colour is taken from the background palette like the backdrop.
 *
 * Sources: the Neo Geo Pocket Color technical reference (`ngpcspec.txt`,
 * devrs.com) — register list, map and object formats, palette layout and the
 * display timing.
 */

import {
  NGP_BACKGROUND_PALETTE,
  NGP_BGC,
  NGP_CHARACTERS,
  NGP_CONTROL,
  NGP_K1GE_PALETTE,
  NGP_PALETTE,
  NGP_PALETTE_STRIDE,
  NGP_PLANE_PRIORITY,
  NGP_PLANE1,
  NGP_PLANE2,
  NGP_PO_H,
  NGP_PO_V,
  NGP_S1SO_H,
  NGP_S1SO_V,
  NGP_S2SO_H,
  NGP_S2SO_V,
  NGP_SCREEN_HEIGHT,
  NGP_SCREEN_WIDTH,
  NGP_SPRITE_COUNT,
  NGP_SPRITE_PALETTES,
  NGP_SPRITES,
  NGP_VIDEO,
  NGP_WBA_H,
  NGP_WBA_V,
  NGP_WSI_H,
  NGP_WSI_V,
} from "@demake/core";

/** Which machine this is. The maps are the same; only the palettes differ. */
export type NgpModel = "ngp" | "ngpc";

export const SCREEN_WIDTH = NGP_SCREEN_WIDTH;
export const SCREEN_HEIGHT = NGP_SCREEN_HEIGHT;

/**
 * Scanlines in a frame, and where the visible ones stop.
 *
 * A hundred and fifty-two lines of picture and forty-seven of blanking, at five
 * hundred and fifteen master cycles a line — which puts this console at 59.95 Hz
 * rather than the sixty every other machine in the set but the WonderSwan runs
 * at.
 */
export const LINES_PER_FRAME = 199;
export const VBLANK_LINE = SCREEN_HEIGHT;
export const CYCLES_PER_LINE = 515;

/** Bytes of video memory: `$8000` through `$BFFF`. */
export const VIDEO_SIZE = 0x4000;

/** The backdrop is black unless the background register says otherwise. */
const BACKGROUND_ON = 0x80;

/**
 * The display's own structures, as offsets into the array it is handed.
 *
 * Everything below reads the console's memory through an *offset* rather than
 * through an address, because this model is given the region rather than the
 * bus. Naming them once here is also what keeps the per-pixel path free of
 * module-level lookups, which matters more than it reads: a scanline renderer
 * that resolved `NGP_CHARACTERS` per pixel spends most of a frame doing it.
 */
const OFF_PLANE: readonly number[] = [0, NGP_PLANE1 - NGP_VIDEO, NGP_PLANE2 - NGP_VIDEO];
const OFF_SCROLL_H: readonly number[] = [0, NGP_S1SO_H - NGP_VIDEO, NGP_S2SO_H - NGP_VIDEO];
const OFF_SCROLL_V: readonly number[] = [0, NGP_S1SO_V - NGP_VIDEO, NGP_S2SO_V - NGP_VIDEO];
const OFF_CHARACTERS = NGP_CHARACTERS - NGP_VIDEO;
const OFF_PALETTE = NGP_PALETTE - NGP_VIDEO;
const OFF_K1GE = NGP_K1GE_PALETTE - NGP_VIDEO;

/**
 * Bytes one 8×8 character at 2bpp occupies, and how a pixel is read out of a
 * row.
 *
 * A row is a little-endian halfword and the *rightmost* pixel is in the low two
 * bits, so the leftmost is the highest pair — the opposite way round from every
 * packed format in this project, and the one thing about this layout worth
 * stating twice. Both readers below spell the shift out rather than calling a
 * helper, because both are inside a loop that runs once a pixel.
 */
const CHARACTER_BYTES = 16;

/** Colours in one palette — the same four on both machines. */
const PALETTE_SIZE = 4;

/**
 * Where a layer's palettes start in the resolved colour cache.
 *
 * In *entries*, where the hardware's own stride is in bytes and a colour is two
 * of them — so this is derived from the register map rather than being a second
 * count of the same palettes.
 */
const LAYER_STRIDE = NGP_PALETTE_STRIDE / 2;

/** Expand a four-bit channel to eight bits by replicating it. */
export function expandChannel(value: number): number {
  const nibble = value & 0xf;
  return (nibble << 4) | nibble;
}

/** The same sixteen answers, for the loop that resolves every palette a line. */
const EXPANDED: readonly number[] = Array.from({ length: 16 }, (_, value) => expandChannel(value));

/**
 * The mono machine's eight grey levels, lightest first.
 *
 * The same ramp the `ngp` console spec declares, because that spec is what a
 * demade picture is fitted against and a second definition here would be a
 * second answer (AGENTS.md §Gotchas — a Game Boy screen is a tested artifact).
 */
export const MONO_SHADES: readonly number[] = Array.from({ length: 8 }, (_, index) => {
  const level = Math.round(255 * (1 - index / 7));
  return (level << 16) | (level << 8) | level;
});

/** One object, once the chain has been resolved into an absolute position. */
interface Sprite {
  x: number;
  y: number;
  tile: number;
  hflip: boolean;
  vflip: boolean;
  priority: number;
  monoPalette: number;
  colorPalette: number;
  /** The character row this object shows on the line being drawn. */
  row: number;
  /** Where its palette starts in the resolved colour cache, for that line. */
  paletteBase: number;
}

export class Display {
  /** RGBA, one byte a channel — where it goes is the caller's business. */
  readonly framebuffer = new Uint8ClampedArray(SCREEN_WIDTH * SCREEN_HEIGHT * 4);

  /** Which scanline the beam is on. */
  line = 0;

  /** Cycles owed to the current line. */
  private cycles = 0;

  /** Set for one step when the beam reaches the first blanked line. */
  frameReady = false;

  /**
   * The objects of each priority that cover the line being drawn.
   *
   * Rebuilt once a scanline rather than consulted once a pixel, which is what
   * the hardware itself does — this chip evaluates a per-line budget, and on
   * this console that budget is the whole table. Without it a frame is 160 by
   * 152 pixels times three priorities times sixty-four entries, and the core is
   * thirty times slower than every other one in the set for a picture that is
   * usually four sprites wide.
   *
   * Indexed by priority, so index 0 is unused: a priority of zero is what hides
   * an object on this hardware.
   */
  private readonly onLine: Sprite[][] = [[], [], [], []];

  private readonly sprites: Sprite[] = Array.from({ length: NGP_SPRITE_COUNT }, () => ({
    x: 0,
    y: 0,
    tile: 0,
    hflip: false,
    vflip: false,
    priority: 0,
    monoPalette: 0,
    colorPalette: 0,
    row: 0,
    paletteBase: 0,
  }));

  /**
   * Every palette, resolved to a colour, refreshed once a line.
   *
   * A hundred and ninety-two entries against twenty-four thousand pixels, so
   * this is cheaper by two orders of magnitude than looking a colour up when a
   * pixel needs one — and it is *equivalent*, because a scanline renderer draws
   * a whole line from the palettes as they stood when the line began.
   */
  private readonly colours = new Int32Array(3 * LAYER_STRIDE);

  /** One line of each scroll plane: the colour index, and the colour it shows. */
  private readonly planeIndex = [
    new Uint8Array(SCREEN_WIDTH),
    new Uint8Array(SCREEN_WIDTH),
    new Uint8Array(SCREEN_WIDTH),
  ];
  private readonly planeColour = [
    new Int32Array(SCREEN_WIDTH),
    new Int32Array(SCREEN_WIDTH),
    new Int32Array(SCREEN_WIDTH),
  ];

  /**
   * @param video the console's `$8000`–`$BFFF`, which the processor writes to
   *   directly — this model never copies it.
   */
  constructor(
    readonly model: NgpModel,
    private readonly video: Uint8Array,
  ) {}

  private byte(address: number): number {
    return this.video[address - NGP_VIDEO] as number;
  }

  private word(address: number): number {
    return this.byte(address) | (this.byte(address + 1) << 8);
  }

  /**
   * Advance the beam, rendering each visible line as it is left behind.
   *
   * Returns whether a frame was completed, which is what a machine uses to
   * decide that the vertical-blank handler is owed a call.
   */
  step(cycles: number): boolean {
    this.frameReady = false;
    this.cycles += cycles;
    while (this.cycles >= CYCLES_PER_LINE) {
      this.cycles -= CYCLES_PER_LINE;
      if (this.line < SCREEN_HEIGHT) this.renderLine(this.line);
      this.line += 1;
      if (this.line === VBLANK_LINE) this.frameReady = true;
      if (this.line >= LINES_PER_FRAME) this.line = 0;
    }
    return this.frameReady;
  }

  /** Whether the beam is outside the visible picture. */
  get blanking(): boolean {
    return this.line >= VBLANK_LINE;
  }

  /**
   * Resolve every object's absolute position, following the chain bits.
   *
   * A chained object's stored position is an offset from the object before it,
   * so this is a running total over the whole table rather than a per-object
   * decode — which is what makes a multi-tile character cost one absolute
   * position and three small ones.
   */
  private positionSprites(): void {
    const offsetX = this.byte(NGP_PO_H);
    const offsetY = this.byte(NGP_PO_V);
    let previousX = 0;
    let previousY = 0;
    for (let index = 0; index < NGP_SPRITE_COUNT; index += 1) {
      const at = NGP_SPRITES + index * 4;
      const low = this.byte(at);
      const flags = this.byte(at + 1);
      const rawX = this.byte(at + 2);
      const rawY = this.byte(at + 3);
      const chainX = (flags & 0x04) !== 0;
      const chainY = (flags & 0x02) !== 0;
      previousX = (chainX ? previousX + rawX : rawX) & 0xff;
      previousY = (chainY ? previousY + rawY : rawY) & 0xff;
      const sprite = this.sprites[index] as Sprite;
      sprite.x = (previousX + offsetX) & 0xff;
      sprite.y = (previousY + offsetY) & 0xff;
      sprite.tile = low | ((flags & 0x01) << 8);
      sprite.hflip = (flags & 0x80) !== 0;
      sprite.vflip = (flags & 0x40) !== 0;
      sprite.monoPalette = (flags >> 5) & 1;
      sprite.priority = (flags >> 3) & 3;
      sprite.colorPalette = this.byte(NGP_SPRITE_PALETTES + index) & 0x0f;
    }
  }

  /** The backdrop or the out-of-window colour, which are the same eight colours. */
  private backdrop(register: number): number {
    const index = register & 0x07;
    if (this.model === "ngp") return MONO_SHADES[index] as number;
    const value = this.word(NGP_BACKGROUND_PALETTE + index * 2);
    return (
      (expandChannel(value) << 16) | (expandChannel(value >> 4) << 8) | expandChannel(value >> 8)
    );
  }

  /**
   * Resolve every palette on every layer into {@link colours}, once a line.
   *
   * The cache is laid out as the hardware lays the palettes out, which is what
   * makes this one walk rather than three nested loops: a colour machine's
   * entry `layer * 64 + palette * 4 + index` is the word at twice that offset,
   * and a mono machine's is the byte at `layer * 8 + entry` with only two
   * palettes a layer — the rest of each layer's block is left as it was,
   * because nothing can name it. The palette field a mono map entry and a mono
   * object carry is one bit.
   */
  private refreshPalettes(): void {
    const video = this.video;
    const colours = this.colours;
    if (this.model === "ngp") {
      for (let layer = 0; layer < 3; layer += 1) {
        for (let entry = 0; entry < 8; entry += 1) {
          const shade = (video[OFF_K1GE + layer * 8 + entry] as number) & 7;
          colours[layer * LAYER_STRIDE + entry] = MONO_SHADES[shade] as number;
        }
      }
      return;
    }
    for (let entry = 0; entry < 3 * LAYER_STRIDE; entry += 1) {
      const low = video[OFF_PALETTE + entry * 2] as number;
      const high = video[OFF_PALETTE + entry * 2 + 1] as number;
      // **The word is BGR, not RGB**: red is the low nibble and blue the high
      // one, which is the opposite of every other RGB444 console in this set and
      // the single easiest thing here to get wrong in a way nothing catches.
      colours[entry] =
        ((EXPANDED[low & 0x0f] as number) << 16) |
        ((EXPANDED[low >> 4] as number) << 8) |
        (EXPANDED[high & 0x0f] as number);
    }
  }

  /**
   * Resolve one scroll plane's whole line into its index and colour arrays.
   *
   * A cell at a time rather than a pixel at a time, which is the difference
   * between one map entry and one character row per eight pixels and one of each
   * per pixel. The first cell of a line is usually partial, because the plane
   * scrolls by pixels and the window starts wherever it starts.
   */
  private planeLine(plane: 1 | 2, y: number): void {
    const video = this.video;
    const index = this.planeIndex[plane] as Uint8Array;
    const colour = this.planeColour[plane] as Int32Array;
    const scrollX = video[OFF_SCROLL_H[plane] as number] as number;
    const scrollY = video[OFF_SCROLL_V[plane] as number] as number;
    const mapY = (y + scrollY) & 0xff;
    // Thirty-two cells of two bytes to a map row, and the map wraps at 256
    // pixels on both axes — so both wraps are a byte and there is no modulo.
    const rowBase = (OFF_PLANE[plane] as number) + (mapY >> 3) * 64;
    const layerBase = plane * LAYER_STRIDE;
    const mono = this.model === "ngp";
    for (let x = 0; x < SCREEN_WIDTH;) {
      const mapX = (x + scrollX) & 0xff;
      const at = rowBase + (mapX >> 3) * 2;
      const entry = (video[at] as number) | ((video[at + 1] as number) << 8);
      const fineY = (entry & 0x4000) !== 0 ? 7 - (mapY & 7) : mapY & 7;
      const rowAt = OFF_CHARACTERS + (entry & 0x1ff) * CHARACTER_BYTES + fineY * 2;
      const row = (video[rowAt] as number) | ((video[rowAt + 1] as number) << 8);
      const flipX = (entry & 0x8000) !== 0;
      const palette = mono ? (entry >> 13) & 1 : (entry >> 9) & 0x0f;
      const base = layerBase + palette * PALETTE_SIZE;
      const first = mapX & 7;
      const span = Math.min(8 - first, SCREEN_WIDTH - x);
      for (let step = 0; step < span; step += 1) {
        const pixel = first + step;
        const fineX = flipX ? 7 - pixel : pixel;
        const value = (row >> ((7 - fineX) * 2)) & 3;
        index[x + step] = value;
        colour[x + step] = this.colours[base + value] as number;
      }
      x += span;
    }
  }

  /**
   * Sort the objects covering this line into the three priority lists, and
   * resolve what each of them shows on it.
   *
   * Walked from the end so that the lowest-numbered object is applied last and
   * therefore wins, which is the ordering the object table's own priority
   * implies. Rebuilding this once a scanline rather than consulting the whole
   * table once a pixel is what the hardware itself does — this chip evaluates a
   * per-line budget, and on this console that budget is the whole table.
   */
  private gatherSprites(y: number): void {
    const video = this.video;
    const mono = this.model === "ngp";
    for (let priority = 1; priority <= 3; priority += 1) {
      (this.onLine[priority] as Sprite[]).length = 0;
    }
    for (let index = NGP_SPRITE_COUNT - 1; index >= 0; index -= 1) {
      const sprite = this.sprites[index] as Sprite;
      if (sprite.priority < 1 || sprite.priority > 3) continue;
      // Eight bits of position against a 152-line screen, and the subtraction
      // wraps — which is deliberate rather than incidental. It is the only way
      // an object can hang off the *top* edge: there is no sign bit, so "four
      // pixels off the top-left" is written as position 252.
      const dy = (y - sprite.y) & 0xff;
      if (dy >= 8) continue;
      const fineY = sprite.vflip ? 7 - dy : dy;
      const at = OFF_CHARACTERS + sprite.tile * CHARACTER_BYTES + fineY * 2;
      sprite.row = (video[at] as number) | ((video[at + 1] as number) << 8);
      sprite.paletteBase = (mono ? sprite.monoPalette : sprite.colorPalette) * PALETTE_SIZE;
      (this.onLine[sprite.priority] as Sprite[]).push(sprite);
    }
  }

  /** The topmost object of a given priority covering this pixel, or what is under. */
  private spriteOver(under: number, x: number, priority: number): number {
    let color = under;
    for (const sprite of this.onLine[priority] as Sprite[]) {
      // The horizontal half of the wrap {@link gatherSprites} did vertically.
      const dx = (x - sprite.x) & 0xff;
      if (dx >= 8) continue;
      const fineX = sprite.hflip ? 7 - dx : dx;
      const value = (sprite.row >> ((7 - fineX) * 2)) & 3;
      if (value === 0) continue;
      color = this.colours[sprite.paletteBase + value] as number;
    }
    return color;
  }

  /**
   * Draw one visible scanline.
   *
   * Back to front: the furthest objects, the back plane, the middle objects, the
   * front plane, and the objects in front of everything — which is this chip's
   * three-deep object priority, and the reason an object can sit *between* the
   * two planes.
   */
  private renderLine(y: number): void {
    if (y === 0) this.positionSprites();
    this.refreshPalettes();
    this.gatherSprites(y);
    this.planeLine(1, y);
    this.planeLine(2, y);

    const background = this.byte(NGP_BGC);
    // Both background-on bits have to agree, and anything else is black — which
    // is the reset state, so a cartridge that never writes the register gets a
    // black screen rather than whatever palette entry zero happens to hold.
    const backdrop =
      (background & 0xc0) === BACKGROUND_ON ? this.backdrop(background) : (MONO_SHADES[7] ?? 0);
    const outside = this.backdrop(this.byte(NGP_CONTROL));

    const windowX = this.byte(NGP_WBA_H);
    const windowY = this.byte(NGP_WBA_V);
    const windowW = this.byte(NGP_WSI_H);
    const windowH = this.byte(NGP_WSI_V);
    const inRows = y >= windowY && y < windowY + windowH;

    const front = (this.byte(NGP_PLANE_PRIORITY) & 0x80) !== 0 ? 2 : 1;
    const back = front === 1 ? 2 : 1;
    const backIndex = this.planeIndex[back] as Uint8Array;
    const backColour = this.planeColour[back] as Int32Array;
    const frontIndex = this.planeIndex[front] as Uint8Array;
    const frontColour = this.planeColour[front] as Int32Array;
    const framebuffer = this.framebuffer;

    for (let x = 0; x < SCREEN_WIDTH; x += 1) {
      const at = (y * SCREEN_WIDTH + x) * 4;
      let color: number;
      if (!inRows || x < windowX || x >= windowX + windowW) {
        color = outside;
      } else {
        color = backdrop;
        color = this.spriteOver(color, x, 1);
        if ((backIndex[x] as number) !== 0) color = backColour[x] as number;
        color = this.spriteOver(color, x, 2);
        if ((frontIndex[x] as number) !== 0) color = frontColour[x] as number;
        color = this.spriteOver(color, x, 3);
      }
      framebuffer[at] = (color >> 16) & 0xff;
      framebuffer[at + 1] = (color >> 8) & 0xff;
      framebuffer[at + 2] = color & 0xff;
      framebuffer[at + 3] = 0xff;
    }
  }
}
