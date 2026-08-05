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

/** Expand a four-bit channel to eight bits by replicating it. */
export function expandChannel(value: number): number {
  const nibble = value & 0xf;
  return (nibble << 4) | nibble;
}

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

  private readonly sprites: Sprite[] = Array.from({ length: NGP_SPRITE_COUNT }, () => ({
    x: 0,
    y: 0,
    tile: 0,
    hflip: false,
    vflip: false,
    priority: 0,
    monoPalette: 0,
    colorPalette: 0,
  }));

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

  /** One pixel of an 8×8 character, as a colour index of zero to three. */
  private characterPixel(tile: number, x: number, y: number): number {
    const row = this.word(NGP_CHARACTERS + tile * 16 + y * 2);
    // The rightmost pixel is in the low two bits, so the leftmost is the highest
    // pair — which is the opposite way round from every packed format in this
    // project and the one thing about the tile layout worth stating twice.
    return (row >> ((7 - x) * 2)) & 3;
  }

  /** A scroll plane's colour index and palette at a screen position, or index zero. */
  private planePixel(plane: 1 | 2, x: number, y: number): { index: number; entry: number } {
    const base = plane === 1 ? NGP_PLANE1 : NGP_PLANE2;
    const scrollX = this.byte(plane === 1 ? NGP_S1SO_H : NGP_S2SO_H);
    const scrollY = this.byte(plane === 1 ? NGP_S1SO_V : NGP_S2SO_V);
    const mapX = (x + scrollX) & 0xff;
    const mapY = (y + scrollY) & 0xff;
    const entry = this.word(base + ((mapY >> 3) * 32 + (mapX >> 3)) * 2);
    const fineX = (entry & 0x8000) !== 0 ? 7 - (mapX & 7) : mapX & 7;
    const fineY = (entry & 0x4000) !== 0 ? 7 - (mapY & 7) : mapY & 7;
    return { index: this.characterPixel(entry & 0x1ff, fineX, fineY), entry };
  }

  /** A colour, given the layer's palette block and which palette and entry. */
  private colorOf(layer: number, palette: number, index: number): number {
    if (this.model === "ngp") {
      // Three shades and a transparent slot, in a table of four bytes.
      const shade = this.byte(NGP_K1GE_PALETTE + layer * 8 + palette * 4 + index) & 7;
      return MONO_SHADES[shade] as number;
    }
    const value = this.word(NGP_PALETTE + layer * NGP_PALETTE_STRIDE + palette * 8 + index * 2);
    return (
      (expandChannel(value) << 16) | (expandChannel(value >> 4) << 8) | expandChannel(value >> 8)
    );
  }

  /** The backdrop, which is a register rather than a layer. */
  private backdrop(select: number): number {
    if (this.model === "ngp") return MONO_SHADES[select & 7] as number;
    const value = this.word(NGP_BACKGROUND_PALETTE + (select & 7) * 2);
    return (
      (expandChannel(value) << 16) | (expandChannel(value >> 4) << 8) | expandChannel(value >> 8)
    );
  }

  private renderLine(y: number): void {
    if (y === 0) this.positionSprites();

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

    const frontPlane = (this.byte(NGP_PLANE_PRIORITY) & 0x80) !== 0 ? 2 : 1;
    const backPlane = frontPlane === 1 ? 2 : 1;

    for (let x = 0; x < SCREEN_WIDTH; x += 1) {
      const at = (y * SCREEN_WIDTH + x) * 4;
      let color: number;
      if (!inRows || x < windowX || x >= windowX + windowW) {
        color = outside;
      } else {
        color = backdrop;
        // Back to front: the furthest objects, the back plane, the middle
        // objects, the front plane, and the objects in front of everything.
        color = this.spriteOver(color, x, y, 1);
        color = this.planeOver(color, backPlane, x, y);
        color = this.spriteOver(color, x, y, 2);
        color = this.planeOver(color, frontPlane, x, y);
        color = this.spriteOver(color, x, y, 3);
      }
      this.framebuffer[at] = (color >> 16) & 0xff;
      this.framebuffer[at + 1] = (color >> 8) & 0xff;
      this.framebuffer[at + 2] = color & 0xff;
      this.framebuffer[at + 3] = 0xff;
    }
  }

  private planeOver(under: number, plane: 1 | 2, x: number, y: number): number {
    const { index, entry } = this.planePixel(plane, x, y);
    if (index === 0) return under;
    const palette = this.model === "ngp" ? (entry >> 13) & 1 : (entry >> 9) & 0x0f;
    return this.colorOf(plane, palette, index);
  }

  /**
   * The topmost object of a given priority covering this pixel, or what is under.
   *
   * Walked from the end so that the lowest-numbered object wins, which is the
   * ordering the object table's own priority implies.
   */
  private spriteOver(under: number, x: number, y: number, priority: number): number {
    let color = under;
    for (let index = NGP_SPRITE_COUNT - 1; index >= 0; index -= 1) {
      const sprite = this.sprites[index] as Sprite;
      if (sprite.priority !== priority) continue;
      // Eight bits of position against a 160-pixel screen, and the subtraction
      // wraps — which is deliberate rather than incidental. It is the only way
      // an object can hang off the *left* edge: there is no sign bit, so "four
      // pixels off the top-left" is written as position 252.
      const dx = (x - sprite.x) & 0xff;
      const dy = (y - sprite.y) & 0xff;
      if (dx >= 8 || dy >= 8) continue;
      const fineX = sprite.hflip ? 7 - dx : dx;
      const fineY = sprite.vflip ? 7 - dy : dy;
      const value = this.characterPixel(sprite.tile, fineX, fineY);
      if (value === 0) continue;
      color = this.colorOf(
        0,
        this.model === "ngp" ? sprite.monoPalette : sprite.colorPalette,
        value,
      );
    }
    return color;
  }
}
